-- Drop architect-side SoC attestation columns — methodology alignment.
--
-- Paper Section 3.1 pins the architect role to scenario authoring +
-- constraint setting + ground-truth trace, with NO further involvement in
-- scoring or adjudication. The static standard-of-care attestation flow
-- (architect reviews LLM-drafted steps + attests / rejects each) is no
-- longer part of the methodology. The negative reference for Phase 2
-- scoring is now the deduplicated candidate-model action union
-- (case_action_union) rated by consultants in Phase 2.
--
-- Pre-drop audit (2026-05-30): architect_cases has ZERO rows total. None
-- of the SoC/attestation columns have any data. Drop latitude is full.
--   COUNT(*) FROM architect_cases                                   = 0
--   COUNT(static_textbook_protocol)                                 = 0
--   COUNT(static_textbook_protocol_rejected_log)                    = 0
--   COUNT(*) FILTER (WHERE textbook_approved = true)                = 0
--   COUNT(textbook_approved_by)                                     = 0
--   COUNT(textbook_approved_at)                                     = 0
--   COUNT(architect_attestation_duration_ms)                        = 0
--   COUNT(registrar_steps_json)                                     = 0
--
-- Preserved:
--   submissions.standard_of_care_steps (text/jsonb, 17 pre-pilot rows)
--     submit-phase2 v10 already writes NULL on new rows; column stays
--     for historical row inspection per the user-confirmed rule that
--     non-zero-row columns are preserved, not dropped.
--   score-case-difficulty edge function + difficulty_rating column +
--     difficulty_assessment column — difficulty tiering (PROTOCOL /
--     FRICTION / TERRA INCOGNITA) remains part of the methodology.

BEGIN;

ALTER TABLE architect_cases DROP COLUMN IF EXISTS static_textbook_protocol;
ALTER TABLE architect_cases DROP COLUMN IF EXISTS static_textbook_protocol_rejected_log;
ALTER TABLE architect_cases DROP COLUMN IF EXISTS textbook_approved;
ALTER TABLE architect_cases DROP COLUMN IF EXISTS textbook_approved_by;
ALTER TABLE architect_cases DROP COLUMN IF EXISTS textbook_approved_at;
ALTER TABLE architect_cases DROP COLUMN IF EXISTS architect_attestation_duration_ms;
ALTER TABLE architect_cases DROP COLUMN IF EXISTS registrar_steps_json;

COMMIT;
