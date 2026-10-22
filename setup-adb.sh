#!/usr/bin/env bash
# Downloads Google's official Android platform-tools (adb) into ./tools. No admin rights needed.
set -e
cd "$(dirname "$0")"
TOOLS="${TOOLS_DIR:-${DATA_DIR:-$PWD}/tools}"
mkdir -p "$TOOLS"
case "$(uname -s)" in
  Darwin) OS=darwin ;;
  Linux)  OS=linux ;;
  *) echo "Unsupported OS"; exit 1 ;;
esac
echo "Downloading platform-tools ($OS) from dl.google.com ..."
curl -fL -o "$TOOLS/platform-tools.zip" "https://dl.google.com/android/repository/platform-tools-latest-$OS.zip"
unzip -oq "$TOOLS/platform-tools.zip" -d "$TOOLS"
rm "$TOOLS/platform-tools.zip"
echo "adb ready: $TOOLS/platform-tools/adb"
