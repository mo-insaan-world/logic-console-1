// case-annotation-counts — CONSUMER-TIER, browser-callable.
//
// Returns AGGREGATE per-case annotation counts (pilot-eligible submissions),
// nothing row-level. Replaces the browser's direct reads of submissions_pilot
// for the admin pipeline "X annotations" badge and the architect "X/3
// annotations" progress bar. Those counts must reflect ALL consultants'
// submissions on a case, but after the 2026-07-10 RLS lockdown a non-admin
// expert can only see their own rows — so the true count is computed here under
// the service role and only the aggregate {case_id: count} is returned.
//
// Auth: requires a verified Supabase user JWT (closed-registration program).
// Output carries no clinical content — counts only.
//
// POST { case_ids: string[] } → { counts: { [case_id]: number } }

import { CORS_HEADERS, jsonResponse, getClientIP } from '../_shared/cors.ts';
import { isRateLimited } from '../_shared/rate-limit.ts';

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SUPABASE_ANON_KEY         = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE_HEADERS = { 'apikey': SUPABASE_SERVICE_ROLE_KEY, 'Authorization': 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY };

const RATE_LIMIT_MAX = 60;
const RATE_LIMIT_WIN_MS = 60_000;
const CASE_IDS_MAX = 500;

async function verifyCaller(req: Request): Promise<boolean> {
  const authz = req.headers.get('Authorization') || '';
  const m = authz.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  const token = m[1].trim();
  if (token.split('.').length !== 3) return false;  // reject raw anon/service keys
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + token },
    });
    if (!res.ok) return false;
    const u = await res.json();
    return !!(u && typeof u.id === 'string');
  } catch { return false; }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== 'POST')    return jsonResponse({ error: 'method not allowed' }, 405);

  const ip = getClientIP(req);
  if (await isRateLimited('case-annotation-counts:' + ip, RATE_LIMIT_MAX, RATE_LIMIT_WIN_MS)) {
    return jsonResponse({ error: 'rate limit exceeded, retry shortly' }, 429);
  }

  if (!(await verifyCaller(req))) return jsonResponse({ error: 'unauthorized' }, 401);

  let body: { case_ids?: unknown };
  try { body = await req.json(); }
  catch { return jsonResponse({ error: 'invalid JSON body' }, 400); }

  const ids = Array.isArray(body.case_ids)
    ? [...new Set(body.case_ids.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length < 200))]
    : [];
  if (ids.length === 0) return jsonResponse({ counts: {} });
  if (ids.length > CASE_IDS_MAX) return jsonResponse({ error: `case_ids cannot exceed ${CASE_IDS_MAX}` }, 400);

  // Service-role read of the pilot view (all consultants' pilot-eligible rows).
  // Only case_id is selected; the aggregate is computed here and returned.
  const counts: Record<string, number> = {};
  try {
    const inList = ids.map(encodeURIComponent).join(',');
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/submissions_pilot?select=case_id&case_id=in.(${inList})`,
      { headers: SERVICE_HEADERS },
    );
    if (!res.ok) return jsonResponse({ error: `count read failed: HTTP ${res.status}` }, 502);
    const rows = await res.json();
    for (const r of rows) {
      const cid = (r as { case_id?: string }).case_id;
      if (typeof cid === 'string') counts[cid] = (counts[cid] || 0) + 1;
    }
  } catch (e) {
    return jsonResponse({ error: 'count read threw: ' + (e as Error).message }, 500);
  }

  return jsonResponse({ counts });
});
