# 01 Observe: scope and current pressure

Read `output/policy.json` and `output/report.json` in this folder. These are
snapshots. Run `diskwatch config --json` to check the live policy before acting.
If you are in an uninstalled source folder, use `node bin/diskwatch` instead.

Ask the owner what matters: free-space target, projects in active use, folders
to exclude, and how much investigation they want automated. To change those
preferences, have the owner run `diskwatch setup`. Preserve a narrower existing
choice. The modes are monitor, suggestions on demand, and daily discovery.
Every mode requires separate approval of exact cleanup items.

If the report is missing or stale, run `diskwatch scan --once`, then
`diskwatch report --json`. It can exit 3 for stale data; do not treat it as fresh.
Use `diskwatch doctor --json` for partial scans and missing permissions. Do not
request sudo, Full Disk Access, or broader filesystem scope automatically.

Write a short `output/summary.md`: timestamp, free space, growth, agreed scope,
and uncertainty. A volume shortage is not authorization to delete anything.
For monitor mode, stop at the summary unless the owner asks to investigate.
Otherwise continue to `../02_investigate/CONTEXT.md` within approved roots.
