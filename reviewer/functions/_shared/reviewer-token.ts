// reviewer-token.ts — issue + verify the short-lived HMAC session token for the
// reviewer gate. The signing secret is read ONLY from the environment
// (REVIEWER_TOKEN_SECRET); it never appears in source or reaches the client.
//
// Token format:  base64url(JSON{exp}) + "." + base64url(HMAC_SHA256(payload, SECRET))
// The browser cannot forge or extend it (no secret), and cannot set an
// "authenticated=true" flag in its place — every data call re-verifies the HMAC
// and the expiry server-side.

import { b64urlFromBytes, b64urlToBytes, hmacBytes, constantTimeEqual } from './reviewer-crypto.ts';

const TOKEN_SECRET = Deno.env.get('REVIEWER_TOKEN_SECRET') ?? '';
const TTL_SECONDS = 4 * 60 * 60;   // 4 hours

function nowSec(): number { return Math.floor(Date.now() / 1000); }

export async function issueReviewerToken(): Promise<{ token: string; expires_in: number }> {
  const payload = b64urlFromBytes(new TextEncoder().encode(JSON.stringify({ exp: nowSec() + TTL_SECONDS })));
  const sig = b64urlFromBytes(await hmacBytes(TOKEN_SECRET, payload));
  return { token: payload + '.' + sig, expires_in: TTL_SECONDS };
}

// Returns null when the request carries a valid, unexpired token; otherwise a
// Response (401, or 500 if the server secret is missing — FAIL CLOSED) that the
// caller must return immediately. The denial is generic.
export async function requireReviewerToken(req: Request, headers: Record<string, string>): Promise<Response | null> {
  const deny = (status: number, error: string) =>
    new Response(JSON.stringify({ error }), { status, headers: { ...headers, 'Content-Type': 'application/json' } });

  if (!TOKEN_SECRET) return deny(500, 'server misconfigured');

  const raw = req.headers.get('X-Reviewer-Token') ?? '';
  const dot = raw.indexOf('.');
  if (dot < 1 || dot === raw.length - 1) return deny(401, 'unauthorized');
  const payload = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);

  const expected = b64urlFromBytes(await hmacBytes(TOKEN_SECRET, payload));
  if (!(await constantTimeEqual(sig, expected))) return deny(401, 'unauthorized');

  let obj: any;
  try { obj = JSON.parse(new TextDecoder().decode(b64urlToBytes(payload))); }
  catch { return deny(401, 'unauthorized'); }
  if (!obj || typeof obj.exp !== 'number' || obj.exp < nowSec()) return deny(401, 'unauthorized');

  return null;   // authorized
}
