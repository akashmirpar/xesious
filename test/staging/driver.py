#!/usr/bin/env python3
"""
Tier 3 staging driver: a Telegram USER client that drives the staging bridge over
REAL Telegram and asserts on the bot's replies.

Why a user account and not a bot: bots never receive other bots' messages, so a bot
could not talk to the bridge. This logs in as the dedicated test account (via the
StringSession from gen_session.py), DMs the staging bot, and checks what comes back.

Deterministic by default: run-staging.sh points the staging bridge's CLAUDE_BIN at
test/claude-stub.ts, so the model layer is canned and replies are stable ("okReply").
Set STAGING_REAL_CLAUDE=1 to instead exercise the real `claude` with a compliance
prompt (a looser, non-hermetic smoke test).

Env (set by run-staging.sh from .env.staging):
    TG_API_ID, TG_API_HASH, TG_TEST_SESSION   — the user client's credentials
    STAGING_BOT_USERNAME                       — @username of the staging bot to DM
    STAGING_REPLY_TIMEOUT                       — seconds to wait per reply (default 60)
    STAGING_REAL_CLAUDE                         — "1" to test against real claude
"""
import asyncio
import os
import sys

try:
    from telethon import TelegramClient, events
    from telethon.sessions import StringSession
except ImportError:
    sys.exit("telethon not installed — pip install -r test/staging/requirements.txt")


def env(name, required=True, default=None):
    v = os.environ.get(name, default)
    if required and not v:
        sys.exit(f"[driver] missing env {name}")
    return v


API_ID = int(env("TG_API_ID"))
API_HASH = env("TG_API_HASH")
SESSION = env("TG_TEST_SESSION")
BOT = env("STAGING_BOT_USERNAME")
TIMEOUT = float(env("STAGING_REPLY_TIMEOUT", required=False, default="60"))
REAL_CLAUDE = env("STAGING_REAL_CLAUDE", required=False, default="") in ("1", "true", "yes")

# Stub mode: single-turn (prompt, expected-substring), mirroring claude-stub.ts.
CASES = [
    ("hello staging", "okReply"),   # claude-stub default success reply
    ("EMPTY", "empty response"),    # stub emits an empty result
    ("ERROR", "boom"),              # stub emits is_error with text "boom"
]

# Real-claude features are exercised by the async functions in FEATURE_TESTS (defined
# after send_and_wait). Each drives a real multi-step flow over Telegram and asserts
# on replies and/or the filesystem, returning (name, passed, detail).


def is_status(text: str) -> bool:
    """The bridge's transient '💭 Thinking…' status (or an empty/blank line), not an answer."""
    return (not text.strip()) or ("thinking" in text.lower()) or text.strip().startswith("💭")


def rich_text(msg) -> str:
    """Flatten a Bot API 10.1 rich message into plain text, or '' if it isn't one.

    A rich reply arrives with `.message` EMPTY and its content in `.rich_message`, a
    tree of Instant-View PageBlocks. Read it here or the whole rich path — every
    table, formula and task list the bridge sends — is invisible to this tier and
    reads as a timeout. Walks the to_dict() form rather than enumerating the
    PageBlock*/RichText* subclasses, so a block type we haven't seen still yields
    its text.
    """
    rm = getattr(msg, "rich_message", None)
    if not rm:
        return ""
    out = []

    def walk(o):
        if isinstance(o, str):
            out.append(o)
        elif isinstance(o, dict):
            for k, v in o.items():
                if k != "_":            # the type marker, not content
                    walk(v)
        elif isinstance(o, (list, tuple)):
            for v in o:
                walk(v)

    walk(rm.to_dict() if hasattr(rm, "to_dict") else rm)
    return " ".join(t for t in out if t.strip())


def reply_text(msg) -> str:
    """What the user actually sees, whichever transport the bridge chose."""
    return (msg.message or "") or rich_text(msg)


async def send_and_wait(client, bot, prompt: str):
    replies = []
    got = asyncio.Event()

    @client.on(events.NewMessage(from_users=bot))
    async def handler(ev):
        t = reply_text(ev.message)
        if is_status(t):
            return
        replies.append(t)
        got.set()

    await client.send_message(bot, prompt)
    try:
        await asyncio.wait_for(got.wait(), TIMEOUT)
    except asyncio.TimeoutError:
        pass
    client.remove_event_handler(handler)
    return replies


def topic_cwd():
    """Where the bridge runs claude for this test account's DM — we can inspect it
    directly since the staging bridge is on this same machine."""
    base, uid = os.environ.get("TG_SESSIONS_BASE"), os.environ.get("TEST_ACCOUNT_USER_ID")
    return os.path.join(base, f"dm-{uid}") if base and uid else None


async def _show(client, bot, prompt):
    print(f"  → {prompt}")
    replies = await send_and_wait(client, bot, prompt)
    print(f"    ← {replies}")
    return replies


async def feature_mode_enforcement(client, bot):
    """The /mode feature must actually be ENFORCED by Claude, not just stored:
    in `plan` (read-only) Claude must NOT write a file; after switching to `auto`
    the same request must write it. Verified on disk in the topic's cwd."""
    cwd = topic_cwd()
    canary = os.path.join(cwd, "canary.txt") if cwd else None

    def rm_canary():
        if canary and os.path.exists(canary):
            os.remove(canary)

    rm_canary()  # start clean regardless of any prior run
    print(f"  (topic cwd: {cwd})")
    try:
        await _show(client, bot, "/mode plan")
        await _show(client, bot,
                   "Create a file named canary.txt in your current working directory, "
                   "with the exact contents HELLO. Write it to disk now.")
        plan_blocked = not (canary and os.path.exists(canary))
        print(f"    [check] after PLAN: canary.txt exists = {not plan_blocked} (want False)")

        await _show(client, bot, "/mode auto")
        await _show(client, bot,
                   "Now actually create canary.txt in your current working directory, "
                   "with the exact contents HELLO. Write it to disk.")
        auto_wrote = bool(canary and os.path.exists(canary))
        print(f"    [check] after AUTO: canary.txt exists = {auto_wrote} (want True)")

        detail = f"plan blocked the write = {plan_blocked}; auto performed the write = {auto_wrote}"
        return ("/mode enforcement (plan read-only → refuses; auto → writes)",
                plan_blocked and auto_wrote, detail)
    finally:
        rm_canary()  # clean up the artifact we created — leave the disk as we found it


async def feature_rich_table(client, bot):
    """A table must arrive as a NATIVE rich message with its cells and its prices
    intact. Covers both halves of the rich-messages work: needsRich routing a table
    to sendRichMessage, and escapeMoneyDollars stopping Telegram from pairing the
    dollar signs and eating everything between two prices as a LaTeX span."""
    prompt = (
        "Reply with ONLY a markdown table, no preamble and no commentary. "
        "Three columns: Item, Price, Note. Three rows exactly: "
        "Widget with price $390B and note the $5B/year figure; "
        "Gadget with price $467,095 and note approximately $50 each; "
        "Doohickey with price $12 and note none."
    )
    replies = await _show(client, bot, prompt)
    blob = " ".join(replies)

    missing = [c for c in ("Item", "Price", "Widget", "Gadget", "Doohickey", "390B", "467,095")
               if c not in blob]
    dollars = blob.count("$")
    leaked = "\\$" in blob
    ok = not missing and dollars >= 4 and not leaked
    detail = (f"missing cells={missing or 'none'}; '$' surviving={dollars} (want >=4); "
              f"visible '\\$' escape leaked={leaked}")
    return ("rich table delivered natively, cells and prices intact", ok, detail)


FEATURE_TESTS = [feature_mode_enforcement, feature_rich_table]


async def main():
    client = TelegramClient(StringSession(SESSION), API_ID, API_HASH)
    await client.connect()
    if not await client.is_user_authorized():
        sys.exit("[driver] session not authorized — regenerate with gen_session.py")
    me = await client.get_me()
    print(f"[driver] logged in as {me.username or me.id}; mode={'REAL claude' if REAL_CLAUDE else 'stub'}")
    bot = await client.get_entity(BOT)

    failures = total = 0
    if REAL_CLAUDE:
        for t in FEATURE_TESTS:
            total += 1
            name, ok, detail = await t(client, bot)
            print(f"[{'PASS' if ok else 'FAIL'}] {name}")
            print(f"    {detail}")
            if not ok:
                failures += 1
    else:
        for prompt, expect in CASES:
            total += 1
            replies = await send_and_wait(client, bot, prompt)
            ok = any(expect in r for r in replies)
            print(f"[{'PASS' if ok else 'FAIL'}] prompt={prompt!r} expect~{expect!r} got={replies}")
            if not ok:
                failures += 1

    await client.disconnect()
    print(f"[driver] {total - failures}/{total} passed")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    asyncio.run(main())
