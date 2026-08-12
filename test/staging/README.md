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
```

`run-staging.sh` boots an isolated bridge (`state/staging/`, its own tmux session),
waits until it logs `polling Telegram`, runs `driver.py`, asserts on the replies, and
tears the bridge down. Exit code is non-zero if any case fails — so it can gate a deploy.

## What it checks

The default (stub) cases mirror `test/claude-stub.ts`: a normal reply (`okReply`), an
empty result (`empty response`), and an error (`boom`) — round-tripped through real
Telegram. Add cases in `driver.py`'s `CASES` list. The real-claude mode sends a single
compliance prompt and checks for `PONG`.

## Notes / caveats

- The staging bot needs its own token bound to the **cloud** Bot API (don't point it
  at the local Bot API server unless you also set `TG_API_ROOT`).
- Keep the message rate low; the driver sends a few messages per run to stay well under
  Telegram's limits and the account-ban threshold.
- This tier needs live secrets, so it is **not** part of `bun test` and should run
  on-demand / as a deploy gate, not on every push.
