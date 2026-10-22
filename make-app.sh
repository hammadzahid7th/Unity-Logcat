#!/usr/bin/env bash
# Builds "Unity Logcat PM.app" (double-click app) + a zip to share. Run on a Mac.
set -e
cd "$(dirname "$0")"
NAME="Unity Logcat PM"
OUT="dist/$NAME.app"
rm -rf dist && mkdir -p "$OUT/Contents/MacOS" "$OUT/Contents/Resources/app"

cp -R server.js package.json README.md lib public unity start.command setup-adb.sh "$OUT/Contents/Resources/app/"

cat > "$OUT/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>$NAME</string>
  <key>CFBundleDisplayName</key><string>$NAME</string>
  <key>CFBundleIdentifier</key><string>dev.unitylogcatpm.app</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleExecutable</key><string>launcher</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
</dict></plist>
PLIST

cat > "$OUT/Contents/MacOS/launcher" <<'LAUNCH'
#!/bin/bash
APP="$(cd "$(dirname "$0")/../Resources/app" && pwd)"
export DATA_DIR="$HOME/Library/Application Support/UnityLogcatPM"
mkdir -p "$DATA_DIR"
URL="http://localhost:7878"
notify() { osascript -e "display notification \"$1\" with title \"Unity Logcat PM\"" >/dev/null 2>&1; }

# already running: just open the page
if curl -s -m 2 -o /dev/null "$URL/api/sessions"; then open "$URL"; exit 0; fi

notify "Starting... the first launch downloads tools and takes about a minute."
cd "$APP"
AUTO_QUIT=1 nohup ./start.command > "$DATA_DIR/app.log" 2>&1 &

# if it is not up after 4 minutes, tell the user instead of failing silently
( sleep 240; curl -s -m 2 -o /dev/null "$URL/api/sessions" || notify "Could not start. Check internet and try again. Log: ~/Library/Application Support/UnityLogcatPM/app.log" ) >/dev/null 2>&1 &
exit 0
LAUNCH
chmod +x "$OUT/Contents/MacOS/launcher" "$OUT/Contents/Resources/app/start.command" "$OUT/Contents/Resources/app/setup-adb.sh"

(cd dist && ditto -c -k --keepParent "$NAME.app" "Unity-Logcat-PM-mac.zip")
echo "Built: dist/$NAME.app and dist/Unity-Logcat-PM-mac.zip"
