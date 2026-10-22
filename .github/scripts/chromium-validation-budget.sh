#!/usr/bin/env bash
# Bound a phase while preserving its required follow-up and artifact-upload time.
set -euo pipefail
if [ "$#" -lt 3 ]; then echo 'usage: budget MAX_SECONDS RESERVE_SECONDS COMMAND...' >&2; exit 64; fi
cap=$1
reserve=$2
shift 2
[[ "$cap" =~ ^[0-9]+$ && "$reserve" =~ ^[0-9]+$ && "${CHROMIUM_DEADLINE:-}" =~ ^[0-9]+$ ]]
remaining=$((CHROMIUM_DEADLINE - $(date +%s) - reserve))
if [ "$remaining" -le 0 ]; then
  echo 'Required follow-up reserve exhausted; preserving incomplete evidence.' >&2
  exit 124
fi
if [ "$cap" -lt "$remaining" ]; then remaining=$cap; fi
if [ "$remaining" -le 0 ]; then exit 124; fi
printf 'Phase budget %ss; follow-up reserve %ss; absolute deadline %s\n' "$remaining" "$reserve" "$CHROMIUM_DEADLINE"
exec timeout --kill-after=30s "${remaining}s" "$@"
