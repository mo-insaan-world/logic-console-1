-- Multi-specialty (ICAM-R): specialty enum on architect_cases.
--
-- The specialty field drives exactly four things — specialist list,
-- specialty-specific constraint set, model prompt domain framing
-- (generate-responses), and architect-form field ordering. Scoring,
-- tiers, Phase 1/2 flow, atoms, facility archetypes, transfer time and
-- consultant IDs are specialty-blind.
--
-- Derive-on-read: every existing row (and any row inserted by a stale
-- cached browser bundle that omits the column) defaults to 'trauma' —
-- no backfill needed, NOT NULL holds from day one.
--
-- Synthetic-firewall note: the GI test case GI-TEST-001 lives in
-- cases.json (synthetic: true), not in this table. If pre-pilot test
-- submissions are ever made against it, flag them synthetic by case_id
-- the same way the BRH rows were (migration 20260530000003).

ALTER TABLE public.architect_cases
  ADD COLUMN IF NOT EXISTS specialty text NOT NULL DEFAULT 'trauma';

ALTER TABLE public.architect_cases
  DROP CONSTRAINT IF EXISTS architect_cases_specialty_check;

ALTER TABLE public.architect_cases
  ADD CONSTRAINT architect_cases_specialty_check
  CHECK (specialty IN ('trauma', 'gastroenterology'));
