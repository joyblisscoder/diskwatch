---
status: draft
approval: required
---

# Proposed cleanup

No items are approved. Complete investigation before proposing an action.

Stored plan ID: pending. Use `diskwatch cleanup plan <candidate-id>` for one
fully traversed item after investigation. Record the returned ID and baseline
here. The stored snapshot is immutable evidence, not approval; incomplete
lower-bound leads and kept/snoozed proposals cannot be planned.

| Exact path | Size estimate | Evidence and active-use checks | Recovery | Proposed method | Blockers |
| --- | --- | --- | --- | --- | --- |

## Owner decision

Present this plan and wait. Record explicit item-level approval separately in
`approval.md`. After the approved action, record actual results in `outcome.md`.
Moving to Trash is reversible but normally does not reclaim free space yet.

Immediately before the external approved action, run `diskwatch cleanup check
<plan-id>`. Stop if identity, metadata or scope changed, the path is absent, or
verification is incomplete. Resolve active-use and recovery checks separately.

Afterward, run `diskwatch cleanup verify <plan-id>` and retain the observation
alongside the actual action result and recovery location. Original-path absence
does not prove Trash placement or reclaimed space. Record the measured volume
delta as unattributed, including zero or negative values. Saved observations
are available through `diskwatch cleanup history --json`.
