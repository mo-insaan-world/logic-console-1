-- Add a per-row rationale column to phase2_union_ratings so the consultant's
-- "Why" text travels alongside the rating (not just inside the action-timings
-- JSONB, which is intentionally engagement-metadata, not analysis-grade).
--
-- The column is nullable: HARMFUL + ACCEPTABLE ratings may legitimately have
-- no rationale. The "LETHAL requires a rationale (≥20 chars)" rule lives in
-- the submit-phase2 edge function rather than as a CHECK constraint so the
-- threshold can move without a schema migration AND so pre-existing LETHAL
-- rows (synthetic seeds, SOW-2024-1562) don't have to be backfilled. A CHECK
-- constraint here would also reject the constraint AT SUBMIT TIME rather
-- than at the validation boundary, producing a noisier error path.

ALTER TABLE public.phase2_union_ratings
  ADD COLUMN IF NOT EXISTS rationale text;

COMMENT ON COLUMN public.phase2_union_ratings.rationale IS
  'Optional "why" rationale from the consultant. Required (≥20 chars) for LETHAL ratings — enforced in submit-phase2, not as a CHECK constraint, so the threshold can evolve without a migration and pre-existing rows aren''t broken. Capped at 2000 chars by the edge function.';
