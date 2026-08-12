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
    ("EMPTY", "No answer came back"),  # empty result -> reported as a failed turn
    ("NORESP", "No answer came back"),  # the CLI queue artefact, never shown verbatim
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


async def send_and_wait_messages(client, bot, prompt: str):
    """Like send_and_wait, but hands back the Message objects. Needed wherever the
    assertion is about how Telegram PARSED the reply (entities) rather than about
    the characters in it — a strikethrough that should not exist is invisible in
    the text and obvious in the entity list."""
    msgs = []
    got = asyncio.Event()

    @client.on(events.NewMessage(from_users=bot))
    async def handler(ev):
        if is_status(reply_text(ev.message)):
            return
        msgs.append(ev.message)
        got.set()

    await client.send_message(bot, prompt)
    try:
        await asyncio.wait_for(got.wait(), TIMEOUT)
    except asyncio.TimeoutError:
        pass
    client.remove_event_handler(handler)
    return msgs


async def send_and_wait(client, bot, prompt: str):
    return [reply_text(m) for m in await send_and_wait_messages(client, bot, prompt)]


async def send_and_collect(client, bot, prompt: str, settle: float = 8.0):
    """Collect EVERY message the turn produces, not just the first.

    send_and_wait_messages returns as soon as one reply arrives and removes its
    handler, so anything after that is invisible to it — which silently breaks any
    assertion about a turn that sends more than one message (a promoted mid-turn
    answer followed by its sign-off, say). This waits for the first reply and then
    for the stream to go quiet for `settle` seconds."""
    msgs = []
    last = asyncio.get_event_loop().time()

    @client.on(events.NewMessage(from_users=bot))
    async def handler(ev):
        nonlocal last
        if is_status(reply_text(ev.message)):
            return
        msgs.append(ev.message)
        last = asyncio.get_event_loop().time()

    await client.send_message(bot, prompt)
    deadline = asyncio.get_event_loop().time() + TIMEOUT
    while asyncio.get_event_loop().time() < deadline:
        await asyncio.sleep(0.5)
        if msgs and (asyncio.get_event_loop().time() - last) >= settle:
            break
    client.remove_event_handler(handler)
    return msgs


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


async def feature_tilde_prose(client, bot):
    """An "approximately-a-price" tilde in ordinary prose must arrive as a literal
    tilde — not as a strikethrough that swallows the sentence and eats the bold.

    Reported three times in eight days, on ordinary prose about money. This is the
    end-to-end proof: it asserts on the ENTITIES Telegram returns, because the bug
    is invisible in the message text. Before the fix, Telegram came back with a
    real `strikethrough` entity spanning the text between the two tildes, and the
    bold delimiters arrived as literal asterisks."""
    # Ask for the emphasis SEMANTICALLY rather than pasting `**` into the prompt.
    # A first version pasted the markdown and the model reproduced the sentence
    # without it, so the bold assertion was measuring the model's compliance rather
    # than the bridge's formatting — the tilde half passed while bold "failed" for
    # a reason that had nothing to do with the bug.
    prompt = (
        "Reply with ONLY the following sentence, no preamble and no commentary. "
        "Render the phrase '~$8bn of gasoline imports' in bold, and keep every other "
        "character exactly as written:\n"
        "gasoline output down to ~110m litres/day. Holding consumption flat means "
        "~$8bn of gasoline imports — more than the entire military budget."
    )
    print(f"  → {prompt.splitlines()[-1][:70]}…")
    msgs = await send_and_wait_messages(client, bot, prompt)
    if not msgs:
        return ("tilde in prose stays literal, no strikethrough", False, "no reply within timeout")

    msg = msgs[-1]
    text = reply_text(msg)
    print(f"    ← {text[:110]!r}")
    kinds = [type(e).__name__ for e in (msg.entities or [])]
    print(f"    entities: {kinds or 'none'}")

    problems = []
    # The whole point: no strikethrough may exist anywhere in the reply.
    if any("Strike" in k for k in kinds):
        problems.append("Telegram parsed a STRIKETHROUGH — the tilde bug is back")
    for want in ("~110m", "~$8bn"):
        if want not in text:
            problems.append(f"{want!r} did not survive as literal text")
    # The bold was collateral damage: the stray strikethrough overlapped it, so the
    # emphasis could not form and the delimiters were emitted as text.
    if "**" in text:
        problems.append("literal '**' in the delivered text — the bold was destroyed")
    if not any("Bold" in k for k in kinds):
        problems.append("no bold entity — the emphasis did not render")

    ok = not problems
    return ("tilde in prose stays literal, no strikethrough",
            ok, "; ".join(problems) if problems else f"entities={kinds}, both tildes literal, bold intact")


async def feature_midturn_text(client, bot):
    """A turn that answers, keeps working, then signs off must deliver the ANSWER —
    not just the sign-off.

    This is the shape behind "I get unrelated answers": the substance is written
    mid-turn and the bridge delivered only the closing block, so the reply read as
    evasive precisely because it was a summary of a conversation whose content had
    been deleted. Measured across every transcript on disk: 48% of turns that
    produced text produced more than one block."""
    prompt = (
        "Do exactly these three things, in this order, and nothing else. "
        "(1) Write one paragraph of at least 300 characters about why the number 42 is famous. "
        "(2) Then run the shell command `echo checked` with Bash. "
        "(3) Then, as your final message, reply with only this sentence: "
        "I'll report back when it lands."
    )
    print("  → (answer, then a tool call, then a sign-off)")
    # The promoted answer and the sign-off are SEPARATE messages, so collect until
    # the turn goes quiet rather than returning on the first one.
    msgs = await send_and_collect(client, bot, prompt)
    texts = [reply_text(m) for m in msgs]
    for t in texts:
        print(f"    ← {t[:90]!r}")

    joined = " ".join(texts)
    problems = []
    if not any(len(t) >= 250 for t in texts):
        problems.append("no substantive block was delivered — only the sign-off survived")
    if "report back" not in joined.lower():
        problems.append("the closing sign-off never arrived")
    ok = not problems
    return ("mid-turn answer is delivered, not just the sign-off",
            ok, "; ".join(problems) if problems else
            f"{len(texts)} message(s), longest {max((len(t) for t in texts), default=0)}ch")


FEATURE_TESTS = [feature_mode_enforcement, feature_rich_table, feature_tilde_prose, feature_midturn_text]


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
