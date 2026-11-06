#!/usr/bin/env bash
# D7 core release: run a READ-ONLY flight script against hosted DEV or PROD and ASSERT the result programmatically.
#   bash scripts/release/d7_core_flight.sh <preflight|postflight|recheck> <dev|prod> [evidence-dir]
# - dev  : runs from D7_DEV_WORKDIR (default: this repository checkout), which must be linked to the DEV project.
# - prod : runs from the pre-linked scratch workdir in D7_PROD_WORKDIR (a directory linked to PROD; never relink the repo).
# It refuses unless the linked project ref is the expected one, saves the raw output + sha256 as evidence, and exits non-zero
# unless the final row (seq 99) says ok = true. It sends SELECT-only scripts; it never applies SQL.
set -euo pipefail
export MSYS_NO_PATHCONV=1
PHASE="${1:?usage: d7_core_flight.sh <preflight|postflight|recheck> <dev|prod> [evidence-dir]}"
TARGET="${2:?usage: d7_core_flight.sh <preflight|postflight|recheck> <dev|prod> [evidence-dir]}"
EVID="${3:-./d7-release-evidence}"
HERE="$(cd "$(dirname "$0")" && pwd)"
SQL="$HERE/d7_core_${PHASE}.sql"
[ -f "$SQL" ] || { echo "no such phase script: $SQL" >&2; exit 2; }

case "$TARGET" in
  dev)  EXPECT_REF="epdrtzcydvnoidwrepqz"; WORKDIR="${D7_DEV_WORKDIR:-$(cd "$HERE/../.." && pwd)}" ;;
  prod) EXPECT_REF="hvsujyfbftfffxpfmlpb"; WORKDIR="${D7_PROD_WORKDIR:?set D7_PROD_WORKDIR to the directory linked to the PROD project}" ;;
  *) echo "target must be dev or prod" >&2; exit 2 ;;
esac
LINKED_REF="$(tr -d '[:space:]' < "$WORKDIR/supabase/.temp/project-ref" 2>/dev/null || true)"
if [ "$LINKED_REF" != "$EXPECT_REF" ]; then
  echo "STOP: $WORKDIR is linked to '${LINKED_REF:-nothing}', expected $TARGET ($EXPECT_REF). Nothing was sent." >&2
  exit 3
fi

mkdir -p "$EVID"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$EVID/${PHASE}_${TARGET}_${STAMP}.json"
SQLW="$(cygpath -m "$SQL" 2>/dev/null || echo "$SQL")"
(cd "$WORKDIR" && supabase db query --linked --workdir . -f "$SQLW" -o json) > "$OUT.raw" 2>&1 || { echo "STOP: the query failed; raw output kept at $OUT.raw" >&2; exit 4; }
node -e '
const fs=require("fs");const raw=fs.readFileSync(process.argv[1],"utf8");
const a=raw.indexOf("{"),b=raw.lastIndexOf("}");
const j=JSON.parse(raw.slice(a,b+1));
fs.writeFileSync(process.argv[2],JSON.stringify(j.rows,null,2));
let bad=0;for(const r of j.rows){const mark=r.ok?"PASS":"FAIL";if(!r.ok)bad++;console.log(String(r.seq).padStart(2),mark,String(r.check_name).slice(0,90),r.detail?"| "+String(r.detail).slice(0,140):"")}
const last=j.rows.find(r=>r.seq===99);
if(!last||last.ok!==true){console.error("\nSTOP: not all checks passed ("+bad+" failing row(s)).");process.exit(1)}
' "$OUT.raw" "$OUT" || { echo "evidence: $OUT (sha256 $(sha256sum "$OUT" | cut -c1-16)...)" >&2; exit 1; }
rm -f "$OUT.raw"
echo "OK ${PHASE} ${TARGET} (${EXPECT_REF}) - evidence: $OUT sha256 $(sha256sum "$OUT" | cut -d' ' -f1)"
