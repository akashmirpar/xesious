# claude-tg-bridge

Drive the **Claude Code CLI** from **Telegram** — each forum **topic** is its own
resumable Claude session with its own memory. Message a topic, Claude works in
that topic's directory on your server, the answer comes back in the same topic.

- **No API key.** It shells out to the `claude` CLI, which uses your existing
  claude.ai (Pro/Max) login. (This is *not* the Agent SDK, which would require a
  Console API key.)
- **No public port.** Telegram long-polling — works behind NAT/firewall.
- **Survives disconnect.** Run it in `tmux`; closing your laptop doesn't kill it.
- **Per-topic isolation.** `(chat, topic) → session_id`, persisted to disk and
  resumed via `claude -p --resume <id>`. History lives in
  `~/.claude/projects/<cwd>/<session-id>.jsonl`.

## How it works

```
Telegram (a forum group with topics)
   │  message in topic T
   ▼
bridge.ts  ──►  claude -p "<text>" --resume <session_for(chat,T)> --output-format json
   │                                   └─ runs in T's working dir, on your subscription
   ▼  parse .result + .session_id (stored back)
Telegram  ◄── reply posted into topic T (message_thread_id)
```

Messages in the same topic are serialized (so `--resume` stays ordered);
different topics run as parallel `claude` processes.

## Setup

Requires [Bun](https://bun.sh) and an authenticated `claude` CLI (`claude` runs
without asking you to log in).

```bash
bun install
cp .env.example .env          # then edit it
```

1. **Create a bot:** DM [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token into `TELEGRAM_BOT_TOKEN`.
2. **Start it:** `./start.sh` (runs in tmux). Or `bun run bridge.ts` in the foreground.
3. **Allowlist yourself:** DM the bot `/whoami`, copy your user id into `TG_ALLOWED_USERS`, restart.
4. **(Group + topics)** Create a Telegram group, turn on **Topics** in group settings, add the bot.
   - In @BotFather, `/setprivacy` → your bot → **Disable**, so it sees every message in topics (not just @mentions).
   - Add the bot, send `/whoami` in the group, put the chat id into `TG_ALLOWED_CHATS`, restart.
   - Now each topic is its own session.
5. **(Optional) Meaning search for group history:** `context/setup.sh`. Keyword search
   of what a group said works without it. This installs llama.cpp's `llama-server`
   and the bge-m3 embedding model (~700 MB, into `~/xesious-data`), starts them,
   writes `state/context-engines.json`, and checks that an embedding comes back.
   Then restart with `./update.sh`. The services don't start themselves after a
   reboot: `context/services.sh start emb && context/services.sh start cache`.
   Details: [Group settings](#group-settings) → *Recall earlier talk*, and
   `context/ENGINES.md`.

## Updating

**Always update with `./update.sh`** — don't edit and hand-restart:

```bash
./update.sh          # apply the working tree, verify, roll back if it breaks
./update.sh --pull   # git pull first, then the same
```

It does, in order: `bun install` → **typecheck** (a bad edit is caught before the
bot is touched) → back up `bridge.ts` → **wait for the bridge to go idle** (never
cuts off a reply mid-flight) → restart → **health-check** → **roll back** to the
exact previous bytes if the check fails.

The health check asks whether it can actually *serve*, not just whether the
process is alive — each condition is a real outage this repo has had: no
`polling Telegram`, a `[fatal]`, a `409` (another instance holding the token), or
an auth config where nothing can authorize. That last one matters: the bridge once
logged `polling Telegram` for hours while silently dropping every message because
`TG_ALLOWED_USERS` was empty — so an empty allowlist with `TG_TRUST_CHAT_MEMBERS`
off is now a **hard startup error**, not a warning.

## Commands

In a group, the commands that only inform the person asking — `/status`, `/jobs`, `/tasks`, `/usage` `/cost` `/context`, `/recall`, `/whoami`, `/help` and `/live` — are answered to that person alone: picked from the command menu, neither the command nor the reply is seen by the rest of the group. A slower one shows a private "checking" first and turns it into the answer. Typed by hand, the reply is private only where the bot is an admin (Telegram's rule), and otherwise visible as before — except `/live`, whose link is a key to the session: it then goes to your DM, and never into the group. Commands that change the topic for everyone (`/new`, `/mode`, `/model`, `/stop`, …) stay visible.

| Command | Effect |
| --- | --- |
| *(any text)* | Send a prompt to this topic's Claude session |
| *(any file)* | Upload it into this topic's `inbox/` (a caption runs as a prompt) |
| `/whoami` | Show your user/chat/topic ids (for the allowlist) — works for anyone |
| `/new` (or `/clear`) | Start a fresh session in this topic. The old session id is **kept** (nothing deleted) — `/resume` to undo. Like Claude's own `/clear`, this resets context without deleting the session. |
| `/resume [id]` | Restore the previous session (undo `/new`), or bind this topic to a specific past session — the 8-character prefix `/sessions` prints is enough, and an ambiguous one is refused rather than guessed |
| `/compact [focus]` | Summarize this topic's session history to free up context (memory kept) |
| `/stop` | Cancel the turn currently running in this topic. A `/bg` run or a task's run there goes on: those stop from `/jobs` (or a task's card), and `/stop` says they are still running |
| `/voice [on\|off\|parts on\|off]` | Voice mode: transcribe voice notes and speak answers back (eyes-free). Default from `TG_VOICE`. `parts` decides whether the progressive notes are sent or only the full file. |
| `/interrupt [on\|off]` | Toggle interrupt mode: a new message cancels the running task and starts immediately (its reply comes as a new message) instead of queueing. Default from `TG_INTERRUPT`. |
| `/mode [plan\|acceptEdits\|auto\|bypass]` | Show or set this topic's permission mode. No argument opens a tap-to-switch keyboard. Persists per topic; defaults to `TG_PERMISSION_MODE`. |
| `/plan <task>` | One read-only turn: Claude researches and proposes without editing. Doesn't change the topic's mode, so "go ahead" carries the plan out; the plan comes with a ✅ Go ahead button that does just that. |
| `/model [opus\|sonnet\|haiku\|fable]` | Show or set this topic's model — an alias, a full id, or `default` to clear. No argument opens a tap-to-switch keyboard. Persists per topic; defaults to `TG_MODEL`. |
| `/config` | This group's settings as a button menu: model, reasoning effort, voice, **topic mode**, and who may change settings. **More settings** holds the rest: instructions for Claude (the group's, plus any a topic adds), what topic mode presets (answers, records messages), how long recorded messages are kept, topics that differ from the group, default permission mode (never bypass), interrupt, voice parts, tool details and run records in the status, long-reply files, fan-out limits. In a group only you see the menu (an ephemeral message); each change is announced in the room with one line. Changes apply at once — no restart. See [Group settings](#group-settings). |
| `/usage` `/cost` `/context` | Claude's own commands, forwarded to the CLI as-is. They report rather than prompt the model, so they're free and take no turn. Each answer carries a **🔄 Refresh** button that re-reads the numbers into the same message, so checking twice doesn't leave two. |
| `/logo bot\|group` | Set the bot's avatar (`setMyProfilePhoto`) or this group's photo (`setChatPhoto`) from `assets/`. Startup only fills these in when they're missing; this replaces an existing one. |
| `/get <path>` | Send a file from this topic's directory back to you |
| `/cwd <abs-path>` | Set this topic's working directory (resets its session) |
| `/status` | Show this topic's session id, cwd and permission mode |
| `/tasks` | What the bot does here on its own: this topic's tasks (in General and the 🗂 Tasks topic, the whole group's, under their topics; in a DM, yours), numbered, to you alone; tap a number for that task's card. `/tasks pause all` (admins) pauses every task in the group. See [Tasks](#tasks). |
| `/sessions <dir…>` | List the Claude sessions stored for one or more directories (what the IDE/CLI picker shows), as a **tappable picker** — tap one to bind this topic to it, page through with `‹ Prev` / `Next ›` |
| `/import <dir…>` | Make a topic for each session in the given directories — bound + recent history backfilled |
| `/history [N]` | Re-post the last N turns of this topic's bound session |
| `/recall <question>` | What each context engine finds in this group's history for a question, side by side (no answer from Claude) |
| `/private [question]` | Ask about this topic privately. **With a question**, the answer appears right there in the topic, visible to you alone (an ephemeral message; nobody sees the question or the answer), worked out on a copy of the topic's session so the group's conversation never learns of it; a **🔒 Continue in DM** button carries that exchange on in your DM. If the answer cannot be shown in the topic it comes to your DM instead. **Without a question**, it carries this topic on in your DM with the bot, where only you see it. The topic's session is forked into your DM (same directory, same mode, model and effort); each DM turn is told what the topic said since, and searches the group's history. Nothing said there reaches the group. In a group only you see the command and the reply; if you have never started the bot, the reply carries a **Continue in DM** button instead. A question after it is answered in the DM. Sent as a reply to a message (an answer, say), it picks up from that message: the DM's first turn gets it with the talk around it, and the pinned message links to it. The DM opens with one pinned message saying which topic it continues (linked back to it), with a **🔓 Exit private** button, and every answer there ends with a 🔒 line linking back to the topic and, on its own line, a **🔓 Exit to your own chat** link; while linked, an **🔓 Exit private** button sits under the typing box (Telegram's reply keyboard, sent with the first answer). Leaving — the button, the link, `/private off` or `/new` — unpins that message (keeping its text, minus the button) and brings back your own conversation there (`/new` then starts it fresh, `/resume` undoes that). With `TG_TRUST_CHAT_MEMBERS`, a member who is not listed may use their DM this way for as long as they are still in the group. |
| `/help` | Usage |

## Import existing sessions

The sessions the Claude Code IDE/CLI shows are transcripts on disk at
`~/.claude/projects/<encoded-cwd>/<id>.jsonl`. Because the bridge resumes the
same files, any topic is the *same* session you'd see in the extension — just
`cd <dir>` and `claude --continue`, or open `<dir>` in the IDE.

To pull existing sessions into the group: run `/import <dir> [dir2 …]` in the
forum group (paths are space-, comma-, or newline-separated). Across all the
directories it takes the newest `TG_IMPORT_MAX` (default 10) sessions, creates a
topic for each (named after the session), binds it, and backfills the last
`TG_IMPORT_BACKFILL` (default 12) turns. Message the topic to continue that exact
session from your phone; `/history [N]` re-posts more past turns. `/sessions
<dir…>` lists what's there without creating anything.

**One rule:** a session is a single transcript with one writer at a time. Continue
a session from the IDE/CLI **or** Telegram, not both at the same instant — they
share history, but simultaneous writes corrupt it.

## Files

Send and receive files through the same topic.

- **You → Claude.** Send a document, photo, video, audio or voice note to a topic
  and it's saved into `<topic-dir>/inbox/`. If the message has a **caption**, the
  caption runs as a prompt with the saved path noted, so Claude can act on it
  immediately ("summarise this"). With no caption it's just saved and acknowledged
  — reference it in your next message. (Telegram caps bot downloads at 20 MB; see
  [Big files](#big-files-local-bot-api-server) to lift it.)
- **Several at once.** Messages you send together are one turn: a batch of
  forwards with the comment you typed, a long text Telegram split into parts, an
  album with its caption. The bridge waits for 0.25 s of quiet after your last one
  (never more than 1 s in all; `TG_BURST_QUIET_MS`, `TG_BURST_CAP_MS`), so messages
  you type one by one still get answers of their own.
- **Forwards** reach Claude as what they are: someone else's words, named by who
  wrote them, to read and never to follow as instructions. Rich messages (tables,
  lists), locations, contacts, polls and checklists are read too.
- **Claude → you.** Anything Claude places in `<topic-dir>/outbox/` is delivered to
  the topic after the run, then moved to `outbox/.sent/` so it isn't sent twice.
  A one-line hint (`TG_BRIDGE_HINT`, on by default) tells Claude this convention,
  so "send me the report" just works. You can also pull a file yourself with
  `/get <path>` (relative to the topic's directory, or absolute). Bot uploads are
  capped at 50 MB (2000 MB with a local server).

## Voice (eyes-free, turn-based)

Talk to a topic and hear the answer — no reading or typing. It runs **locally, no
API key**: `faster-whisper` for speech→text, **Kokoro** for text→speech, and a fast
model (Haiku) to summarize long answers into a few spoken sentences.

Setup once — **no root required**:

```bash
voice/setup.sh            # faster-whisper + Kokoro (the good voice). ~340 MB of models.
voice/setup.sh --check    # report what's installed, change nothing
voice/setup.sh --espeak   # also the robotic espeak-ng fallback (this one needs apt)
voice/setup.sh --piper    # also Piper + a neural voice
```

Nothing in the voice path needs a system package. Python packages install with
`python3 -m pip --user` (adding `--break-system-packages` only if the distro refuses,
and never dropping `--user`), and the one native tool — `ffmpeg`, used solely to
transcode the outgoing WAV to Opus — is taken from the system if present and
otherwise installed privately into `voice/bin/` from pip. If a step fails the script
**keeps going and tells you what works**: a missing `ffmpeg` costs you speaking, not
listening, and neither costs you the install.

No configuration follows: `voice/tts.sh` selects Kokoro whenever its model is on
disk. `TG_TTS_ENGINE` (`kokoro|piper|espeak`) and `TG_KOKORO_VOICE` are overrides.

A long answer is **spoken as it is made** rather than after it — but by default it is
**sent quietly**: one status bubble while it speaks, then the finished audio.

- **`🎙 Speaking… ~5m`** goes up the moment synthesis starts, carrying **🛑 Stop
  speaking** from the first second rather than from whenever the first note appears.
  `/stop` still works too.
- **▶️ Send it in parts** on that bubble switches to progressive delivery, and it
  **back-fills**: tap it a minute in and every chunk already made arrives at once,
  then the rest follow live. `/voice parts on` makes that the topic's default
  (`TG_VOICE_PARTS=1` for all topics).
- The **full file** follows as one audio message, captioned with a timestamp per
  section — tap one to jump there — and the status bubble is deleted. Synthesis is
  chunked either way, so this arrives at exactly the same moment whichever you choose;
  only the number of messages differs.
- Any parts that were sent **stay**. **🧹 Remove the parts** on the full file clears
  them if you want that; nothing deletes a voice note on its own, because the full file
  lands while you are most likely still mid-chunk.
- A **read-along page** comes with it: the answer, the audio, and each block
  highlighted as it is spoken, with a **section list** in the player bar — tap a
  heading to seek there and the page scrolls with it. Self-contained, so it works
  offline. Only for answers long enough to arrive as `answer.md`/`answer.html`
  (`TG_REPLY_FILE_CHARS`, default 6000) — it is a companion to those files, and a
  reply short enough to sit inline in the chat gets a voice note and nothing to open.
  `TG_VOICE_READALONG_MAX_MIN` caps how long an answer gets one;
  `TG_VOICE_CHUNKED=0` turns the whole progressive path off.

Synthesis runs off the topic's queue, so the next message you send is answered
immediately.

Then per topic send `/voice on` (or set `TG_VOICE=1` for all topics). With voice on:

- **Send a voice note** → it's transcribed and run as your message. The bridge first
  echoes `🎙 "<what it heard>"` so a mis-hear is visible, then answers.
- **Every answer is also spoken back** as a voice message — short answers verbatim,
  long ones summarized to a couple of sentences so the note stays seconds, not minutes.
- Works with everything else: `/stop`, `/interrupt`, `/mode`, `/model` still apply.

`/voice off` returns a topic to text-only. Knobs: `TG_STT_MODEL` (whisper size),
`TG_STT_LANG` (force a language), `TG_PIPER_VOICE`, `TG_VOICE_SUMMARY_MODEL`,
`TG_VOICE_MAX_CHARS`, `TG_STT_CMD`/`TG_TTS_CMD` (swap in any engine).

## Group settings

Many settings no longer need SSH and a restart: a group changes its own with
`/config`, from any topic, with buttons.

**Topic mode** is the one most people need — what the bot does in a group or topic:

| Mode | The bot answers | It records messages | For |
| --- | --- | --- | --- |
| 💬 Bot chat | every message | yes | people talking to the bot |
| 👥 Conversation | when @mentioned or replied to | yes | people talking to each other, calling the bot now and then |
| ✨ Auto | when @mentioned or replied to, **and on its own when it has something useful to add** | yes | a team that wants the bot to chime in, like a colleague |
| 🔕 Off | never (commands still work) | no | a jokes topic — no cost, nothing stored |

- **In a Conversation topic a mention carries the conversation.** Everything said
  since the bot's last answer there goes in front of the question, marked as
  background written by other people. Each message goes to Claude once, then lives
  in the topic's session. About 20k tokens go inline; the whole recorded topic is
  also written to `inbox/conversation.md`, which Claude can read for anything older.
- **Replying to someone's message** while mentioning the bot brings that message and
  up to 10 either side (anything also said since the bot's last answer is not sent
  twice) — even from before recording began, since Telegram sends the
  replied-to message along.
- **Files are fetched only when needed.** A photo or document posted in the
  conversation is recorded as a Telegram file id and downloaded when a mention's
  context includes it (the cloud Bot API caps bot downloads at 20 MB).
- **Recorded messages** live in `state/messages/<chat>/<topic>.jsonl`, edits included
  (the Bot API never reports deletions). They are kept forever unless the group sets
  a limit under *Keep recorded messages*.
- **A new group gets a mode from its size** the first time the bot sees it: just you
  and the bot is a bot chat, anything bigger is a conversation — said once in the
  group. `TG_REQUIRE_MENTION` in `.env` pins the default instead.
- **Reading along needs privacy mode off** for the bot (@BotFather → /setprivacy →
  Disable); `/config` warns when it is on.
- *Answers* and *Records messages* are under More settings, for when the preset is
  not quite right. Picking a Topic mode resets them to follow it.
- **How Auto decides.** After people go quiet for a moment (25 s by default; a busy
  topic waits at most 2 minutes), a cheap *judge* reads the last ~14 messages and
  answers JOIN or QUIET. Only a JOIN reaches the topic's real model, which runs
  without a status message and may still decide it has nothing to add — then
  nothing appears at all. After joining in, the bot pauses before it may do so
  again; saying its name skips the wait. Acknowledgements and emoji alone are never
  judged, and only a message from someone allowed to use the bot can wake the judge.
  - *Auto: who decides* — **Claude Haiku** (default), **Claude Sonnet**, or a **local
    model** on your server (`TG_AUTO_LOCAL_URL`, any OpenAI-compatible server that
    returns logprobs, such as llama.cpp's `llama-server`; costs nothing per message).
    Measured on a 90-case test set (`research/auto/REPORT.md`): Sonnet 96% right with
    2 unwanted joins, Haiku 88% with 3, and locally **Qwen3-4B-Instruct-2507**
    (Apache-2.0, with the short prompt the bridge gives local judges) 80% with 6, at
    ~6 s a look on a 4-core VPS — best paired with *reserved*:
    `llama-server -m Qwen3-4B-Instruct-2507-Q4_K_M.gguf --port 8090 -c 4096 -t 2 --reasoning off`.
  - *Auto: how often it joins* — reserved / balanced / chatty: how high the bar is,
    how long it waits, and how long it pauses after joining (15 / 5 / 1 minutes).
  - A judge call is `claude -p` with no tools, no MCP servers and no session file,
    from a directory outside any repository — about 1k input tokens a look. It uses
    the same Claude login as the bot itself.
- **Recall earlier talk (the context engine).** When a message in a group points
  back at something — "is the Friday demo still on?", "what did we decide last
  Tuesday?", "who suggested the discount?", a colleague's name, one of the group's
  own names for things — the bot searches everything the group has said before, in
  any of its topics, and hands Claude up to three earlier stretches of conversation
  that match well. A message that doesn't point back gets none: old talk that
  merely shares a word is noise. Either way Claude can search further on its own
  with three history tools (search, read around a message, list topics). A topic or
  group can search another history instead — an imported archive or another group —
  through `links` in `state/context-engines.json` (`context/ENGINES.md`).
  - The index is `state/context.db`, derived from the recorded topic logs: rebuilt
    from them at startup, pruned with them by *Keep recorded messages*, and safe to
    delete. Only recorded messages can be found.
  - **Keywords** (SQLite FTS5, with Persian spelling normalised) need nothing extra.
    **Meaning** search — finding "the Friday thing" from "weekly demo session" — uses
    the bge-m3 embedding model on llama.cpp, in its own process on the server's CPU:
    run `context/setup.sh` (it installs, starts and checks it, and writes
    `state/context-engines.json` with keywords + bge-m3 as the default engine). To use
    an embeddings server you already run, set `TG_CONTEXT_EMBED_URL` and
    `TG_CONTEXT_EMBED` (its model name) instead, or edit the JSON file.
    **Summaries** (also called digests) — a few lines per finished stretch naming its
    ideas and decisions — are written when a model is set: `TG_CONTEXT_DIGEST=haiku`,
    or `"summaries"` in the JSON file. Then every recorded topic gets them unless
    `/config` turns them off there; one short call per few stretches.
  - **Photos** are found by the text in them (a screenshot of an email, an error, a
    dashboard) with a local OCR service: run `context/setup-ocr.sh`, then
    `context/services.sh start ocr`, and add `"ocr": { "url": "http://127.0.0.1:8094" }`
    to `context-engines.json` (or set `TG_CONTEXT_OCR_URL`). A photo posted in a
    recorded topic is then saved to `state/media/` and read in the background, on the
    server's CPU. The text read joins the history, so it reaches Claude like any
    message. `context/OCR.md` has how it was chosen.
  - **Settings** (`/config` → More settings → *Context engine*, per group or topic):
    *Recall earlier talk* (when a message points back / on every message / off),
    *Search words* (written by Sonnet — the default — by Haiku, or the message as typed), *Search
    engine*, and *Summarise conversations*.
  - **Cost:** keywords, meaning search and photo reading run locally for free. Two
    parts use your Claude usage: summaries, and Claude-written search words — one
    small call each time the recall searches (and for each `/recall`).

- **Three levels, most specific wins:** a topic's own value → the group's value →
  the server's `.env`. The `.env` keys below are now the *defaults*.
- **Where a change lands** is asked each time: *the whole group* (topics that have
  their own value keep it), *everywhere* (also resets every topic's own value, e.g.
  turn voice off everywhere), or *only this topic*. The per-topic commands (`/model`,
  `/mode`, `/effort`, `/voice`, `/interrupt`) still set this topic's own value.
- **Who can change settings:** Telegram admins always can. An admin decides who
  else can — nobody (the default), people they pick (by @username, even someone who
  has never posted, or from the people who have), or everyone the bot lets in.
  Everyone else can open the menu and look.
- **Private menu, public record:** in a group the menu is an ephemeral message
  (Bot API 10.3) only you see; if Telegram refuses one, an ordinary message is sent
  instead. `/config` is registered as an *ephemeral command*, so
  the command you send is invisible to the room too. Every change posts one line
  in the room saying who changed what.
- **The "/" menu:** on startup the bridge registers its command list (`/config`
  ephemeral, the rest ordinary). `TG_SET_COMMANDS=0` leaves the list alone,
  e.g. if you manage it in @BotFather.
- **Prompts and instructions for Claude** (📝 *Prompts and Instructions* in
  `/config`): the group can set instructions Claude follows on every turn, and a
  topic can add its own on top — e.g. the group says "never push to main", the
  *Summaries* topic adds "only ever summarise". A topic's are added
  to the group's, never instead of them; both come after the built-in ones.
  **Unlike the other settings, a change to instructions only reaches new sessions**:
  the CLI fixes a session's system prompt when the session is created, so a topic
  already mid-conversation keeps the instructions it started with until `/new`. The
  announcement in the room says so.
- **What stays in `.env`:** guardrails (`TG_ALLOW_BYPASS`, `TG_ALLOWED_TOOLS`,
  `TG_TRUST_CHAT_MEMBERS`), allowlists, anything the bridge executes, credentials,
  paths and timeouts. A setting a chat can flip is not a guardrail.

## Group memory

Claude Code keeps its own memory per working directory, and every topic has its own directory, so on its own a fact saved in one topic is invisible in the others. Each group therefore also gets a **shared memory**, in `~/tg-topics/.groups/<chat id>/` (`TG_GROUPS_DIR` to move it):

- `memory/<short-name>.md` — one fact per file, with a `name` and a one-line `description` at the top. Claude saves a fact here when it matters to the whole group (a decision, a convention, who looks after what); facts for one topic stay in its own memory. Anyone in the group can add to it, by asking the bot to remember something or by the bot noticing.
- `CLAUDE.md` — written by the bridge before every turn: the rules, and an index of every fact (one line each). Each run in the group adds this folder (`--add-dir`, with `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`), and the CLI reads that `CLAUDE.md` on every run — so a fact saved in one topic is known in every other from its next message, resumed sessions included, with no `/new`.
- In a private continuation or a private answer (`/private`) the memory is **read-only**: the run gets a copy, thrown away afterwards, so private talk never reaches what the group sees. A plain DM gets no group memory.
- The facts are plain files — read, edit or delete them on the server. `TG_GROUP_MEMORY=0` turns the whole thing off.

## Tasks

Things the bot does on its own, later, again and again, or when something happens, reporting where they were set up. Ask for one in plain words, in a topic or a DM:

- "remind me in two hours to take the pills" — a 🔔 **reminder**: the message at its time, naming whoever asked, with ✅ Done and ⏰ +15 min.
- "every weekday at 9, summarize what changed in the repo" — a ⏰ **scheduled** Claude run: a fresh session each time (or one session it keeps, if asked), in the topic's folder with its model, effort and permission mode, acting for the person who set it up.
- "every evening, check the news and only tell us if something big happened" — a run that speaks only when it found something. A task can post its progress as it goes, its result (the default), only what's worth telling, only problems, or nothing; its history keeps every run either way. It can post to your DM instead, stop after a number of runs or at a date.
- "tell me when this product's price drops below 300", "when the share price moves more than 1% in 3 minutes, find out why", "keep the sync loop running" — a 👀 **watcher**: see [Watchers](#watchers).
- "every night, back up the database; only tell me if it fails" — a **script**: a command, with no AI. Its status decides; what it prints is posted as the task says (its output; only when it printed something; only when it fails, every failure, loud).
- "every evening, list what my tasks did" — a 📋 **digest**, made without Claude; "each morning, check the backup and sync tasks and tell me only if something is off" — a **watchdog**, a Claude run handed what those tasks did since its last run.

Claude makes them with the bot's own `task_create` tool, passing the time as it was said (at a time, in N minutes, every N minutes, or a cron expression) and the time zone; the bridge does the date arithmetic, daylight saving included. Claude Code's own schedulers are switched off in the bot's runs: a session cron dies with its run, and a cloud trigger would report to claude.ai instead of here.

What you see:

- **A card** in the topic, posted silently when the task is made and edited as it changes: what it does, when it runs next, how its last runs went, with ▶️ Run now, ⏸ Pause or ▶️ Resume, 📜 History (sent to you alone) and 🗑 (which asks first). While a run is going: ⏹ Stop.
- **The results.** In a group a result is silent unless the task was asked to be loud; reminders, finds, problems and repeated failures notify. The topic's next turn is told what the task posted, so Claude knows.
- **`/tasks`**, the list, numbered: tap a number for that task's card, privately.
- **The 🗂 Tasks topic**, made with a group's first task: where every topic's tasks are seen and managed. A board pinned at its top lists every task in the group under its topic, kept up to date, with a number to tap for each one's card; `/tasks` there lists the whole group; ask there to change any task, or to set one up in another topic. Below, every task created, changed, paused, failing or finished is logged silently, with a link to its topic. `/config` turns it off.

The rules:

- Anyone who may use the bot in a chat may run, pause or stop a task there; changing or deleting one is for the person who set it up, the group's admins and the bot's own users. In `/config`, *Tasks: who may create them* can limit creating to admins.
- A task acts for the person who set it up. If they can no longer use that chat, it pauses.
- After the bot was down, a task runs once for the slot it missed if that slot is still recent (half its period, between 2 minutes and 2 hours; 12 hours for a reminder), never a backlog. A run cut off by a restart isn't run again by itself; its topic gets a ▶️ Run again button. After a start, Claude runs wait two minutes, then go a few at a time.
- Two failures in a row raise an alert, edited in place rather than repeated; five pause the task. A run the account's usage limit stopped waits for the reset and doesn't count as a failure.
- At most `TG_TASKS_MAX_CLAUDE` (2) scheduled Claude runs at once, 2 scripts at once, 20 tasks per topic, at most one run a minute. Each run's model, tokens, cost and time are kept in its history.
- A task runs until it's paused, deleted or finished, or until an end it was given ("for the next two weeks"); when it reaches that end it says so in its topic, with ▶️ Keep it running.

In a forum group Claude can also make a topic for a new piece of work (with its own folder, or one you name, and another topic's settings), rename a topic, or move one to another folder: `topic_create`, `topic_rename`, `topic_set_cwd`. Moving the topic you're talking in happens when the turn ends.

Scripts on the server reach the bot through a Unix socket, `state/xesious.sock`, open only to the bot's user, with the operator token in `state/xesious.token`:

```
bun tasks/cli.ts send --chat -1001234567890 --topic Builds --silent "Nightly build finished"
bun tasks/cli.ts tasks list
bun tasks/cli.ts tasks pause <task id>
```

Each Claude run talks to it with a token of its own, scoped to its chat, topic and person, that dies with the run; so does a task's script, which can post in its topic with `bun "$XESIOUS_CLI" notify "…"`. `TG_TASKS=0` turns tasks off. Hand-offs between topics and bots, multi-step tasks and tasks that ask before they act are designed ([research/tasks/REPORT.md](research/tasks/REPORT.md)) but not built yet.

### Questions and approvals

- **A task's run can ask** when it can't go on without someone: a choice, a missing detail, a go-ahead. The question goes into its topic, naming whoever set the task up, with its options as buttons; a reply in your own words counts too. The run waits a few minutes for the answer. If none comes it stops and waits (❔ on its card), and the answer, whenever it comes, carries the task on in the session that asked. After a day it takes its default answer, if it had one, or lets the question go.
- **In a turn, Claude's own questions** (a choice between options, one or several) show as buttons, or take a reply in your own words; **a plan** (in plan mode, or from `/plan`) comes with ✅ Go ahead, which starts the turn that carries it out in the topic's own mode; **a prompt for permission** shows what Claude asks to do, with Allow and Deny. Only the person whose turn it is, or one of the bot's own users, answers; ten minutes without an answer is a no. A task that shows its work live gets the same; one nobody watches doesn't, and what its permission mode blocked is listed in its history.

### Watchers

A watcher is a small program in the topic's folder that Claude writes for the task and runs once to show it works. Every line it prints is an event. It is either **polled**, run every few minutes, printing what it found and exiting (a page, an API), or **streaming**, kept running (a websocket, a feed). The bot runs it itself; nothing needs setting up on the server.

- Each event can send a message (`{event}` is the line, `{value}` and `{why}` what the rule saw), or start a Claude run that gets the lines as material, or run a script. A watcher can also be kept running for its own sake, its failures the only thing said.
- **Rules**, exact and free, decide which events count: a value above or below a number, crossing it (once, and again only after it came back), a move of X% within a window, a change, words, a pattern; on the line or a field of its JSON. Their state outlasts a restart.
- An **AI filter**, for what no rule can decide ("does this suggest a major outage is starting?"): what passes the rule waits, and every few minutes the topic's judge (as Auto mode has it: Haiku, Sonnet or the local model) is asked which items answer the question, and why. One small call per batch, only when something came; the card counts what it considered and let through.
- At most one run per cooldown (5 minutes for Claude, 1 for a message) and so many an hour (6, 20); what comes meanwhile is folded into the next run. Events older than 10 minutes are dropped: a price move from an hour ago isn't news.
- A streaming watcher runs detached, at low priority, in its own process group, and outlives a restart: the next start picks it up, by its pid and start time, and reads what it printed meanwhile. It ends itself an hour after the bot is gone for good. One that dies starts again after a backoff; two failures in a row alert the topic, five pause the task. At most `TG_TASKS_MAX_WATCHERS` (8) run at once.

## Config

All keys live in `.env` (see [.env.example](.env.example)). Several are only
defaults now — a group can override them with `/config` (see above). Highlights:

- `TG_WORKDIR` — default directory Claude runs in (override per topic with `/cwd`).
- `TG_PERMISSION_MODE` — the **default** permission mode (see below); `/mode` overrides it per topic.
- `TG_ALLOWED_TOOLS` — tools auto-approved in `acceptEdits` mode.
- `TG_REQUIRE_MENTION` — the default Topic mode: 1 = Conversation, 0 = Bot chat. Unset, a new group gets one from its size. `/config` overrides it per group or topic.
- `TG_AUTO_JUDGE` / `TG_AUTO_EAGERNESS` — defaults for Auto mode's judge (`haiku`, `sonnet`, `local`) and eagerness (`reserved`, `balanced`, `chatty`); `/config` overrides both.
- `TG_AUTO_LOCAL_URL` / `TG_AUTO_LOCAL_MODEL` — the OpenAI-compatible server (e.g. `http://127.0.0.1:8090`) and model name for the *local* judge. It is scored from the first token's logprobs, so the server must return them (llama-server does).
- `TG_AUTO_MAX_LOOKS_PER_HOUR` — a ceiling on judge calls per topic per hour (default 40).
- `TG_CONTEXT` — the context engine (default on; `0` turns it off entirely). `state/context-engines.json` (written by `context/setup.sh`; `TG_CONTEXT_ENGINES` for another path) lists the search engines — see `context/ENGINES.md`. Without it, `TG_CONTEXT_EMBED=1` adds meaning search with bge-m3 on the local server `context/setup.sh` runs, or `TG_CONTEXT_EMBED_URL` (+ `TG_CONTEXT_EMBED`, the model name) another one; `TG_CONTEXT_DIGEST=haiku` adds summaries (see Group settings), `TG_CONTEXT_OCR_URL` reads the text in photos (or `"ocr"` in `context-engines.json`), `TG_CONTEXT_QUERY=haiku|typed` has Haiku write the recall's search words, or searches with the message as typed, instead of Sonnet, `TG_CONTEXT_DB` moves the index.
- `TG_PROGRESS_DETAIL` — show the real command/path/query in the status message (default on).
- `TG_BOT_LOGO` / `TG_SET_LOGO` — avatar to set on startup **if the bot has none**.
- `TG_GROUP_LOGO` / `TG_SET_GROUP_LOGO` — group photo to set **if the group has none**
  (needs the bot to be an admin with *change group info*). Applied at startup and
  whenever the bot is promoted to admin — not when it's added, since it has no rights
  at that point. Neither photo is ever replaced automatically; `/logo bot|group` does
  that on purpose.
- `TG_API_ROOT` — a local Bot API server, for files over 20 MB (see below).
- `TG_TASKS` — [tasks](#tasks) (default on; `0` turns them off). `TG_TASKS_MAX_CLAUDE` caps the scheduled Claude runs at once (2), `TG_TASKS_MAX_WATCHERS` the streaming watchers kept running (8); `TG_TASK_CREATORS` (`everyone`|`admins`) and `TG_TASKS_ACTIVITY` (`1`|`0`) are the defaults for the two task settings in `/config`; `TG_API_SOCKET` moves the local API's socket.

## Permission modes

The CLI can't pop a permission prompt at you over Telegram, so every run has to be
pre-authorized. Pick the posture per topic with `/mode` (or set the default with
`TG_PERMISSION_MODE`):

| Mode | What it does |
| --- | --- |
| `plan` | Read-only. Researches and proposes; never edits. Also available as a one-shot: `/plan <task>`. |
| `acceptEdits` | Auto-approves edits and the tools in `TG_ALLOWED_TOOLS`. |
| `auto` | *(default)* Runs unattended, but routes each tool call through Claude's classifier, which blocks destructive/irreversible ones. Preferred over `acceptEdits`, which waves through everything in `TG_ALLOWED_TOOLS` — `Bash` included — without looking at it. |
| `bypass` | No checks at all (`--dangerously-skip-permissions`). Only on a server you're willing to lose. |

`auto` trusts only your working directory and the current repo's remotes by
default, so pushing to your org or writing to a team bucket is blocked until you
describe your infrastructure in the `autoMode` block of `~/.claude/settings.json`
— note it deliberately ignores a repo's own `.claude/settings.json`, so a cloned
repo can't grant itself permissions. See
[auto mode config](https://code.claude.com/docs/en/auto-mode-config).

A typical loop from the phone: `/plan refactor the parser` → read it → "go ahead"
(runs in the topic's normal mode).

## Big files (local Bot API server)

The cloud Bot API caps bot **downloads at 20 MB** and **uploads at 50 MB** — a
hard limit of Telegram's, not this bridge's. Running a
[local Bot API server](https://github.com/tdlib/telegram-bot-api) removes the
download cap and raises uploads to 2000 MB. `./local-api.sh up` starts one in
Docker (needs `TG_API_ID`/`TG_API_HASH` from [my.telegram.org](https://my.telegram.org/apps)),
then set `TG_API_ROOT=http://localhost:8081` and restart. With `TG_LOCAL_API=1` in
`.env`, `./start.sh` brings it up for you.

**Understand the trade before you migrate.** A bot talks to exactly one API
server. Binding it to a local one means calling `logOut` on the cloud API, and
Telegram then refuses to let it back for **10 minutes**; `file_id`s minted before
the move stop resolving. So this is a standing posture for the deployment — it
cannot be switched on just for one big file. `./local-api.sh migrate` performs the
logOut, and asks you to type the bot's username first. Nothing else ever calls it.

The server we run is the [tdlight](https://hub.docker.com/r/tdlight/tdlightbotapi)
fork rather than upstream, because upstream
[keeps every downloaded file in RAM forever](https://github.com/tdlib/telegram-bot-api/issues/514)
— enough to OOM a small VPS after a couple of large transfers.

## Security

The bot is publicly addressable. Access is gated on the **sender's** user id
(never the room), so only ids in `TG_ALLOWED_USERS` are served; everyone else is
dropped. `/whoami` is the only ungated command and reveals only the caller's own
ids. Anyone you allowlist can run tools on your server — allowlist only yourself
and people you fully trust.

## Live voice call (web, real-time)

`live/` is a real-time voice page — open it on your phone, talk, and Claude talks
back, with barge-in (talk over it to interrupt). It reuses whisper + Kokoro + the
`claude` CLI (no API key). Turn-based Telegram voice is for messaging; this is for
holding a conversation.

- **Server:** `live/server.ts` (Bun) serves the page and a WebSocket. A persistent
  `live/worker.py` keeps whisper + Kokoro loaded so each turn is ~a few seconds,
  not ~15s. `live/start-live.sh` runs it in tmux.
- **Page:** `live/index.html` — mic capture, client-side VAD (hands-free) or
  push-to-talk, sentence-by-sentence playback, barge-in.
- **Behind nginx** on its own subdomain (see `live/nginx-app.besporesh.ir.conf`):
  proxy `/` to `127.0.0.1:3060` with WebSocket upgrade + a long read timeout.
- **Per session, no password.** In a Telegram topic, `/live` mints a `LIVE_URL/<uuid>`
  link bound to *that* topic's Claude session (shared via `state/live-links.json`).
  The uuid is the only secret. Speech-to-text happens in the browser (Web Speech
  API) — only text is sent, so it's fast; the page shows your words live plus
  Claude's thinking, tool use, and answer. Default permission mode `plan` (read-only).

Setup: `voice/setup.sh`, set `LIVE_PASSCODE` in `.env`, `live/start-live.sh`,
point the subdomain at `:3060`. Latency floor is Kokoro (~1x realtime on CPU); a GPU
or a lighter voice makes it snappier.
