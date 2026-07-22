// auto-build-union — CONSUMER-TIER orchestrator.
//
// Fires the candidate-action-union pipeline for an architect case without a
// manual admin step. Browser-callable (anon): the architect-submit and admin-
// edit flows POST { case_id } here; the admin/architect "Build / Retry" button
// POSTs { case_id, force: true }. This function holds FUNCTION_INVOKE_SECRET
// server-side (never in the browser) and uses it to call the existing ADMIN-
// tier functions — it does NOT reimplement the pipeline:
//
//   generate-responses  (the 5 providers → model_responses)
//   build-action-union  (atom extraction + clustering → case_action_union)
//
// ── ASYNC ──────────────────────────────────────────────────────────────────
// The full cycle is ~3 min. We set union_status='union_building', respond
// immediately, and run the chain in EdgeRuntime.waitUntil so the caller's
// submit never blocks. On success → union_ready; on error → union_failed
// (union_error captured for the admin view).
//
// ── REDUNDANCY GUARD ───────────────────────────────────────────────────────
// union_content_hash = SHA-256 over {scenario, vitals, constraints, specialty}.
// When !force and the hash is unchanged AND a union already exists, we skip —
// cosmetic edits (e.g. case title, which is NOT in the hash) don't re-spend.
// force:true (manual button) always (re)builds.

import { jsonResponse, CORS_HEADERS } from '../_shared/cors.ts';
import { PHASE2_PROVIDERS } from '../_shared/providers.ts';

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const FUNCTION_INVOKE_SECRET    = Deno.env.get('FUNCTION_INVOKE_SECRET') || '';

const SERVICE_HEADERS = {
  'Content-Type':  'application/json',
  'apikey':        SUPABASE_SERVICE_ROLE_KEY,
  'Authorization': 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
};
const INVOKE_HEADERS = {
  'Content-Type':  'application/json',
  'Authorization': 'Bearer ' + FUNCTION_INVOKE_SECRET,
};

// The construction set fired on every build — the fixed canonical THREE
// (Fable 5 / GPT-5.6 Sol / Gemini 3.1 Pro), identical on every case. Single source
// of truth in _shared/providers.ts so generation and the phase2-model-outputs
// serving allowlist can never drift apart.
const PROVIDERS = [...PHASE2_PROVIDERS];

// Stable, key-sorted JSON so the hash doesn't churn on jsonb key reordering.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = canonical((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}
async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function patchCase(caseId: string, fields: Record<string, unknown>): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/architect_cases?id=eq.${encodeURIComponent(caseId)}`, {
    method: 'PATCH',
    headers: { ...SERVICE_HEADERS, 'Prefer': 'return=minimal' },
    body: JSON.stringify(fields),
  });
}

async function unionRowCount(caseId: string): Promise<number> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/case_action_union?case_id=eq.${encodeURIComponent(caseId)}&select=id`,
    { headers: { ...SERVICE_HEADERS, 'Prefer': 'count=exact' } },
  );
  const cr = res.headers.get('content-range') || '';
  const m = cr.match(/\/(\d+)$/);
  if (m) return parseInt(m[1], 10);
  try { return (await res.json()).length || 0; } catch { return 0; }
}

// Run the (slow) pipeline. Updates union_status to ready/failed at the end.
async function runPipeline(caseId: string, caseData: Record<string, unknown>, forceRebuild: boolean): Promise<void> {
  try {
    const genRes = await fetch(`${SUPABASE_URL}/functions/v1/generate-responses`, {
      method: 'POST',
      headers: INVOKE_HEADERS,
      body: JSON.stringify({ case_id: caseId, case_data: caseData, providers: PROVIDERS }),
    });
    if (!genRes.ok) {
      const detail = (await genRes.text().catch(() => '')).slice(0, 500);
      await patchCase(caseId, { union_status: 'union_failed', union_error: `generate-responses HTTP ${genRes.status}: ${detail}` });
      return;
    }

    const buildRes = await fetch(`${SUPABASE_URL}/functions/v1/build-action-union`, {
      method: 'POST',
      headers: INVOKE_HEADERS,
      body: JSON.stringify({ case_id: caseId, force_rebuild: forceRebuild }),
    });
    if (!buildRes.ok) {
      const detail = (await buildRes.text().catch(() => '')).slice(0, 500);
      await patchCase(caseId, { union_status: 'union_failed', union_error: `build-action-union HTTP ${buildRes.status}: ${detail}` });
      return;
    }

    await patchCase(caseId, { union_status: 'union_ready', union_error: null });
  } catch (e) {
    await patchCase(caseId, { union_status: 'union_failed', union_error: `pipeline error: ${(e as Error).message}` });
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return jsonResponse({ error: 'method not allowed' }, 405);
  if (!FUNCTION_INVOKE_SECRET) return jsonResponse({ error: 'server misconfigured: invoke secret not set' }, 500);

  let body: { case_id?: string; force?: boolean };
  try { body = await req.json(); }
  catch { return jsonResponse({ error: 'invalid JSON body' }, 400); }

  const caseId = (body.case_id || '').trim();
  const force  = body.force === true;
  if (!caseId) return jsonResponse({ error: 'case_id required' }, 400);

  // Load the case (service role). Auto-build is architect-cases only —
  // synthetic cases.json cases keep the manual curl path.
  const caseRes = await fetch(
    `${SUPABASE_URL}/rest/v1/architect_cases?id=eq.${encodeURIComponent(caseId)}&select=id,scenario_json,vitals_json,constraints_json,specialty,union_status,union_content_hash`,
    { headers: SERVICE_HEADERS },
  );
  if (!caseRes.ok) return jsonResponse({ error: `case lookup failed: HTTP ${caseRes.status}` }, 502);
  const rows = await caseRes.json();
  if (!Array.isArray(rows) || rows.length === 0) return jsonResponse({ error: 'case not found in architect_cases' }, 404);
  const row = rows[0];

  const newHash = await sha256Hex(JSON.stringify(canonical({
    scenario:    row.scenario_json    ?? {},
    vitals:      row.vitals_json       ?? {},
    constraints: row.constraints_json  ?? {},
    specialty:   row.specialty         ?? 'trauma',
  })));

  const existingUnion = await unionRowCount(caseId);

  // Redundancy guard: unchanged content + a union already present + not forced
  // → leave the existing union intact, don't re-spend on the providers. NOT
  // gated on union_status==='union_ready' — a prior build whose trailing
  // status PATCH was lost (background task killed) still has its union + hash,
  // so we skip the re-spend AND self-heal the status here.
  if (!force && existingUnion > 0 && row.union_content_hash === newHash) {
    if (row.union_status !== 'union_ready') {
      await patchCase(caseId, { union_status: 'union_ready', union_error: null });
    }
    return jsonResponse({ status: 'union_ready', skipped: true, reason: 'no material change since last build' });
  }

  // generate-responses wants constraints under `constraints` (not _json).
  const caseData = {
    scenario_json:    row.scenario_json,
    vitals_json:      row.vitals_json,
    constraints:      row.constraints_json,
    specialty:        row.specialty,
  };

  // Mark building + stamp the hash now, then return immediately. The heavy
  // chain runs in the background (waitUntil) so the caller's submit doesn't block.
  await patchCase(caseId, { union_status: 'union_building', union_content_hash: newHash, union_error: null });

  const task = runPipeline(caseId, caseData, existingUnion > 0);
  // @ts-ignore — EdgeRuntime is provided by the Supabase edge runtime.
  if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime.waitUntil) EdgeRuntime.waitUntil(task);
  else task; // best-effort fallback (no awaiting — caller must not block)

  return jsonResponse({ status: 'union_building', case_id: caseId, rebuild: existingUnion > 0 });
});
