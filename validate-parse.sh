#!/usr/bin/env bash
# validate-parse.sh — Slice 1 validation for parse-actions (consumer-tier).
#
# Tests the parse-actions Edge Function in isolation, with NO dependence on
# the consultant UI. Uses the public anon key (same key the browser will use)
# in the Authorization header — confirms the consumer-tier auth path works
# without leaking the admin-tier FUNCTION_INVOKE_SECRET.
#
# Usage:  ./validate-parse.sh

set -uo pipefail

PROJECT_URL="https://lmrmteaclszgsvrfjnsg.supabase.co"
ANON_KEY="sb_publishable_hAcVbzEFM5s0r-8IIhrS4Q_nOArlR7d"  # public by design — already in supabase.js
ENDPOINT="$PROJECT_URL/functions/v1/parse-actions"

AUTH=(-H "Authorization: Bearer $ANON_KEY" -H "Content-Type: application/json")

# ── Test 1: normal parse — realistic ~150-word trauma trace ───────────────────
# Expected: { atoms: [...] } with several 5-12 word strings, including at least
# one explicit negative action ("Did NOT pursue CT angiography").

TRACE="On arrival, immediate primary survey — secured airway with rapid sequence intubation using ketamine and rocuronium given the haemodynamic instability. Applied bilateral pelvic binder for the suspected unstable pelvic ring injury. Activated massive haemorrhage protocol, transfused two units O-negative through the rapid infuser. Did NOT proceed to immediate laparotomy given the transient responder status — opted for damage control imaging with FAST scan first, which showed free fluid in the right upper quadrant. Inserted bilateral large-bore femoral lines for further resuscitation access. Called interventional radiology for possible angioembolisation of the pelvic bleeding. Did NOT obtain CT angiography given the lack of time and ongoing haemodynamic instability. Transferred directly to theatre for damage control laparotomy and external pelvic fixation."

NORMAL_BODY=$(jq -n --arg t "$TRACE" --arg m "damage" '{ action_trace: $t, mode: $m }')

echo "── 1/3 normal parse — ~150-word trauma trace (expect atoms array with negatives) ──"
curl -sS -X POST "$ENDPOINT" "${AUTH[@]}" -d "$NORMAL_BODY" | jq

# ── Test 2: input cap — 9000-char string (expect 413) ─────────────────────────
echo
echo "── 2/3 input-cap test — 9000-char input (expect 413 'action_trace too long') ──"
LONG_TRACE=$(head -c 9000 /dev/urandom | base64 | head -c 9000)
LONG_BODY=$(jq -n --arg t "$LONG_TRACE" --arg m "damage" '{ action_trace: $t, mode: $m }')
curl -sS -w "\nHTTP %{http_code}\n" -X POST "$ENDPOINT" "${AUTH[@]}" -d "$LONG_BODY" | jq -R '. as $line | try fromjson catch $line'

# ── Test 3: rate limit — fire 35 small calls rapidly (expect 429 after 30) ────
# The limiter is global (rate_limit_hits table, 30/min/IP), so all 35 calls
# share the same bucket regardless of which edge-function instance serves them.
# Expect HTTP 200 on calls 1–30 and HTTP 429 on calls 31–35.
# Skip with TEST_RATE_LIMIT=false ./validate-parse.sh if cost-conscious
# (each tiny call is ~1¢ of Sonnet usage on the successful ones).
TEST_RATE_LIMIT="${TEST_RATE_LIMIT:-true}"
echo
if [ "$TEST_RATE_LIMIT" = "true" ]; then
  echo "── 3/3 rate-limit test — 35 rapid calls (expect 200 ×30 then 429 ×5) ──"
  TINY_BODY=$(jq -nc '{ action_trace: "Applied tourniquet.", mode: "damage" }')
  for i in $(seq 1 35); do
    CODE=$(curl -sS -o /dev/null -w "%{http_code}" -X POST "$ENDPOINT" "${AUTH[@]}" -d "$TINY_BODY")
    echo "  call $i → HTTP $CODE"
  done
else
  echo "── 3/3 rate-limit test SKIPPED (TEST_RATE_LIMIT=$TEST_RATE_LIMIT) ──"
fi

echo
echo "── done ──"
