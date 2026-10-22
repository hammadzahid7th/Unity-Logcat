# Unity Logcat PM

Standalone test companion for Unity Android builds, made for product managers.
Get an APK from a developer → install it on a phone (USB or Wi-Fi) → play → see live logs, crashes, ANRs
and per-level timings → export a report to send back to the developer.

Runs locally on `http://localhost:7878`. No install step: nothing to `npm install`.

## Start (Mac)

1. Unzip, then **double-click `start.command`**.
2. First run only: it downloads what is missing into the `tools/` folder (a private Node.js ~45 MB and Google's `adb` ~10 MB, no admin password). Later runs start instantly.
3. The browser opens by itself.

If macOS says the file "cannot be opened because it is from an unidentified developer" (common for zips received over Slack/email):
**right-click `start.command` → Open → Open**. Or run once in Terminal: `xattr -dr com.apple.quarantine <folder>`.

Already have Node 18+ or adb (Android Studio, Unity's Android module)? They are detected and used instead.
Terminal alternative: `./start.command` or `node server.js`.

## Flow

1. **Phone** - USB (enable *Developer options → USB debugging*) or Wi-Fi (phone and Mac on the same network):
   - Android 11+: **Pair with QR code** → on the phone *Wireless debugging → Pair device with QR code* → scan. Pairs and connects by itself (needs internet once to draw the QR, and mDNS allowed on the router).
   - Or "Pair with code": the pairing IP:port + 6-digit code, then **Connect** using the *different* IP:port on the main Wireless debugging screen.
   - Older phones: plug in once → **Switch USB phone to Wi-Fi** → unplug.
2. **Build** - drop the `.apk` (package, version, IL2CPP/Mono, ABIs are read from the file) → **Install**.
   "Clean install" uninstalls first (needed when the signing key differs). Or pick any app already on the phone:
   the list shows only apps with a launcher icon, newest install/update first ("Include system apps" adds Chrome etc.); you can also type a bundle id.
3. **Start session** → play. Stop = saved in **History**; **Report** tab = shareable HTML (download or copy a Slack summary).

## What you get

| Feature | How it is detected |
|---|---|
| Java crash | `AndroidRuntime: FATAL EXCEPTION` blocks for your package |
| Native crash (typical for Unity/IL2CPP) | tombstone in `DEBUG`: signal, crashing library, backtrace |
| ANR | `ActivityManager: ANR in <pkg>` + reason, plus thread dump from `dumpsys dropbox` (best effort, no root) |
| Unexpected kill | "Process has died" with no crash/ANR next to it (low-memory killer etc). Swipe-away is ignored |
| Script errors/exceptions | `E` logs from your app, grouped by message, with the C# stack |
| Cold start time | `Displayed <pkg>/...: +1s480ms` |
| Level timings | your own debug logs (below) |
| Crash → level | every crash/ANR is attributed to the level being played |
| Memory | `dumpsys meminfo` PSS sampled every 10 s |
| Phone drops off Wi-Fi | auto-reconnect, shown in the report |

## Level timing

**Firebase Analytics event** (e.g. event `Steps` with params `Started` / `Ended`): type the event and parameter names in the sidebar and press
*Use this Firebase event*. It matches Firebase's own log line (`name=Steps,params=Bundle[{Started=3}]`) and the game's Unity log
(`Steps | STARTED: Level 3`, `Steps | STARTED already sent previously for Level 3`, `Steps | ENDED: Level 3`). The choice is saved in `rules.json`.
The tool also turns on Firebase's verbose logging (`log.tag.FA`) at session start.

Plain logs:

Ask the developers to add `unity/PMLog.cs` and call `PMLog.LevelStart(id)`, `PMLog.LevelComplete(id)`,
`PMLog.LevelFail(id)` (these just `Debug.Log("[PM] LEVEL_START 3")`). Existing logs work too:
the patterns are editable in the sidebar (regex, first group = level id) and the live session is re-analyzed on save.
Default patterns already match things like `LEVEL_START 3`, `Level 3 started`, `LEVEL_COMPLETE 3`, `Level 3 failed`.

Report shows per level: tries, won/failed/quit, crashed, ANR, avg / median / min / max time and the delay before it (gap since the previous level),
plus session time, time inside levels, average/longest delay and each app launch (process) with its duration.
Custom milestones: `PMLog.Event("tutorial_done")`.

## Stack traces for your own `Debug.Log`s

Unity: *Project Settings → Player → Other Settings → Stack Trace Logging* → `ScriptOnly` for Error / Exception / Warning
(and Log if you want it for every log). Stacks are then folded under each log line (click a row to expand).
Release (non-development) builds work too; development builds just give richer info.

## Safety

The server only listens on `127.0.0.1` and rejects requests whose Host/Origin is not localhost (so a website you visit cannot drive your phone).
Package names, device serials and install paths are validated. Saved sessions in `sessions/` contain raw device logs - delete them from History if they hold anything sensitive.
Theme: Auto / Light / Dark in the header (also applied to the report).

## Files

- `server.js` - local HTTP + SSE server
- `lib/adb.js` - adb wrapper · `lib/apk.js` - APK reader · `lib/analyzer.js` - crash/ANR/level logic · `lib/report.js` - HTML report
- `public/index.html` - UI · `sessions/` - saved sessions · `test/` - `npm test`, plus `fake-adb.sh` to try the UI without a phone

## Known limits

- Only APK (not AAB). OBB/split-binary builds: install the OBB separately.
- ANR thread dumps depend on the device exposing `dumpsys dropbox` to adb.
- One live session at a time.
