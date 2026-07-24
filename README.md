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

| Command | Effect |
| --- | --- |
| *(any text)* | Send a prompt to this topic's Claude session |
| *(any file)* | Upload it into this topic's `inbox/` (a caption runs as a prompt) |
| `/whoami` | Show your user/chat/topic ids (for the allowlist) — works for anyone |
| `/new` (or `/clear`) | Start a fresh session in this topic. The old session id is **kept** (nothing deleted) — `/resume` to undo. Like Claude's own `/clear`, this resets context without deleting the session. |
| `/resume [id]` | Restore the previous session (undo `/new`), or bind this topic to a specific past session id |
| `/compact [focus]` | Summarize this topic's session history to free up context (memory kept) |
| `/stop` | Cancel the task currently running in this topic |
| `/voice [on\|off]` | Voice mode: transcribe voice notes and speak answers back (eyes-free). Default from `TG_VOICE`. |
| `/interrupt [on\|off]` | Toggle interrupt mode: a new message cancels the running task and starts immediately (its reply comes as a new message) instead of queueing. Default from `TG_INTERRUPT`. |
| `/mode [plan\|acceptEdits\|auto\|bypass]` | Show or set this topic's permission mode. No argument opens a tap-to-switch keyboard. Persists per topic; defaults to `TG_PERMISSION_MODE`. |
| `/plan <task>` | One read-only turn: Claude researches and proposes without editing. Doesn't change the topic's mode, so "go ahead" carries the plan out. |
| `/model [opus\|sonnet\|haiku\|fable]` | Show or set this topic's model — an alias, a full id, or `default` to clear. No argument opens a tap-to-switch keyboard. Persists per topic; defaults to `TG_MODEL`. |
| `/usage` `/cost` `/context` | Claude's own commands, forwarded to the CLI as-is. They report rather than prompt the model, so they're free and take no turn. |
| `/logo bot\|group` | Set the bot's avatar (`setMyProfilePhoto`) or this group's photo (`setChatPhoto`) from `assets/`. Startup only fills these in when they're missing; this replaces an existing one. |
| `/get <path>` | Send a file from this topic's directory back to you |
| `/cwd <abs-path>` | Set this topic's working directory (resets its session) |
| `/status` | Show this topic's session id, cwd and permission mode |
| `/sessions <dir…>` | List the Claude sessions stored for one or more directories (what the IDE/CLI picker shows) |
| `/import <dir…>` | Make a topic for each session in the given directories — bound + recent history backfilled |
| `/history [N]` | Re-post the last N turns of this topic's bound session |
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
- **Claude → you.** Anything Claude places in `<topic-dir>/outbox/` is delivered to
  the topic after the run, then moved to `outbox/.sent/` so it isn't sent twice.
  A one-line hint (`TG_BRIDGE_HINT`, on by default) tells Claude this convention,
  so "send me the report" just works. You can also pull a file yourself with
  `/get <path>` (relative to the topic's directory, or absolute). Bot uploads are
  capped at 50 MB (2000 MB with a local server).

## Voice (eyes-free, turn-based)

Talk to a topic and hear the answer — no reading or typing. It runs **locally, no
API key**: `faster-whisper` for speech→text, `piper`/`espeak-ng` for text→speech,
and a fast model (Haiku) to summarize long answers into a few spoken sentences.

Setup once:

```bash
voice/setup.sh            # ffmpeg + faster-whisper + espeak-ng (robotic voice)
voice/setup.sh --piper    # also a natural neural voice (recommended)
```

Then per topic send `/voice on` (or set `TG_VOICE=1` for all topics). With voice on:

- **Send a voice note** → it's transcribed and run as your message. The bridge first
  echoes `🎙 "<what it heard>"` so a mis-hear is visible, then answers.
- **Every answer is also spoken back** as a voice message — short answers verbatim,
  long ones summarized to a couple of sentences so the note stays seconds, not minutes.
- Works with everything else: `/stop`, `/interrupt`, `/mode`, `/model` still apply.

`/voice off` returns a topic to text-only. Knobs: `TG_STT_MODEL` (whisper size),
`TG_STT_LANG` (force a language), `TG_PIPER_VOICE`, `TG_VOICE_SUMMARY_MODEL`,
`TG_VOICE_MAX_CHARS`, `TG_STT_CMD`/`TG_TTS_CMD` (swap in any engine).

## Config

All keys live in `.env` (see [.env.example](.env.example)). Highlights:

- `TG_WORKDIR` — default directory Claude runs in (override per topic with `/cwd`).
- `TG_PERMISSION_MODE` — the **default** permission mode (see below); `/mode` overrides it per topic.
- `TG_ALLOWED_TOOLS` — tools auto-approved in `acceptEdits` mode.
- `TG_REQUIRE_MENTION` — in groups, only answer when @mentioned.
- `TG_PROGRESS_DETAIL` — show the real command/path/query in the status message (default on).
- `TG_BOT_LOGO` / `TG_SET_LOGO` — avatar to set on startup **if the bot has none**.
- `TG_GROUP_LOGO` / `TG_SET_GROUP_LOGO` — group photo to set **if the group has none**
  (needs the bot to be an admin with *change group info*). Applied at startup and
  whenever the bot is promoted to admin — not when it's added, since it has no rights
  at that point. Neither photo is ever replaced automatically; `/logo bot|group` does
  that on purpose.
- `TG_API_ROOT` — a local Bot API server, for files over 20 MB (see below).

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
- **Gate it.** The URL drives Claude on your server, so `LIVE_PASSCODE` is required
  and the server refuses to start without one. Default permission mode is `plan`
  (read-only) — the web mouth shouldn't edit unasked.

Setup: `voice/setup.sh --kokoro`, set `LIVE_PASSCODE` in `.env`, `live/start-live.sh`,
point the subdomain at `:3060`. Latency floor is Kokoro (~1x realtime on CPU); a GPU
or a lighter voice makes it snappier.
