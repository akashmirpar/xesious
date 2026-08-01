#!/usr/bin/env python3
"""
One-time login for the Tier 3 staging driver. Run this ONCE, interactively, to turn
a phone-number login into a portable StringSession.

    export PYTHONPATH="$PWD/test/staging/.deps"      # if you used the pip --target path
    python3 test/staging/gen_session.py

It reads TG_API_ID / TG_API_HASH from test/staging/.env.staging (or the environment,
or prompts), asks for the phone number + the login code Telegram sends (and 2FA
password if set), then writes TEST_ACCOUNT_USER_ID and TG_TEST_SESSION straight back
into .env.staging — so the secret session never has to be copied by hand.

USE A DEDICATED TEST ACCOUNT — automation carries a real ban risk, and the session
string grants full control of whatever account you log in with.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ENVF = os.path.join(HERE, ".env.staging")


def load_envfile(path):
    d = {}
    if os.path.exists(path):
        with open(path) as f:
            for line in f:
                s = line.strip()
                if not s or s.startswith("#") or "=" not in s:
                    continue
                k, v = s.split("=", 1)
                d[k.strip()] = v.strip()
    return d


def update_envfile(path, updates):
    """Rewrite the given keys in place (append if absent), preserving other lines."""
    out, seen = [], set()
    if os.path.exists(path):
        with open(path) as f:
            for raw in f:
                s = raw.strip()
                key = s.split("=", 1)[0].strip() if ("=" in s and not s.startswith("#")) else None
                if key in updates:
                    out.append(f"{key}={updates[key]}\n")
                    seen.add(key)
                else:
                    out.append(raw if raw.endswith("\n") else raw + "\n")
    for k, v in updates.items():
        if k not in seen:
            out.append(f"{k}={v}\n")
    with open(path, "w") as f:
        f.writelines(out)


try:
    from telethon.sync import TelegramClient
    from telethon.sessions import StringSession
except ImportError:
    sys.exit("telethon not installed — pip install --target test/staging/.deps telethon "
             "(then: export PYTHONPATH=\"$PWD/test/staging/.deps\")")


def main():
    cfg = load_envfile(ENVF)
    api_id = os.environ.get("TG_API_ID") or cfg.get("TG_API_ID") or input("api_id: ").strip()
    api_hash = os.environ.get("TG_API_HASH") or cfg.get("TG_API_HASH") or input("api_hash: ").strip()
    if not api_id or not api_hash:
        sys.exit("need TG_API_ID and TG_API_HASH — put them in .env.staging or the environment")

    print("\nLogging in — Telegram sends a code to the account you enter.")
    print("Use your DEDICATED test account, not your main one.\n")
    with TelegramClient(StringSession(), int(api_id), api_hash) as client:
        me = client.get_me()
        session = client.session.save()

    update_envfile(ENVF, {"TEST_ACCOUNT_USER_ID": str(me.id), "TG_TEST_SESSION": session})
    print("\n" + "=" * 72)
    print(f"Logged in as {me.username or me.first_name} (id {me.id}).")
    print(f"Wrote TEST_ACCOUNT_USER_ID and TG_TEST_SESSION into {ENVF}")
    print("That file is gitignored — the session stays only there. Keep it secret.")
    print("=" * 72)


if __name__ == "__main__":
    main()
