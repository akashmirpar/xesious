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

## Commands

| Command | Effect |
| --- | --- |
| *(any text)* | Send a prompt to this topic's Claude session |
| *(any file)* | Upload it into this topic's `inbox/` (a caption runs as a prompt) |
| `/whoami` | Show your user/chat/topic ids (for the allowlist) — works for anyone |
| `/new` | Start a fresh session in this topic (forget history) |
| `/get <path>` | Send a file from this topic's directory back to you |
| `/cwd <abs-path>` | Set this topic's working directory (resets its session) |
| `/status` | Show this topic's session id and cwd |
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
  — reference it in your next message. (Telegram caps bot downloads at 20 MB.)
- **Claude → you.** Anything Claude places in `<topic-dir>/outbox/` is delivered to
  the topic after the run, then moved to `outbox/.sent/` so it isn't sent twice.
  A one-line hint (`TG_BRIDGE_HINT`, on by default) tells Claude this convention,
  so "send me the report" just works. You can also pull a file yourself with
  `/get <path>` (relative to the topic's directory, or absolute). Bot uploads are
  capped at 50 MB.

## Config

All keys live in `.env` (see [.env.example](.env.example)). Highlights:

- `TG_WORKDIR` — default directory Claude runs in (override per topic with `/cwd`).
- `TG_PERMISSION_MODE` — `acceptEdits` (default) or `bypass` for full autonomy
  (`--dangerously-skip-permissions`). The CLI can't prompt you over Telegram, so
  it must be pre-authorized. Only loosen this on a server you trust.
- `TG_ALLOWED_TOOLS` — tools auto-approved in `acceptEdits` mode.
- `TG_REQUIRE_MENTION` — in groups, only answer when @mentioned.

## Security

The bot is publicly addressable. Access is gated on the **sender's** user id
(never the room), so only ids in `TG_ALLOWED_USERS` are served; everyone else is
dropped. `/whoami` is the only ungated command and reveals only the caller's own
ids. Anyone you allowlist can run tools on your server — allowlist only yourself
and people you fully trust.
