// rate-limit.ts — global rate limiter backed by public.rate_limit_hits.
//
// Parameterized by (bucket, max, windowMs) so each consumer-tier function can
// either isolate its quota (e.g. "submit-phase2:<ip>") or share one (e.g.
// "global:<ip>") with no code change in the limiter itself.
//
// FAIL CLOSED: any DB error (count or insert) returns true (rate-limited).
// The prune step is the only branch allowed to fail open — a stale-row buildup
// for one request is not a security concern; the count still operates on the
// same set with or without the prune.

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SERVICE_HEADERS = {
  'apikey':        SUPABASE_SERVICE_ROLE_KEY,
  'Authorization': 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
};

export async function isRateLimited(bucket: string, max: number, windowMs: number): Promise<boolean> {
  const windowStart = new Date(Date.now() - windowMs).toISOString();

  // 1. Prune old rows (non-fatal)
  try {
    const pruneRes = await fetch(
      `${SUPABASE_URL}/rest/v1/rate_limit_hits?hit_at=lt.${encodeURIComponent(windowStart)}`,
      { method: 'DELETE', headers: SERVICE_HEADERS },
    );
    if (!pruneRes.ok) {
      console.error('rate_limit prune non-fatal:', pruneRes.status, await pruneRes.text());
    }
  } catch (e) {
    console.error('rate_limit prune threw:', (e as Error).message);
  }

  // 2. Count — FAIL CLOSED
  try {
    const countRes = await fetch(
      `${SUPABASE_URL}/rest/v1/rate_limit_hits?bucket=eq.${encodeURIComponent(bucket)}&hit_at=gte.${encodeURIComponent(windowStart)}&select=id`,
      { headers: { ...SERVICE_HEADERS, 'Prefer': 'count=exact', 'Range': '0-0' } },
    );
    if (!countRes.ok) {
      console.error('rate_limit count failed:', countRes.status, await countRes.text());
      return true;
    }
    const range = countRes.headers.get('content-range') ?? '0/0';
    const count = parseInt(range.split('/')[1] ?? '0', 10);
    if (count >= max) return true;
  } catch (e) {
    console.error('rate_limit count threw:', (e as Error).message);
    return true;
  }

  // 3. Insert this hit — FAIL CLOSED
  try {
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/rate_limit_hits`, {
      method: 'POST',
      headers: { ...SERVICE_HEADERS, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({ bucket }),
    });
    if (!insertRes.ok) {
      console.error('rate_limit insert failed:', insertRes.status, await insertRes.text());
      return true;
    }
  } catch (e) {
    console.error('rate_limit insert threw:', (e as Error).message);
    return true;
  }

  return false;
}
