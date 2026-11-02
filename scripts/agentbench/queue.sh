#!/bin/bash
# queue.sh <label> <src> <timeout-min> <backend:model>... — every task for each backend, one at a time.
label=$1; src=$2; to=$3; shift 3
for bm in "$@"; do
  b=${bm%%:*}; m=${bm#*:}; [ "$m" = "$bm" ] && m=""
  for t in ui bug logic locate rule; do
    echo "== $(date +%T) $label $b $m $t"
    node "$(dirname "$0")/run.mjs" --src $src --label $label ${BENCH_ENV:+--env $BENCH_ENV} --backend $b ${m:+--model $m} --task $t --timeout-min $to > /dev/null 2>> "${AGENTBENCH_WORK:-${TMPDIR:-/tmp}/agentbench}/queue-$label.err"
    tail -1 "${AGENTBENCH_WORK:-${TMPDIR:-/tmp}/agentbench}/results.jsonl" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["backend"],d["model"],d["task"],d["outcome"],d["wallS"],d["score"],d["stats"].get("tools"))'
  done
done
