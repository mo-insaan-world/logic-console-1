# logic-console
Surgeon annotation interface for RLHF and chain-of-thought trace capture. Built for Insaan Inc.

## Running locally

```bash
npm install
node server.js
# open http://localhost:3000
```

## Supabase setup

1. Create a project at [supabase.com](https://supabase.com)
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

-- Enable Row Level Security and allow anonymous inserts
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

Submissions fall back silently to local `submissions.json` if Supabase is unreachable, so the demo never breaks.

## Deploy / cache strategy

`vercel.json` sets aggressive no-cache headers on `/`, `/index.html`,
and on every served `.js` / `.json` / `.css` file:

```
Cache-Control: no-cache, no-store, max-age=0, must-revalidate    (HTML)
Cache-Control: no-cache, max-age=0, must-revalidate              (JS/JSON/CSS)
Pragma: no-cache                                                 (HTML)
Expires: 0                                                       (HTML)
```

**Why so strict.** This tool is used by surgeons in a single-shot
pilot context (one annotation session per case, then the tab is
closed). They will not clear caches, open dev tools, or know to
hard-refresh. A stale UI shipped from a prior deploy could silently
break their experience — wrong rating ladder, broken submit gate,
missing methodology controls — without any signal that the page is
out of date.

We accept the small per-load latency cost (a 304 conditional GET on
every navigation) in exchange for the guarantee that every deploy is
visible on the user's next page load with zero user action.

**Do NOT relax these headers** to improve perceived speed without
understanding that trade-off. The HTML entry point is small (~330 KB
gzipped substantially less) and the revalidation round-trip is fast.

**Do NOT add a service worker** without setting `updateViaCache:
'none'` on the registration, or the SW's own bytes will be served
from cache and the strict header strategy above will be silently
bypassed. There is currently no SW registered. The defensive comment
in `index.html` next to the PWA meta tags reminds future contributors
of this constraint.
