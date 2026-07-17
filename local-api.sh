#!/usr/bin/env bash
# Run a local Telegram Bot API server, so the bridge can move files bigger than
# the cloud API's 20 MB fetch / 50 MB upload caps (local: no download cap, 2000 MB up).
#
#   ./local-api.sh up        # start the container
#   ./local-api.sh status    # is it up? is the bot bound to it?
#   ./local-api.sh migrate   # ONE-WAY-ish: log the bot out of the cloud API
#   ./local-api.sh down      # stop the container
#
# Why this is a separate, opt-in step rather than something start.sh just does:
#
#   * A bot can only talk to ONE API server. To bind it to this one you must call
#     logOut on the cloud API first, and Telegram then refuses to let it back onto
#     the cloud for 10 MINUTES. It is a standing posture for the whole deployment,
#     not a per-file toggle — which is why `migrate` asks before it fires.
#   * file_ids are not portable between the cloud and a local server. Ids minted
#     before the move stop resolving after it.
#
# We run the tdlight fork, not tdlib/telegram-bot-api: the upstream server keeps
# every downloaded file in RAM forever (tdlib/telegram-bot-api#514), which will
# OOM a small box after a couple of large files. tdlight holds memory constant.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAME="${TG_LOCAL_API_NAME:-tg-bot-api}"
PORT="${TG_LOCAL_API_PORT:-8081}"
DATA="${TG_LOCAL_API_DATA:-$DIR/state/bot-api}"
IMAGE="${TG_LOCAL_API_IMAGE:-tdlight/tdlightbotapi:latest}"

[ -f "$DIR/.env" ] && set -a && . "$DIR/.env" && set +a || true

need() { command -v "$1" >/dev/null 2>&1 || { echo "ERROR: $1 not on PATH" >&2; exit 1; }; }

case "${1:-up}" in
  up)
    need docker
    : "${TG_API_ID:?set TG_API_ID in .env — get one at https://my.telegram.org/apps}"
    : "${TG_API_HASH:?set TG_API_HASH in .env — get one at https://my.telegram.org/apps}"
    if docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
      echo "Already running: $NAME  (http://localhost:$PORT)"; exit 0
    fi
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    mkdir -p "$DATA"
    # --local makes getFile return an absolute path on this disk instead of a URL;
    # bridge.ts reads it directly. The bind mount is what makes that path visible
    # to the bridge, so host and container must agree on it.
    docker run -d --name "$NAME" --restart unless-stopped \
      -p "127.0.0.1:$PORT:8081" \
      -v "$DATA:$DATA" \
      -e TELEGRAM_API_ID="$TG_API_ID" \
      -e TELEGRAM_API_HASH="$TG_API_HASH" \
      -e TELEGRAM_LOCAL=1 \
      -e TELEGRAM_WORK_DIR="$DATA" \
      "$IMAGE" >/dev/null
    for i in $(seq 1 30); do
      # Any HTTP answer means it's listening; 404 on / is a healthy server.
      curl -sf -o /dev/null "http://localhost:$PORT/" && break
      curl -s -o /dev/null "http://localhost:$PORT/" && break
      sleep 1
    done
    echo "Started $NAME → http://localhost:$PORT  (files under $DATA)"
    echo
    echo "Next: put this in $DIR/.env"
    echo "    TG_API_ROOT=http://localhost:$PORT"
    echo "then, if the bot has never been migrated:  ./local-api.sh migrate"
    ;;

  status)
    docker ps --filter "name=$NAME" --format 'container: {{.Names}} {{.Status}}' || true
    docker ps --format '{{.Names}}' | grep -qx "$NAME" || echo "container: not running"
    echo "TG_API_ROOT=${TG_API_ROOT:-(unset — bridge is on the cloud API)}"
    if [ -n "${TELEGRAM_BOT_TOKEN:-}" ]; then
      echo -n "cloud getMe : "; curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getMe" | head -c 200; echo
      echo -n "local getMe : "; curl -s "http://localhost:$PORT/bot$TELEGRAM_BOT_TOKEN/getMe" | head -c 200; echo
    fi
    ;;

  migrate)
    : "${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN not set (is .env there?)}"
    cat <<EOF
This logs the bot OUT of the cloud Bot API so it can bind to the local server.

  * The bot CANNOT return to the cloud API for 10 minutes.
  * file_ids issued by the cloud API stop resolving afterwards.
  * Every deployment using this token is affected — it is per-bot, not per-host.

Only do this if you intend to keep running the local server.
EOF
    read -r -p "Type the bot's username to confirm: " answer
    me="$(curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getMe" | grep -oP '"username":"\K[^"]+' || true)"
    [ -n "$me" ] || { echo "Could not reach the cloud API to identify the bot; aborting." >&2; exit 1; }
    [ "$answer" = "$me" ] || { echo "Got '$answer', expected '$me' — aborting, nothing changed." >&2; exit 1; }
    echo -n "logOut: "; curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/logOut"; echo
    echo "Done. Set TG_API_ROOT=http://localhost:$PORT in .env and restart the bridge."
    ;;

  down)
    docker rm -f "$NAME" >/dev/null 2>&1 && echo "Stopped $NAME." || echo "$NAME was not running."
    echo "Remember to unset TG_API_ROOT in .env — and note the bot needs ./local-api.sh"
    echo "to stay up unless you move it back to the cloud (close + wait 10 min)."
    ;;

  *) echo "usage: $0 {up|status|migrate|down}" >&2; exit 2 ;;
esac
