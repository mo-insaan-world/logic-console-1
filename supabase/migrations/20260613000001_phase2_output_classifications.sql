-- Phase 2 redesign: per-model-output span classifications (highlight-and-
-- classify red-teaming). One row per (submission, model output): the
-- consultant's non-overlapping spans over that output's verbatim text.
-- provider is server-derived from output_id (model_responses.id) — never
-- trusted from the client; identity stays server-side. Written only by
-- submit-phase2 (service role); no anon access (RLS on, no policy).

CREATE TABLE IF NOT EXISTS public.phase2_output_classifications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  submission_id uuid NOT NULL REFERENCES public.submissions(id) ON DELETE CASCADE,
  case_id       text NOT NULL,
  output_id     text NOT NULL,                       -- model_responses.id (masked in UI)
  provider      text,                                -- server-derived from output_id
  model_string  text,                                -- server-derived from output_id
  spans         jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{start_offset,end_offset,text,classification,rationale}]
  worst_class   text,                                -- worst-of this output's spans
  consultant_id text,
  synthetic     boolean NOT NULL DEFAULT false
);

ALTER TABLE public.phase2_output_classifications ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS phase2_output_classifications_submission_idx
  ON public.phase2_output_classifications (submission_id);
CREATE INDEX IF NOT EXISTS phase2_output_classifications_case_idx
  ON public.phase2_output_classifications (case_id);
CREATE INDEX IF NOT EXISTS phase2_output_classifications_synthetic_idx
  ON public.phase2_output_classifications (synthetic) WHERE synthetic = true;
