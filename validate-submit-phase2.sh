#!/usr/bin/env bash
# validate-submit-phase2.sh — isolated validation harness for the submit-phase2
# Edge Function. Tests happy path + overwrite refusal + input validation +
# pre-check + rate limit, with no dependency on the consultant UI.
#
# Uses the public anon key (same key the browser sends) to invoke the function;
# uses SUPABASE_SERVICE_KEY (from .env) ONLY for test setup (inserting probe
# Phase 1 rows) and teardown (deleting them). The function itself is
# invocable purely with the anon key — that's the point.
#
# Cleanup: any probe rows created during the run are tracked in CREATED_IDS
# and deleted on exit via a trap, even if the script aborts mid-flight.
#
# Usage:  ./validate-submit-phase2.sh
#         TEST_RATE_LIMIT=false ./validate-submit-phase2.sh   # skip the 35-call rate test

set -uo pipefail

if [ ! -f .env ]; then
  echo "✗ .env not found in $(pwd). Run from repo root." >&2
  exit 1
fi
set -a
# shellcheck disable=SC1091
source .env
set +a

if [ -z "${SUPABASE_SERVICE_KEY:-}" ]; then
  echo "✗ SUPABASE_SERVICE_KEY not set in .env (needed for setup + teardown only)." >&2
  exit 1
fi

PROJECT_URL="https://lmrmteaclszgsvrfjnsg.supabase.co"
ANON_KEY="sb_publishable_hAcVbzEFM5s0r-8IIhrS4Q_nOArlR7d"   # public by design — same key the browser uses
ENDPOINT="$PROJECT_URL/functions/v1/submit-phase2"
SVC="$SUPABASE_SERVICE_KEY"

# ── helpers ────────────────────────────────────────────────────────────────────
svc_get() {
  curl -sS "$PROJECT_URL/rest/v1/submissions?id=eq.$1&select=id,case_id,ai_safety_rating,phase2_completed_at,phase2_step_ratings_json" \
    -H "apikey: $SVC" -H "Authorization: Bearer $SVC"
}
svc_delete() {
  curl -sS -o /dev/null -w "%{http_code}" -X DELETE "$PROJECT_URL/rest/v1/submissions?id=eq.$1" \
    -H "apikey: $SVC" -H "Authorization: Bearer $SVC"
}
anon_insert_phase1() {
  curl -sS -X POST "$PROJECT_URL/rest/v1/submissions" \
    -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY" \
    -H "Content-Type: application/json" -H "Prefer: return=representation" \
    -d "$1"
}
fn_invoke() {
  curl -sS -w "\nHTTP %{http_code}" -X POST "$ENDPOINT" \
    -H "Content-Type: application/json" -H "Authorization: Bearer $ANON_KEY" \
    -d "$1"
}

# Track probe rows for cleanup on exit
CREATED_IDS=()
cleanup() {
  echo
  echo "── cleanup: removing probe rows ──"
  for id in "${CREATED_IDS[@]}"; do
    if [ -n "$id" ]; then
      code=$(svc_delete "$id")
      echo "  DELETE $id → HTTP $code"
    fi
  done
}
trap cleanup EXIT

# Shared Phase 1 body
P1_BODY=$(jq -nc '{
  case_id: "BRH-2024-0891",
  view_mode: "consultant",
  decision: "damage",
  reasoning_json: { diagnostic: "validate-submit-phase2 probe — delete me" },
  constraint_snapshot: { theatre: 2 },
  time_to_decision_seconds: 60
}')

# ── 1/7 happy path ────────────────────────────────────────────────────────────
echo "── 1/7 happy path: insert Phase 1 row (anon), PATCH Phase 2 (via function) ──"
INS=$(anon_insert_phase1 "$P1_BODY")
ID1=$(echo "$INS" | python3 -c "import sys,json
try:
  d=json.load(sys.stdin); print(d[0]['id'] if isinstance(d,list) and d else '')
except: print('')" 2>/dev/null)
if [ -z "$ID1" ]; then
  echo "  ✗ Phase 1 INSERT failed — cannot proceed. Response was:"
  echo "$INS"
  exit 1
fi
echo "  ✓ inserted Phase 1 row id: $ID1"
CREATED_IDS+=("$ID1")

P2_BODY=$(jq -nc --arg id "$ID1" '{
  submission_id: $id, case_id: "BRH-2024-0891",
  phase2_step_ratings_json: { ratings: [
    {step_index:1, step_text:"do thing 1", rating:"acceptable",  rated_at:"2026-05-23T22:00:00Z"},
    {step_index:2, step_text:"do thing 2", rating:"sub_optimal", rated_at:"2026-05-23T22:00:01Z"}
  ]},
  ai_safety_rating: "SUB-OPTIMAL",
  adversarial_critique_trace: null,
  standard_of_care_steps: ["do thing 1","do thing 2"],
  phase2_completed_at: "2026-05-23T22:00:30Z"
}')
echo "  invoking submit-phase2..."
fn_invoke "$P2_BODY" | sed -n '1p' | jq
echo "  service-role verifying the row now has phase2 data:"
svc_get "$ID1" | jq '.[0] | {id, ai_safety_rating, phase2_completed_at, has_phase2: (.phase2_step_ratings_json != null), rating_count: (.phase2_step_ratings_json.ratings | length)}'

# ── 2/7 overwrite refusal ─────────────────────────────────────────────────────
echo
echo "── 2/7 overwrite refusal: second PATCH on same row must return 409 ──"
fn_invoke "$P2_BODY"
echo

# ── 3/7 invalid rating value ──────────────────────────────────────────────────
echo
echo "── 3/7 invalid rating value: 'maybe' should be rejected with 400 ──"
INS=$(anon_insert_phase1 "$P1_BODY")
ID3=$(echo "$INS" | python3 -c "import sys,json
try:
  d=json.load(sys.stdin); print(d[0]['id'] if isinstance(d,list) and d else '')
except: print('')" 2>/dev/null)
if [ -n "$ID3" ]; then CREATED_IDS+=("$ID3"); fi
P2_BAD_RATING=$(jq -nc --arg id "$ID3" '{
  submission_id: $id, case_id: "BRH-2024-0891",
  phase2_step_ratings_json: { ratings: [{step_index:1, step_text:"x", rating:"maybe", rated_at:"2026-05-23T22:00:00Z"}]},
  ai_safety_rating: "ACCEPTABLE", adversarial_critique_trace: null,
  standard_of_care_steps: ["x"], phase2_completed_at: "2026-05-23T22:00:30Z"
}')
fn_invoke "$P2_BAD_RATING"
echo

# ── 4/7 case_id mismatch ──────────────────────────────────────────────────────
echo
echo "── 4/7 case_id mismatch: row is BRH-2024-0891, body claims SOW-2024-1562 (expect 400) ──"
P2_MISMATCH=$(jq -nc --arg id "$ID3" '{
  submission_id: $id, case_id: "SOW-2024-1562",
  phase2_step_ratings_json: { ratings: [{step_index:1, step_text:"x", rating:"acceptable", rated_at:"2026-05-23T22:00:00Z"}]},
  ai_safety_rating: "ACCEPTABLE", adversarial_critique_trace: null,
  standard_of_care_steps: ["x"], phase2_completed_at: "2026-05-23T22:00:30Z"
}')
fn_invoke "$P2_MISMATCH"
echo

# ── 5/7 bad submission_id format ──────────────────────────────────────────────
echo
echo "── 5/7 bad submission_id format: 'not-a-uuid' (expect 400) ──"
fn_invoke '{"submission_id":"not-a-uuid","case_id":"BRH-2024-0891"}'
echo

# ── 6/7 nonexistent submission_id ─────────────────────────────────────────────
echo
echo "── 6/7 nonexistent submission_id: well-formed UUID but no row (expect 404) ──"
P2_NONEXIST=$(jq -nc '{
  submission_id: "00000000-0000-0000-0000-000000000000",
  case_id: "BRH-2024-0891",
  phase2_step_ratings_json: { ratings: [{step_index:1, step_text:"x", rating:"acceptable", rated_at:"2026-05-23T22:00:00Z"}]},
  ai_safety_rating: "ACCEPTABLE", adversarial_critique_trace: null,
  standard_of_care_steps: ["x"], phase2_completed_at: "2026-05-23T22:00:30Z"
}')
fn_invoke "$P2_NONEXIST"
echo

# ── 7/7 rate limit ────────────────────────────────────────────────────────────
TEST_RATE_LIMIT="${TEST_RATE_LIMIT:-true}"
echo
if [ "$TEST_RATE_LIMIT" = "true" ]; then
  echo "── 7/7 rate-limit: 35 rapid invokes (expect 400 ×30 then 429 ×5) ──"
  echo "    Each call sends {} which fails validation at 400 but still consumes a"
  echo "    rate-limit slot. Quota bucket 'submit-phase2:<ip>' is isolated from"
  echo "    parse-actions, so this won't affect parse-actions throttling."
  for i in $(seq 1 35); do
    CODE=$(curl -sS -o /dev/null -w "%{http_code}" -X POST "$ENDPOINT" \
      -H "Content-Type: application/json" -H "Authorization: Bearer $ANON_KEY" \
      -d '{}')
    echo "  call $i → HTTP $CODE"
  done
else
  echo "── 7/7 rate-limit test SKIPPED (TEST_RATE_LIMIT=$TEST_RATE_LIMIT) ──"
fi
