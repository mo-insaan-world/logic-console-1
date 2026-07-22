// admin-delete-case — ADMIN-TIER Edge Function.
//
// Deletes a single architect_cases row by id. Created because the
// enable_rls_pre_pilot migration revoked anon DELETE on architect_cases,
// breaking the prior browser-side adminDeleteCase. Anon delete restored
// would defeat the RLS protection (any client could delete any case);
// the service-role bypass lives here, behind FUNCTION_INVOKE_SECRET so
// the secret never reaches the browser.
//
// ── SECURITY MODEL — ADMIN TIER ───────────────────────────────────────────
// Same tier as build-action-union / generate-responses / score-responses:
// requires FUNCTION_INVOKE_SECRET via Authorization: Bearer. NOT browser-
// reachable. The browser admin UI shows a curl command for the admin to
// run from their terminal where the secret already lives in .env.
//
// ── SCOPE OF DELETE ───────────────────────────────────────────────────────
// architect_cases row only. Linked rows in other tables (submissions,
// case_action_union, case_consensus, etc.) reference case_id as a TEXT
// foreign key, not as a referential-integrity FK, so they're orphaned
// rather than cascaded. Preserves the historical browser-side semantic
// (the prior fetch DELETE also only touched architect_cases). If a future
// caller needs deeper cleanup, add an explicit cascade pass here.

import { jsonResponse } from '../_shared/cors.ts';
import { requireInvokeSecret } from '../_shared/auth.ts';

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SERVICE_HEADERS = {
  'apikey':        SUPABASE_SERVICE_ROLE_KEY,
  'Authorization': 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
};

// UUID v4-ish validation. Architect_cases.id is a uuid; reject anything
// else outright so an accidental SQL fragment can't reach the URL.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  const authError = requireInvokeSecret(req);
  if (authError) return authError;

  if (req.method !== 'POST') return jsonResponse({ error: 'method not allowed' }, 405);

  let body: any;
  try { body = await req.json(); }
  catch { return jsonResponse({ error: 'invalid JSON body' }, 400); }

  const caseId: unknown = body.case_id;
  if (typeof caseId !== 'string' || !UUID_RE.test(caseId.trim())) {
    return jsonResponse({ error: 'case_id required (uuid)' }, 400);
  }
  const id = caseId.trim();

  // Pre-fetch the row so the response can echo case_title for audit / UI.
  const preUrl = `${SUPABASE_URL}/rest/v1/architect_cases?id=eq.${encodeURIComponent(id)}&select=id,case_title,status,created_at`;
  const preRes = await fetch(preUrl, { headers: SERVICE_HEADERS });
  if (!preRes.ok) {
    return jsonResponse({ error: 'pre-fetch failed: ' + preRes.status + ' ' + await preRes.text() }, 500);
  }
  const preRows: any[] = await preRes.json();
  if (preRows.length === 0) {
    return jsonResponse({ ok: false, error: 'no architect_cases row with that id', case_id: id }, 404);
  }
  const target = preRows[0];

  // Delete via service role — bypasses RLS / the revoked anon DELETE.
  const delUrl = `${SUPABASE_URL}/rest/v1/architect_cases?id=eq.${encodeURIComponent(id)}`;
  const delRes = await fetch(delUrl, {
    method:  'DELETE',
    headers: { ...SERVICE_HEADERS, 'Prefer': 'return=representation' },
  });
  if (!delRes.ok) {
    return jsonResponse({ error: 'DELETE failed: ' + delRes.status + ' ' + await delRes.text() }, 500);
  }
  const deleted: any[] = await delRes.json();
  const ok = Array.isArray(deleted) && deleted.length === 1;

  return jsonResponse({
    ok,
    deleted_id:        target.id,
    deleted_title:     target.case_title,
    deleted_status:    target.status,
    deleted_created_at: target.created_at,
    cascade_note: 'submissions / case_action_union / case_consensus rows for this case_id are NOT cascaded (case_id is a TEXT identifier, no referential FK). Manual cleanup required if desired.',
  });
});
