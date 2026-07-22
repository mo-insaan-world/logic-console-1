// phase2-model-outputs — CONSUMER-TIER, browser-callable.
//
// Phase 2 (highlight-and-classify red-teaming) rates each model's full
// verbatim output. The browser must NOT see provider identity, and anon has
// no SELECT on model_responses, so this function returns the outputs with
// provider/model_string STRIPPED and order SHUFFLED server-side. The browser
// only ever holds an opaque output_id + the verbatim text.
//
// POST { case_id } → { outputs: [{ output_id, text }] }  (shuffled, masked)
//
// Identity masking is the rating-integrity invariant: a consultant must not
// be able to tell which model produced which output. submit-phase2 re-derives
// provider from output_id server-side when persisting classifications.

import { jsonResponse, CORS_HEADERS, getClientIP } from '../_shared/cors.ts';
import { isRateLimited } from '../_shared/rate-limit.ts';
import { PHASE2_PROVIDERS } from '../_shared/providers.ts';

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SERVICE_HEADERS = {
  'apikey':        SUPABASE_SERVICE_ROLE_KEY,
  'Authorization': 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
};

const RATE_LIMIT_MAX = 60;
const RATE_LIMIT_WIN_MS = 60_000;

// The single locked red-team prompt. ONLY outputs generated under this prompt
// version are rateable — a surgeon must never be served a stale/old-prompt
// plan to fill a slot. Rows without it (legacy benchmark-era outputs, or any
// provider not yet regenerated under the current prompt) are simply absent;
// showing one fewer plan is correct, showing a wrong-prompt plan is not.
// Keep in sync with PROMPT_VERSION in _shared/redteam-prompt.ts.
const CURRENT_PROMPT_VERSION = 'redteam-neutral-v1';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== 'POST') return jsonResponse({ error: 'method not allowed' }, 405);

  const ip = getClientIP(req);
  if (await isRateLimited('phase2-model-outputs:' + ip, RATE_LIMIT_MAX, RATE_LIMIT_WIN_MS)) {
    return jsonResponse({ error: 'rate limit exceeded, retry shortly' }, 429);
  }

  let body: { case_id?: string };
  try { body = await req.json(); }
  catch { return jsonResponse({ error: 'invalid JSON body' }, 400); }
  const caseId = (body.case_id || '').trim();
  if (!caseId) return jsonResponse({ error: 'case_id required' }, 400);

  // Pull the case's model outputs (service role). Only rows that actually
  // produced text are rateable — drop error/empty rows. Dedupe to the most
  // recent row per provider (same rule build-action-union uses) so an
  // upgraded model_string doesn't surface the same provider twice.
  // Hard-gate on the current prompt version: a row generated under any other
  // (or null) prompt can never reach a surgeon, even if it is the most-recent
  // row for its provider.
  let rows: Array<{ id: string; provider: string; response_text: string | null; created_at: string }>;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/model_responses`
        + `?case_id=eq.${encodeURIComponent(caseId)}`
        + `&prompt_version=eq.${encodeURIComponent(CURRENT_PROMPT_VERSION)}`
        + `&select=id,provider,response_text,created_at`
        + `&order=created_at.desc`,
      { headers: SERVICE_HEADERS },
    );
    if (!res.ok) return jsonResponse({ error: `model_responses read failed: HTTP ${res.status}` }, 502);
    rows = await res.json();
  } catch (e) {
    return jsonResponse({ error: 'read threw: ' + (e as Error).message }, 500);
  }

  // Canonical lineup allowlist: serve EXACTLY the three Phase 2 models
  // (Fable 5 / GPT-5.6 Sol / Gemini 3.1 Pro), identical on every case. Any other
  // provider still in the table (legacy deepseek/xai generation rows) is never
  // surfaced — no 4th/5th plan reaches a surgeon. Rows are not deleted; they
  // are simply not served here.
  const allow = new Set<string>(PHASE2_PROVIDERS);
  const seenProvider = new Set<string>();
  const outputs: Array<{ output_id: string; text: string }> = [];
  for (const r of rows) {
    if (!allow.has(r.provider)) continue;                 // not in the canonical three
    if (seenProvider.has(r.provider)) continue;          // keep most-recent per provider
    seenProvider.add(r.provider);
    const text = (r.response_text || '').trim();
    if (!text) continue;                                  // unrateable (error/empty)
    outputs.push({ output_id: r.id, text });              // provider deliberately omitted
  }

  // Fisher–Yates shuffle so output order carries no provider signal. Order is
  // randomized per request (per consultant load), matching the prior union
  // shuffle discipline.
  for (let i = outputs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [outputs[i], outputs[j]] = [outputs[j], outputs[i]];
  }

  return jsonResponse({ case_id: caseId, outputs });
});
