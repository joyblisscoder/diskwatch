# DiskWatch

See what's taking up space on your Mac, what grew today, and how it changes over time.

## What you get

- Collector samples a watchlist, volume free space, swap, and restart-reclaimable bytes
- SQLite history under `~/.local/state/diskwatch/`
- CLI: `report`, `why`, `status`, `doctor`, `scan`, `ingest`, `serve`, `canary`
- Loopback dashboard at http://127.0.0.1:7381
- SwiftBar menu line for free space

## Requirements

- macOS, on Apple Silicon or Intel
- Node.js >= 22.13, with built-in `node:sqlite`
- No npm install. There is no `node_modules`.

## Install

Download the [latest source release](https://github.com/joyblisscoder/diskwatch/releases/latest)
and unzip it. If Node.js isn't installed, get it from [nodejs.org](https://nodejs.org/en/download).

```bash
# Run from the source folder after downloading and unzipping the release.
node scripts/install.js --start
open http://127.0.0.1:7381
```

The installer creates `~/.local/bin/diskwatch` and two LaunchAgents, which run
the dashboard after login and scan every 15 minutes. The first scan starts in
the background; a large disk may take several minutes. Keep the source folder
where you installed it. Use a stable Node installation, since setup records
the current Node executable.

Preview setup without writing anything with `node scripts/install.js --dry-run`.
Setup refuses to overwrite an unrelated binary or a changed LaunchAgent.

To try it without background jobs:

```bash
node bin/diskwatch migrate
node bin/diskwatch scan --once
node bin/diskwatch serve
```

Leave that Terminal open and visit the dashboard. Run another scan for fresh
readings. `doctor` may warn about missing background jobs in this mode.

## Menu bar (optional)

Install [SwiftBar](https://github.com/swiftbar/SwiftBar) separately. Put a symlink to `swiftbar/diskwatch.60s.sh` in
the plugin folder you chose in SwiftBar. After setup, the plugin uses
`~/.local/bin/diskwatch`, which handles Node's path even in GUI apps.
Only put the plugin in that folder. SwiftBar executes every plugin it finds.

## Settings and alerts

Edit `~/.local/state/diskwatch/config.json` to change thresholds and watched
folders. Paths starting with `~/` use your home directory. Missing paths are
harmless. Restart the dashboard after changing settings; the next collector
run reads them.

Alerts are off by default. To enable local Mac notifications, set
`"notifications": { "channel": "macos" }`, then run
`~/.local/bin/diskwatch canary` to submit a test notification. Allow notifications
for the sending app in macOS settings if prompted. Successful submission means
macOS accepted the request; Focus and notification settings can still hide it.

Optional Telegram alerts require your own compatible `hermes send` helper and
`"channel": "telegram"`. Personal worktree discovery, external cleanup-log
imports, and the Claude agent menu are disabled on new installs. Existing
pre-release configs retain their original integrations.

## Privacy and measurements

DiskWatch keeps folder paths, sizes, scan history, and events in
`~/.local/state/diskwatch/`. It doesn't read file contents. The dashboard listens
only on your Mac's loopback address. There is no telemetry. Optional Telegram
alerts send notification bodies through the helper you configure.

Reports, screenshots, and the database can reveal folder names. Share the source
release instead of your state folder. See [SECURITY.md](SECURITY.md).

Sizes from `du` are logical. Don't add overlapping watchlist entries together.
macOS permissions can make measurements partial; DiskWatch doesn't request
elevated access. Restart-reclaimable space is an estimate.

## Uninstall

```bash
launchctl bootout gui/$(id -u)/com.diskwatch.collector
launchctl bootout gui/$(id -u)/com.diskwatch.server
```

In Finder, move these generated files to Trash:

- `~/Library/LaunchAgents/com.diskwatch.collector.plist`
- `~/Library/LaunchAgents/com.diskwatch.server.plist`
- `~/.local/bin/diskwatch`
- The optional SwiftBar symlink

Then you can move the source folder to Trash. Keep
`~/.local/state/diskwatch/` to preserve history, or move it to Trash to remove
your local data too. Existing pre-release jobs have different labels and must
be stopped separately.

## Quick checks

```bash
~/.local/bin/diskwatch doctor --json
~/.local/bin/diskwatch report --json
~/.local/bin/diskwatch why ~/Downloads --json
```

`doctor` exits 0 for healthy, 1 for warnings, and 2 for failures.
Reports exit 3 when the latest scan is stale.

## Contribute

Run `npm test`, or `bash test/run-all.sh`, on macOS. No `npm install` is needed.
See [CONTRIBUTING.md](CONTRIBUTING.md). DiskWatch is licensed under [MIT](LICENSE).
