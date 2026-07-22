(function () {
  // ── MLC closed-registration auth (GoTrue REST; no supabase-js dep) ──────────
  // Swaps the app from the public publishable key to per-user JWTs. Every
  // /rest/v1 + /functions/v1 fetch reads window.sbAuthToken() for its Bearer
  // (user JWT when signed in, else the publishable key for the auth calls
  // themselves). Boot is gated behind a valid session; the admin view is
  // role-gated (RLS is the real enforcement — this only hides the button).
  const AUTH_BASE = window.SUPABASE_URL + '/auth/v1';
  const REST_BASE = window.SUPABASE_URL + '/rest/v1';
  const PUB = window.SUPABASE_ANON_KEY;
  const LS_KEY = 'mlc_session_v1';
  let session = null;   // { access_token, refresh_token, email, user_id }
  let profile = null;   // { id, email, full_name, role }

  try { session = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (e) { session = null; }

  function saveSession(s) {
    session = s;
    try { s ? localStorage.setItem(LS_KEY, JSON.stringify(s)) : localStorage.removeItem(LS_KEY); } catch (e) {}
  }

  // Bearer accessor used by every REST/function call in the app.
  window.sbAuthToken = function () { return (session && session.access_token) ? session.access_token : PUB; };
  window.mlcSession  = function () { return session; };
  window.mlcProfile  = function () { return profile; };
  window.mlcRole     = function () { return profile ? profile.role : null; };

  async function authPost(path, bodyObj) {
    const res = await fetch(AUTH_BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': PUB },
      body: JSON.stringify(bodyObj),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }

  async function doLogin(email, password) {
    const r = await authPost('/token?grant_type=password', { email: email.trim(), password });
    if (!r.ok || !r.data.access_token) {
      const msg = r.data && (r.data.error_description || r.data.msg);
      return { ok: false, error: msg || 'Invalid email or password.' };
    }
    saveSession({
      access_token: r.data.access_token,
      refresh_token: r.data.refresh_token,
      email: (r.data.user && r.data.user.email) || email.trim(),
      user_id: (r.data.user && r.data.user.id) || null,
    });
    return { ok: true };
  }

  async function doRegister(email, password) {
    const r = await authPost('/signup', { email: email.trim(), password });
    // Never reveal the allowlist: ANY non-2xx maps to the same generic copy.
    if (!r.ok) return { ok: false, error: 'Registration is not available for this email address.' };
    return { ok: true, needsConfirm: !(r.data && r.data.access_token) };
  }

  async function doRecover(email) {
    // Always report the same thing regardless of whether the email exists.
    try { await authPost('/recover', { email: email.trim() }); } catch (e) {}
    return { ok: true };
  }

  async function fetchProfile() {
    if (!session || !session.access_token) return null;
    try {
      const res = await fetch(REST_BASE + '/profiles?select=id,email,full_name,role&limit=1',
        { headers: { 'apikey': PUB, 'Authorization': 'Bearer ' + session.access_token } });
      if (!res.ok) return null;
      const rows = await res.json();
      profile = (Array.isArray(rows) && rows[0]) || null;
      return profile;
    } catch (e) { return null; }
  }

  async function doRefresh() {
    if (!session || !session.refresh_token) return false;
    const r = await authPost('/token?grant_type=refresh_token', { refresh_token: session.refresh_token });
    if (!r.ok || !r.data.access_token) return false;
    saveSession({
      access_token: r.data.access_token,
      refresh_token: r.data.refresh_token || session.refresh_token,
      email: (r.data.user && r.data.user.email) || session.email,
      user_id: (r.data.user && r.data.user.id) || session.user_id,
    });
    return true;
  }

  function logout() { saveSession(null); profile = null; location.reload(); }

  window.mlcAuth = { doLogin, doRegister, doRecover, fetchProfile, doRefresh, logout };

  // ── Overlay UI ──────────────────────────────────────────────────────────────
  function el(html) { const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstChild; }

  function buildAuthOverlay() {
    if (document.getElementById('mlc-auth-overlay')) return;
    const style = document.createElement('style');
    style.textContent = `
      #mlc-auth-overlay{position:fixed;inset:0;z-index:100000;background:#0d0d0f;color:#e8e8e8;
        display:flex;align-items:center;justify-content:center;font-family:'Courier New',monospace;}
      #mlc-auth-overlay .card{width:360px;max-width:92vw;background:#151517;border:1px solid #2a2a2e;padding:30px 28px;}
      #mlc-auth-overlay .wm{margin-bottom:16px;line-height:1.3;}
      #mlc-auth-overlay .wm-brand{display:block;font-size:24px;letter-spacing:0.34em;color:#c9a94a;white-space:nowrap;}
      #mlc-auth-overlay .wm-sub{display:block;font-size:13px;letter-spacing:0.2em;color:#c8b986;white-space:nowrap;margin-top:5px;}
      #mlc-auth-overlay h2{font-size:18px;font-weight:700;letter-spacing:0.16em;text-transform:uppercase;color:#c9a94a;
        margin:0 0 18px;padding-bottom:12px;border-bottom:1px solid #2a2a2e;}
      #mlc-auth-overlay label{display:block;font-size:13px;letter-spacing:0.1em;text-transform:uppercase;color:#aaa;margin:14px 0 5px;}
      #mlc-auth-overlay input{width:100%;box-sizing:border-box;background:#0d0d0f;border:1px solid #2a2a2e;color:#e8e8e8;
        padding:11px 12px;font-family:inherit;font-size:16px;}
      #mlc-auth-overlay input:focus{outline:none;border-color:#c9a94a;}
      #mlc-auth-overlay button.primary{width:100%;margin-top:20px;background:#c9a94a;color:#0d0d0f;border:none;padding:12px;
        font-family:inherit;font-size:16px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;cursor:pointer;}
      #mlc-auth-overlay button.primary:disabled{opacity:0.5;cursor:default;}
      #mlc-auth-overlay .links{margin-top:18px;display:flex;justify-content:space-between;gap:12px;}
      #mlc-auth-overlay .links a{color:#9a9a9a;font-size:14px;cursor:pointer;text-decoration:none;white-space:nowrap;}
      #mlc-auth-overlay .links a:hover{color:#c9a94a;}
      #mlc-auth-overlay .msg{margin-top:14px;font-size:13px;line-height:1.5;min-height:15px;}
      #mlc-auth-overlay .msg.err{color:#d9736a;}
      #mlc-auth-overlay .msg.ok{color:#6ab07a;}
      #mlc-auth-overlay .hint{font-size:12px;color:#888;line-height:1.55;margin-top:3px;}`;
    document.head.appendChild(style);

    const ov = el(`<div id="mlc-auth-overlay"><div class="card">
      <div class="wm"><span class="wm-brand">INSAAN</span><span class="wm-sub">MEDICAL LOGIC CONSOLE</span></div>
      <h2 id="mlc-auth-title">Sign in</h2>
      <div id="mlc-auth-body"></div>
      <div class="msg" id="mlc-auth-msg"></div>
      <div class="links" id="mlc-auth-links"></div>
    </div></div>`);
    document.body.appendChild(ov);
  }

  function setMsg(text, kind) {
    const m = document.getElementById('mlc-auth-msg');
    if (m) { m.textContent = text || ''; m.className = 'msg' + (kind ? ' ' + kind : ''); }
  }

  const FIELDS = {
    login: `<label>Email</label><input id="mlc-f-email" type="email" autocomplete="username">
            <label>Password</label><input id="mlc-f-pass" type="password" autocomplete="current-password">
            <button class="primary" id="mlc-f-submit">Sign in</button>`,
    register: `<div class="hint">Register with the personal email you provided during onboarding.</div>
            <label>Email</label><input id="mlc-f-email" type="email" autocomplete="username">
            <label>Password</label><input id="mlc-f-pass" type="password" autocomplete="new-password">
            <label>Confirm password</label><input id="mlc-f-pass2" type="password" autocomplete="new-password">
            <div class="hint">Minimum 8 characters.</div>
            <button class="primary" id="mlc-f-submit">Create account</button>`,
    reset: `<div class="hint">Enter your account email and we'll send a password-reset link.</div>
            <label>Email</label><input id="mlc-f-email" type="email" autocomplete="username">
            <button class="primary" id="mlc-f-submit">Send reset link</button>`,
  };
  const TITLES = { login: 'Sign in', register: 'Register', reset: 'Reset password' };
  const LINKS = {
    login: `<a data-screen="register">Register</a><a data-screen="reset">Forgot password?</a>`,
    register: `<a data-screen="login">Have an account? Sign in</a>`,
    reset: `<a data-screen="login">Back to sign in</a>`,
  };

  function showScreen(screen) {
    buildAuthOverlay();
    document.getElementById('mlc-auth-overlay').style.display = 'flex';
    document.getElementById('mlc-auth-title').textContent = TITLES[screen];
    document.getElementById('mlc-auth-body').innerHTML = FIELDS[screen];
    document.getElementById('mlc-auth-links').innerHTML = LINKS[screen];
    setMsg('');
    document.querySelectorAll('#mlc-auth-links a').forEach(a =>
      a.addEventListener('click', () => showScreen(a.getAttribute('data-screen'))));
    const submit = document.getElementById('mlc-f-submit');
    submit.addEventListener('click', () => handleSubmit(screen, submit));
    document.getElementById('mlc-auth-body').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); handleSubmit(screen, submit); }
    });
    const emailEl = document.getElementById('mlc-f-email'); if (emailEl) emailEl.focus();
  }

  async function handleSubmit(screen, btn) {
    const email = (document.getElementById('mlc-f-email') || {}).value || '';
    const passEl = document.getElementById('mlc-f-pass');
    const pass = passEl ? passEl.value : '';
    if (!email.trim()) { setMsg('Email is required.', 'err'); return; }
    if ((screen === 'login' || screen === 'register') && (!pass || pass.length < 8)) {
      setMsg('Password must be at least 8 characters.', 'err'); return;
    }
    if (screen === 'register') {
      const pass2 = (document.getElementById('mlc-f-pass2') || {}).value || '';
      if (pass !== pass2) { setMsg('Passwords do not match.', 'err'); return; }
    }
    btn.disabled = true; setMsg('Working…');
    try {
      if (screen === 'login') {
        const r = await doLogin(email, pass);
        if (!r.ok) { setMsg(r.error, 'err'); btn.disabled = false; return; }
        const p = await fetchProfile();
        if (!p) { setMsg('Signed in, but your profile could not be loaded. Contact the study admin.', 'err'); btn.disabled = false; return; }
        applyPostAuth(p);
      } else if (screen === 'register') {
        const r = await doRegister(email, pass);
        if (!r.ok) { setMsg(r.error, 'err'); btn.disabled = false; return; }
        setMsg(r.needsConfirm
          ? 'Account created. Check your email to confirm, then sign in.'
          : 'Account created. You can sign in now.', 'ok');
        btn.disabled = false;
      } else {
        await doRecover(email);
        setMsg('If that email has an account, a reset link is on its way.', 'ok');
        btn.disabled = false;
      }
    } catch (e) {
      setMsg('Something went wrong. Please try again.', 'err'); btn.disabled = false;
    }
  }

  function hideOverlay() {
    const o = document.getElementById('mlc-auth-overlay');
    if (o) o.style.display = 'none';
  }

  // ── Session chrome (identity chip + logout + admin experts button) ───────────
  function addSessionChrome(p) {
    const right = document.querySelector('.topbar-right');
    if (right && !document.getElementById('mlc-session-chrome')) {
      const wrap = el(`<div id="mlc-session-chrome" style="display:flex;align-items:center;gap:10px;">
        <span style="font-size:11px;color:#8a7a4a;letter-spacing:0.06em;" title="${(p.email||'').replace(/"/g,'')}">${p.full_name || p.email || ''}${p.role === 'admin' ? ' · ADMIN' : ''}</span>
        <button id="mlc-experts-btn" style="display:${p.role === 'admin' ? 'inline-block' : 'none'};background:transparent;border:1px solid #2a2a2e;color:#c9a94a;font-size:10px;letter-spacing:0.08em;padding:4px 8px;cursor:pointer;font-family:inherit;text-transform:uppercase;">Experts</button>
        <button id="mlc-logout-btn" style="background:transparent;border:1px solid #2a2a2e;color:#999;font-size:10px;letter-spacing:0.08em;padding:4px 8px;cursor:pointer;font-family:inherit;text-transform:uppercase;">Sign out</button>
      </div>`);
      right.insertBefore(wrap, right.firstChild);
      document.getElementById('mlc-logout-btn').addEventListener('click', logout);
      const eb = document.getElementById('mlc-experts-btn');
      if (eb) eb.addEventListener('click', openExpertsPanel);
    }
  }

  // ── Experts management panel (admin only; manual add + list) ──────────────────
  async function openExpertsPanel() {
    if (window.mlcRole() !== 'admin') return;
    let modal = document.getElementById('mlc-experts-modal');
    if (!modal) {
      modal = el(`<div id="mlc-experts-modal" style="position:fixed;inset:0;z-index:100001;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;font-family:'Courier New',monospace;">
        <div style="width:560px;max-width:94vw;max-height:88vh;overflow:auto;background:#151517;border:1px solid #2a2a2e;padding:24px;color:#e8e8e8;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
            <div style="font-size:13px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#c9a94a;">Allowed Experts</div>
            <button id="mlc-experts-close" style="background:transparent;border:1px solid #2a2a2e;color:#999;padding:4px 8px;cursor:pointer;font-family:inherit;">Close</button>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr 120px auto;gap:6px;align-items:end;margin-bottom:14px;">
            <div><label style="font-size:9px;color:#999;text-transform:uppercase;">Email</label><input id="mlc-ex-email" style="width:100%;box-sizing:border-box;background:#0d0d0f;border:1px solid #2a2a2e;color:#e8e8e8;padding:6px;font-family:inherit;"></div>
            <div><label style="font-size:9px;color:#999;text-transform:uppercase;">Full name</label><input id="mlc-ex-name" style="width:100%;box-sizing:border-box;background:#0d0d0f;border:1px solid #2a2a2e;color:#e8e8e8;padding:6px;font-family:inherit;"></div>
            <div><label style="font-size:9px;color:#999;text-transform:uppercase;">Role</label>
              <select id="mlc-ex-role" style="width:100%;box-sizing:border-box;background:#0d0d0f;border:1px solid #2a2a2e;color:#e8e8e8;padding:6px;font-family:inherit;"><option value="surgeon">surgeon</option><option value="admin">admin</option></select></div>
            <button id="mlc-ex-add" style="background:#c9a94a;color:#0d0d0f;border:none;padding:7px 12px;font-weight:700;cursor:pointer;font-family:inherit;text-transform:uppercase;font-size:11px;">Add</button>
          </div>
          <div class="msg" id="mlc-ex-msg" style="font-size:11px;min-height:14px;margin-bottom:10px;"></div>
          <div id="mlc-ex-list" style="font-size:12px;"></div>
          <div style="margin-top:22px;padding-top:16px;border-top:1px solid #2a2a2e;font-size:13px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#c9a94a;">Registered Users</div>
          <div id="mlc-pr-list" style="font-size:12px;margin-top:8px;"></div>
        </div></div>`);
      document.body.appendChild(modal);
      document.getElementById('mlc-experts-close').addEventListener('click', () => { modal.style.display = 'none'; });
      document.getElementById('mlc-ex-add').addEventListener('click', addExpert);
    }
    modal.style.display = 'flex';
    await loadExperts();
    await loadProfiles();
  }

  // Read-only list of registered users (admin-gated by RLS). No actions.
  async function loadProfiles() {
    const list = document.getElementById('mlc-pr-list');
    if (!list) return;
    list.textContent = 'Loading…';
    try {
      const res = await fetch(REST_BASE + '/profiles?select=email,full_name,role,created_at&order=created_at.desc',
        { headers: { 'apikey': PUB, 'Authorization': 'Bearer ' + session.access_token } });
      if (!res.ok) { list.textContent = 'Failed to load (HTTP ' + res.status + ').'; return; }
      const rows = await res.json();
      if (!rows.length) { list.textContent = 'No registered users yet.'; return; }
      list.innerHTML = rows.map(r => `<div style="display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px solid #222;">
        <span>${(r.full_name || '').replace(/</g, '&lt;')} <span style="color:#777;">&lt;${(r.email || '').replace(/</g, '&lt;')}&gt;</span></span>
        <span style="color:#777;white-space:nowrap;">${r.role} · ${(r.created_at || '').slice(0, 10)}</span></div>`).join('');
    } catch (e) { list.textContent = 'Failed to load.'; }
  }

  function exMsg(t, kind) {
    const m = document.getElementById('mlc-ex-msg');
    if (m) { m.textContent = t || ''; m.style.color = kind === 'err' ? '#d9736a' : (kind === 'ok' ? '#6ab07a' : '#999'); }
  }

  async function loadExperts() {
    const list = document.getElementById('mlc-ex-list');
    list.textContent = 'Loading…';
    try {
      const res = await fetch(REST_BASE + '/allowed_experts?select=email,full_name,role,approved_at&order=created_at.desc',
        { headers: { 'apikey': PUB, 'Authorization': 'Bearer ' + session.access_token } });
      if (!res.ok) { list.textContent = 'Failed to load (HTTP ' + res.status + ').'; return; }
      const rows = await res.json();
      if (!rows.length) { list.textContent = 'No experts yet.'; return; }
      list.innerHTML = rows.map(r => `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #222;">
        <span>${(r.full_name || '').replace(/</g, '&lt;')} <span style="color:#777;">&lt;${(r.email || '').replace(/</g, '&lt;')}&gt;</span></span>
        <span style="color:${r.role === 'admin' ? '#c9a94a' : '#6a8ab0'};text-transform:uppercase;font-size:10px;">${r.role}</span></div>`).join('');
    } catch (e) { list.textContent = 'Failed to load.'; }
  }

  async function addExpert() {
    const email = (document.getElementById('mlc-ex-email').value || '').trim();
    const name = (document.getElementById('mlc-ex-name').value || '').trim();
    const role = document.getElementById('mlc-ex-role').value;
    if (!email || !name) { exMsg('Email and full name are required.', 'err'); return; }
    exMsg('Adding…');
    try {
      const res = await fetch(REST_BASE + '/allowed_experts', {
        method: 'POST',
        headers: { 'apikey': PUB, 'Authorization': 'Bearer ' + session.access_token, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({ email, full_name: name, role, approved_by: session.user_id, approved_at: new Date().toISOString() }),
      });
      if (!res.ok) { const d = await res.text(); exMsg('Add failed: ' + d.slice(0, 120), 'err'); return; }
      document.getElementById('mlc-ex-email').value = '';
      document.getElementById('mlc-ex-name').value = '';
      exMsg('Added.', 'ok');
      await loadExperts();
    } catch (e) { exMsg('Add failed.', 'err'); }
  }

  // ── Boot gate ─────────────────────────────────────────────────────────────────
  function applyPostAuth(p) {
    hideOverlay();
    if (p.role !== 'admin') {
      const ab = document.getElementById('btn-admin');
      if (ab) ab.style.display = 'none';
    }
    addSessionChrome(p);
    // Keep the access token fresh across long rating sessions (default TTL ~1h)
    // so mid-session REST/function calls don't 401.
    if (!window.__mlcRefreshTimer) {
      window.__mlcRefreshTimer = setInterval(() => { doRefresh().catch(() => {}); }, 45 * 60 * 1000);
    }
    if (!window.__mlcAppStarted) { window.__mlcAppStarted = true; if (typeof window.init === 'function') window.init(); }
  }

  window.__mlcBoot = async function () {
    buildAuthOverlay();
    if (session && session.access_token) {
      let p = await fetchProfile();
      if (!p && await doRefresh()) p = await fetchProfile();  // expired access token → refresh once
      if (p) { applyPostAuth(p); return; }
      saveSession(null);   // stale/expired + refresh failed → require re-login
    }
    showScreen('login');
  };
})();
