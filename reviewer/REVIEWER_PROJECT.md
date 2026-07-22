# Reviewer project — live provisioning status

Provisioned 2026-06-23. Isolated throwaway Supabase project; **never** production.

## Live facts
- **Project ref:** `abmmyjnhhxgyqspycecz`  (org: Insaan Inc, region us-east-1, paid ~$10/mo)
- **URL:** `https://abmmyjnhhxgyqspycecz.supabase.co`
- **Anon (publishable) key:** `sb_publishable_ifcCNox-wvTd0Z1Zz-CZxw_1_NIY7Fv`
- Production (DO NOT TOUCH): `lmrmteaclszgsvrfjnsg`

## Done (live, by me via MCP)
- **Schema:** 7 tables matching production's column shape — `submissions`,
  `architect_cases`, `model_responses`, `phase2_output_classifications`,
  `output_omissions`, `output_omission_reviews`, `rate_limit_hits`. **RLS ON,
  ZERO policies** on all → the anon key alone reads/writes nothing.
- **Edge functions deployed (`verify_jwt=false`):**
  - `reviewer-auth` — login gate (constant-time both fields, HMAC token)
  - `reviewer-data` — token-gated service-role data path (list/architect/phase1)
  - `phase2-model-outputs` — token-gated copy (read masked outputs)
- **Verified fail-closed (no secrets set yet):**
  - `phase2-model-outputs` / `reviewer-data` without token → `500 server misconfigured` (no data)
  - `reviewer-auth` junk creds → `500` (won't issue tokens until secrets set)
  - anon REST read `submissions` → `[]`; anon INSERT `submissions`/`architect_cases`
    → `42501 row-level security policy` (denied)

## Remaining (CLI / dashboard / Vercel — I can't do these from here)
All need the Supabase CLI (which you also need for secrets) or Vercel access.

1. **Deploy the 4th function** (31 KB — staged, gated, ready):
   ```bash
   supabase functions deploy submit-phase2 --project-ref abmmyjnhhxgyqspycecz --no-verify-jwt
   # source: reviewer/functions/submit-phase2/index.ts  (+ reviewer/functions/_shared/*)
   ```
2. **Set the secrets** (the gate stays fail-closed until these exist):
   ```bash
   supabase secrets set --project-ref abmmyjnhhxgyqspycecz \
     REVIEWER_USERNAME='Werksmans' \
     REVIEWER_ACCESS_PASSWORD='<the password you provided>' \
     REVIEWER_TOKEN_SECRET="$(openssl rand -hex 32)"
   ```
3. **Seed one synthetic case** (`SOW-2024-1562` + its 5 `model_responses`) — see
   SETUP.md §E (the model_responses already carry `prompt_version=redteam-neutral-v1`,
   so the gated reader will serve them).
4. **Reviewer client bundle + Vercel** — SETUP.md §F/§G:
   `supabase.js` → the reviewer URL + anon key above; add `<script src="reviewer-gate.js">`;
   deploy as a Vercel project; add the `/medicine/MLC` rewrite to insaan.world.

After 1–4, run the SETUP.md verification checklist (login pair, wrong-field
denials, no-token 401s, production-zero-rows isolation proof).
