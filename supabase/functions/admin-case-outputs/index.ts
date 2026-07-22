// admin-case-outputs — CONSUMER-TIER. Returns per-output generation PROVENANCE
// for a case so the admin case-detail view can show which model produced each
// output, when, and under which prompt. model_responses is NOT anon-readable
// (that masking keeps provider identity from consultants), so this read runs
// server-side with the service role and returns PROVENANCE ONLY.
//
// No secret gate: it is already-stored generation metadata the admin needs to
// see, and nobody holds the invoke secret. The response deliberately OMITS
// response_text and the row id, so it CANNOT de-mask a shuffled Phase-2 output
// (the identity-masking invariant is preserved) — only the model lineup,
// timestamps, and prompt version are exposed. Re-add a gate here if broader
// lock-down is ever required.
//
// POST { case_id } → { case_id, outputs: [{ provider, model_string,
//   model_snapshot, generated_at, created_at, prompt_version, temperature,
//   finish_reason, has_text, text_length }] }  (ordered by provider)

import { CORS_HEADERS, jsonResponse } from '../_shared/cors.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SERVICE_HEADERS = {
  'apikey': SUPABASE_SERVICE_ROLE_KEY,
  'Authorization': 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== 'POST') return jsonResponse({ error: 'method not allowed' }, 405);

  let body: any;
  try { body = await req.json(); } catch { return jsonResponse({ error: 'invalid JSON body' }, 400); }
  const caseId = typeof body.case_id === 'string' ? body.case_id.trim() : '';
  if (!caseId) return jsonResponse({ error: 'case_id required' }, 400);

  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/model_responses`
        + `?case_id=eq.${encodeURIComponent(caseId)}`
        + `&select=provider,model_string,model_snapshot,generated_at,created_at,prompt_version,temperature,finish_reason,response_text`
        + `&order=provider.asc`,
      { headers: SERVICE_HEADERS },
    );
    if (!res.ok) return jsonResponse({ error: `read failed: HTTP ${res.status}` }, 502);
    const rows = await res.json();
    const outputs = (Array.isArray(rows) ? rows : []).map((r: any) => ({
      provider:       r.provider,
      model_string:   r.model_string,
      model_snapshot: r.model_snapshot,
      generated_at:   r.generated_at,
      created_at:     r.created_at,
      prompt_version: r.prompt_version,
      temperature:    r.temperature,
      finish_reason:  r.finish_reason,
      has_text:       !!(r.response_text && r.response_text.trim()),
      text_length:    r.response_text ? r.response_text.length : 0,
    }));
    return jsonResponse({ case_id: caseId, outputs });
  } catch (e) {
    return jsonResponse({ error: 'read threw: ' + (e as Error).message }, 500);
  }
});
