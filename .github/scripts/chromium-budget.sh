#!/usr/bin/env bash
# Leave time for evidence upload even if compilation consumes the job budget.
set -euo pipefail
remaining=$((CHROMIUM_DEADLINE - $(date +%s)))
if [ "$remaining" -le 0 ]; then
  echo 'Chromium diagnostic build budget exhausted; preserving partial evidence.' >&2
  exit 124
fi
timeout --kill-after=30s "${remaining}s" "$@"
