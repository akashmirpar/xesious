# Tier 3 — staging end-to-end tests (real Telegram)

Tiers 1 and 2 (`bun test`) fake Telegram entirely. Tier 3 is the real thing: an
**isolated staging bot**, driven over actual Telegram by a **dedicated user account**,
so the MTProto transport, the real bridge process, and `tmux`/startup are all
exercised. The model layer stays deterministic by default (the staging bridge's
`CLAUDE_BIN` points at `test/claude-stub.ts`), so replies are stable and assertable.

## Why a user account (not a bot)

Bots never receive other bots' messages, so a second bot can't drive the bridge. The
test client must be a **user** account, logged in over MTProto (Telethon). This is the
one part that needs credentials only you can provide.

## One-time setup

1. **A separate staging bot.** In [@BotFather](https://t.me/BotFather) create a *new*
   bot (not your production one) and copy its token → `STAGING_BOT_TOKEN`. Note its
   `@username` → `STAGING_BOT_USERNAME`.

2. **A dedicated test account.** Use a **secondary Telegram account, not your main one** —
   user-account automation carries a real ban risk (flooding / repeated logins trip
   Telegram's anti-spam). A cheap second number is the safe move.

3. **API credentials** for that account: log in at <https://my.telegram.org/apps> and
   copy `api_id` / `api_hash` → `TG_API_ID` / `TG_API_HASH`. (Same pair `local-api.sh`
   already uses.)

4. **A StringSession** (a portable login token for the account). Install Telethon
   first — a venv is cleanest (needs `sudo apt install python3.12-venv` on Debian/
   Ubuntu, which ship venv separately):
   ```bash
   python3 -m venv test/staging/.venv && . test/staging/.venv/bin/activate
   pip install -r test/staging/requirements.txt
   # No venv / no sudo? Install into an isolated dir and export PYTHONPATH instead:
   #   pip3 install --target test/staging/.deps telethon
   #   export PYTHONPATH="$PWD/test/staging/.deps"
   python3 test/staging/gen_session.py     # asks for phone + the code Telegram sends
   ```
   It prints `TEST_ACCOUNT_USER_ID` and `TG_TEST_SESSION`.
   **Keep `TG_TEST_SESSION` secret** — it is full access to that account.

5. **Fill in the env:**
   ```bash
   cp test/staging/.env.staging.example test/staging/.env.staging
   # paste the five values from steps 1–4 into it
   ```
   `.env.staging` and `*.session` are gitignored — they never get committed.

## Run

```bash
. test/staging/.venv/bin/activate        # if you used a venv
test/staging/run-staging.sh              # deterministic (stub CLI), real Telegram
STAGING_REAL_CLAUDE=1 test/staging/run-staging.sh   # against the real claude CLI

# While developing one feature, run only its test — the real-CLI cases each cost
# real turns and real minutes, so re-running all of them per iteration is the main
# thing that makes this tier feel slow. It prints what it skipped.
STAGING_ONLY=interrupt STAGING_REAL_CLAUDE=1 test/staging/run-staging.sh
# Comma-separated for a set — one fix often spans several cases, and running them
# one invocation at a time reboots the bridge each round.
STAGING_ONLY=rtl,usage,album STAGING_REAL_CLAUDE=1 test/staging/run-staging.sh
```

`run-staging.sh` boots an isolated bridge (`state/staging/`, its own tmux session),
waits until it logs `polling Telegram`, runs `driver.py`, asserts on the replies, and
tears the bridge down. Exit code is non-zero if any case fails — so it can gate a deploy.

## What it checks

The default (stub) cases mirror `test/claude-stub.ts`: a normal reply (`okReply`), an
empty result (`empty response`), and an error (`boom`) — round-tripped through real
Telegram. Add cases in `driver.py`'s `CASES` list. Real-claude mode runs the async
functions in `FEATURE_TESTS`, each driving a multi-step flow and asserting on replies,
entities and/or the filesystem.

### What only this tier can prove

Several cases exist because tiers 1 and 2 fake Telegram and therefore *cannot* see the
thing that broke:

| Case | The fact only real Telegram settles |
|---|---|
| `unicode_topic_directories` | A **real** forum topic is what makes Telegram send the `forum_topic_created` service message the bridge derives a directory from — and the directory it then creates is on the real filesystem. Also checks the production symptom directly: a file made in one Persian topic comes back to *that* topic. |
| `long_answer_is_one_album` | `grouped_id` is assigned by the **server**; whether a caption's markup became *entities* or stayed characters is a parsing result, not an API argument. |
| `rtl_answer_stays_rich` | A rich message arrives with `.message` empty and its content in `.rich_message`. Nothing else distinguishes rich from MarkdownV2. |
| `rtl_answer_file_reads_correctly` | Downloads the `.html` Telegram actually delivered and reads what is in it. |
| `usage_refreshes_in_place` | "Same message id, changed text" is a server-side fact, and Telegram's `message is not modified` rejection is only reachable against the real API. |
| `run_alongside` / `promoted_run_keeps_the_topics_session` | A real inline-keyboard **tap** is the only thing that produces the callback the promotion runs on — tier 2 hand-builds that update — and the real CLI is the only thing that mints a real forked session id, which tier 2 has to stub. The second case then asks the topic itself whether it remembers what was said inside the fork, which is the harm a state file cannot show. |
| `sessions_picker` | A callback button is the only in-chat tap that carries a payload back to the bot, so the picker cannot be exercised any other way. |

## Notes / caveats

- The staging bot needs its own token bound to the **cloud** Bot API (don't point it
  at the local Bot API server unless you also set `TG_API_ROOT`).
- Keep the message rate low; the driver sends a few messages per run to stay well under
  Telegram's limits and the account-ban threshold.
- This tier needs live secrets, so it is **not** part of `bun test` and should run
  on-demand / as a deploy gate, not on every push.
