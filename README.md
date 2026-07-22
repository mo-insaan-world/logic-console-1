# Medical Logic Console

Expert annotation platform for clinical red-teaming of frontier LLMs. Trauma surgeons capture gold-standard management plans for clinical scenarios, then blind-grade model outputs against them. Built solo and deployed in production at Insaan, Inc., where it powers an expert-governed evaluation pipeline with practicing surgeons as annotators.

**Live deployment:** registration is closed (allowlist-only for verified clinicians), but the architecture and full flow are documented below.

## Why I built this

Standard medical benchmarks test what models know. They do not test what models do under the conditions where clinical decisions actually fail. A model can score well on exam-style questions and still produce dangerous management plans when the scenario involves judgment under pressure rather than recall.

I developed a framework of four factors that predict where frontier models are most likely to fail in a medical specialty:

1. **Tacit procedural knowledge.** Expertise that lives in hands and pattern recognition, not textbooks. It is systematically underrepresented in training data because it is rarely written down.
2. **Time compression.** Decisions made in minutes, where the correct answer depends on sequencing and triage, not just the endpoint. Models trained on retrospective literature see the outcome, not the clock.
3. **Resource-dependent improvisation.** The right management plan changes when the CT scanner is down, blood products are limited, or the nearest higher-level facility is hours away. Models default to gold-standard-resource assumptions that do not hold in most of the world.
4. **Sparse, non-Western-skewed literature.** Training corpora over-represent high-resource Western practice. Specialties whose hardest cases occur outside that context are evaluated against a literature that barely describes them.

**Why trauma surgery:** it scores highest on all four factors simultaneously. Trauma is tacit, time-compressed, brutally resource-dependent, and its global caseload is concentrated precisely where the literature is thinnest. If frontier models fail anywhere in medicine, they fail here first — which makes it the right stress test.

A second thesis shapes the annotator pipeline: clinical expertise concentrates globally by exposure and caseload, not by credentials or geography alone. The surgeons best positioned to grade a model's penetrating-trauma management plan are the ones who see that pathology at volume. The platform is built to bring those experts in under real accountability — named, verified, and governed — rather than through anonymous crowdwork.

## What it does

- **Phase 1: ground-truth capture.** Surgeons work through trauma scenarios and record their management plans — decision rationale, resource constraints, and confidence. Dictation supported via speech-to-text.
- **Phase 2: model annotation.** Annotators grade frontier model outputs against expert plans using span-level highlighting (ACCEPTABLE / HARMFUL / LETHAL), with structured reasons for harmful and lethal spans and a transcript-level omission check, since a commission-only span model cannot capture dangerous absences.
- **Admin panel** for case assignment, submission review, and annotator management.

## Architecture

- Single-file SPA (vanilla JS, ~460 KB unminified) for zero build-step deploys and trivial auditability
- Supabase backend: Postgres with Row Level Security on all clinical tables, annotator identity derived from verified JWTs, closed registration via allowlist
- LLM calls proxied through Supabase Edge Functions; no API keys ship to the client
- Vercel hosting with a deliberate no-cache strategy (see below)
- Evaluation harness and seed scripts for generating synthetic annotation data across multiple models

All case data in this repository is synthetic. No real clinical annotations are included.

## Running locally

```
npm install
node server.js
# open http://localhost:3000
```

## Supabase setup

1. Create a project at [supabase.com](https://supabase.com/)
2. Run the SQL below in the Supabase SQL editor
3. Copy your project URL and anon key into `supabase.js`

```sql
create table submissions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  case_id text,
  view_mode text,
  decision text,
  selected_alternative text,
  reasoning_json jsonb,
  resilience_score integer,
  constraint_snapshot jsonb,
  time_to_decision_seconds integer
);

alter table submissions enable row level security;

create policy "Allow anon insert"
  on submissions for insert
  to anon
  with check (true);

create policy "Allow anon select"
  on submissions for select
  to anon
  using (true);
```

4. Update `supabase.js`:

```js
const SUPABASE_URL = 'https://xxxx.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGci...';
```

Submissions fall back silently to local `submissions.json` if Supabase is unreachable, so a demo never breaks.

Note: the anon-insert policies above are for local demo setup. The production deployment restricts writes to authenticated annotators via JWT-scoped RLS policies.

## Deploy and cache strategy

`vercel.json` sets aggressive no-cache headers on `/`, `/index.html`, and every served `.js` / `.json` / `.css` file:

```
Cache-Control: no-cache, no-store, max-age=0, must-revalidate    (HTML)
Cache-Control: no-cache, max-age=0, must-revalidate              (JS/JSON/CSS)
Pragma: no-cache                                                 (HTML)
Expires: 0                                                       (HTML)
```

**Why so strict.** This tool is used by surgeons in a single-shot pilot context: one annotation session per case, then the tab is closed. They will not clear caches, open dev tools, or know to hard-refresh. A stale UI shipped from a prior deploy could silently break their experience (wrong rating ladder, broken submit gate, missing methodology controls) without any signal that the page is out of date. We accept the small per-load latency cost of a 304 conditional GET on every navigation in exchange for the guarantee that every deploy is visible on the annotator's next page load with zero user action.
