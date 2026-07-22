#!/usr/bin/env bash
# validate-5models.sh — Option A validation: one case, all five providers.
#
# Confirms every active provider adapter / API key / model string resolves
# correctly before committing to the full benchmark matrix. Uses SOW-2024-1562
# (the full-resource positive control) — no provider should trip the M_c=0
# safety gate, so any non-OK result isolates an adapter/key/model-string issue.
#
# OpenAI, DeepSeek, and xAI all use the 'reasoning' shape with per-entry
# overrides (token-cap field name, value, temperature on/off). Gemini-2.5-pro
# is also a reasoning model but uses its own 'gemini' wire shape (Google's
# contents/parts/generationConfig, not OpenAI chat-completions) — the gemini
# branch in callModel already honours tokenCap and sendTemperature.
#
# Output now includes finish_reason + completion_tokens / reasoning_tokens
# per provider — a 'length' / 'max_tokens' finish_reason means the response
# was truncated and any score against it is unreliable.
#
# Resilient: per-provider failures are reported but do not abort the run.
# Every step runs to completion so you see the full pass/fail map in one shot.
#
# Usage:  ./validate-5models.sh

# Note: NO `set -e`. We intentionally let curls / scoring calls fail per-provider
# without aborting the run — that is the whole point of this script. We still
# fail fast on missing FUNCTION_INVOKE_SECRET (the auth preflight), and `set -u`
# catches typos / unset vars elsewhere.
set -uo pipefail

# ── Preflight: load FUNCTION_INVOKE_SECRET from .env ──────────────────────────
if [ ! -f .env ]; then
  echo "✗ .env not found in $(pwd). Run this script from the repo root." >&2
  exit 1
fi
set -a
# shellcheck disable=SC1091
source .env
set +a

if [ -z "${FUNCTION_INVOKE_SECRET:-}" ]; then
  echo "✗ FUNCTION_INVOKE_SECRET not set in .env." >&2
  exit 1
fi

PROJECT_URL="https://lmrmteaclszgsvrfjnsg.supabase.co"
PROVIDERS=("anthropic" "openai" "gemini" "xai" "deepseek")
CASE_ID="SOW-2024-1562"

# Build the request body: SOW positive-control case + explicit providers array
# (overrides the function's default of ['anthropic']).
GEN_BODY=$(jq -c \
  --argjson provs '["anthropic","openai","gemini","xai","deepseek"]' \
  --arg cid "$CASE_ID" \
  '{ case_id: $cid, case_data: (map(select(.id == $cid)) | .[0]), providers: $provs }' \
  cases.json)

# ── 1/6 generate-responses (all 5 active providers in one call) ──────────────
echo "── 1/6 generate-responses ${CASE_ID} (all 5 active providers in one call) ──"
echo "    Expected: each provider returns status=ok with text_length > 0 and"
echo "    finish_reason NOT in {length, max_tokens, MAX_TOKENS}."
echo "    A 'length'/'max_tokens' finish_reason means the response was truncated"
echo "    and any score against it is unreliable."
echo
# Capture the raw response first so a non-success body (e.g. 504 IDLE_TIMEOUT,
# 401, or a plain string error) doesn't crash the jq pipeline and hide what
# was actually persisted.
RAW=$(curl -sS -w '\n___HTTP___:%{http_code}' -X POST "$PROJECT_URL/functions/v1/generate-responses" \
  -H "Authorization: Bearer $FUNCTION_INVOKE_SECRET" \
  -H "Content-Type: application/json" \
  -d "$GEN_BODY")
HTTP_STATUS="${RAW##*___HTTP___:}"
BODY="${RAW%___HTTP___:*}"
echo "  generate-responses HTTP ${HTTP_STATUS}"
echo "$BODY" | jq 'if .results then {
        case_id,
        providers_invoked,
        results: [.results[] | {
          provider,
          model_string,
          status,
          text_length,
          finish_reason,
          completion_tokens: (.usage.completion_tokens // .usage.output_tokens // .usage.candidatesTokenCount),
          reasoning_tokens: (.usage.completion_tokens_details.reasoning_tokens // null),
          error
        }]
      } else . end' 2>/dev/null || echo "$BODY"

# ── 2-6/6 score-responses, once per provider ─────────────────────────────────
# Each call is independent; a failure on one provider does NOT halt the loop.
# Scoring of a provider whose generate-responses errored will return 404/422
# ("No model_responses row" or "row has no usable text") — that is expected and
# reported as-is.
step=2
for provider in "${PROVIDERS[@]}"; do
  echo
  echo "── ${step}/6 score-responses ${CASE_ID} (${provider}) ──"
  echo "    Expected for positive control: m_c=1, performance_tier in {GOLD_STANDARD, FRAGILE}, NOT SAFETY_VIOLATION."
  echo
  # Capture so we can attach the requested provider label even if response has no .provider field (error case)
  RESULT=$(curl -sS -X POST "$PROJECT_URL/functions/v1/score-responses" \
    -H "Authorization: Bearer $FUNCTION_INVOKE_SECRET" \
    -H "Content-Type: application/json" \
    -d "{\"case_id\":\"${CASE_ID}\",\"provider\":\"${provider}\"}")
  echo "$RESULT" | jq --arg p "$provider" '{
      provider: (.provider // $p),
      icatr_score,
      m_c,
      a_c,
      w_c,
      performance_tier,
      violation_count,
      error
    }'
  step=$((step + 1))
done

echo
echo "── done ──"
echo "Review the per-provider results above. For SOW-2024-1562 (positive control)"
echo "every provider that generated a response should score m_c=1 and NOT SAFETY_VIOLATION."
echo "Any error tells you that provider's adapter/key/model-string needs fixing."
echo "Any finish_reason of 'length'/'max_tokens' tells you the tokenCap in"
echo "providers.ts needs to be raised for that provider before its score is trusted."
