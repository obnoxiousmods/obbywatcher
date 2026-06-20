#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"
TARGET_DIR="${OBBYWATCHER_DEPLOY_ROOT:-/var/www/live.obnoxious.lol}"
STREAM_DIR="$TARGET_DIR/stream"
OWNER="${OBBYWATCHER_DEPLOY_OWNER:-http:media}"

cd "$ROOT_DIR"

for required_command in npm sudo rsync curl getent id find; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "refusing deploy: missing required command '$required_command'" >&2
    exit 1
  fi
done

npm run build

if [[ ! -d "$DIST_DIR" ]]; then
  echo "dist directory missing after build" >&2
  exit 1
fi

if [[ ! -d "$STREAM_DIR" ]]; then
  echo "refusing deploy: $STREAM_DIR is missing" >&2
  exit 1
fi

sudo install -d -m 0755 "$TARGET_DIR"
sudo rsync -a --delete \
  --exclude '/stream/***' \
  --exclude '/stream' \
  --exclude '*.map' \
  "$DIST_DIR/" "$TARGET_DIR/"

sudo find "$TARGET_DIR" -path "$STREAM_DIR" -prune -o -type d -exec chmod 0755 {} +
sudo find "$TARGET_DIR" -path "$STREAM_DIR" -prune -o -type f -exec chmod 0644 {} +

if getent group "${OWNER#*:}" >/dev/null 2>&1 && id -u "${OWNER%:*}" >/dev/null 2>&1; then
  sudo find "$TARGET_DIR" -path "$STREAM_DIR" -prune -o -exec chown "$OWNER" {} +
fi

sudo test -r "$TARGET_DIR/index.html"
sudo test -r "$TARGET_DIR/assets/$(basename "$(ls -1 "$DIST_DIR"/assets/index-*.js | head -n 1)")"
curl -k --resolve fight.nswfiles.com:443:127.0.0.1 -fsS https://fight.nswfiles.com/ >/dev/null
echo "deployed ObbyWatcher to $TARGET_DIR"
