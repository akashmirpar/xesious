# Scheduled and background work for a Claude Code bridge: landscape

Web research, 2026-10-15, plus checks on this host:
- Claude Code 2.1.290 is installed; the latest release is 2.1.300.
- Bun 1.3.14 is installed; the latest release is 1.4.3.

"Unverified" marks a claim I could not confirm from a primary source. The design built on this is in [REPORT.md](REPORT.md).

## 1. Anthropic's own surfaces

| Surface | Runs on | Survives restarts | Minimum interval | Where output goes | Approvals |
|---|---|---|---|---|---|
| **Routines** (Claude Code on the web, research preview since 2026-04-14) | Anthropic's cloud, on a fresh clone | Yes | 1 h | A new cloud session per run. Each run is listed on the routine's page | None: runs are autonomous |
| **Desktop scheduled tasks** (local) | Your machine, while the app is open | Yes | 1 min | A fresh session per run, plus a desktop notification | Set per task. Manual mode stalls until you approve |
| **Cowork scheduled tasks** | Remote by default since Oct 2026; local when the task needs local files | Yes | Hourly presets | A Cowork session per run | Set per task |
| **`/loop` and the cron tools** (`CronCreate`, `ScheduleWakeup`) | The open session | Only on `--resume`. Recurring jobs expire after 7 days | 1 min | The same session, between turns | The session's own |
| **Background sessions** (`claude --bg`, `claude agents`) | A local supervisor daemon | Crashes and sleep, not shutdown | — | `claude agents --json`: `working/blocked/done/failed/stopped` | Surfaced when someone attaches |
| **Claude Tag routines** (Slack, public beta) | Anthropic | Yes | — | Back into the thread that set them up | Anyone in the channel can pause or stop a routine |

Sources:
- https://code.claude.com/docs/en/scheduled-tasks.md and the pages it links: `routines.md`, `desktop-scheduled-tasks.md`, `agent-view.md`
- https://support.claude.com/en/articles/13854387
- https://claude.com/docs/claude-tag/users/proactivity.md

**Run states and other details worth copying:**
- **Missed runs:** after sleep, Desktop starts *one* catch-up run for the most recent missed time and drops older ones.
- **Skipped runs stay visible.** Run history keeps them, with the reason: asleep, previous run still going, or too many tasks already running.
- **Clock times:** routines take local time and store UTC. A run set exactly on the hour may start a few minutes late, so the docs suggest times like 9:07.
- **Framing:** since 2.1.213 a routine's stored prompt is framed as its assigned task, "not live user input and can't act as approval or consent". Text sent with an API trigger arrives wrapped as untrusted data.
- **A green run is not success.** It means only that the run started and exited without an infrastructure error.

### What the `claude -p` that this bridge runs can and can't do

- **Background work at the end of a turn.**
  - Since **2.1.292** a `-p` run stays open for background work and then takes one more turn with the result. It gives up after 10 minutes of continuous idle waiting (`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`).
  - **2.1.290, installed here, still stops background commands 5 s after the answer.**
  - Session crons die with the process. `CLAUDE_CODE_DISABLE_CRON=1` removes those tools. Source: https://code.claude.com/docs/en/headless.md#background-tasks-at-exit
- **Asking a person mid-run.** `--permission-prompt-tool mcp__<server>__<tool>` hands every permission prompt to an MCP tool.
  - The tool gets `{tool_name, input}` and returns the JSON string `{"behavior":"allow","updatedInput":{…}}` or `{"behavior":"deny","message":"…"}`. The contract was last published on the old SDK page; it is still current in the CLI reference.
  - **`AskUserQuestion` and `ExitPlanMode` are offered in `-p` only when such a host exists.** They are answered through `updatedInput.answers`.
  - `--permission-prompts none` denies anything that would prompt, and removes `AskUserQuestion`.
  - Sources: https://code.claude.com/docs/en/cli-reference.md, https://code.claude.com/docs/en/headless.md, the [2025 SDK page](https://web.archive.org/web/20250620/https://docs.anthropic.com/en/docs/claude-code/sdk).
- **Waiting without holding a process.** A `PreToolUse` hook can return `defer`.
  - The run then exits with `stop_reason: "tool_deferred"` and the pending call. `claude -p --resume` with an `allow` continues it later.
  - There is no timeout, and sessions are kept 30 days. It works only when Claude made a single tool call in that step.
  - Source: https://code.claude.com/docs/en/hooks.md
- **How long an MCP tool may block.**
  - The wall clock defaults to about 28 h (`MCP_TOOL_TIMEOUT`).
  - Idle (no answer and no progress) is cut at **30 min** for stdio servers; progress notifications reset that timer.
  - So an "ask the owner" tool can wait for a while, but a run left parked for hours should exit and resume instead.
  - Source: https://code.claude.com/docs/en/mcp.md
- **Channels** (push messages into a session; there is an official Telegram plugin) **don't work under `-p`.** Custom channels need an interactive-only flag.
  - **If the official Telegram plugin is enabled at user scope, every `claude -p` run starts its own `getUpdates` poller on that token, and they steal each other's updates** ([#84108](https://github.com/anthropics/claude-code/issues/84108)).
  - Source: https://code.claude.com/docs/en/channels.md
- **Claude can create cloud routines from inside a run.** `RemoteTrigger` (actions `list`, `get`, `create`, `update`, `run`, `list_runs`, `get_run_log`) is the tool behind `/schedule`, and it is available in a `claude -p` run logged in with a subscription.
  - So a request to "schedule" something can turn into a cloud routine. It runs on Anthropic's servers and reports into claude.ai, not to the chat it was asked in.
  - Source: https://code.claude.com/docs/en/agent-sdk/typescript.md#remotetrigger
- **Cross-session messaging** (`SendMessage` between local sessions) has been on by default since 2.1.224. A message from a peer "can't approve anything".
  - A bridge that runs several topics at once should refuse inbound peer messages (`crossSessionInbound`) and keep hand-offs in its own hands.
  - Source: https://code.claude.com/docs/en/cross-session-messaging.md
- **Model Context Protocol (MCP).**
  - The current spec revision is **2026-07-28**: stateless, multi-round-trip requests, and Tasks moved out of core into an extension.
  - Claude Code does **not** support MCP Tasks ([#102347](https://github.com/anthropics/claude-code/issues/102347)). It does support elicitation, in form and URL modes.
  - Since 2.1.292 stdio servers negotiate 2026-07-28 by default. **`context/mcp.ts` echoes whatever version the client asks for**, so it must answer with a version it really implements before Claude Code is upgraded here.
  - Sources: https://modelcontextprotocol.io/specification/2026-07-28/changelog.md, https://code.claude.com/docs/en/mcp.md
- **Guard rails for unattended runs.**
  - `--max-turns`, and `--max-budget-usd`, which is a client-side estimate and can overshoot.
  - There is no session timeout, so the host must end the run itself: SIGINT, then SIGTERM.
  - There is **no auto-wait at a usage limit** in `-p`; the `StopFailure` hook reports `rate_limit`.
  - `--system-prompt-snapshot off` lets a resumed session pick up a new `--append-system-prompt`. Otherwise the session keeps the one it started with.
  - Sources: https://code.claude.com/docs/en/headless.md, https://code.claude.com/docs/en/cli-reference.md
- **Terms.**
  - The [Consumer Terms](https://www.anthropic.com/legal/consumer-terms) (Pro/Max) bar "automated or non-human means" except through an API key or where explicitly permitted.
  - [Help Center](https://support.claude.com/en/articles/15036540) (2026-10-07): "You can still use the Claude Agent SDK, claude -p, and third-party apps with your subscription limits."
  - The [Claude Code legal page](https://code.claude.com/docs/en/legal-and-compliance.md) says usage limits assume "ordinary, individual usage".
  - A group of people driving one person's subscription on a schedule is where these texts conflict. An API key avoids the question. The texts changed several times in 2026.

## 2. Open-source agent harnesses with chat gateways

| Project | Name for it | Where a run executes | Saying "nothing to report" | Can a scheduled run schedule more? | After a restart |
|---|---|---|---|---|---|
| **OpenClaw** | "Automations" (renamed from cron, 2026-07). The heartbeat became one of them | `isolated` (fresh session, the default), `current`, `main`, or a named session. Output is announced to the creating chat, with the topic id | `NO_REPLY`, or the structured `heartbeat_respond {outcome, notify, summary}` tool | No: a run gets a tool scoped to its own job | At most one catch-up per job, 5 at once, 5 s apart, agent jobs delayed 2 min. An in-flight run becomes "interrupted" and is not replayed |
| **Hermes Agent** (Nous Research) | "Scheduled Tasks (Cron)"; its Desktop app calls them "Routines" | A fresh agent per run. Output goes to the origin chat and topic (`thread_id`), a home channel, or another profile | `[SILENT]`; a `wakeAgent:false` script gate; `monitor` for change detection; `no_agent` jobs | No: the cron toolset is removed from cron runs | Grace is half the period, clamped to 2 min–2 h, then one catch-up. In-flight runs become "unknown" |
| **nanobot** | Automations | As a turn in the originating session, when it is idle | A second LLM call decides whether to notify | Refused | No replay |
| **NanoClaw** (on the Claude Agent SDK) | Scheduled tasks | Own session per series. Silent unless the run calls `send_message` | Silent by default | Allowed, but an **ungated recurring task that fires more than 4 times a day is refused**, with a warning about quota and account bans | One late run |
| **ZeroClaw, PicoClaw, IronClaw, Moltis** | cron, heartbeat | Mostly isolated | Token variants (`NO_REPLY[FAIL]` is still delivered) | ZeroClaw strips the scheduler tools | IronClaw de-duplicates every fire by (trigger, slot) |
| **Letta, Agent Zero, Goose, OpenHands, ElizaOS** | cron/Wake, Tasks, schedules, Automations, triggers | Mixed | Mostly implicit | ElizaOS caps 100 triggers per creator and event chains at depth 4 | Mostly no catch-up. In Agent Zero one error stops a task for good |

Sources are cited per claim in the research notes. The main ones are `openclaw/openclaw` (docs/automation/*, src/cron/*), `NousResearch/hermes-agent` (cron/*, tools/cronjob_tools.py), `HKUDS/nanobot`, `nanocoai/nanoclaw` (src/modules/scheduling/create.ts) and `nearai/ironclaw`.

**What both leading projects converged on:**
- The gateway owns the clock, and the model gets a tool to create, list, update, pause, remove and run jobs.
- Each run gets a fresh session, and the result goes back to the chat and topic that created the job.
- A scheduled run cannot create jobs.
- One catch-up after downtime, and an interrupted run is never replayed.

**Worth borrowing:**
- **OpenClaw's preamble for unattended runs:** "This is an unattended scheduled run. Nobody is present to clarify or approve… If nothing needs doing, reply exactly NO_REPLY. If you cannot complete the task, explain what blocked it."
- **OpenClaw's "promotion" flow for creating a job:** restate the schedule in plain words, create it enabled, run it once now as a visible test, and delete it if that fails.
- **Failure handling.** OpenClaw: alert after 2 failures in a row (with a 1 h cooldown), auto-disable after 10, back off 30 s → 60 min. Hermes: one alert per error signature.
- **Approvals.** OpenClaw stopped sending approval cards for scheduled runs to chat after one job produced a card per occurrence. Its "always allow" is bound to the job's exact definition and command, and any edit voids it. Hermes denies by default in cron runs.

**What went wrong, by issue count:**
- **Silence tokens.** They swallow real answers, or leak into the chat as `NO`, `N` or `HEARTBEAT_OK`. Dozens of issues across both projects; every new output path re-opened one or the other.
- **Wrong destination.** Topic ids dropped and routes inferred after the fact: OpenClaw #19367, #112500, #73900.
- **Duplicate runs.** No durable claim for each occurrence: OpenClaw #17821 (a job re-firing 100+ times a second), #18875, #42640.
- **Silent missed runs.** OpenClaw #139215 (20–30% of fires lost), #161049.
- **Heartbeats in the shared main session** starved live chat (OpenClaw #103690) and cost 60–100K tokens a run (#97317).
- **Costs nobody capped:** about $248 from one zombie heartbeat (OpenClaw #98556); no spend cap in Hermes (#23419).
- **Size.** OpenClaw's cron subsystem reached about 44k lines of code plus 79k of tests. It removed its Tasks ledger and TaskFlow layer after six months.

## 3. Telegram bridges for coding agents

| Project | Scheduling | Approvals | Notes |
|---|---|---|---|
| [chenhg5/cc-connect](https://github.com/chenhg5/cc-connect) (~16k★, Go) | `/cron` and `/timer`; jobs are a prompt or a shell command (`Exec`), with `Silent` and `Mute` switches and a session mode (reuse or fresh per run) | `--permission-prompt-tool stdio` with Allow / Deny / Allow-all buttons | Drops runs missed during downtime. The repo has no LICENSE file |
| [grinev/opencode-telegram-bot](https://github.com/grinev/opencode-telegram-bot) (grammY) | `/task`: natural language turned into JSON and validated. At least 5 min apart, at most 10 tasks | Buttons for permissions and questions | A run left running at restart becomes "interrupted", and an overdue run fires once |
| [overwirehq/claude-code-telegram](https://github.com/overwirehq/claude-code-telegram) | APScheduler jobs in SQLite | Off by default; Allow/Deny with deny on a 60 s timeout | **Scheduled output carries only a chat id, no topic** |
| [slopus/happy](https://github.com/slopus/happy) + happy-agent | `wait`/`schedule_message`; deliveries accepted once | `canUseTool` from a phone app | Scheduled messages are stamped as coming from the agent, never from the user |
| [linuz90/claude-telegram-bot](https://github.com/linuz90/claude-telegram-bot) (Bun) | — | Bypassed | `ask_user` buttons through files in `/tmp` |
| [six-ddc/ccbot](https://github.com/six-ddc/ccbot) | — | Recognises the prompt on the terminal screen | One topic = one tmux window |

## 4. Commercial products

In 2026 most products turned "a prompt on a clock" into **automations**: a trigger, a condition, an action, and a memory of earlier runs. Names changed often:
- **OpenAI:**
  - ChatGPT Pulse was shut down in June 2026.
  - ChatGPT "Tasks" was relaunched as "Scheduled tasks", with monitoring tasks, in June 2026.
  - Codex "Automations" became "Scheduled tasks" in July 2026.
- **Perplexity** Tasks became "Automations" on 2026-09-29.
- **Manus** has renamed the feature three times in 15 months.
- **Relay.app** shut down on 2026-09-14.

| Product (feature name) | How it's created and confirmed | "Only tell me when…" | Managing it, and limits | People in the loop |
|---|---|---|---|---|
| **ChatGPT** (Scheduled tasks; monitoring tasks; events) | Ask in chat. The reply is one restating sentence ("I'll check your Gmail hourly and notify you only when a new package is confirmed delivered") plus a "Monitoring · title" pill that opens Prompt / Repeat / Until | Built into the **monitoring** type; plain tasks notify on every run | Scheduled page: next run, pause, edit, delete. Cards show "Checked 36m ago". 3–15 active by plan. Tasks auto-pause when inactive | "Pauses until you review it", with no timeout |
| **Codex** (Scheduled tasks, ex-Automations) | A form, or chat through a model tool (`automation_update`); "same chat or new chat per run" | Left to the prompt. The launch inbox auto-archived runs with nothing to report. Users asked for "quiet unless actionable" (#28922) | The Scheduled view works as an inbox, with unread marks | `approval_policy=never` for scheduled runs. Runaway: a 1-minute heartbeat ran 8 days and 10,353 turns (#51239) |
| **Cursor** (Automations; Bugbot) | Form, templates, or `/automate`, which opens a **draft the user saves** | Only through enabled tools. "Set a quality bar for when the agent should open a pull request, comment, or do nothing" | Run history with duration, tools and status. Overlapping ticks skipped. Complaints: double runs, wrong weekday, "silently stopped… no failed run was recorded" | Tool permissions; plans for long agents |
| **GitHub** (Copilot cloud agent Automations; Agentic Workflows) | Form: name, triggers, prompt, model, **tools** ("grant only the tools that the task needs"), then **Run now** to test | gh-aw: `noop` logs "nothing to do"; `skip-if-match` checks run before the agent starts | gh-aw: `stop-after: +25h`, `cooldown`, deterministic scatter of fuzzy times ("daily around 14:00") | gh-aw "safe outputs": the agent runs read-only and *requests* issues, comments or PRs through capped outputs |
| **Devin** (Automations) | Form, templates, or "Generate with Devin" | A **preflight script** returns `{run:false, reason}`, or a list of items that each start their own session | Activity tab; "Error (consecutive failures)" status; email Always / On failure / On success | Sessions sleep until messaged |
| **Gemini** (Scheduled actions; Spark schedules and monitors) | In chat; summarises, then Edit before confirming | Gmail and topic monitors (Spark) | 10 active (actions), 50 (Spark). "Within an hour of the scheduled time"; "run times are approximate" | Spark asks before spending money or sending email |
| **Jules** (Scheduled tasks; Suggested tasks) | Frequency and cadence picker | — | 15–300 tasks a day by plan | **Auto-approves a plan on a timer** |
| **Manus** (Automations) | "When … / Only if … / Manus will …"; "review the generated timing, conditions, actions… before activating"; works from Telegram too | Filtered events are logged as **"Condition not met"** | Updates calendar; **Test run**. A trigger pauses after the same failure repeats. Manus dropped "a new task per run" because results scattered | "Approval required / No approval needed" for posting or sending |
| **Microsoft 365 Copilot** (Scheduled prompts; Cowork tasks) | Cowork asks "What would you like Cowork to do regularly?" and "When should this run?", then shows a card: Name / Recurrence / **Run in: new or same conversation** | Event triggers default to **draft-and-approve** | Run now / Edit / Turn off / Delete; at most 10 | Pauses and asks when it needs approval |
| **Perplexity** (Tasks, then Automations) | Settings form with an **expiry date**; "Price Alert" is a type of its own | Watching for triggers costs no credits; "missed-update checks" | Run history used as memory | Setup asks which actions need approval |
| **Notion** (Custom Agents) | Created by chat; "Review the next scheduled run time" | "No action needed" runs are billed. For digests: "post 'No updates' instead of skipping" | `pause_reason`: credit_limit, runaway_credit_usage, failure_limit, needs_user_review…; an agent that starts spending unusually fast is paused | Always ask (default for write tools) / Always allow |
| **Zapier** (Agents, now "AI by Zapier"; Human in the Loop) | Instructions box, trigger card, test panel | Prompt or Filter steps | Zaps that fail 95% of the time are turned off | **The most complete**: approval with an explicit timeout outcome (skip and continue, or end the run), reminders, an editable reviewed content |
| **Lindy** (Routines) | "Describe your routine"; edited by chat ("Change my morning routine to 9am") | "Run this as a script": "most runs end quietly"; a **dry run** that checks "quiet days… stay silent instead of inventing filler" | A usage warning when a task gets expensive | Approve/Deny in the thread; "Always allow" turns it into a rule |

Sources are per product in the research notes:
- the ChatGPT and Codex help centres;
- the docs at cursor.com, docs.github.com, docs.devin.ai, jules.google, manus.im, notion.com and help.zapier.com, and docs.lindy.ai;
- the official docs and community posts on Microsoft's Copilot and Google's Gemini.

**Complaints, by frequency:**
1. **Reliability.** Missed, duplicate and wrong-weekday runs; time-zone slips (Claude Tag runs in UTC and drifts an hour; Cowork showed 08:00 as 17:00 JST); silent stops with no record.
2. **Noise.** Early ChatGPT tasks sent daily "nothing today" messages.
3. **Cost.** Per-run billing on Bugbot; credits burned on Notion and Lindy.

**Names in use:**
- **"Scheduled tasks" / "Tasks"** is the most common consumer label. But "task" also means a single run in several products, so people confuse the definition with its runs.
- **"Automations"** leads in pro and coding tools, for event-driven work.
- **"Routines"** is used by Anthropic (Claude Code, Claude Tag), Lindy and Replit, and reads as a habitual rhythm.
- **"Monitor", "watch", "alert"** name the conditional kind, and set the expectation of silence until something happens.
- **"Reminder"** names a one-off.

## 5. Building blocks

- **Schedulers.**
  - **`Bun.cron`:**
    - It never runs two copies of a job at once.
    - Up to 1.3.14 every schedule is read in UTC, and a `{tz}` option is silently ignored.
    - **Bun 1.4.0 (2026-08-20)** switched to local time and added `{tz}`.
  - **[croner](https://github.com/Hexagon/croner):** zero dependencies, 8 KB, timezone support through Intl. Use it as a next-run calculator: `nextRun`/`previousRuns`.
  - **DST, tested under Bun:**
    - On the spring-forward day croner shifts a 02:30 job to 03:30 and does not skip it.
    - On the fall-back day it skips the repeated hour for `0 * * * *`.
    - So keep sub-hourly cadences as intervals.
  - None of the in-process libraries (node-cron, cron, toad-scheduler, bree) store anything, so persistence and catch-up are always the host's job.
- **Queues and workflow engines.**
  - **[bunqueue](https://github.com/egeominotti/bunqueue)** is the closest ready-made fit: SQLite, `preventOverlap`/`skipMissedOnRestart`, durable approval gates. But it needs Bun ≥ 1.4, is 8 months old, and has one main author and 292 releases.
  - BullMQ, pg-boss, Temporal, Trigger.dev, Inngest, Windmill and n8n need Redis, Postgres or a server of their own. DBOS is Postgres-only.
  - [OpenWorkflow](https://github.com/openworkflowdev/openworkflow) embeds on `bun:sqlite`, but it is 0.x and drops a signal when nobody is waiting for it.
  - **Concepts worth copying:**
    - A2A's run states (`SUBMITTED, WORKING, INPUT_REQUIRED, COMPLETED, FAILED, CANCELED, REJECTED`).
    - Trigger.dev-style wait tokens: a deadline, a default outcome, first answer wins, re-armed after a restart.
    - `scheduleId@slot` as a unique run id.
    - Temporal's overlap policies (skip is the default) and catch-up window.
    - Per-key concurrency (Inngest, Trigger.dev).
- **MCP servers: none worth adopting.**
  - They either own their own state and runner, or poll the bot token, which the bridge already holds.
  - Tool surfaces worth borrowing:
    - [ZenlixAI/hitl-mcp](https://github.com/ZenlixAI/hitl-mcp): ask, then wait; typed questions; a default answer on timeout; idempotent submits.
    - [jolks/mcp-cron](https://github.com/jolks/mcp-cron): a claim made with a guarded `UPDATE … WHERE next_run = old`.
    - [TadMSTR/task-queue-mcp](https://github.com/TadMSTR/task-queue-mcp): a hand-off state machine with dead letters.
- **Monitoring.**
  - [Healthchecks.io](https://healthchecks.io/docs/): states new/up/late/down/paused plus `started`; a grace period; alerts on state changes only.
  - [Cronitor](https://cronitor.io/docs/monitor-api): failure tolerance, schedule tolerance, re-alert every 8 h.
  - [changedetection.io](https://github.com/dgtlmoon/changedetection.io) and Huginn: notify only on a change, with price thresholds.
  - Nobody covers LLM cost, so a usage-limit error should read as "deferred", not "failed".
- **Process supervision.**
  - For anything that has to outlive the bridge, a transient **systemd user service** (`systemd-run --user --unit=… -p CPUQuota= -p RuntimeMaxSec= -p StandardOutput=append:…`) gives caps, an exit status, and stopping by unit name.
  - A scope (what `context/services.sh` uses now) suits capped children the bridge waits on anyway.
  - **User units die with the user manager.** Without lingering (`loginctl show-user $USER -p Linger`), that happens when the last session ends.
  - macOS: launchd agents; there is no CPU quota, only `taskpolicy -c background`.

## 6. Telegram Bot API facts (through 10.3)

- **Bots can now read other bots in groups** (10.0, 2026-05-08). It is an opt-in "Bot-to-Bot Communication Mode" in @BotFather. The bot is reached by `/command@Bot` or a reply, or sees everything if it is an admin or has privacy off. Loop guards are mandatory. The FAQ's "bots can't see bots" is out of date.
- **Topics in private chats** (9.3, 9.4): a bot can create topics in a DM, so a person's own tasks can have a topic each.
- **Checklists** (`sendChecklist`) still need a business connection. Rich messages (10.1–10.3) can show checkbox list items, tables and buttons, which suits a status board the bot edits.
- **`date_time` entities** (9.5) show a time in each viewer's own locale and timezone ("next run in 3 h").
- **No API to schedule a message.** `sendMessageDraft` streaming works in private chats only.
- **Pins are per topic.** Pinning needs `can_pin_messages` in groups.
- **Buttons:** `style` success/danger/primary (9.4), `disabled` once decided, and `force_reply` on an inline keyboard (10.3).
- **Reactions:** a bot may set one per message.
- **Ephemeral messages are not durable** (they "may disappear… if the app is restarted"), so they don't suit approvals or reports.
- **Rate limit:** about 20 messages a minute per group, **shared by every topic**. The bridge's throttler counts edits and reactions against the same budget.
