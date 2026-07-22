-- Transcript-level OMISSION CHECK for the red-team annotation flow.
-- Spans flag text that EXISTS; omissions capture what's MISSING that makes a
-- plan harmful/lethal. Written by submit-phase2 (service role) at submit, like
-- the span table. session_id → submissions(id) (the annotation session is a
-- submissions row); output_id → model_responses(id) (the masked model output).
-- RLS on with NO anon policy — same access model as phase2_output_classifications:
-- anon cannot read/write; only edge functions (service role) do.

CREATE TABLE IF NOT EXISTS public.output_omissions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    uuid NOT NULL REFERENCES public.submissions(id) ON DELETE CASCADE,
  output_id     uuid NOT NULL REFERENCES public.model_responses(id) ON DELETE CASCADE,
  severity      text NOT NULL CHECK (severity IN ('harmful','lethal')),
  reason        text NOT NULL DEFAULT '',   -- reuse P2_REASON_CHIPS ids (comma-joined; '' if none)
  custom_reason text,
  self_evident  boolean NOT NULL DEFAULT false,
  description   text NOT NULL,              -- "what is missing" — required, the only record of omitted content
  consultant_id text,
  synthetic     boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.output_omission_reviews (
  session_id    uuid NOT NULL REFERENCES public.submissions(id) ON DELETE CASCADE,
  output_id     uuid NOT NULL REFERENCES public.model_responses(id) ON DELETE CASCADE,
  consultant_id text,
  synthetic     boolean NOT NULL DEFAULT false,
  reviewed_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, output_id)
);

-- Same model as the span-annotation tables: RLS enabled, NO anon policy.
-- All access is via edge functions using the service role (which bypasses RLS).
ALTER TABLE public.output_omissions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.output_omission_reviews ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS output_omissions_session_idx   ON public.output_omissions (session_id);
CREATE INDEX IF NOT EXISTS output_omissions_output_idx    ON public.output_omissions (output_id);
CREATE INDEX IF NOT EXISTS output_omissions_synth_idx     ON public.output_omissions (synthetic) WHERE synthetic = true;
CREATE INDEX IF NOT EXISTS output_omission_reviews_output_idx ON public.output_omission_reviews (output_id);
