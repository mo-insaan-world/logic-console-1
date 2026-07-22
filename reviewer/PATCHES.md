# Token-gating the existing service-role data functions (reviewer copies)

On the reviewer project, `phase2-model-outputs` (reads masked model outputs) and
`submit-phase2` (writes classifications + omissions) are `verify_jwt=false`
service-role functions — callable by anyone with the URL + anon key. For the
reviewer they MUST require the reviewer token. Apply this two-part change to the
**reviewer copies** of each function before deploying them to the reviewer
project (leave the production copies untouched).

## 1. Add the shared verifier import (top of each file)

```ts
import { requireReviewerToken } from '../_shared/reviewer-token.ts';
```

(Copy `reviewer/functions/_shared/reviewer-token.ts` and `reviewer-crypto.ts`
into the reviewer deployment's `functions/_shared/`.)

## 2. Gate at the very top of the handler — right after the OPTIONS/preflight
short-circuit and before any work (rate-limit, body parse, DB calls):

```ts
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });

  // ── Reviewer gate: no valid token ⇒ no data. ──
  const denied = await requireReviewerToken(req, CORS_HEADERS);
  if (denied) return denied;

  // … existing handler body unchanged …
});
```

Also add `x-reviewer-token` to the function's CORS `Access-Control-Allow-Headers`
(in `_shared/cors.ts` for the reviewer deployment, or inline) so the browser may
send the header:

```
'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-reviewer-token',
```

## Result

After this + `REVIEWER_lockdown.sql`:

| Path | Without a valid token |
| --- | --- |
| `submissions` / `architect_cases` direct anon REST | RLS denies (no anon policy) |
| `model_responses` etc. direct anon REST | RLS denies (already no policy) |
| `phase2-model-outputs` (read) | 401 (token required) |
| `submit-phase2` (write) | 401 (token required) |
| `reviewer-data` (list/architect/phase1) | 401 (token required) |

⇒ the anon key alone cannot read or write any reviewer data, and every edge
data path requires the unforgeable, expiring token.
