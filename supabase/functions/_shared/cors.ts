// cors.ts — shared CORS + JSON-response helpers for consumer-tier Edge Functions
// called from the consultant browser. Production should lock the allow-origin
// down to the deployed app's actual origin once the UI is published; for now
// it's open so local dev and Vercel previews work.

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Max-Age':       '86400',
};

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

// Fail toward limiting (constant fallback bucket), not toward unlimited:
// callers should never bucket on null/empty when the client IP is unknown.
export function getClientIP(req: Request): string {
  const xff = req.headers.get('x-forwarded-for') ?? '';
  return xff.split(',')[0].trim() || req.headers.get('cf-connecting-ip') || 'unknown';
}
