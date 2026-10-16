# Tasks: scheduled, watching and background work, with a local API and MCP

*Proposal, branch `feat/jobs-mcp-api`. Phases 1 and 2 (§18) are built: schedules, reminders, Claude runs, scripts, watchers with rules and the AI filter, digests and watchdogs. Written 2026-10-15; the decisions from the 2026-10-16 review are folded in and listed in [§19](#19-decisions-2026-10-16). The research behind it is in [landscape.md](landscape.md).*

## The short version

- **A task is something the bot does on its own: _trigger → (optional) filter → action_.**
  - **Triggers:**
    - a **schedule**: at a time, every interval, or a cron expression;
    - a **watcher**: a small program the bot keeps running (a websocket, a stream) or runs every so often (an API, a feed), where everything it prints is an event;
    - a **webhook**;
    - **after** another task.
  - **Filters:**
    - a **rule**: thresholds, crosses, a % change within a window, keywords. Free and exact;
    - an **AI filter**: a cheap model judges relevance in batches.
  - **Actions:**
    - a **message** (reminders);
    - a **script** (a command, no AI);
    - a **Claude run**;
    - a **Codex run**;
    - a **hand-off** to another topic or bot.
  - **A task can also be a short plan of steps**, with the bridge enforcing its gates: "push only if the tests pass", "retry once".
- **The cost trick:** Claude never watches anything. Watchers and rules do that for free, and Claude runs only when something passes them.
- **A single setting decides how much a task says:** live, result, noteworthy, problems or never. Messages are **loud only for _found something_, _needs you_ and _failed_**; everything else is silent. "Nothing to report" is a `report` tool call, not a magic word.
- **Tasks behave like the rest of the bridge.**
  - **Permissions:** they run in their topic's permission mode (auto by default). When auto mode blocks something in a run nobody was watching, the run says so, with **Approve and re-run**.
  - **Usage:** there are no budgets by default. Every run's usage is recorded, so it can be looked into later.
- **Hand-offs:**
  - **To another topic of the same bot:** a hand-off queues work there, done with that topic's own folder, instructions and skills. It is standalone by default, with links in both topics.
  - **To another xesious bot:** an ordinary message in the target topic that @mentions that bot, sent with Telegram's bot-to-bot mode on. Files go as links.
  - **Child tasks:** a task may create them without asking, within limits. Long-lived standalone tasks need a person's tap.
- **Creating a task is just asking.** Claude fills in the task and picks the time zone. The bridge replies with a card built from what was actually saved, with **Run once now / Edit / Pause / Delete**.
- **Watching and managing:**
  - `/tasks`, and a card per task, edited in place;
  - run history, with each run's usage;
  - health alerts that don't involve Claude;
  - digests, and watchdog tasks;
  - an activity topic, on by default.
- **The local API comes first.** The bridge listens on a Unix socket. The per-run MCP server and a small `xesious` CLI are thin clients of it. With it, Claude can also create topics and set a topic's folder, instead of a person typing `/cwd`.
- **Build, don't adopt.** The only new dependency is **croner**, used to compute next run times. Watchers are supervised by the bridge itself, so nothing like systemd lingering has to be switched on.

## 1. What people need, and how each is expressed

All examples are invented; §14 walks through six of them step by step.

| Need | Trigger → filter → action |
|---|---|
| "Remind me to take my medicine in two hours" | schedule (once) → message, loud |
| "Send me a news summary every night" | schedule (cron) → Claude run, says *result* |
| "Tell me when this product's price drops below 300" | watcher (polls the page every 10 min) → rule *crosses below 300* → message, loud |
| "When the share price moves more than 1% in 3 minutes, find out why and tell me" | watcher (websocket) → rule *change ≥ 1% within 3 min* → Claude run (news + summary) |
| "Follow this news feed and tell me if a major cloud outage seems to be starting" | watcher (stream) → rule (keywords) → AI filter (batched) → Claude run → alert |
| "Every night, back up the database; only tell me if it fails" | schedule → script, says *problems* |
| "Keep the sync loop running" | watcher (kept running), says *problems* |
| "Every 30 min, refresh the dashboard data; don't tell me each time" | schedule → Claude run, says *never*, evening digest |
| "Each morning check the backup and sync tasks; tell me only if something's off" | schedule → Claude run with `watch: [backup, sync]`, says *noteworthy* |
| "Make a short video every day; when it's final, the Posting topic publishes it" | schedule → Claude run (own session) → hand-off to Posting on success; errors loud in Content |
| "Every weekend, take my tracker issue, have Codex implement it, push if the tests pass" | schedule → steps (script → Claude → Codex → script → …), §6 |
| "Do this now in the background" (today's `/bg`) | now → Claude run, says *result* |

## 2. The model

**Task** (the standing definition):
- **What:**
  - `id`, `name`;
  - a **trigger**;
  - optional **filters**;
  - an **action**, or **steps**.
- **How much it says:** the `says` level, `sound`, `where`, `digest`.
- **Claude runs:** `session` (fresh, own or topic). The model and permission mode come from the topic unless the task sets them.
- **Limits:**
  - overlap: skip by default;
  - catch-up: once, inside a grace window;
  - expiry: a date, a number of runs, or "until done";
  - for watcher events: a cooldown and a maximum per hour.
- **Ownership:**
  - `home`: the chat and topic, bound when the task is created and never inferred later;
  - `owner`: a person;
  - `created_by`: a person, or a run, for provenance;
  - `parent`: for child tasks.
- **State:**
  - active, paused (always with a reason: a person, failures, needs review, owner lost access), done or expired;
  - plus the next due time and the health state.

**Run** (one execution):
- **Identity:** the id is `taskId@slot` and is unique, so a slot can never fire twice. The trigger is one of: schedule, catch-up, manual, event, hand-off, after, or webhook.
- **States:**

  ```
  scheduled → queued → running → waiting(input | approval | hand-off) → succeeded | failed | timed_out | canceled | skipped(reason) | interrupted | deferred(usage limit)
  ```

  - `interrupted` means the bridge stopped mid-run. Such a run is never replayed automatically.
  - `deferred` means a usage limit stopped the run. It doesn't count as a failure.
- **Separate from the state:**
  - the outcome (what the run reported, and whether it notified);
  - delivery (whether it was posted, and the message ids);
  - for multi-step tasks, each step's result;
  - usage: model, tokens, estimated cost and duration;
  - the session id, and the parent run or flow.

**Flow:** the chain of runs linked by hand-offs, child tasks and `after` triggers. Each link inherits the root's flow id and adds one to the depth.

## 3. Triggers

- **Schedule:**
  - `at` a time;
  - `every` an interval of at least 60 s;
  - `cron` with an IANA time zone.
  - Jitter is fixed per task (a hash of its id), so a restart never re-rolls it, and "hourly" tasks don't all land on :00.
  - Sub-hourly cadences are intervals, not cron: cron libraries handle the daylight-saving hour differently.
- **Watcher:** a small program in the topic's folder. Claude writes it when you create the task, and runs it once to show it works.
  - **Two ways to run:**
    - **Polled:** the bridge runs it every N (at least 60 s); it prints what it found and exits.
    - **Streaming:** the bridge keeps it running; it reconnects by itself.
  - **Events:** every line it prints (JSON or text) is an event. A crash or a non-zero exit is a *watcher failure* that counts against its health; it is not an event.
  - **"Keep X running"** is a streaming watcher whose output nobody needs, with `says: problems`.
  - **Supervision, with no systemd and no lingering:**
    - The bridge starts the watcher detached, in its own process group, at low priority (`nice`). It records the pid and start time, and keeps the output in a log file with a read position.
    - It restarts a dead watcher with backoff.
    - After a bridge restart it re-adopts running watchers (it checks the pid against the recorded start time) and reads what they wrote in the meantime. Events older than the task's staleness limit (10 min by default) are dropped: a price move from an hour ago isn't news.
    - After a reboot, the bridge starts active watchers again when it starts.
  - Watchers should be light; heavy work belongs in a Claude run or a step.
- **Webhook:**
  - `xesious fire <task> [payload]` from the local CLI;
  - optionally, an HTTP URL with a secret, off by default.
  - The payload reaches the run as untrusted material.
- **After:** another task's run succeeded, was noteworthy, or failed. That run's result arrives as material.
- **Ends:**
  - `until` a time, or `times: N`;
  - "until done": a run calls `task_done`;
  - for watchers, `stop_when` a condition holds ("until the pull request is merged").
  - Anything that fires more often than hourly asks for an end date (default 7 days, renewable with one tap). That bounds a forgotten task to a week.

## 4. Filters

- **Rule**, applied to an event or to a field of it (JSON path):
  - above or below a value;
  - **crosses**: fires once, and re-arms when the value goes back;
  - **change ≥ X% within a window**, e.g. 1% within 3 minutes;
  - changed since last time;
  - contains a keyword, or matches a regex.
  - A **cooldown** and **at most N per hour** keep it from flooding. Events that arrive during a cooldown, or while a run is going, are folded into the next run ("…and moved again: −2.1% in total").
  - A watcher can apply its own logic and print only what matters; built-in rules exist so it doesn't have to.
- **AI filter.** For "is this relevant?", which no rule can answer:
  - A cheap model reads a batch of events every N minutes, with the task's question, and returns the items that pass plus one-line reasons.
  - It reuses the judge Auto mode already has: Claude Haiku through the CLI, or a local model.
  - It makes one small call per batch, and only when there are candidates. Every decision is logged ("considered, not passed").

## 5. Actions

- **Message:** a fixed text (reminders), with buttons where they help: ✅ Done, ⏰ +15 min.
- **Script:** a command, with no AI, run in the topic's folder. Its exit status decides success, and its output is posted according to `says`.
- **Claude run:** a turn through the existing machinery: status message, Interrupt button, delivery, outbox. The session it uses:
  - **fresh** (the default): a new session each run, in the topic's folder, with the topic's instructions and skills.
    - Afterwards the topic's own conversation gets a short note and a link to the result, so a later "what did the report say?" works.
    - This is today's `bgNotes`, fixed: kept across restarts, and pointing to the result file instead of pasting 600 characters.
  - **own:** the task keeps one session across its runs, so it remembers. "Don't repeat yesterday's topics" and "don't re-report the same story" need this.
    - It starts with `--system-prompt-snapshot off`, so a change to the task's instructions reaches it.
    - Claude picks this when continuity matters, and the card says so.
  - **topic:** a turn in the topic's own conversation, once the topic is idle. Only when asked for.
- **Codex run:** `codex exec --json -C <dir>`, with `-o` for its final message. Codex CLI 0.141.0 is installed and logged in on the development host. This is mostly used as a step (§6). Its usage counts against the ChatGPT/Codex plan, not Claude's.
- **Hand-off:** work delivered to another topic, or to another xesious bot (§9).

## 6. Multi-step tasks

Some tasks need gates that must not depend on Claude following a prompt: "push only if the tests pass", "try once more, then give up". For those, a task carries a short **plan**: an ordered list of steps, with simple conditions.
- **Step types:** message, script, Claude run, Codex run, ask (a person decides), hand-off.
- **Conditions:**
  - "if the previous step passed (or failed), go to step N";
  - "retry N times, with the failure output passed back in";
  - "stop".
- **Each step's result is saved**, so a restart resumes at the step that was running.
  - Steps that are safe to repeat simply run again.
  - Steps that aren't check first. A push looks at whether the branch is already on the remote.
- **Who decides what:**
  - Claude and Codex make the judgment calls *inside* steps: what to build, how to fix it.
  - The bridge enforces the flow *between* them. A push step can't run unless the tests exited 0.
- **What you see:** one run card, edited silently as the steps go by, then a normal report. A failure is loud and names the step.
- **It is not a workflow engine.** There are no parallel branches. The existing `/fanout` could become a step type later.
- **Creating one:** the same as any task. You describe it, Claude drafts the steps, the card lists them in words, and you confirm or change them by asking. Claude chooses a single run for simple tasks, and steps when there are gates, retries or other tools.

## 7. How much it says

| `says` | Posts | Typical use |
|---|---|---|
| **live** | Progress (a status message with steps and the Interrupt button) and the answer | Tasks someone watches, or that ask questions |
| **result** | The answer when done | Reports |
| **noteworthy** | Only when the run calls `report(notify: true)`; otherwise nothing, logged as "nothing new" | Watchers, monitors, watchdogs |
| **problems** | Failures and blocks only | Backups, syncs, kept-running watchers |
| **never** | Nothing; history only | Housekeeping |

- **`report(outcome, notify, summary, text?)`** is accepted once per run.
  - `outcome` is one of: nothing_new, done, progress, blocked, needs_attention.
  - If a run never calls it: under live and result the final text is posted as usual. Under noteworthy nothing is posted, and history shows "no report".
  - History keeps three cases apart: "chose silence", "produced nothing" and "failed".
- **Sound:**
  - **loud only** for *found something*, *needs you* and *failed*, plus anything a person explicitly asked to receive (a reminder, the nightly summary);
  - **silent** for everything else: results in groups, digests, "done, nothing notable", hand-off link lines.
  - It can be changed per task ("make it silent").
- **Quiet runs stay visible without a ping.** The card shows "last check 10:00 · nothing new".
- **Where:**
  - the home topic (the default);
  - the task's **own topic** ("⏰ name"), which a person can mute, for chatty tasks;
  - the owner's DM.
- **Digest:** daily or weekly, at a set time. A list of runs with their one-line summaries, built without Claude by default; "summarise with Claude" is an option.
- **Telegram's budget:** all topics of a group share about 20 messages a minute, and that includes edits and reactions. So:
  - scheduled posts go through a low-priority lane behind live replies;
  - cards are edited only when their state changes.

## 8. Permissions and people in the loop

- **Tasks run in their topic's permission mode, auto by default**, like the rest of the bridge. Nothing extra is set up unless a person asks for it, e.g. "make this one read-only" (plan mode), or a fixed list of tools. Bypass stays behind `TG_ALLOW_BYPASS`, as today.
- **When auto mode blocks something nobody was watching:**
  - In auto mode, Claude Code's classifier allows or blocks each action. In a `-p` run, a blocked action is skipped and the run carries on.
  - The bridge reads the run's denied actions (`permission_denials` in the result) and shows them on the run: "auto mode blocked: pushing to `main`".
  - **Approve and re-run** starts the run again, with the owner's approval of that specific action in its prompt. An approval in the conversation that names the action and its specifics is what auto mode accepts.
- **Questions.** `ask(question, options?, free_text?, wait ≤ 10 min, default?)`:
  - It posts in the home topic and mentions the owner, so they're notified even when the task is silent. It offers buttons, and a reply also counts as an answer.
  - Once answered, the buttons are disabled and the answer is shown.
  - If nobody answers in time, the run stops, saying what it's waiting for, and ends `waiting(input)`. The task shows ⏳.
  - A later answer resumes that run's session as a new turn. The wait is stored in SQLite: the first answer wins, and the wait is re-armed after a restart.
  - After 24 h, the question's default answer is used if it set one; otherwise the wait is dropped.
  - Every question says who may answer, by when, and what happens if nobody does. An approval is never given automatically.
- **When someone is around** (live runs, phase 3):
  - The run gets `--permission-prompt-tool mcp__xesious__approve`. Actions that need approval, including blocks that auto mode escalates, appear as **Allow once / Always for this task / Deny**. A timeout counts as a deny.
  - "Always" is tied to the task's definition and to the exact command. Any edit to the task voids it.
  - The same handler renders Claude's own `AskUserQuestion` and `ExitPlanMode` as buttons, which Claude Code offers in `-p` only when a permission host exists. That helps ordinary topic turns too: today they can only "ask one clarifying question and stop".
- **The bridge's idle watchdog is paused while the bridge itself is waiting on a person.** Otherwise a run is killed after 15 minutes with no output. Claude Code cuts an idle MCP call at 30 minutes, so longer waits always park and resume instead of holding a process.

## 9. Hand-offs and flows

### Within the same bot
- **`handoff(to_topic, brief, files?, wait?, reply_back?)`** queues a turn in another topic of the same group, which works on it with its own folder, instructions, skills and settings.
  - The brief arrives as **"Hand-off from Content · Daily video, run 12"**. It is material from an agent: it never counts as a person's approval.
  - Files are copied into the target's inbox.
  - **By default it is standalone.** The receiving topic posts its own result, and with `reply_back` a one-line link goes back.
  - **`wait: N min`** makes the sender wait for the result, parking if it takes longer, the way `ask` does.
- **Hand-offs written into the task.** For fixed pipelines, the hand-off is part of the task ("on success, hand the outputs to Posting"), and the bridge performs it. A pipeline step shouldn't depend on Claude remembering to call a tool.

### To another xesious bot
For a topic served by a different xesious bot: Content and Posting each have their own bot.
- **Setup, once:**
  - Both bots are in the group, with Bot-to-Bot Communication Mode switched on in @BotFather (Bot API 10.0).
  - Each bot lists the other as a **peer** (by bot id).
  - The sending bot knows which topics the other serves.
  - xesious's group setup already turns privacy mode off (or makes the bot an admin). With bot-to-bot mode on, the bots then see each other's group messages.
- **The hand-off is an ordinary message** in the target topic, readable by people and addressed with a mention:
  > @PosterBot, hand-off from Content · Daily video #12: today's video and caption, ready to post. Files: ‹links› `#handoff-12`
- **The receiving bot:**
  1. Acts on it only because it comes from a peer *and* mentions it. It treats it as hand-off material: not a person's instruction, and unable to approve anything.
  2. Runs a turn in that topic, under its own rules.
  3. **Replies to that message** with "✅ #handoff-12 posted: ‹link›" or "❌ #handoff-12 failed: ‹reason›".
- **The sending bot:**
  - matches the reply (by reply-to and the tag), and marks the hand-off done or failed;
  - updates its own line in the source topic;
  - if no reply arrives by the deadline, posts a loud error there.
- **Files go as links**, not uploads, so Telegram's 20 MB download limit for bots never applies. The link is a short-lived URL served by the sending bot, or a folder both bots can read.
- **Loop guards** (Telegram requires them):
  - only messages that mention the bot and come from a peer are acted on;
  - replies to the bot's own hand-off messages are results, never new work;
  - each hand-off id is accepted once;
  - a rate limit per peer, and a depth cap;
  - a bot never hands off in reply to a result.
- **History:** hand-off messages are recorded in the receiving topic's history. Today the bridge drops every bot's messages from its record; peers' messages would be kept.
- **Later:**
  - third-party bots, best effort (a mention or a command they understand; the reply is taken as the result text);
  - a same-host shortcut between xesious bots through their local APIs.

### Child tasks and limits
- **A run may create child tasks without asking.** Children:
  - inherit their parent's owner;
  - expire with the parent, or after at most 7 days;
  - are limited to 3 active per parent, and 2 levels deep;
  - can't raise their own permissions or change the model;
  - are listed on the parent's card, and each one's creation gets a silent note.

  Claude decides between a child and a hand-off.
- **A standalone task** (long-lived, open-ended, or with more access) proposed by a run needs one tap: **[Add] [Edit] [No]**.
- **Visibility:**
  - silent link lines in both topics, as `/fork` posts today;
  - a **flow view** on the card and in `/tasks flows` ("Daily video #12 ✅ → Posting ✅ → Stats ⏳", each step linked);
  - the activity topic.
- **Limits:**
  - depth at most 4;
  - at most 5 hand-offs per run;
  - no cycles inside a flow;
  - about 20 hand-offs an hour per topic;
  - hand-offs only into topics the owner may use.

## 10. Creating tasks

1. **Ask in plain words**, in the topic where the task should live.
2. **Claude fills in the task:**
   - The topic's normal turn calls `task_create` with structured fields.
   - For a watcher, Claude writes it and runs it once, to show it works and what it sees now.
   - **Claude also picks the time zone**, from what it knows of the person and the conversation, and asks only when it can't tell. The zone is stored with the task.
3. **The bridge validates it:**
   - the minimum interval, and a cap of 20 tasks per topic;
   - **duplicates:** the same topic, schedule and a similar prompt returns the existing task instead.
4. **The bridge posts a card, built from the saved record**, not from Claude's reply:

   > ⏰ **Weekday triage**: weekdays at 09:00 *(shown in your own time; zone: Europe/Berlin)* · fresh session here · posts only when something needs you · silent · Claude, about 5 runs a week
   > Next run: Monday 09:00
   > [▶️ Run once now] [✏️ Edit] [⏸ Pause] [🗑 Delete]

   - Times use Telegram's `date_time` entity, so every viewer sees their own local time.
   - A task a person asked for is active at once.
   - **Run once now** is the visible test: it shows what the task would have posted, or that it would have stayed silent.
   - A task with outside effects (posting, sending, pushing) gets a **dry run** first: read-only, with those actions shown instead of done.
5. **Changing it is asking too:** "make it 10:00", "make it silent". The edit *replaces* the old schedule, and the card is edited.
6. **"⏰ Repeat this"** on a turn that went well turns that same request into a task in the same topic. It's offered on the turn's existing record message.

## 11. Watching and managing

- **`/tasks`.** Private to the asker in a group.
  - **What it lists:** in a topic, that topic's tasks; in General, the whole group's; in a DM, the person's own.
  - **Each line:** a status mark, the name, the schedule in words, the next run, and the last outcome. Marks: ✅ posted · 🔇 nothing new · ⚠️ blocked · ❌ failed · ⏸ paused · ⏳ waiting for you.
- **A card per task**, in its home topic, edited in place:
  - the definition in words;
  - a strip of the last runs (✅🔇🔇❌✅), and its health;
  - buttons: **Run now · Pause/Resume · History · Edit · Delete**.
- **History.** The last 20 runs, each with:
  - time and trigger, outcome and duration;
  - **usage: model, tokens, estimated cost**;
  - a link to the message it posted;
  - 📄 to get the full result or log as a file.
- **Usage is tracked, not budgeted.** There are no budgets or extra caps by default, beyond the bridge's existing time limits: 4 h per run, and 15 min with no activity.
  - The card says how often the task runs Claude.
  - `/tasks usage` totals it per task for the day or week, so it can be looked into later.
  - A per-task budget exists only when someone asks for one.
  - A run stopped by a usage limit is *deferred*. It runs once after the reset if its slot is still current; otherwise frequent tasks just continue with their next slot.
- **Health, with no Claude involved** (states: up, late, down, paused, running). Alerts fire only when the state changes; repeats edit the same alert, and recovery gets one message.
  - **Missed or late:** past the grace period.
  - **Failures:** 2 in a row raise an alert (1 h cooldown). **5 pause the task**, with [Resume].
  - **Too slow:** a run past its maximum runtime is stopped and reported.
  - **Watcher keeps dying.**
  - **Waiting for you:** one reminder after 1 h.
  - **Never succeeded since it was created.**
  - **A pause always says why,** with [Resume].
- **Digests**, per task or per topic.
- **Watchdog tasks:** a Claude run with `watch: [...]`. It gets the watched tasks' recent runs as material, and read-only history tools for them. It says **noteworthy**, so it speaks only when something looks wrong.
- **Activity topic, on by default** (a `/config` setting):
  - The bot creates "🗂 Tasks" with the group's first task. If it may not manage topics, it says so once.
  - Every creation, change, hand-off, failure, approval and digest is logged there silently.
  - It's the one place to see cross-topic flows, and people can manage tasks by talking there.
- **Plain words work everywhere:** "what did the backup task do this week?", "why did yesterday's triage fail?", "pause the video task until Monday".
- **Who may do what** (a per-group `/config` setting):
  - **Default:** anyone allowed in a topic may create tasks there. The other option is "only allowlisted users and admins".
  - **Pausing:** anyone may pause any task.
  - **Edits and deletes:** the owner and group admins only.
  - A task runs as its owner, and pauses itself if the owner loses access.
  - Admins can pause every task at once with `/tasks pause all`.

## 12. The local API, the MCP server and the CLI

- **Socket API.**
  - The bridge serves HTTP/JSON on `state/xesious.sock` (mode 0600). Every change goes through the bridge, which is the only writer.
  - **Tokens:**
    - an operator token for scripts;
    - a token per run, passed to its MCP server, scoped to the chat, topic, person and run;
    - a token per task, for its watcher and script commands.
  - These limit what a tool can reach and who an action is attributed to. They don't contain a model that already has a shell as the same Unix user.
- **MCP server `xesious`.** One per run, next to the history server. It is a thin client of the socket, and learns its chat and topic from its environment, never from tool arguments.

  | Group | Tools |
  |---|---|
  | Tasks | `task_create`, `task_list`, `task_get` (with runs), `task_update`, `task_pause`, `task_resume`, `task_delete`, `task_run_now`, `task_propose`, `task_done` |
  | Inside a run | `report`, `ask`, `handoff`, `notify` (a message besides the final answer, to the home topic or the owner's DM) |
  | Topics | `topic_list` (with folder and settings), `topic_create(name, cwd?, like?)`, `topic_set_cwd`, `topic_rename` |
  | Hidden | `approve`, the permission-prompt target; not offered to the model |

  - **Scheduled runs get a smaller set:**
    - for their own task only: `task_get`, `task_pause`, `task_done`;
    - `task_create` for **child** tasks, within the limits in §9;
    - `task_propose`, for standalone tasks;
    - `report`, `notify` and `handoff`, plus `ask` when the run is live.
  - **Keeping them apart from Claude Code's own tools:**
    - Claude Code has `TaskCreate`/`TaskList` (a private to-do list that ends with the turn), `CronCreate` (session crons) and `RemoteTrigger` (Anthropic's cloud routines).
    - Each `task_*` description says it is the bot's task, which runs later and reports in Telegram.
    - Bridge runs set `CLAUDE_CODE_DISABLE_CRON=1` and disallow `RemoteTrigger`.
- **CLI `xesious`**, a thin client for scripts, system cron and other programs:
  - `xesious send --topic Deploys "Build finished"`
  - `xesious ask --topic Deploys "Deploy to production?" --options yes,no` blocks until someone answers, and its exit code is the choice.
  - `xesious run --topic Research "summarise today's papers"`
  - `xesious fire <task> [payload]`
  - `xesious tasks list|pause|resume`

## 13. How it runs inside the bridge

- **Store:** `state/tasks.db` (bun:sqlite, WAL).
  - Tables: tasks, runs, steps, waits, handoffs, rule_state, watchers, health_log, outbox.
  - Results and logs are files under `state/tasks/<id>/`.
- **One loop:**
  - a timer set to the earliest due time, re-checked at least every 30 s;
  - each fire is claimed with a guarded `UPDATE … WHERE next_due = old`;
  - the run id `task@slot` is unique.
- **Restarts:**
  1. `drain` works as today.
  2. On start, in-flight runs become **interrupted**, with one notice in the topic and a [Run again] button. Multi-step runs resume at their step.
  3. At most **one** catch-up per task, inside a grace window: half the period, clamped to 2 min–2 h. The bridge checks the last *completed* slot first, so a finished slot never fires again.
  4. A reminder is sent late, marked "late", for up to 12 h.
  5. Catch-ups are staggered: 5 at once, 5 s apart, and Claude runs start 2 min after the bridge does.
  6. Waits are re-armed, watchers re-adopted, and the outbox drained.
  7. One summary notice goes to each topic.
- **Concurrency:**
  - Scheduled Claude runs have a global cap (2), below live turns. Each task has one run at a time; an overlap is recorded as "skipped: still running".
  - Fresh and own sessions use their own queue key, so a task never blocks its topic. A topic-session task waits for the topic to be idle.
  - Watchers and scripts have their own caps.
  - A run waiting on a person holds no slot.
- **Stopping:**
  - Task runs have their own Interrupt button, and can be stopped from their card.
  - A topic's `/stop` and interrupt mode no longer kill them. Today the `stopped` set is per topic, so `/stop` also kills `/bg` runs; that gets fixed for both.
- **A context with no incoming message.** `dmContext` becomes a builder for any topic, with the owner as sender, so `handlePrompt` and `runStreaming` work unchanged. A small header message ("⏰ Daily video · run 12") is what the answer replies to.
- **Framing:**
  - The stored prompt reads as the task's assignment, stored by its owner on a date. It is "not live input and can't approve anything", which is the wording Claude Code's own routines use.
  - Watcher events, webhook payloads and hand-off briefs are material, in the bridge's existing nonce-marked blocks.
  - Runs nobody watches get a preamble saying so, adapted from OpenClaw's.
- **On every run:**
  - the topic's permission mode, passed explicitly;
  - the bridge's existing wall-clock and idle limits;
  - `CLAUDE_CODE_DISABLE_CRON=1`, `RemoteTrigger` disallowed, cross-session messages refused;
  - the model fixed by the topic or the task, never changed by the run itself.

## 14. Worked examples

**🔔 "Remind me to take my medicine in two hours."**
1. In the same turn, Claude creates: schedule at 16:40 → message "💊 Time to take your medicine", mentioning you, loud.
2. Card: "🔔 today 16:40 (in 2 h)", with [Change time] [Cancel].
3. At 16:40 the bridge sends it, with [✅ Done] [⏰ +15 min]. "+15 min" creates a new reminder.

No Claude run happens at 16:40. If the bot was restarting then, the reminder arrives as soon as it's back, marked "late".

**⏰ "Send me a news summary every night."**
1. Claude picks 21:07 in your time zone, or asks which subjects you want.
2. It creates: cron daily → Claude run in a fresh session, with web search, says *result*, loud (you asked to receive it).
3. **Run once now** shows tonight's version immediately.
4. Each night the bridge claims that night's slot and starts the run with the stored assignment. Claude searches, writes, and calls `report(done, notify: true)`. The summary is posted under "⏰ Nightly news", and the card shows "✅ 21:09" along with the run's usage.
5. **If it fails:** "⚠️ failed: reason [Retry]". A usage limit counts as *deferred*. 2 failures in a row raise an alert, and 5 pause the task.

**👀 "When the share price moves more than 1% in 3 minutes, find out why and tell me."**
1. **Claude writes a watcher** of about 40 lines: it connects to the market data websocket, reconnects on drops, and prints the price once a second. Claude runs it briefly to prove it works.
2. **Claude creates the task:**
   - watcher (streaming);
   - rule: *change ≥ 1% within 3 min* (fires once, re-arms when it calms), with a 15 min cooldown and at most 4 an hour;
   - action: a Claude run with "Price moved {pct}% in 3 min ({from}→{to}). Find news from the last hour that might explain it; summarize in 3–5 bullets with links";
   - says *result*, loud.
3. **The bridge supervises the watcher.** When the rule fires, a fresh Claude run gets the event as material, searches, and posts "📉 −1.3% in 3 min (… → …). Likely reasons: …".

Claude never watches the socket; it runs only when the rule fires.

**👀 "Follow this news feed and tell me if a major cloud outage seems to be starting."**
1. **Claude writes a streaming watcher** that prints each item. It proposes a keyword list (provider names, "outage", "degraded", "down") in the relevant languages.
2. **The task:**
   - watcher → rule (keywords);
   - **AI filter** every 5 min on the batch: "Which of these suggest a new, major outage is starting (not commentary, not old news)? Return ids + one-line reasons";
   - Claude run in its **own** session, so it remembers what it has already reported;
   - says *noteworthy*, at most 6 runs an hour, into the Alerts topic, loud.
3. **Running:** keyword hits queue up, the cheap filter screens them in batches, and only filter hits wake Claude. Claude checks other sources and either posts "🚨 … (sources)" or records "considered, not significant".
4. An optional evening digest: "340 items matched keywords, 12 reached the filter, 2 alerts".

**⏰ + hand-off: "Make a short video every day from the past week's news, in our brand and persona; when it's ready, the Posting topic publishes it; tell me here if anything fails."**
1. **Setup:**
   - The Content topic's folder holds the brand and persona files.
   - Its instructions and skills cover video and audio; the bridge already has text-to-speech.
2. **The task:**
   - cron daily 09:07;
   - Claude run in its **own** session, so it doesn't repeat earlier days;
   - on success, hand the outputs and summary to Posting (written into the task);
   - on failure, a loud error in Content.
3. **Each morning:**
   - Claude gathers the news, writes the script in the persona, and renders the audio and video (CPU-capped, with a maximum runtime). The files go to the outbox, and it calls `report`.
   - The bridge performs the hand-off.
   - Posting gets "⬅️ From Content · Daily video #12" with the files, runs its own turn under its own rules (perhaps asking you [Post] [Edit caption] [Skip]), and publishes.
   - Content's silent line becomes "✅ Posted (link)".
4. **Any failure** posts "❌ Daily video #12 failed at ‹step›: reason [Retry] [Logs]" in Content. That covers fetching, rendering, Posting declining, and no answer by the deadline.
5. If Posting has its own bot, the hand-off goes as described in §9.

**⏰ + steps: "Every weekend, take the tracker issue assigned to me, have Codex implement it, push if the tests pass, retry once, and report."**

```
Saturday 10:07
1. script  fetch the assigned issue (tracker API)                 → issue.json
2. Claude  scope it: read issue + repo, write spec.md             → unclear? ask, else continue
3. Codex   implement spec.md in a git worktree, branch issue-123  (codex exec --json -C <worktree>)
4. script  run the tests — exit code decides
           ├ pass → 6
           └ fail → 5
5. Codex   fix, given the failing output (once) → tests again
           ├ pass → 6
           └ fail → 7, marked failed, nothing pushed
6. script  push the branch / open a PR   (optionally: ask first)
7. Claude  write the report from the step records; post it; comment on the issue
```

The run card reads, silently, as the steps go by:
> ✅ fetched #123 · ✅ scoped · ✅ implemented · ❌ tests 37/40 · ✅ fixed · ✅ tests 40/40 · ✅ pushed abc123

Then the report arrives as a normal message.

## 15. Naming

| Name | Used by | For | Against |
|---|---|---|---|
| **Tasks** | Most consumer assistants: ChatGPT and Codex ("Scheduled tasks"), Gemini Spark, Jules, Claude Desktop and Cowork; Perplexity and Manus until September 2026 | The plainest and most widely understood word. It covers one-offs, reminders and watches, not just rhythms | Claude Code has its own `TaskCreate`/`TaskList` (a to-do list that ends with the turn) and a `/tasks` view of background work. "Task" can also mean a single run. Both are handled below |
| **Routines** | Anthropic (Claude Code's cloud routines, `/schedule` alias `/routines`; Claude Tag), Lindy, Replit, Hermes Desktop | Anthropic's word for scheduled agent work | Awkward for one-offs and watches. It also names a *different* system: inside a bridge run logged in with a subscription, Claude can create a cloud routine with `RemoteTrigger`, which reports to claude.ai and never to Telegram |
| **Automations** | Cursor, GitHub Copilot, Devin, Perplexity, Manus 2.0, OpenClaw (renamed from cron, 2026-07), nanobot | Covers triggers, watchers and pipelines | Sounds like power-user rules; clashes with the bridge's "✨ Auto" topic mode |
| **Jobs** | — | — | `/jobs` already means "what's running right now" |

**Chosen: Tasks.** Each kind gets a visible label: ⏰ **Scheduled** · 🔔 **Reminder** · 👀 **Watch** · ↪️ **On event** · 🌿 **Background**.
- A **task** is the standing definition, and a **run** is one execution. Cards and history never call a run a task.
- `/jobs` stays as the "running now" view, with task runs included.

**How the clashes are handled:**
- Neither `/tasks` nor `/routines` reaches Claude Code through the bridge: only `/usage`, `/cost` and `/context` are forwarded.
- Each `task_*` tool description says it is the bot's task.
- `RemoteTrigger` is disallowed in bridge runs.

## 16. Build or adopt

- **Build, in the bridge's own style:** one SQLite file, the existing job registry, `drain` on SIGTERM.
- **The only new dependency is croner** (zero dependencies, 8 KB), used to compute next run times. It handles time zones on today's Bun 1.3.14. On Bun 1.4 or later, `Bun.cron.parse(expr, from, {tz})` could replace it.
- **Copy, don't import:**
  - run states from A2A and MCP Tasks;
  - wait tokens from Trigger.dev;
  - overlap and catch-up policies from Temporal;
  - health states from Healthchecks.io;
  - `report` from OpenClaw's `heartbeat_respond`;
  - the creation flow and failure policy from OpenClaw;
  - the delivery origin with a topic id, and the gates, from Hermes;
  - the monitoring type and "Checked 36m ago" from ChatGPT;
  - "Condition not met" as a logged state from Manus;
  - timeout outcomes for approvals from Zapier and Relay;
  - the dry run from Lindy;
  - pause reasons from Notion;
  - `noop` and `stop-after` from GitHub's Agentic Workflows;
  - preflight items that each start a run, from Devin (later).
- **Not adopted, and why:**
  - **Claude Code's cloud routines:** they run in Anthropic's cloud, at most hourly, and post into claude.ai.
  - **Claude Code's session crons:** they die with `-p`.
  - **`claude --bg` sessions:** they can't be combined with `-p`, and their files are "not a stable interface".
  - **systemd user services for watchers:** they need lingering.
  - **bunqueue:** young, one author, and needs Bun 1.4.
  - **Queue and workflow engines:** they need Redis, Postgres or a server of their own.
  - **Scheduler and Telegram MCP servers:** they own their own state, or poll the bot's token.

**Size, roughly.** Phase 1 is about 1,500–2,000 lines plus tests. OpenClaw's cron subsystem reached 44k lines before a planned 41% cut, which is the argument for keeping this to one mechanism.

## 17. On the host

- **Claude Code 2.1.301 is installed** (2026-10-16). It includes the 2.1.292 fix (background commands are no longer stopped 5 s after the answer) and the 2.1.299 fix (MCP calls no longer run twice).
  - The history MCP server still connects under it; this was checked with one real run.
  - `context/mcp.ts` echoes the client's protocol version instead of naming the one it implements. That's a small cleanup, not a breakage.
- **Lingering is not needed.** The bridge supervises watchers itself (§3).
  - A separate, existing property: the bridge runs under the user's systemd manager through tmux. Without lingering, that manager stops when the user's last login session ends, and the bridge with it.
  - A crontab watchdog line is a non-root way to start it again. This proposal doesn't change any of that.
- **Keep Claude Code's official Telegram channel plugin off** for the bot's token. Enabled at user scope, it starts a competing poller in every `claude -p` run.
- **Credential:** the subscription, for everything, for now. Anthropic's texts say Pro/Max limits assume "ordinary, individual usage", so an API-key option for scheduled runs in shared groups can come later ([landscape §1](landscape.md#1-anthropics-own-surfaces)).

## 18. Phases

1. **Foundations, reminders and scheduled Claude runs.**
   - The socket API, the MCP server, and `xesious send`.
   - The store, the loop and the restart rules.
   - Messages, and Claude runs (fresh and own), with `says`, sound and `report`.
   - Creating tasks by asking, the card, `/tasks`, history with usage, and basic health alerts.
   - The topic tools, the activity topic, and the who-may-create setting.
   - The message-less context, and the stop-semantics fix.
2. **Watchers.** Polled and streaming, supervised by the bridge; rules, the AI filter, digests, watchdog tasks.
3. **People in the loop.**
   - The permission-prompt tool: blocks as buttons, and `AskUserQuestion`/`ExitPlanMode` as buttons in all turns.
   - `ask`, with parking and resuming.
   - Approve and re-run.
4. **Hand-offs and steps.**
   - Hand-offs within a bot, and hand-offs written into tasks.
   - Multi-step tasks, with the Codex step.
   - Child tasks, `after` triggers, the flow view.
   - `xesious ask`, `run` and `fire`; webhooks.
5. **Other bots.** Hand-offs between xesious bots over Telegram; third-party bots after that, best effort.

## 19. Decisions (2026-10-16)

1. **Name:** Tasks, with a label for each kind.
2. **Model:** trigger → filter → action. Triggers are schedule, watcher, webhook and after; "check" is gone.
3. **Session:** fresh by default; own for continuity; topic only when asked.
4. **Sound:** loud only for found something, needs you and failed (plus what was asked for). Everything else is silent.
5. **Permissions:** the topic's mode, auto by default; nothing extra unless asked. Auto-mode blocks are reported with Approve and re-run.
6. **Usage:** tracked per run and per task; no budgets or taps by default.
7. **Hand-offs:** standalone by default.
8. **Child tasks:** allowed by default (7 days, 3 per parent, 2 levels); standalone ones need a tap.
9. **Who may create:** a `/config` setting, defaulting to anyone allowed in the topic.
10. **Other bots:** xesious bots first, by an @mention message over Telegram, with files as links.
11. **Phases:** as in §18.
12. **Secrets for outside services:** not now.
13. **Activity topic:** on by default, created with the group's first task.
14. **Claude Code:** 2.1.301, already installed.
15. **Lingering:** not needed.
16. **Credential:** the subscription for now.
17. **Time zone:** Claude decides it when creating the task.
18. **These notes** are committed with the branch.

## Not in this proposal

- **Secrets for outside services.** Tokens are kept out of chat and passed to a task by name. It comes later; until then, a task relies on what its topic's folder and environment already have.
- **Merging queued messages into one turn.** Still an undecided idea in the feedback file.
- **A web dashboard for flows.** The live server could serve one later.
- **A triage model that reads every message and decides to act.** That's its own research item.
