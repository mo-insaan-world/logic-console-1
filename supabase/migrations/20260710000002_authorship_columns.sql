-- M2: Authorship columns tying rows to the authenticated user.
--
-- architect_cases.created_by  — the case author (default auth.uid() on an
--                               authenticated PostgREST insert).
-- submissions.annotator_id    — the annotator (default auth.uid()). consultant_id
--                               is retained unchanged for display/back-compat;
--                               annotator_id is the new DB-enforced identity that
--                               M3 policies and submit-phase2 (JWT-derived) use.
--
-- Additive only. Nullable + ON DELETE SET NULL so user deletion never blocks and
-- pre-auth rows (2 architect_cases, 0 submissions) simply carry NULL authorship
-- (backfill not required per brief; unauthored rows are flagged in the report).

alter table public.architect_cases
  add column if not exists created_by uuid references auth.users(id) on delete set null default auth.uid();

alter table public.submissions
  add column if not exists annotator_id uuid references auth.users(id) on delete set null default auth.uid();

comment on column public.architect_cases.created_by is
  'Auth uid of the case author. Default auth.uid() on authenticated insert; NULL on pre-auth rows.';
comment on column public.submissions.annotator_id is
  'Auth uid of the annotator (DB-enforced identity). Default auth.uid() on authenticated insert; submit-phase2 sets it from the verified JWT. consultant_id retained for display/back-compat.';
