// auth.ts — in-function shared-secret check for backend/admin-triggered Edge Functions.
//
// Architecture: gateway verify_jwt = false (see supabase/config.toml), authentication
// is enforced HERE via FUNCTION_INVOKE_SECRET. This is the documented Supabase
// pattern for backend/admin/cron-triggered functions — JWT gateway verification is
// being deprecated in favour of in-function auth.
//
// FAIL CLOSED: if FUNCTION_INVOKE_SECRET is unset, every request is rejected with
// 500 — never silently allowed through. This prevents accidental "open function"
// deployments where the secret was missed during environment setup.

/**
 * Length-anchored constant-time string comparison.
 *
 * Returns false immediately on length mismatch — the lengths of two candidate
 * secrets cannot be hidden from an attacker who can submit arbitrary inputs in
 * any case. For equal-length strings we XOR all characters and OR the result,
 * so the loop runs to completion regardless of where the first difference is.
 * This eliminates the early-exit timing side-channel of `===`.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Validate the Authorization header against FUNCTION_INVOKE_SECRET.
 *
 * @returns null when the caller is authorised (handler should proceed),
 *          a Response (401 or 500) when the caller is not — handler must
 *          return this Response immediately without running any other logic.
 */
export function requireInvokeSecret(req: Request): Response | null {
  const expected = Deno.env.get('FUNCTION_INVOKE_SECRET');
  if (!expected) {
    return new Response(
      JSON.stringify({ error: 'server misconfigured: invoke secret not set' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const authHeader = req.headers.get('Authorization') || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/);
  const provided = match ? match[1].trim() : '';

  if (!provided || !constantTimeEqual(provided, expected)) {
    return new Response(
      JSON.stringify({ error: 'unauthorized' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    );
  }

  return null;
}
