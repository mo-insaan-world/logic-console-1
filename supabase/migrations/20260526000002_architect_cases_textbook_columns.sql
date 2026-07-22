-- Add the four textbook-approval columns to architect_cases.
--
-- These columns are documented in the in-source DDL comment block in
-- index.html (around line 1030) as "needs to be applied" but were
-- never actually run against the live Supabase project. Discovered
-- after applying the rejected-log migration (20260526000001) when an
-- information_schema query showed the live table missing them.
--
-- Both the legacy admin "approve textbook" path (adminApproveTextbook
-- in index.html, which was apparently inert without these columns —
-- the PATCH bodies referenced columns that didn't exist) AND the new
-- at-submit-time protocol-review flow (protocolAcceptSubmit /
-- protocolSavePending) depend on these. Adding them retroactively
-- unblocks both paths.
--
-- Defaults + nullability:
--   static_textbook_protocol jsonb           — nullable, no default.
--     Legacy shape: string[]. New shape: object[] with .step +
--     .reference + .provenance.verification_log (see migration
--     20260526000001 for the rejected-log shape; the kept-protocol
--     shape mirrors it with an additional provenance.verification_log
--     array). buildPhase2 dual-renders. Old rows (none today — the
--     column didn't exist) would have been null anyway; new rows are
--     null until ACCEPT & SUBMIT is clicked.
--
--   textbook_approved boolean DEFAULT false  — non-null, defaults to
--     false. "A case is not approved until it is." Existing rows
--     pre-migration get backfilled to false on this column add, which
--     is correct: none of them went through the architect-side
--     verification flow (which didn't exist yet), so none of them
--     count as architect-approved. Admin can manually approve via the
--     existing admin pipeline if they need to.
--
--   textbook_approved_by text                — nullable, no default.
--     Set to archId on architect ACCEPT, or to 'admin' on the admin
--     pipeline's approve action. Null until set.
--
--   textbook_approved_at timestamptz         — nullable, no default.
--     Set to now() ISO timestamp at the same moment as
--     textbook_approved_by. Null until set.
--
-- ADD COLUMN IF NOT EXISTS makes this idempotent — re-applying is a
-- no-op. Wrapped in a single transaction so the four additions are
-- atomic; either all four land or none do.

BEGIN;

ALTER TABLE public.architect_cases
  ADD COLUMN IF NOT EXISTS static_textbook_protocol jsonb;

ALTER TABLE public.architect_cases
  ADD COLUMN IF NOT EXISTS textbook_approved boolean NOT NULL DEFAULT false;

ALTER TABLE public.architect_cases
  ADD COLUMN IF NOT EXISTS textbook_approved_by text;

ALTER TABLE public.architect_cases
  ADD COLUMN IF NOT EXISTS textbook_approved_at timestamptz;

COMMENT ON COLUMN public.architect_cases.static_textbook_protocol IS
  'Ideal-standard standard-of-care management steps for the case. Legacy shape is text[] (admin-authored). New shape (from architect ACCEPT & SUBMIT) is jsonb object[] where each element is {step, reference: {source, section, recommendation_grade}, provenance: {generated_by, generated_at, generator_prompt_version, origin, verification_log[]}}. buildPhase2 in index.html dual-renders. See supabase/migrations/20260526000001 for the rejected-log companion column.';

COMMENT ON COLUMN public.architect_cases.textbook_approved IS
  'True once the standard-of-care steps for this case have been verified — by an architect at ACCEPT & SUBMIT time, or by an admin via the legacy adminApproveTextbook path. Defaults to false; cases at status=pending_protocol carry textbook_approved=false until completion. Denormalized for the admin queue filter; the rich audit trail lives in static_textbook_protocol[].provenance.verification_log.';

COMMENT ON COLUMN public.architect_cases.textbook_approved_by IS
  'Identifier of the actor who set textbook_approved=true. archId for architect ACCEPT path, "admin" for admin pipeline. Null until approved.';

COMMENT ON COLUMN public.architect_cases.textbook_approved_at IS
  'ISO timestamp at which textbook_approved was set to true. Null until approved. Distinct from the per-step verification_log entries — this captures the case-level approval moment.';

COMMIT;
