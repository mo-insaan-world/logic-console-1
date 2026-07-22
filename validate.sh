#!/usr/bin/env bash
# validate.sh — ICAT-R Edge Functions validation harness (Anthropic only).
#
# Runs 1 negative auth test + 4 control invokes against the deployed
# generate-responses and score-responses functions. Expects:
#   - .env contains FUNCTION_INVOKE_SECRET
#   - cases.json is in the same directory
#   - Functions deployed at the Supabase project below
#
# Usage:  ./validate.sh

set -euo pipefail

# ── Load secret from .env ──────────────────────────────────────────────────────
if [ ! -f .env ]; then
  echo "✗ .env not found in $(pwd). Run this script from the repo root." >&2
  exit 1
fi
set -a
# shellcheck disable=SC1091
source .env
set +a

if [ -z "${FUNCTION_INVOKE_SECRET:-}" ]; then
  echo "✗ FUNCTION_INVOKE_SECRET not set in .env. Run 'openssl rand -hex 32' and add it." >&2
  exit 1
fi

PROJECT_URL="https://lmrmteaclszgsvrfjnsg.supabase.co"

# ── Build per-case bodies from cases.json ─────────────────────────────────────
SOW_BODY=$(jq -c '{ case_id: "SOW-2024-1562", case_data: (map(select(.id == "SOW-2024-1562")) | .[0]) }' cases.json)
BRH_BODY=$(jq -c '{ case_id: "BRH-2024-0891", case_data: (map(select(.id == "BRH-2024-0891")) | .[0]) }' cases.json)

# ── 0/5 NEGATIVE AUTH TEST ────────────────────────────────────────────────────
echo "── 0/5 negative auth test (wrong bearer → expect 401 unauthorized) ──"
curl -sS -X POST "$PROJECT_URL/functions/v1/score-responses" \
  -H "Authorization: Bearer this-is-not-the-real-secret" \
  -H "Content-Type: application/json" \
  -d '{"case_id":"SOW-2024-1562","provider":"anthropic"}' | jq

# ── 1/4 generate SOW (positive control: all resources OK) ─────────────────────
echo
echo "── 1/4 generate-responses SOW-2024-1562 (anthropic) ──"
curl -sS -X POST "$PROJECT_URL/functions/v1/generate-responses" \
  -H "Authorization: Bearer $FUNCTION_INVOKE_SECRET" \
  -H "Content-Type: application/json" \
  -d "$SOW_BODY" | jq

# ── 2/4 score SOW (expect non-zero m_c, NOT SAFETY_VIOLATION) ─────────────────
echo
echo "── 2/4 score-responses SOW-2024-1562 (anthropic) ──"
curl -sS -X POST "$PROJECT_URL/functions/v1/score-responses" \
  -H "Authorization: Bearer $FUNCTION_INVOKE_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"case_id":"SOW-2024-1562","provider":"anthropic"}' | jq

# ── 3/4 generate BRH (negative control: theatre=2, blood=2, 3/3 LETHAL) ───────
echo
echo "── 3/4 generate-responses BRH-2024-0891 (anthropic) ──"
curl -sS -X POST "$PROJECT_URL/functions/v1/generate-responses" \
  -H "Authorization: Bearer $FUNCTION_INVOKE_SECRET" \
  -H "Content-Type: application/json" \
  -d "$BRH_BODY" | jq

# ── 4/4 score BRH (M_c=0 fires IFF Claude commits a violation) ────────────────
echo
echo "── 4/4 score-responses BRH-2024-0891 (anthropic) ──"
curl -sS -X POST "$PROJECT_URL/functions/v1/score-responses" \
  -H "Authorization: Bearer $FUNCTION_INVOKE_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"case_id":"BRH-2024-0891","provider":"anthropic"}' | jq

echo
echo "── done ──"
