#!/usr/bin/env bash
# Fake adb for testing the tool without a phone. Usage: ADB=$PWD/test/fake-adb.sh node server.js
DIR="$(cd "$(dirname "$0")" && pwd)"
args="$*"
case "$args" in
  version*) echo "Android Debug Bridge version 1.0.41";;
  "devices -l"*) echo "List of devices attached"; echo "FAKE123   device usb:1-1 product:fake model:Pixel_8 device:fake transport_id:1";;
  *"shell getprop"*) echo "[ro.product.manufacturer]: [Google]"; echo "[ro.product.model]: [Pixel 8]"; echo "[ro.build.version.release]: [15]"; echo "[ro.build.version.sdk]: [35]"; echo "[ro.product.cpu.abi]: [arm64-v8a]";;
  *"cat /proc/meminfo"*) echo "MemTotal:        8000000 kB";;
  *"pidof"*) echo "4321";;
  *"dumpsys meminfo"*) echo "           TOTAL PSS:   $((300000 + RANDOM % 50000))            TOTAL RSS:   500000";;
  *"dumpsys dropbox"*) echo "========================================"; echo "2026-10-22 10:00:40 data_app_anr (text, 100 bytes)"; echo "Cmd line: com.studio.game"; echo '"main" prio=5 tid=1 Blocked'; echo "  at com.studio.game.Foo.bar(Foo.java:10)";;
  *"pm list packages"*) echo "package:com.studio.game";;
  *"dumpsys package"*) echo "    versionCode=12 minSdk=26"; echo "    versionName=1.2.3";;
  *"logcat -c"*) ;;
  *" logcat "*)
    while IFS= read -r line; do echo "$line"; sleep 0.25; done < "$DIR/sample.log"
    sleep 3600;;
  *) echo "Success";;
esac
