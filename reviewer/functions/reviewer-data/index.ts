// reviewer-data — token-gated service-role data path for the reviewer instance.
//
// On the reviewer Supabase project the anon policies on `submissions` and
// `architect_cases` are DROPPED (see reviewer/migrations/REVIEWER_lockdown.sql),
// so the anon key alone can read/write NOTHING. The reviewer app therefore
// routes the calls it used to make with the anon key (the case list, architect
// submit, Phase 1 submit) through THIS function, which:
//   1. requires a valid reviewer token (X-Reviewer-Token) — else 401,
//   2. then performs the operation with the service-role key and returns the
//      PostgREST response VERBATIM (same body + status the direct REST call gave)
//      so the client is a drop-in.
// No valid token ⇒ no data in or out.
//
// Deploy with verify_jwt = false (auth is the reviewer token, checked here).

import { requireReviewerToken } from '../_shared/reviewer-token.ts';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-reviewer-token',
  'Access-Control-Max-Age':       '86400',
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}
function passthrough(upstreamBody: string, status: number): Response {
  return new Response(upstreamBody, { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SVC = { 'apikey': SERVICE_KEY, 'Authorization': 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json' };

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  // GATE: data path requires the reviewer token.
  const denied = await requireReviewerToken(req, CORS);
  if (denied) return denied;

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'invalid JSON' }, 400); }
  const action = body && body.action;

  try {
    if (action === 'list_cases') {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/architect_cases?order=created_at.desc&select=*`, { headers: SVC });
      return passthrough(await r.text(), r.status);
    }
    if (action === 'submit_architect') {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/architect_cases`, {
        method: 'POST', headers: { ...SVC, 'Prefer': 'return=representation' }, body: JSON.stringify(body.payload || {}),
      });
      return passthrough(await r.text(), r.status);
    }
    if (action === 'submit_phase1') {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/submissions`, {
        method: 'POST', headers: { ...SVC, 'Prefer': 'return=representation' }, body: JSON.stringify(body.payload || {}),
      });
      return passthrough(await r.text(), r.status);
    }
    return json({ error: 'unknown action' }, 400);
  } catch (e) {
    return json({ error: 'data op failed: ' + (e as Error).message }, 500);
  }
});
