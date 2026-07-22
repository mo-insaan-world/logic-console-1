// reviewer-auth — server-side username+password gate for the Werksmans reviewer
// instance. Validates BOTH fields server-side with constant-time comparison and,
// on success, returns a short-lived HMAC-signed token. On any failure it returns
// a SINGLE generic denial that never reveals which field was wrong.
//
// SECRETS (env only — never in source, the bundle, or git):
//   REVIEWER_USERNAME         expected username   (e.g. "Werksmans")
//   REVIEWER_ACCESS_PASSWORD  expected password   (the literal lives ONLY here)
//   REVIEWER_TOKEN_SECRET     HMAC signing key for the session token
//
// Deploy with verify_jwt = false (the gate IS the auth; it must be reachable
// pre-login). Abuse is bounded by the per-IP rate limit below.

import { constantTimeEqual } from '../_shared/reviewer-crypto.ts';
import { issueReviewerToken } from '../_shared/reviewer-token.ts';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Max-Age':       '86400',
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

const USERNAME = Deno.env.get('REVIEWER_USERNAME') ?? '';
const PASSWORD = Deno.env.get('REVIEWER_ACCESS_PASSWORD') ?? '';
const TOKEN_SECRET = Deno.env.get('REVIEWER_TOKEN_SECRET') ?? '';

// Tiny in-memory per-IP throttle (best-effort; resets on cold start). The
// reviewer instance is single-tenant + low-traffic, so this is sufficient to
// blunt online password guessing without a DB round-trip.
const HITS = new Map<string, number[]>();
const WINDOW_MS = 60_000, MAX_PER_WINDOW = 10;
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const arr = (HITS.get(ip) ?? []).filter(t => now - t < WINDOW_MS);
  arr.push(now);
  HITS.set(ip, arr);
  return arr.length > MAX_PER_WINDOW;
}
function clientIP(req: Request): string {
  return (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim()
    || req.headers.get('cf-connecting-ip') || 'unknown';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  // FAIL CLOSED if any server secret is unset — never accept logins in a
  // misconfigured deployment.
  if (!USERNAME || !PASSWORD || !TOKEN_SECRET) return json({ error: 'server misconfigured' }, 500);

  if (rateLimited(clientIP(req))) return json({ error: 'too many attempts, retry shortly' }, 429);

  let body: { username?: string; password?: string };
  try { body = await req.json(); } catch { return json({ error: 'invalid credentials' }, 401); }
  const username = typeof body.username === 'string' ? body.username : '';
  const password = typeof body.password === 'string' ? body.password : '';

  // Evaluate BOTH comparisons unconditionally (no short-circuit) so neither the
  // result nor the timing reveals which field was wrong.
  const [userOK, passOK] = await Promise.all([
    constantTimeEqual(username, USERNAME),
    constantTimeEqual(password, PASSWORD),
  ]);

  if (userOK && passOK) {
    const { token, expires_in } = await issueReviewerToken();
    return json({ ok: true, token, expires_in });
  }
  return json({ error: 'invalid credentials' }, 401);   // generic — never says which field
});
