# DiskWatch

Local macOS disk monitoring with a read-only collector, SQLite history, a CLI,
loopback dashboard, and optional SwiftBar menu status.

| Task | Read |
| --- | --- |
| Install, use, or stop | README.md |
| Change implementation | CONTRIBUTING.md, src/, test/ |
| Privacy or vulnerability | SECURITY.md |
| Create a source release | scripts/package-release.js |

Run `bash test/run-all.sh` on macOS. Use an isolated `DISKWATCH_STATE_DIR`
when testing. Never ship a real database, configuration, logs, or private paths.

The collector never deletes, moves, or modifies monitored files. Unknown paths
and user data stay protected. No npm dependencies, bundler, or sudo.
Only `diskwatch.60s.sh` belongs in `swiftbar/`, which SwiftBar executes automatically.

Runtime state lives in `~/.local/state/diskwatch/`. New installations don't
require personal helpers. Older configurations preserve their integrations.

## Claiming work across machines

The canonical protocol is pinned issue #2 in `joyblisscoder/diskwatch`.
When this summary differs, issue #2 wins.

- Before the first edit, list open issues and read every claim title and body.
- If someone else's claim overlaps the task or files, stop and report it.
- Otherwise create `<HumanName>: <task>` with files/area and branch, re-list,
  and let the lower issue number win any simultaneous overlap.
- Comment `Still on it. <Name>` on each new multi-day session.
- Close the claim with a signed outcome when done or a signed state when
  abandoning it. Never close the protocol issue.
- If GitHub is unavailable, continue read-only investigation only.
- Claims contain no secrets, credentials, or private client data.
