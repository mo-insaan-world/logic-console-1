# Werksmans reviewer instance — provisioning runbook

Stand up an **isolated** MLC at `www.insaan.world/medicine/MLC` behind a
server-validated **username + password** gate. The reviewer build points ONLY at
a throwaway Supabase project; production's address is physically absent from it.

> **Credentials are NOT stored in this repo.** The password lives only as a
> Supabase edge-function secret (`REVIEWER_ACCESS_PASSWORD`). Substitute the
> password you were given wherever you see `<REVIEWER_ACCESS_PASSWORD>` below.
> Do not paste the literal into any committed file.

Production project (DO NOT TOUCH): `lmrmteaclszgsvrfjnsg`.

---

## A. Create the reviewer Supabase project
Dashboard → New Project (e.g. `insaan-mlc-reviewer`). Note its **ref**, **URL**,
and **anon (publishable) key**. Everything below uses `--project-ref <REVIEWER_REF>`.

## B. Reproduce schema + RLS (NO data)
The repo migrations are **not** self-sufficient (the base tables `submissions`,
`model_responses`, `architect_cases` were created outside migrations). Use a
**schema-only** dump of production:

```bash
# schema only, public schema — NO rows
supabase db dump --db-url "$PROD_DB_URL" --schema public -f reviewer_schema.sql
psql "$REVIEWER_DB_URL" -f reviewer_schema.sql
# lock down: drop anon table access on the reviewer project
psql "$REVIEWER_DB_URL" -f reviewer/migrations/REVIEWER_lockdown.sql
```

## C. Deploy the edge functions (reviewer project)
Copy `reviewer/functions/_shared/*` into each function dir's `../_shared`, then:

```bash
# the gate + token-gated data path
supabase functions deploy reviewer-auth  --project-ref <REVIEWER_REF> --no-verify-jwt
supabase functions deploy reviewer-data  --project-ref <REVIEWER_REF> --no-verify-jwt

# token-gated COPIES of the two data functions (apply reviewer/PATCHES.md first)
supabase functions deploy phase2-model-outputs --project-ref <REVIEWER_REF> --no-verify-jwt
supabase functions deploy submit-phase2        --project-ref <REVIEWER_REF> --no-verify-jwt
```
(`score-case-difficulty` + `transcribe-audio` are OPTIONAL — architect submit
degrades to a PENDING rating without scoring, and dictation degrades to typing.
Deploy them only if you also set `ANTHROPIC_API_KEY` / `GROQ_API_KEY`.)

## D. Set the secrets (THE security boundary — env only, never in code)
```bash
supabase secrets set --project-ref <REVIEWER_REF> \
  REVIEWER_USERNAME='Werksmans' \
  REVIEWER_ACCESS_PASSWORD='<REVIEWER_ACCESS_PASSWORD>' \
  REVIEWER_TOKEN_SECRET="$(openssl rand -hex 32)"
```
`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` are injected by the platform.
Rotating `REVIEWER_ACCESS_PASSWORD` or `REVIEWER_TOKEN_SECRET` instantly revokes
access (existing tokens become unverifiable on the next call).

## E. Seed ONE synthetic case (no real data)
Seed `SOW-2024-1562` + its 5 `model_responses` so the consultant Phase 2 flow has
outputs to annotate. Export from production (read-only) and import to reviewer:
```bash
# rows only for the synthetic case
psql "$PROD_DB_URL" -c "\copy (select * from model_responses where case_id='SOW-2024-1562') to 'mr.csv' csv header"
psql "$REVIEWER_DB_URL" -c "\copy model_responses from 'mr.csv' csv header"
```
`SOW-2024-1562` itself is a static case in `cases.json` (no architect_cases row
needed). Do NOT copy `submissions`, `phase2_output_classifications`, or
`output_omissions` — those must stay empty until the reviewers create them.

## F. Build the reviewer client bundle
A copy of the production static site with a reviewer `supabase.js` + the gate:
```
reviewer-build/
  index.html          # copy of production index.html, UNCHANGED
  cases.json          # copy (SOW-2024-1562)
  supabase.js         # REVIEWER url + anon key ONLY (see below)
  reviewer-gate.js    # copy of reviewer/client/reviewer-gate.js
```
`supabase.js` (reviewer):
```js
var SUPABASE_URL = 'https://<REVIEWER_REF>.supabase.co';
var SUPABASE_ANON_KEY = '<reviewer anon/publishable key>';
```
In the reviewer `index.html`, load the gate immediately after supabase.js:
```html
<script src="supabase.js"></script>
<script src="reviewer-gate.js"></script>   <!-- add this line -->
```
The gate intercepts `window.fetch`, so the rest of `index.html` is unchanged: it
attaches the token to the reviewer edge functions and reroutes the (now
locked-down) anon-REST calls through `reviewer-data`.

## G. Vercel routing (production untouched)
1. Deploy `reviewer-build/` as its own Vercel static project → note its URL
   (`https://<reviewer-mlc>.vercel.app`).
2. In the **insaan.world** project's `vercel.json`, add ONLY this rewrite
   (leave all existing config intact):
```json
{ "rewrites": [
  { "source": "/medicine/MLC", "destination": "https://<reviewer-mlc>.vercel.app/index.html" },
  { "source": "/medicine/MLC/:path*", "destination": "https://<reviewer-mlc>.vercel.app/:path*" }
] }
```
Redeploy insaan.world. All other paths are unaffected.

---

## Verification (run after provisioning) — the DONE criteria
1. **Effective config:** view `www.insaan.world/medicine/MLC/supabase.js` → it
   contains the **reviewer** URL, NOT `lmrmteaclszgsvrfjnsg`.
2. **Login:** `Werksmans` + correct password → granted, token issued. Wrong
   username (right pw) → denied; wrong pw (right username) → denied; both
   identical "Access denied." messages.
3. **Data path without token (the load-bearing check):** with no/expired/forged
   `X-Reviewer-Token`, every call 401s and anon REST is empty:
   ```bash
   AK=<reviewer anon key>; U=https://<REVIEWER_REF>.supabase.co
   curl -s -o /dev/null -w '%{http_code}\n' -X POST "$U/functions/v1/phase2-model-outputs" \
     -H "Authorization: Bearer $AK" -H 'Content-Type: application/json' -d '{"case_id":"SOW-2024-1562"}'   # 401
   curl -s "$U/rest/v1/submissions?select=*" -H "apikey: $AK" -H "Authorization: Bearer $AK"                 # []
   curl -s "$U/rest/v1/architect_cases?select=*" -H "apikey: $AK" -H "Authorization: Bearer $AK"             # []
   ```
4. **Full flows in-browser** at `/medicine/MLC`: author+submit an architect case,
   and run consultant Phase 1 + Phase 2 annotate + submit.
5. **Isolation proof — production unchanged.** Using PRODUCTION service role,
   confirm ZERO new rows after step 4:
   ```sql
   select (select count(*) from submissions), (select count(*) from architect_cases),
          (select count(*) from phase2_output_classifications), (select count(*) from output_omissions);
   ```
   Then confirm the reviewer project shows the new rows. Writes landed in the
   reviewer project only.
6. **Bundle scan:** `view-source` of every reviewer asset (index.html,
   supabase.js, reviewer-gate.js) → the password string is absent.
7. **Repo scan:** `git grep - n "$REVIEWER_PW"` (export the password to a shell
   var first; do not type it inline) → zero matches in tracked files.
8. **Production non-MLC paths** still resolve.

## Security summary
- Both fields validated server-side in `reviewer-auth` with length-hiding
  constant-time compare; both evaluated unconditionally → generic denial.
- Success issues an HMAC-SHA256 token (signed by `REVIEWER_TOKEN_SECRET`, 4h
  expiry); the browser cannot forge or extend it.
- **Data path** (not just UI): reviewer RLS denies the anon key all table access,
  and `phase2-model-outputs` / `submit-phase2` / `reviewer-data` each require the
  token → no valid token ⇒ no reads, no writes, even bypassing the UI.
- Password exists only as `REVIEWER_ACCESS_PASSWORD`; revoke by rotating it.
