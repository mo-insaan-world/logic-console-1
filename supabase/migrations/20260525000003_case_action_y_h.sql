-- case_action_y_h — per-(case × response × consensus-action) cached judge result.
--
-- Motivation: checkActionPresent is the last non-deterministic LLM call in the
-- ICAT-R pipeline. The consensus set (case_consensus, slice 1) is now
-- deterministic and cached per case, but y_h per consensus action is still
-- decided by a fresh LLM call on every scoring request. On SYNTH-QUAL-001
-- (clean N=20, see synthetic bench), the single-sample y_h flip rate measured
-- 0.6% (8 of 1287 decisions), with 64 of 65 (provider × consensus-action)
-- cells byte-deterministic and ONE cell (openai × "Monitor CK, urine output,
-- and Doppler with ICU-level post-operative surveillance") flipping 40% of
-- the time. This cache is built primarily for EXACT REPRODUCIBILITY of W_c
-- across reruns and for AUDIT VISIBILITY into which consensus actions are
-- borderline (the samples JSONB), NOT to fix severe noise — there isn't any.
--
-- Cache key: (case_id, model_response_hash, consensus_action, judge_prompt_version).
-- Population strategy: K=5 fresh judge samples, store majority + full sample
-- audit trail. Only successful majority computations are cached; transient
-- API errors leave the row unwritten so the next request retries fresh.
--
-- judge_prompt_version is the SHA-256 hex of the FULL checkActionPresent
-- system prompt (with QUALIFIER_HANDLING_BLOCK interpolated). Auto-invalidates
-- cache rows when EITHER the judge prompt template OR the qualifier-handling
-- policy changes — no manual integer bump required, no risk of forgetting to
-- invalidate when the architects ratify a stricter qualifier policy.
--
-- ── Tie policy (samples[].YES == samples[].NO after errors are removed) ───
-- y_h_majority = false (NO). DELIBERATE COVERAGE-CONSERVATIVE convention —
-- under-credits the candidate model on borderline actions, reducing W_c
-- rather than inflating it. Note this is OPPOSITE in direction from the
-- safety gate's bias (which errs toward firing the M_c=0 gate). Both biases
-- are PLACEHOLDER pending clinical-architect review alongside the
-- QUALIFIER_HANDLING_BLOCK tolerance setting. Same architect decision that
-- ratifies the qualifier policy should ratify (or flip) this tie-break.

CREATE TABLE IF NOT EXISTS public.case_action_y_h (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id               text    NOT NULL,
  model_response_hash   text    NOT NULL,
  consensus_action      text    NOT NULL,
  judge_prompt_version  text    NOT NULL,
  k                     integer NOT NULL,
  y_h_majority          boolean NOT NULL,
  yes_count             integer NOT NULL,
  no_count              integer NOT NULL,
  error_count           integer NOT NULL DEFAULT 0,
  samples               jsonb   NOT NULL,
  judged_at             timestamptz NOT NULL DEFAULT now(),
  synthetic             boolean NOT NULL DEFAULT false,
  CONSTRAINT case_action_y_h_key UNIQUE
    (case_id, model_response_hash, consensus_action, judge_prompt_version),
  CONSTRAINT case_action_y_h_k_chk CHECK (k > 0),
  CONSTRAINT case_action_y_h_quorum_chk CHECK (yes_count + no_count >= 1),
  CONSTRAINT case_action_y_h_hash_chk CHECK (model_response_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT case_action_y_h_judgeprompt_chk CHECK (judge_prompt_version ~ '^[0-9a-f]{64}$')
);

-- Lookup index — composite UNIQUE already covers SELECT by (case, hash, action, version).
-- The synthetic flag has its own partial index for cleanup queries.
CREATE INDEX IF NOT EXISTS case_action_y_h_synthetic_idx
  ON public.case_action_y_h (synthetic)
  WHERE synthetic = true;

ALTER TABLE public.case_action_y_h ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.case_action_y_h TO service_role;
