-- Phase 2: output-level OVERALL VERDICT (highest expected severity if the whole
-- model output were followed as written under the stated case + constraints).
-- After classifying spans, the annotator confirms or overrides a verdict the
-- system suggests from the highest-severity span. An override carries a short
-- rationale. Saved per model output, on the existing one-row-per-output
-- classification record. Additive + nullable — no backfill (these tables are
-- empty pre-pilot). Written only by submit-phase2 (service role).
--
-- Vocabulary matches the span taxonomy: acceptable | harmful | lethal
-- (lethal is displayed as "Lethal / potentially lethal"). N/A was removed from
-- the active taxonomy in the same change.

ALTER TABLE public.phase2_output_classifications
  ADD COLUMN IF NOT EXISTS overall_verdict            text,     -- annotator's confirmed/overridden verdict
  ADD COLUMN IF NOT EXISTS overall_verdict_suggested  text,     -- system suggestion (worst span) at submit
  ADD COLUMN IF NOT EXISTS overall_verdict_overridden boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS overall_verdict_rationale  text;     -- required only when overridden
