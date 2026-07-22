export const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-reviewer-token',
  'Access-Control-Max-Age':       '86400',
};
export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
}
export function getClientIP(req) {
  const xff = req.headers.get('x-forwarded-for') ?? '';
  return xff.split(',')[0].trim() || req.headers.get('cf-connecting-ip') || 'unknown';
}
