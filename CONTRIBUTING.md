# Contributing

DiskWatch is a small macOS app using Node's built-in modules and SQLite.
Keep changes focused, explain the behavior they change, and include a regression
test when changing executable behavior.

Run `bash test/run-all.sh` on macOS before submitting a pull request. Use
`DISKWATCH_STATE_DIR` pointing at a temporary directory for manual testing.
Never include your real database, configuration, logs, or folder names in fixtures.

- `src/scan/`: read-only filesystem measurements and event collection
- `src/db/`: schema and database access
- `src/report/` and `src/server/`: reports and loopback dashboard
- `public/`: plain HTML, CSS, and JavaScript
- `scripts/install.js`: portable per-user installation
- `test/`: tests with synthetic data

The collector must never delete, move, or modify monitored files. Unknown paths
and user data remain protected. Do not add npm dependencies, a bundler, or sudo.
Only `diskwatch.60s.sh` belongs in `swiftbar/`.

Use `npm run share` to produce the source archive. The exporter uses an explicit
file list; add new public files there deliberately. Keep private incident notes,
runtime state, and local Git history out of the release.
