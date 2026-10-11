#!/usr/bin/env bash
# SwiftBar plugin: DiskWatch status every 60s.
# Install: symlink into SwiftBar plugins dir; ensure ~/.local/bin/diskwatch exists.

set -u
CLI="${HOME}/.local/bin/diskwatch"
export NO_COLOR=1
unset FORCE_COLOR

if [[ ! -x "$CLI" ]]; then
  echo "DW ! | color=red"
  echo "---"
  echo "Missing binary: $CLI"
  exit 0
fi

errfile="$(mktemp)"
code=0
out="$( "$CLI" status --swiftbar 2>"$errfile" )" || code=$?
err="$(grep -v "Warning: The 'NO_COLOR'" "$errfile" 2>/dev/null || true)"
rm -f "$errfile"

if [[ -z "${out// }" ]]; then
  echo "DW ! | color=red"
  echo "---"
  if [[ -n "$err" ]]; then
    echo "${err:0:200}"
  else
    echo "Empty status output (exit $code)"
  fi
  exit 0
fi

if [[ "$code" -ne 0 ]]; then
  # CLI already emits DW ! markup on hard failures; do not double-wrap.
  if [[ "$out" == DW\ !* ]]; then
    printf '%s\n' "$out"
    exit 0
  fi
  echo "DW ! | color=red"
  echo "---"
  tail="${err:-exit $code}"
  echo "${tail:0:200}"
  echo "$out"
  exit 0
fi

printf '%s\n' "$out"
