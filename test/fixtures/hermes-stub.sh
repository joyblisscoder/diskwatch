#!/usr/bin/env bash
# Stub hermes send: prove notification row exists before delivery, then succeed.
set -euo pipefail

BODY="${@: -1}"
PROOF="${DISKWATCH_HERMES_PROOF:-}"
DB="${DISKWATCH_TEST_DB:-}"

if [[ -n "$DB" ]]; then
  BODY="$BODY" DB="$DB" node --input-type=module <<'EOF'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.env.DB);
const row = db.prepare(
  `SELECT body, delivered_at, attempt FROM notifications ORDER BY id DESC LIMIT 1`
).get();
db.close();
if (!row) throw new Error('hermes-stub: no notification row before send');
if (row.delivered_at != null) throw new Error('hermes-stub: already delivered before send');
if (Number(row.attempt) !== 0) throw new Error('hermes-stub: attempt must be 0 before send');
if (row.body !== process.env.BODY) throw new Error('hermes-stub: body mismatch');
EOF
fi

if [[ -n "$PROOF" ]]; then
  printf '%s\n' "$BODY" >> "$PROOF"
fi

echo '{"ok":true}'
exit 0
