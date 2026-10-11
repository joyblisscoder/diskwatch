# DiskWatch

See what's taking up space on your Mac, what grew today, and how it changes over time.

## What you get

- Collector samples a watchlist, volume free space, swap, and restart-reclaimable bytes
- SQLite history under `~/.local/state/diskwatch/`
- CLI: `report`, `why`, `status`, `doctor`, `scan`, `ingest`, `serve`, `canary`
- Loopback dashboard at http://127.0.0.1:7381
- SwiftBar menu line for free space
- Guided terminal setup with explicit scope and automation choices
- Bounded stale-file discovery and a private, staged workspace for your own AI agent
- Saved keep/snooze decisions, read-only worktree inventory, and cleanup verification history

## Requirements

- macOS, on Apple Silicon or Intel
- Node.js >= 22.13, with built-in `node:sqlite`
- No npm install. There is no `node_modules`.

## Install

Download the [latest source release](https://github.com/joyblisscoder/diskwatch/releases/latest)
and unzip it. If Node.js isn't installed, get it from [nodejs.org](https://nodejs.org/en/download).

```bash
# Run from the source folder after downloading and unzipping the release.
node scripts/setup.js
```

Or, with Git and Node installed, paste this into Terminal:

```bash
git clone https://github.com/joyblisscoder/diskwatch.git && cd diskwatch && node scripts/setup.js
```

Setup explains what DiskWatch reads and asks which folders to watch, what to
exclude from investigation, how old and large a candidate should be, the free
space warning level, and whether to enable local notifications. Review the
summary before saving. It then asks whether to install the background jobs.
Declining leaves your preferences saved for a manual trial. Ctrl-C cancels.

The interactive **Agentic coder** profile watches developer projects and caches,
and adds size monitoring for agent history/worktrees, native developer and
container stores, package stores, model weights and Trash. Those protected
stores are monitored for growth, without transcript reads or cleanup permission.
Downloads are watched but excluded from this profile's investigation roots.
The simpler profiles and keeping your existing scope remain available.
`setup --defaults` keeps the narrow read-only defaults on a new install.

Choose how automatic you want it:

| Mode | What happens |
| --- | --- |
| Monitor only | Track space and growth. No scheduled stale-file search. |
| Suggestions on demand (default) | Run `diskwatch candidates` or `diskwatch agent` when you want help. |
| Daily discovery | The collector prepares fresh candidate evidence once a day for your agent. |

Every mode requires your approval of exact items before cleanup. Daily discovery
does not launch an AI or delete anything. Re-run `~/.local/bin/diskwatch setup`
to change preferences. No model credentials or paid services are required.

For an unattended read-only setup, run `node bin/diskwatch setup --defaults`,
then `node scripts/install.js --start` if you want background jobs. Interactive
setup refuses piped input rather than guessing your answers.

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

## Work with your agent

```bash
~/.local/bin/diskwatch candidates --json
~/.local/bin/diskwatch inventory --json
~/.local/bin/diskwatch agent
```

The `agent` command prints a prompt and creates a private workspace with a small
agent map and three stages: observe, investigate, decide. Claude Code, Codex or
another filesystem-capable agent can follow it. It contains a current report,
your scope, candidate evidence, worktree inventory, saved decisions, recent
outcomes and a cleanup-plan template. Each run is preserved
under `~/.local/state/diskwatch/agent/runs/`; `agent/latest.json` identifies the
latest completed run. Nothing is uploaded by these commands. A cloud agent can
send the evidence it reads to its provider, so review that boundary first.

Discovery reads metadata within the approved roots. It checks project source
and Git activity before ranking old dependency/cache/build artifacts, including
Rust, Python, Gradle and Turbo outputs. It gives each root an entry budget and
shares the overall time fairly, inspecting projects before expensive generated
trees. Defaults are 200,000 entries per root, 16 levels, up to five seconds per
root and 30 seconds overall between metadata calls. It retains the largest 100
leads observed. A blocked filesystem call can take longer.

Symlink targets and filesystem boundaries are never traversed. Links inside a
generated tree contribute only their own metadata. Incomplete items can appear
as explicitly marked lower-bound estimates: unvisited contents and activity
remain unknown, and those items cannot become cleanup plans. Old timestamps
still do not establish non-use. `inventory` reads scoped Git worktree metadata;
locked/prunable flags do not establish that a worktree is safe to remove.

Agents check ownership, active use, recoverability and exclusions, then show
you exact items to approve. Unknown items stay blocked. DiskWatch itself has no
deletion executor. Prefer reversible Move to Trash after approval, and remember
that moving something to Trash normally does not free disk space until you
choose to empty it. See [the agent workflow](docs/AGENT-WORKFLOW.md).

## Remember decisions and verify cleanup

Use the IDs printed by `candidates`; use the saved ID from `decisions` to clear
a preference. Replace the uppercase placeholders below with those IDs.

```bash
diskwatch decide CANDIDATE_ID keep
diskwatch decide CANDIDATE_ID snooze --days 14
diskwatch decisions --json
diskwatch decide DECISION_ID clear
```

Keep hides an unchanged proposal across runs. Snooze hides it until its deadline
(30 days by default). A changed metadata fingerprint resurfaces either item for
review. Clear removes the saved rule. These decisions never approve cleanup.

After investigating one complete candidate:

```bash
diskwatch cleanup plan CANDIDATE_ID
diskwatch cleanup check PLAN_ID
# Obtain exact owner approval, then use the agreed external tool or Finder.
diskwatch cleanup verify PLAN_ID
diskwatch cleanup history --json
```

The plan saves an immutable single-item snapshot and a free-space baseline in
the private `cleanup.db`. It is not approval. `check` observes current identity,
metadata and scope without recording an outcome; resolve any change or
uncertainty before acting. DiskWatch never performs the action. `verify` appends
an observation to history. A missing original path proves neither Trash
placement nor reclaimed space. The before/after volume delta is measured but
not attributed to that action; it may be zero or negative.

## Contribute

Run `npm test`, or `bash test/run-all.sh`, on macOS. No `npm install` is needed.
See [CONTRIBUTING.md](CONTRIBUTING.md). DiskWatch is licensed under [MIT](LICENSE).
