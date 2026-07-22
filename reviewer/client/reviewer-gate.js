/* reviewer-gate.js — REVIEWER INSTANCE ONLY. Loaded (in <head>) BEFORE the app's
 * inline script. It is the FIRST thing that runs and it OWNS app initialization:
 * the app does not init, render any view, or fire any prompt() until a valid
 * reviewer token exists.
 *
 * Contract with the reviewer build: the app's bottom-of-script `init();` call is
 * replaced with `if (window.__reviewerGate) window.__reviewerGate(init); else init();`
 * so the gate decides whether/when init runs.
 *
 *   - No token  → show the login overlay; NEVER call init (no view, no prompt).
 *   - Token     → run init (the app boots). On a fresh login we save the token,
 *                 pre-fill the reviewer IDs, and reload so the app parses with a
 *                 valid token + pre-filled IDs (so even the post-login init fires
 *                 zero native prompts).
 *
 * It also: (a) installs a fetch interceptor so every data call carries the token
 * (locked-down anon REST is rerouted through reviewer-data); (b) pre-fills the
 * consultant + architect attribution IDs to 'WERKSMANS-REVIEW' so no prompt()
 * ever appears; (c) paints the isolated-environment banner.
 */
(function () {
  'use strict';
  var FN = window.SUPABASE_URL + '/functions/v1/';
  var AUTH_URL = FN + 'reviewer-auth';
  var DATA_URL = FN + 'reviewer-data';
  var TOK_KEY = 'reviewer_token', EXP_KEY = 'reviewer_token_exp';
  var REVIEWER_ID = 'WERKSMANS-REVIEW';

  // ── token ───────────────────────────────────────────────────────────────
  function token() {
    try {
      var exp = parseInt(sessionStorage.getItem(EXP_KEY) || '0', 10);
      if (!exp || exp * 1000 < Date.now()) return null;     // absent or expired
      return sessionStorage.getItem(TOK_KEY);
    } catch (e) { return null; }
  }
  function setToken(t, expiresInSec) {
    try {
      sessionStorage.setItem(TOK_KEY, t);
      sessionStorage.setItem(EXP_KEY, String(Math.floor(Date.now() / 1000) + (expiresInSec || 0)));
    } catch (e) {}
  }
  function clearToken() {
    try { sessionStorage.removeItem(TOK_KEY); sessionStorage.removeItem(EXP_KEY); } catch (e) {}
  }
  // Pre-fill attribution IDs (read by the app's consultantId/archId at parse
  // time) so the native "enter your ID" prompts never fire.
  function seedIds() {
    try { localStorage.setItem('mlc_consultant_id', REVIEWER_ID); localStorage.setItem('mlc_arch_id', REVIEWER_ID); } catch (e) {}
  }

  // ── anti-flash: hide the page until the gate decides what to show ─────────
  var hideStyle = document.createElement('style');
  hideStyle.textContent = 'html{visibility:hidden!important}';
  (document.head || document.documentElement).appendChild(hideStyle);
  function reveal() { if (hideStyle && hideStyle.parentNode) hideStyle.parentNode.removeChild(hideStyle); }

  // If this load is already authenticated, seed IDs NOW (before the app's inline
  // script parses + reads them).
  if (token()) seedIds();

  // ── fetch interceptor: token on every data path ───────────────────────────
  var origFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    init = init || {};
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var method = (init.method || (typeof input !== 'string' && input && input.method) || 'GET').toUpperCase();
    var t = token();
    if (/\/functions\/v1\/(phase2-model-outputs|submit-phase2|reviewer-data|reviewer-auth)\b/.test(url)) {
      if (!/reviewer-auth\b/.test(url)) init.headers = withToken(init.headers, t);
      return origFetch(input, init);
    }
    if (/\/rest\/v1\/architect_cases\b/.test(url)) {
      if (method === 'GET')  return dataCall('list_cases', null, t);
      if (method === 'POST') return dataCall('submit_architect', parseBody(init.body), t);
    }
    if (/\/rest\/v1\/submissions\b/.test(url) && method === 'POST') {
      return dataCall('submit_phase1', parseBody(init.body), t);
    }
    return origFetch(input, init);
  };
  function withToken(headers, t) { var h = new Headers(headers || {}); if (t) h.set('X-Reviewer-Token', t); return h; }
  function parseBody(b) { try { return typeof b === 'string' ? JSON.parse(b) : b; } catch (e) { return b; } }
  function dataCall(action, payload, t) {
    return origFetch(DATA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + window.SUPABASE_ANON_KEY, 'X-Reviewer-Token': t || '' },
      body: JSON.stringify(payload ? { action: action, payload: payload } : { action: action }),
    });
  }

  // ── the gate owns app init ────────────────────────────────────────────────
  var pendingInit = null;
  window.__reviewerGate = function (appInit) {
    pendingInit = appInit;
    if (token()) { runApp(); } else { showGate(); }
  };
  function runApp() {
    reveal();
    banner();
    if (pendingInit) { var f = pendingInit; pendingInit = null; try { f(); } catch (e) { console.error('app init failed', e); } }
  }

  // ── login overlay (the only thing visible pre-auth) ───────────────────────
  function showGate() {
    reveal();   // reveal the page so the overlay (opaque, covers the app) shows
    document.documentElement.style.overflow = 'hidden';
    var ov = document.createElement('div');
    ov.id = 'reviewer-gate-overlay';
    ov.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#0d0f12;color:#e8e8e8;display:flex;align-items:center;justify-content:center;font-family:"Courier New",monospace;';
    ov.innerHTML =
      '<form id="rg-form" style="width:320px;max-width:88vw;border:1px solid #333;padding:26px 24px;background:#15181c;">' +
        '<div style="font-size:13px;letter-spacing:0.12em;color:#d4a853;margin-bottom:4px;">INSAAN MLC — REVIEWER</div>' +
        '<div style="font-size:11px;color:#8a8a8a;margin-bottom:18px;line-height:1.5;">Isolated test environment. Authorised reviewers only.</div>' +
        '<input id="rg-user" placeholder="Username" autocomplete="off" autocapitalize="off" spellcheck="false" style="width:100%;box-sizing:border-box;margin-bottom:10px;padding:9px;background:#0d0f12;border:1px solid #333;color:#e8e8e8;font-family:inherit;">' +
        '<input id="rg-pass" type="password" placeholder="Password" style="width:100%;box-sizing:border-box;margin-bottom:14px;padding:9px;background:#0d0f12;border:1px solid #333;color:#e8e8e8;font-family:inherit;">' +
        '<button type="submit" id="rg-btn" style="width:100%;padding:10px;background:#1c2f24;border:1px solid #3dba6f;color:#3dba6f;letter-spacing:0.1em;text-transform:uppercase;cursor:pointer;font-family:inherit;">Enter</button>' +
        '<div id="rg-err" style="display:none;color:#e07820;font-size:11px;margin-top:12px;"></div>' +
      '</form>';
    document.body.appendChild(ov);
    document.getElementById('rg-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var btn = document.getElementById('rg-btn'), err = document.getElementById('rg-err');
      btn.disabled = true; btn.textContent = 'Checking…'; err.style.display = 'none';
      origFetch(AUTH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + window.SUPABASE_ANON_KEY },
        body: JSON.stringify({ username: document.getElementById('rg-user').value, password: document.getElementById('rg-pass').value }),
      }).then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) {
          if (j && j.ok && j.token) {
            setToken(j.token, j.expires_in);
            seedIds();
            // Reload so the app parses fresh with a valid token + pre-filled IDs:
            // the gate then runs init with zero native prompts.
            location.reload();
          } else {
            err.textContent = 'Access denied.'; err.style.display = 'block';
            btn.disabled = false; btn.textContent = 'Enter';
          }
        })
        .catch(function () { err.textContent = 'Access denied.'; err.style.display = 'block'; btn.disabled = false; btn.textContent = 'Enter'; });
    });
  }

  function banner() {
    if (document.getElementById('reviewer-banner')) return;
    var b = document.createElement('div');
    b.id = 'reviewer-banner';
    b.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483646;background:#5a3a12;color:#ffd9a0;font-family:"Courier New",monospace;font-size:12px;letter-spacing:0.04em;text-align:center;padding:6px 10px;border-top:1px solid #d4a853;';
    var label = document.createElement('span');
    label.textContent = 'Reviewer environment';
    b.appendChild(label);
    // Logout — always-visible, in the persistent reviewer banner, right-aligned.
    var out = document.createElement('button');
    out.id = 'reviewer-logout';
    out.type = 'button';
    out.textContent = 'Log out';
    out.style.cssText = 'position:absolute;right:12px;top:50%;transform:translateY(-50%);background:transparent;border:1px solid #d4a853;color:#ffd9a0;font-family:inherit;font-size:11px;letter-spacing:0.06em;text-transform:uppercase;padding:3px 11px;cursor:pointer;';
    out.onmouseover = function () { out.style.background = 'rgba(255,217,160,0.16)'; };
    out.onmouseout = function () { out.style.background = 'transparent'; };
    out.addEventListener('click', function () { clearToken(); location.reload(); });
    b.appendChild(out);
    document.body.appendChild(b);
  }

  // Safety net: if the app never calls __reviewerGate (e.g. the init-call patch
  // is missing), fail CLOSED — show the gate so nothing is exposed.
  document.addEventListener('DOMContentLoaded', function () {
    if (pendingInit === null && !document.getElementById('reviewer-gate-overlay') && !token()) showGate();
  });
})();
