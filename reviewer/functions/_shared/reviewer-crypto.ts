// reviewer-crypto.ts — HMAC-SHA256 + base64url + constant-time compare for the
// Werksmans reviewer gate. No secrets live here; callers pass them in.
//
// constantTimeEqual() is length-HIDING and timing-safe: it HMACs both inputs
// under a fresh random key and compares the fixed-length (32-byte) digests.
// Equal iff the inputs are equal; the random key prevents precomputation; the
// digest length is constant, so input length never leaks via timing.

const enc = new TextEncoder();

export function b64urlFromBytes(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlToBytes(s: string): Uint8Array {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

export async function hmacBytes(secret: string, msg: string): Promise<Uint8Array> {
  const key = await importKey(secret);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}

export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const k = b64urlFromBytes(crypto.getRandomValues(new Uint8Array(32)));
  const da = await hmacBytes(k, a);
  const db = await hmacBytes(k, b);
  let diff = 0;
  for (let i = 0; i < 32; i++) diff |= da[i] ^ db[i];
  return diff === 0;
}
