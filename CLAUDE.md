# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Unity Logcat PM: a local, zero-dependency Node.js (18+) tool that drives `adb` to install an Android build, stream logcat, detect crashes/ANRs/level timings, and render a shareable HTML report. Audience is product managers, so the UX goal is "double-click, no terminal". There is no `npm install` step and no build/lint config.

## Commands

```bash
node server.js                 # run from source -> http://localhost:7878 (NO_OPEN=1 skips opening the browser, PORT=... changes port)
npm test                       # runs test/analyzer.test.js then test/fb.test.js (plain assert scripts, no framework)
node test/analyzer.test.js     # single test file
./make-app.sh                  # builds dist/"Unity Logcat PM.app" + dist/Unity-Logcat-PM-mac.zip (macOS only)
```

Try the UI without a phone: `ADB=$PWD/test/fake-adb.sh NO_OPEN=1 node server.js`, then start a session for `com.studio.game` on serial `FAKE123` (it replays `test/sample.log`). Restart the server after editing anything under `lib/` or `server.js`; `public/*` is read from disk per request.

## Architecture

Data flow: `adb logcat` -> `lib/session.js` (spawn, line split, `lib/parse.js`) -> `lib/analyzer.js` (state machine) -> batched SSE (`/api/stream`) -> `public/index.html` (single-file UI, no framework). `server.js` is the only HTTP layer: a route table keyed `"METHOD /api/path"`, SSE broadcast, static files, report endpoints.

- **Analyzer is pure and incremental.** `Analyzer.feed(line)` returns an app log entry (or null) and queues events (`crash`, `anr`, `died`, `level`, `stack`) retrieved via `drain()`. It is the core of the project; `test/` exercises it directly with `sample.log`.
- **Multi-line blocks use log-time gaps, not wall time.** Java crash (`AndroidRuntime`), native crash (`DEBUG` tombstone) and ANR (`ActivityManager`) are accumulated into blocks and finalized when the next line is >1.5s later in log time, or by `tick()`/`finish()`. "Process died" events are deferred 2.5s so they can be merged into a crash/ANR instead of double counting.
- **App-only filtering is by pid**, not `--pid`: pids come from `pidof` polling plus `Start proc` lines, so restarts keep working. If `launch` is on, pre-existing pids are deliberately ignored (the old process gets force-stopped).
- **Level timing is regex-driven.** Rules (`start`/`end`/`fail`/`event`) take the first defined capture group as the level id. Defaults live in `DEFAULT_RULES`; user rules persist in `rules.json`; `reanalyze()` replays stored entries (levels/error groups only, since non-app lines such as tombstones are not stored). The Firebase preset in `public/index.html` (`#btnFb`) generates regexes matching both Firebase's `name=Steps,params=Bundle[{Started=3}]` and the game's own Unity log (`Steps | STARTED: Level 3`, `... already sent previously for Level 3`).
- **Unity stack grouping:** frame-like lines (`isFrame`) from the same pid:tid within 1.5s are folded into the previous entry's `stack` and emitted as separate `stack` events. Entries pushed to the SSE batch are copied (`{...e}`) so the later `stack` events are not duplicated.
- **Persistence:** sessions are saved as one JSON (`meta`, `summary`, `entries`) in `sessions/`, autosaved every 30s and on stop. `lib/report.js` renders reports purely from that `{meta, summary}` shape, for both live (`/api/report/live.html`) and saved sessions; the Report tab is an iframe of it.
- **APK inspection without aapt:** `lib/apk.js` reads the zip central directory and parses the binary `AndroidManifest.xml` itself. If parsing fails the upload still succeeds with `package: null`; the UI then diffs installed packages before/after install to find it.
- **Paths:** `lib/paths.js` resolves `DATA_DIR`/`TOOLS_DIR` (set by the .app launcher to `~/Library/Application Support/UnityLogcatPM`). Anything written at runtime (sessions, uploads, rules.json, downloaded adb/node) must go through it, never `__dirname`.
- **adb discovery** (`lib/adb.js`): `$ADB`, `tools/platform-tools`, PATH, Android SDK, Unity Hub's bundled SDK. `setup-adb.sh` downloads Google's platform-tools; `start.command` also bootstraps a private Node into `tools/` when none is installed.

## Gotchas

- Security-sensitive: `server.js` rejects non-localhost `Host`/`Origin` and validates `serial`, `pkg`, `addr` and install `path` (must be inside `uploads/`) before any handler runs. `pkg` and `serial` end up in `adb shell` strings, so keep new endpoints behind `validate()` and never interpolate other user input into shell commands.
- The server binds to `127.0.0.1` only and exits after 3 idle minutes only when `AUTO_QUIT=1` (set by the .app launcher).
- Client log view keeps max ~120k rows and renders only the last 1500; avoid O(n) work per incoming line in `public/index.html`.
- `.gitignore` excludes `sessions/`, `uploads/`, `tools/`, `dist/`, `rules.json`, `*.zip`; screenshots in `docs/` are generated from demo data and are committed.
