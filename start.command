#!/usr/bin/env bash
# Double-click to start. First run downloads what is missing (Node.js, adb) into ./tools - no admin rights needed.
cd "$(dirname "$0")"
set -e
# apps launched from Finder get a minimal PATH; add the usual Homebrew/installer locations
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

NODE_BIN="$(command -v node || true)"
TOOLS="${TOOLS_DIR:-${DATA_DIR:-$PWD}/tools}"
export TOOLS_DIR="$TOOLS"
LOCAL_NODE="$TOOLS/node/bin/node"
if [ -x "$LOCAL_NODE" ]; then NODE_BIN="$LOCAL_NODE"; fi

# Node 18+ required
if [ -n "$NODE_BIN" ]; then
  MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$MAJOR" -lt 18 ]; then NODE_BIN=""; fi
fi

if [ -z "$NODE_BIN" ]; then
  echo "Node.js not found - downloading a private copy (about 45 MB, one time)..."
  case "$(uname -m)" in arm64) ARCH=arm64 ;; *) ARCH=x64 ;; esac
  BASE="https://nodejs.org/dist/latest-v22.x"
  mkdir -p "$TOOLS"
  FILE="$(curl -fsSL "$BASE/SHASUMS256.txt" | awk -v a="darwin-$ARCH.tar.gz" '$2 ~ a"$" {print $2}')"
  EXPECT="$(curl -fsSL "$BASE/SHASUMS256.txt" | awk -v f="$FILE" '$2==f {print $1}')"
  curl -fL -o "$TOOLS/node.tar.gz" "$BASE/$FILE"
  echo "$EXPECT  $TOOLS/node.tar.gz" | shasum -a 256 -c - >/dev/null || { echo "Checksum mismatch - aborting."; rm -f "$TOOLS/node.tar.gz"; exit 1; }
  rm -rf "$TOOLS/node" && mkdir "$TOOLS/node"
  tar -xzf "$TOOLS/node.tar.gz" -C "$TOOLS/node" --strip-components=1
  rm "$TOOLS/node.tar.gz"
  NODE_BIN="$LOCAL_NODE"
fi

# adb: skip if one is already available (PATH, Android SDK, Unity's bundled SDK or ./tools)
if ! command -v adb >/dev/null 2>&1 \
   && [ ! -x "$TOOLS/platform-tools/adb" ] \
   && [ ! -x "$HOME/Library/Android/sdk/platform-tools/adb" ] \
   && ! ls /Applications/Unity/Hub/Editor/*/PlaybackEngines/AndroidPlayer/SDK/platform-tools/adb >/dev/null 2>&1; then
  ./setup-adb.sh
fi

AUTO_QUIT="${AUTO_QUIT:-}" exec "$NODE_BIN" server.js
