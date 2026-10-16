#!/usr/bin/env python3
"""
Tier 3, two bots: hand-offs between two xesious bridges over real Telegram.

run-peers.sh starts the two bridges: A (the staging bot) and B (a second bot), in the
staging group, each listing the other as a peer, both on the stub CLI. This logs in
as the test account, makes two topics, and in each asks one bot (by name) to hand
work to the other through the stub's MCPTASK scenario. For each hand-off it checks
what the bots post:

  1. the sending bot's message in the other topic, naming the other bot, with a
     #handoff-… tag;
  2. the other bot's "✅ #handoff-… done" reply to that message;
  3. the sending bot's ➡️ line in the first topic, edited to say ✅ Done.

One case sends a file along and checks it reached the other bridge's inbox.

Env (set by run-peers.sh from .env.staging):
    TG_API_ID, TG_API_HASH, TG_TEST_SESSION        the test account
    STAGING_BOT_USERNAME, STAGING_PEER_BOT_USERNAME  the two bots
    STAGING_GROUP_ID                                the forum group they share
    STAGING_PEERS_BASE                              the bridges' sessions bases
    STAGING_KEEP_TOPICS=1                           leave the topics, to look at
"""
import asyncio
import glob
import json
import os
import re
import sys
import time

try:
    from telethon import TelegramClient, events
    from telethon.sessions import StringSession
    from telethon.tl import functions
except ImportError:
    sys.exit("telethon not installed — pip install -r test/staging/requirements.txt")


def env(name, default=None):
    v = os.environ.get(name, default)
    if not v:
        sys.exit(f"[peers] missing env {name}")
    return v


API_ID = int(env("TG_API_ID"))
API_HASH = env("TG_API_HASH")
SESSION = env("TG_TEST_SESSION")
A = env("STAGING_BOT_USERNAME").lstrip("@")
B = env("STAGING_PEER_BOT_USERNAME").lstrip("@")
GROUP = int(env("STAGING_GROUP_ID"))
TIMEOUT = float(os.environ.get("STAGING_REPLY_TIMEOUT") or "60")
BASE = env("STAGING_PEERS_BASE")
KEEP = os.environ.get("STAGING_KEEP_TOPICS", "") in ("1", "true", "yes")

seen = []      # every new message in the group, as it arrives
edits = []     # every edit, newest last
created = []   # the topics this run made


def topic_of(m):
    """Which forum topic a message is in."""
    r = getattr(m, "reply_to", None)
    if not r:
        return None
    return getattr(r, "reply_to_top_id", None) or getattr(r, "reply_to_msg_id", None)


def replied_to(m):
    r = getattr(m, "reply_to", None)
    return getattr(r, "reply_to_msg_id", None) if r else None


async def until(fn, secs=TIMEOUT):
    end = time.monotonic() + secs
    while time.monotonic() < end:
        v = fn()
        if v:
            return v
        await asyncio.sleep(0.5)
    return None


async def new_topic(client, title):
    peer = await client.get_input_entity(GROUP)
    res = await client(functions.messages.CreateForumTopicRequest(peer=peer, title=title))
    tid = next((u.message.id for u in res.updates
                if getattr(getattr(u, "message", None), "id", None) and getattr(u.message, "action", None)), None)
    if tid:
        created.append(tid)
    return tid


async def hand_off(client, ids, frm, to, here, there, brief, files=None):
    """Ask @frm, in topic `here`, to hand `brief` to @to in topic `there`."""
    args = {"topic": str(there), "bot": to, "brief": brief}
    if files:
        args["files"] = files
    start, estart = len(seen), len(edits)
    # The mention goes after the JSON: the stub reads the scenario from the first word.
    await client.send_message(GROUP, f"MCPTASK handoff {json.dumps(args)} @{frm}", reply_to=here)
    fid, tid = ids[frm], ids[to]
    out = await until(lambda: next((m for m in seen[start:] if m.sender_id == fid and topic_of(m) == there
                                    and m.raw_text.lower().startswith(f"@{to.lower()}, hand-off from")
                                    and "#handoff-" in m.raw_text), None))
    if not out:
        said = [m.raw_text[:120] for m in seen[start:] if m.sender_id == fid]
        return False, f"@{frm} posted no hand-off naming @{to} in topic {there}" + (f"; it said {said}" if said else "")
    tag = re.search(r"#handoff-([a-z0-9]+)", out.raw_text).group(1)
    print(f"    @{frm} posted hand-off #{tag} in topic {there}")
    done = await until(lambda: next((m for m in seen[start:] if m.sender_id == tid and replied_to(m) == out.id
                                     and m.raw_text.startswith(f"✅ #handoff-{tag} done")), None))
    if not done:
        said = [m.raw_text[:160] for m in seen[start:] if m.sender_id == tid]
        return False, f"@{to} never answered ✅ to #{tag}" + (f"; it said {said}" if said else "; it said nothing")
    print(f"    @{to} answered: {done.raw_text[:100]}")
    line = await until(lambda: next((m for m in reversed(edits[estart:]) if m.sender_id == fid and topic_of(m) == here
                                     and m.raw_text.startswith(f"➡️ Handed to @{to.lower()}") and "✅ Done" in m.raw_text), None))
    if not line:
        return False, f"@{frm}'s ➡️ line in topic {here} never said ✅ Done"
    print(f"    @{frm}'s line: {line.raw_text.splitlines()[-1]}")
    return True, out


async def main():
    client = TelegramClient(StringSession(SESSION), API_ID, API_HASH)
    await client.start()
    ids = {A: (await client.get_entity(A)).id, B: (await client.get_entity(B)).id}

    @client.on(events.NewMessage(chats=GROUP))
    async def on_new(ev):
        seen.append(ev.message)

    @client.on(events.MessageEdited(chats=GROUP))
    async def on_edit(ev):
        edits.append(ev.message)

    results = []
    try:
        x = await new_topic(client, "peer test: A side")
        y = await new_topic(client, "peer test: B side")
        if not x or not y:
            print("[peers] could not make the two topics")
            return 1
        print(f"[peers] topics: A side {x}, B side {y}")
        # Both bridges learn the topics' names from the service messages.
        await asyncio.sleep(3)

        print(f"[peers] case: @{A} hands work to @{B}")
        ok, d = await hand_off(client, ids, A, B, x, y, "Say hello to the B side.")
        results.append((f"@{A} hands work to @{B}, which answers; the line says so", ok, d))

        print(f"[peers] case: @{B} hands work to @{A}")
        ok, d = await hand_off(client, ids, B, A, y, x, "Say hello back to the A side.")
        results.append((f"@{B} hands work to @{A}, the other way", ok, d))

        print("[peers] case: a file goes along")
        path = os.path.join(BASE, "peer-file.txt")
        with open(path, "w") as fh:
            fh.write("MANGO42\n")
        ok, d = await hand_off(client, ids, A, B, x, y, "Read peer-file.txt and say what it holds.", files=[path])
        if ok:
            if "📎 peer-file.txt: http" not in d.raw_text:
                ok, d = False, f"the hand-off carried no link to the file: {d.raw_text[:200]!r}"
            else:
                got = glob.glob(os.path.join(BASE, "b", "sessions", "**", "inbox", "peer-file*.txt"), recursive=True)
                if not got:
                    ok, d = False, "the file never reached the other bridge's inbox"
                elif open(got[0]).read() != "MANGO42\n":
                    ok, d = False, f"the other bridge's copy holds {open(got[0]).read()!r}"
        results.append(("a file handed along lands in the other bridge's inbox", ok, d))
    finally:
        if created and not KEEP:
            peer = await client.get_input_entity(GROUP)
            for tid in created:
                try:
                    await client(functions.messages.DeleteTopicHistoryRequest(peer=peer, top_msg_id=tid))
                except Exception as e:                          # noqa: BLE001
                    print(f"[peers] could not remove topic {tid}: {e}")
        elif created:
            print(f"[peers] kept the topics {created}, to look at")
        await client.disconnect()

    print()
    for name, ok, d in results:
        print(f"  {'PASS' if ok else 'FAIL'}  {name}" + ("" if ok else f"\n        {d}"))
    passed = sum(1 for r in results if r[1])
    print(f"[peers] {passed}/{len(results)} passed")
    return 0 if results and passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
