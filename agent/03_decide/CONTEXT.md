# 03 Decide: approval, reversible action, verification

Read `../02_investigate/output/findings.md`, live `diskwatch config --json`, and
`output/plan.md`. Fill the plan using verified evidence. Show the owner the exact
paths, why each is proposed, expected benefit, recovery and remaining risks.
Ask for explicit approval of the listed items and method. Broad statements such
as "clean my Mac" or enabling daily discovery are not item-level approval.

For a fully traversed current candidate, run `diskwatch cleanup plan <id>` and
record its plan ID in `output/plan.md`. This saves one immutable item, its
metadata/path identity, current policy and a measured free-space baseline.
Incomplete lower-bound leads cannot be sealed into plans. Kept/snoozed items
require the owner's direction to clear that decision first. The stored plan is
evidence, not approval; its existence never authorizes an action.

Wait for that answer. Save its exact scope and time to `output/approval.md`.
Do not manufacture approval or treat edits to a snapshot as new authorization.
Recheck paths, symlinks, ownership, active use and changes immediately before any
action. If anything changed or remains uncertain, stop and ask again.
Run `diskwatch cleanup check <plan-id>` immediately before the approved external
action. This observation does not append history or remove the manual checks.
Proceed only with unchanged identity, metadata and scope, and resolved blockers.
An absent/recreated path, changed policy or incomplete verification needs fresh
investigation, not reuse of the approval. These checks are not an atomic safety
boundary around another tool's action.

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

Run `diskwatch cleanup verify <plan-id>` after the external action and save the
JSON observation with the actual tool/Finder result. `diskwatch cleanup history
--json` shows recent recorded observations. Verification distinguishes the
original path being unchanged, changed, absent or recreated, and policy/coverage
problems. `verified: true` establishes observed absence only, not Trash placement,
successful deletion, recovery or reclaimed bytes. Report the measured
before/after free-space delta as unattributed; other work can make it negative.
