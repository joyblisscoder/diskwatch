# 03 Decide: approval, reversible action, verification

Read `../02_investigate/output/findings.md`, live `diskwatch config --json`, and
`output/plan.md`. Fill the plan using verified evidence. Show the owner the exact
paths, why each is proposed, expected benefit, recovery and remaining risks.
Ask for explicit approval of the listed items and method. Broad statements such
as "clean my Mac" or enabling daily discovery are not item-level approval.

Wait for that answer. Save its exact scope and time to `output/approval.md`.
Do not manufacture approval or treat edits to a snapshot as new authorization.
Recheck paths, symlinks, ownership, active use and changes immediately before any
action. If anything changed or remains uncertain, stop and ask again.

DiskWatch does not execute deletion. If the owner's agent has an appropriate
native Trash tool, use it only for the exact approved items. Otherwise guide the
owner through Finder's Move to Trash. Never use rm, sudo, empty Trash, secure
erase, or a recursive deletion command. Tool-managed cleanup that permanently
deletes data requires separate explicit approval of that exact procedure.

Moving to Trash usually does not free disk space. Never claim reclaimed space
from moved bytes. Only the owner decides when to empty Trash.

Write `output/outcome.md`: actual action, timestamp, per-item result, recovery
location, failures, and before/after free space from `diskwatch scan --once` and
`diskwatch report --json`. Do not report success for a failed or unverified action.
Preserve findings and approval for the next agent; do not modify old runs.
