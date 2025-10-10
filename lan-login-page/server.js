const path = require('path');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const morgan = require('morgan');
const axios = require('axios');
const fs = require('fs');
const https = require('https');
const http = require('http');
const QRCode = require('qrcode');

require('dotenv').config();


const app = express();

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const HTTPS_ENABLED = process.env.HTTPS_ENABLED === 'true';
const TLS_KEY = process.env.TLS_KEY || '';
const TLS_CERT = process.env.TLS_CERT || '';
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 3443);

if (HTTPS_ENABLED && TLS_KEY && TLS_CERT && fs.existsSync(TLS_KEY) && fs.existsSync(TLS_CERT)) {
  const httpsServer = https.createServer({
    key: fs.readFileSync(TLS_KEY),
    cert: fs.readFileSync(TLS_CERT)
  }, app);
  httpsServer.listen(HTTPS_PORT, HOST, () => {
    console.log(`HTTPS listening at https://${HOST}:${HTTPS_PORT}  (self-signed)`);
  });
} else {
  console.log('HTTPS disabled or missing cert files – serving HTTP only.');
}

const SESSION_NAME = 'sid';
const COUCH_URL = (process.env.COUCH_URL || 'http://127.0.0.1:5984').replace(/\/+$/, '');
const COUCH_ADMIN_USER = process.env.COUCH_ADMIN_USER || '';
const COUCH_ADMIN_PASS = process.env.COUCH_ADMIN_PASS || '';
const PRIMARY_DB = process.env.PRIMARY_DB || 'attendance';

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "img-src": ["'self'", "data:"],
      "style-src": ["'self'", "'unsafe-inline'"], // why: allow minimal inline styles in dialogs
      "script-src": ["'self'"]
    }
  }
}));
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(session({
  name: SESSION_NAME,
  secret: process.env.SESSION_SECRET || 'dev_only_secret',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 8 }
}));
app.use(express.static(path.join(__dirname, 'public')));

/* auth helpers */
function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  res.redirect('/');
}
function requireRole(role) {
  return (req, res, next) => {
    const roles = req.session?.user?.roles || [];
    if (roles.includes(role)) return next();
    res.status(403).sendFile(path.join(__dirname, 'public', '403.html'));
  };
}
async function couchAuthenticate(name, password) {
  const url = `${COUCH_URL}/_session`;
  const res = await axios.post(
    url,
    new URLSearchParams({ name, password }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, validateStatus: () => true }
  );
  const ok = res.status === 200 && res.data?.ok === true;
  const cookie = (res.headers['set-cookie'] || []).find(c => c.startsWith('AuthSession='));
  if (!ok || !cookie) throw new Error(res.data?.reason || 'authentication_failed');
  return {
    name: res.data.userCtx?.name || name,
    roles: res.data.userCtx?.roles || [],
    couchCookie: cookie.split(';')[0]
  };
}
async function couchLogout(couchCookie) {
  if (!couchCookie) return;
  const url = `${COUCH_URL}/_session`;
  try { await axios.delete(url, { headers: { Cookie: couchCookie }, validateStatus: () => true }); } catch {}
}
function httpAsUser(req) {
  return axios.create({
    headers: { 'Content-Type': 'application/json', Cookie: req.session?.couchCookie || '' },
    validateStatus: () => true,
    timeout: 8000
  });
}
function httpAsAdmin() {
  if (!COUCH_ADMIN_USER || !COUCH_ADMIN_PASS) return null;
  return axios.create({
    auth: { username: COUCH_ADMIN_USER, password: COUCH_ADMIN_PASS },
    headers: { 'Content-Type': 'application/json' },
    validateStatus: () => true,
    timeout: 8000
  });
}

/* pages */
app.get('/', (req, res) => {
  if (req.session?.user) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ ok: false, message: 'Μη έγκυρη υποβολή.' });
  try {
    const auth = await couchAuthenticate(String(username), String(password));
    req.session.user = { name: auth.name, roles: auth.roles };
    req.session.couchCookie = auth.couchCookie;
    res.json({ ok: true, redirect: '/dashboard' });
  } catch {
    res.status(401).json({ ok: false, message: 'Λανθασμένα στοιχεία.' });
  }
});
function handleLogout(req, res) {
  const cookie = req.session?.couchCookie;
  const done = () => { res.clearCookie(SESSION_NAME, { path: '/', sameSite: 'lax' }); res.redirect(303, '/'); };
  couchLogout(cookie).finally(() => { if (req.session) req.session.destroy(() => done()); else done(); });
}
app.post('/logout', handleLogout);
app.get('/logout', handleLogout);

app.get('/dashboard', requireAuth, (_req, res) => res.sendFile(path.join(__dirname, 'protected', 'dashboard.html')));
app.get('/event-new', requireAuth, (_req, res) => res.sendFile(path.join(__dirname, 'protected', 'event-new.html')));
app.get('/profile', requireAuth, (_req, res) => res.sendFile(path.join(__dirname, 'protected', 'profile.html')));
app.get('/me', requireAuth, (req, res) => res.json({ ok: true, user: req.session.user }));

/* ======= Event Types + Event Create ======= */
/* returns [{code,name}] from PRIMARY_DB; expects docs with kind:'event_type' OR _id 'eventtype:<code>' */
app.get('/api/event-types', requireAuth, async (req, res) => {
  const http = httpAsUser(req);
  // Try Mango first
  try {
    const r = await http.post(`${COUCH_URL}/${encodeURIComponent(PRIMARY_DB)}/_find`, {
      selector: { kind: 'event_type' },
      fields: ['_id', 'code', 'name', 'active'],
      sort: [{ name: 'asc' }]
    });
    if (r.status === 200) {
      const rows = (r.data.docs || [])
        .filter(d => d.active !== false)
        .map(d => ({ code: d.code || String(d._id).replace(/^eventtype:/,''), name: d.name || d.code }));
      if (rows.length) return res.json({ ok: true, rows });
    }
  } catch {}
  // Fallback to _all_docs prefix scan
  try {
    const r2 = await http.get(`${COUCH_URL}/${encodeURIComponent(PRIMARY_DB)}/_all_docs`, {
      params: {
        startkey: JSON.stringify('eventtype:'),
        endkey: JSON.stringify('eventtype;\uffff'),
        include_docs: true
      }
    });
    if (r2.status === 200) {
      const rows = (r2.data.rows || [])
        .map(x => x.doc)
        .filter(Boolean)
        .filter(d => d.active !== false)
        .map(d => ({ code: d.code || String(d._id).replace(/^eventtype:/,''), name: d.name || d.code }));
      return res.json({ ok: true, rows });
    }
  } catch {}
  res.status(502).json({ ok: false, rows: [] });
});

app.get('/api/db-details', requireAuth, async (req, res) => {
  try {
    const base = `${COUCH_URL}/${encodeURIComponent(PRIMARY_DB)}`;

    // user-scoped HTTP (uses CouchDB AuthSession cookie stored in your Express session)
    const httpUser = axios.create({
      headers: { 'Content-Type': 'application/json', Cookie: req.session?.couchCookie || '' },
      validateStatus: () => true,
      timeout: 8000
    });

    // admin-scoped HTTP (only if creds exist in .env)
    const adminUser = process.env.COUCH_ADMIN_USER || COUCH_ADMIN_USER || '';
    const adminPass = process.env.COUCH_ADMIN_PASS || COUCH_ADMIN_PASS || '';
    const httpAdmin = (adminUser && adminPass)
      ? axios.create({
          auth: { username: adminUser, password: adminPass },
          headers: { 'Content-Type': 'application/json' },
          validateStatus: () => true,
          timeout: 8000
        })
      : null;

    const [rootUp, dbInfo, dbsInfo, sec] = await Promise.allSettled([
      axios.get(`${COUCH_URL}/_up`, { validateStatus: () => true }),
      httpUser.get(base, { validateStatus: () => true }),
      httpUser.post(`${COUCH_URL}/_dbs_info`, { keys: [PRIMARY_DB] }, { validateStatus: () => true }),
      httpAdmin ? httpAdmin.get(`${base}/_security`, { validateStatus: () => true }) : Promise.resolve({ status: 'noadmin' })
    ]);

    const online = rootUp.status === 'fulfilled' && rootUp.value.status === 200 && rootUp.value.data?.status === 'ok';
    const active = dbInfo.status === 'fulfilled' && dbInfo.value.status === 200;

    const d = active ? dbInfo.value.data : {};
    const row = (dbsInfo.status === 'fulfilled' && dbsInfo.value.status === 200 && dbsInfo.value.data?.rows?.[0]) || {};
    const info = row.info || {};
    const props = info.props || d.props || {};
    const sizes = d.sizes || info.sizes || {};
    const cluster = d.cluster || {};

    const security = httpAdmin
      ? (sec.status === 'fulfilled' && (sec.value.status === 200 || sec.value.status === 404) ? (sec.value.data || {}) : null)
      : null;

    res.json({
      ok: true,
      db: PRIMARY_DB,
      online,
      active,
      details: {
        doc_count: d.doc_count ?? 0,
        doc_del_count: d.doc_del_count ?? 0,
        update_seq: d.update_seq ?? null,
        purge_seq: d.purge_seq ?? null,
        compact_running: !!d.compact_running,
        sizes: {
          file: sizes.file ?? null,
          active: sizes.active ?? null,
          external: sizes.external ?? null
        },
        cluster: {
          q: cluster.q ?? null,
          n: cluster.n ?? null,
          w: cluster.w ?? null,
          r: cluster.r ?? null
        },
        props: {
          partitioned: props.partitioned === true || d.props?.partitioned === true || false
        },
        security // null if no admin creds
      }
    });
  } catch (e) {
    console.error('[api/db-details] error:', e?.message || e);
    res.status(502).json({ ok: false, message: 'db_details_failed' });
  }
});

/* --- Optional: route inspector (helps confirm registration). Remove in prod. --- */
app.get('/__routes', (req, res) => {
  const list = [];
  (app._router?.stack || []).forEach(l => {
    if (l.route && l.route.path) {
      const methods = Object.keys(l.route.methods).filter(m => l.route.methods[m]);
      list.push({ methods, path: l.route.path });
    }
  });
  res.json(list);
});

// File: server.js  (ADD the two routes below somewhere with your other routes)
// Requires: axios already imported, requireAuth middleware, COUCH_URL, PRIMARY_DB, httpAsUser(req) helper available

/* Ensure index once (optional, run via Postman or call it from UI if you like) */
app.post('/api/events/_ensure-index', requireAuth, async (req, res) => {
  try {
    const httpU = axios.create({
      headers: { 'Content-Type': 'application/json', Cookie: req.session?.couchCookie || '' },
      validateStatus: () => true, timeout: 8000
    });
    const r = await httpU.post(`${COUCH_URL}/${encodeURIComponent(PRIMARY_DB)}/_index`, {
      index: { fields: ['kind','ts'] }, name: 'by_kind_ts', type: 'json'
    });
    if (r.status === 200 || r.status === 201) return res.json({ ok: true, index: 'by_kind_ts' });
    res.status(502).json({ ok: false, message: 'index_failed', status: r.status, body: r.data });
  } catch (e) {
    res.status(502).json({ ok: false, message: 'index_error' });
  }
});

/* List event logs with Mango + bookmark paging */
app.get('/api/events', requireAuth, async (req, res) => {
  try {
    const { limit, bookmark, type, createdBy } = req.query || {};
    const lim = Math.max(1, Math.min(100, parseInt(limit, 10) || 25));
    const selector = { kind: 'event' };
    if (type) selector.type = String(type);
    if (createdBy) selector.createdBy = String(createdBy);

    const httpU = axios.create({
      headers: { 'Content-Type': 'application/json', Cookie: req.session?.couchCookie || '' },
      validateStatus: () => true, timeout: 10000
    });

    // Try sorted query first (requires index on kind,ts)
    let body = { selector, limit: lim, sort: [{ ts: 'desc' }] };
    if (bookmark) body.bookmark = String(bookmark);

    let r = await httpU.post(`${COUCH_URL}/${encodeURIComponent(PRIMARY_DB)}/_find`, body);

    // Fallback without sort if CouchDB complains about sorting/index
    if (r.status !== 200) {
      const fb = { selector, limit: lim };
      if (bookmark) fb.bookmark = String(bookmark);
      r = await httpU.post(`${COUCH_URL}/${encodeURIComponent(PRIMARY_DB)}/_find`, fb);
      if (r.status !== 200) return res.status(502).json({ ok: false, message: 'find_failed', status: r.status, body: r.data });
      // Sort by ts desc in Node
      if (Array.isArray(r.data?.docs)) {
        r.data.docs.sort((a,b)=> String(b.ts||'').localeCompare(String(a.ts||'')));
      }
    }

    const docs = Array.isArray(r.data?.docs) ? r.data.docs : [];
    const rows = docs.map(d => ({
      _id: d._id, ts: d.ts, type: d.type, qrData: d.qrData, createdBy: d.createdBy
    }));
    return res.json({ ok: true, rows, bookmark: r.data?.bookmark || null });
  } catch (e) {
    console.error('[api/events] error:', e?.message || e);
    res.status(502).json({ ok: false, message: 'events_failed' });
  }
});


app.get('/partials/sidebar.html', requireAuth, (req, res) => {
  // why: serve the shared sidebar partial to all pages via /sidebar.js fetch
  res.set('Cache-Control', 'public, max-age=300'); // optional
  res.sendFile(path.join(__dirname, 'public', 'partials', 'sidebar.html'));
});

app.get('/api/summary', requireAuth, async (req, res) => {
  try {
    const COUCH_URL  = (process.env.COUCH_URL || 'http://127.0.0.1:5984').replace(/\/+$/, '');
    const PRIMARY_DB = process.env.PRIMARY_DB || 'attendance';

    // user-scoped client (uses CouchDB AuthSession stored in Express session)
    const httpUser = axios.create({
      headers: { 'Content-Type': 'application/json', Cookie: req.session?.couchCookie || '' },
      validateStatus: () => true,
      timeout: 8000
    });

    // 1) Couch online?
    const up = await axios.get(`${COUCH_URL}/_up`, { validateStatus: () => true }).catch(()=>({status:0,data:{}}));
    const online = up.status === 200 && up.data?.status === 'ok';

    // 2) DB info
    const info = await httpUser.get(`${COUCH_URL}/${encodeURIComponent(PRIMARY_DB)}`, { validateStatus: () => true });
    const active = info.status === 200;
    const sizes = info.data?.sizes || {};
    const sizeBytes = sizes.file ?? sizes.active ?? sizes.external ?? 0;
    const docCount = info.data?.doc_count ?? 0;

    // 3) Optional: count users if admin creds exist (safe fallback to null)
    let usersCount = null;
    const ADM_USER = process.env.COUCH_ADMIN_USER || '';
    const ADM_PASS = process.env.COUCH_ADMIN_PASS || '';
    if (ADM_USER && ADM_PASS) {
      const httpAdmin = axios.create({
        auth: { username: ADM_USER, password: ADM_PASS },
        validateStatus: () => true,
        timeout: 8000
      });
      const ur = await httpAdmin.get(`${COUCH_URL}/_users/_all_docs`, {
        params: {
          startkey: JSON.stringify('org.couchdb.user:'),
          endkey:   JSON.stringify('org.couchdb.user;\uffff'),
          include_docs: false
        }
      });
      usersCount = Array.isArray(ur.data?.rows) ? ur.data.rows.length : null;
    }

    res.json({ ok: true, db: PRIMARY_DB, sizeBytes, docCount, usersCount, online, active });
  } catch (e) {
    console.error('[api/summary] error:', e?.message || e);
    res.status(502).json({ ok: false, message: 'summary_failed' });
  }
});

/* create event with QR payload */
app.post('/api/events', requireAuth, async (req, res) => {
  const { type, qr } = req.body || {};
  if (!type || !qr) return res.status(400).json({ ok: false, message: 'Απαιτούνται τύπος και QR.' });

  // Optional: validate that the chosen type exists
  try {
    const httpU = httpAsUser(req);
    const ts = new Date().toISOString();
    const doc = {
      kind: 'event',
      type: String(type),
      qrData: String(qr),
      ts,
      createdBy: req.session.user?.name || 'unknown'
    };
    const r = await httpU.post(`${COUCH_URL}/${encodeURIComponent(PRIMARY_DB)}`, doc);
    if (r.status === 201 || r.status === 202) return res.json({ ok: true, id: r.data.id, ts });
    return res.status(502).json({ ok: false, message: 'Αποτυχία εγγραφής.' });
  } catch {
    res.status(502).json({ ok: false, message: 'Σφάλμα διακομιστή.' });
  }
});

/* ======= Minimal profile password change (kept from earlier) ======= */
app.post('/api/me/password', requireAuth, async (req, res) => {
  try {
    const { current, next } = req.body || {};
    if (!next || next.length < 4) return res.status(400).json({ ok: false, message: 'Αδύναμος κωδικός.' });
    const username = req.session.user?.name;
    if (current) {
      try { await couchAuthenticate(username, current); }
      catch { return res.status(401).json({ ok: false, message: 'Λάθος τρέχων κωδικός.' }); }
    }
    const adm = httpAsAdmin(); if (!adm) return res.status(500).json({ ok: false, message: 'Δεν επιτρέπεται.' });
    const id = `org.couchdb.user:${username}`;
    const get = await adm.get(`${COUCH_URL}/_users/${encodeURIComponent(id)}`);
    if (get.status !== 200) return res.status(404).json({ ok: false });
    const doc = get.data; doc.password = String(next);
    const put = await adm.put(`${COUCH_URL}/_users/${encodeURIComponent(id)}`, doc);
    if (put.status === 201 || put.status === 202) return res.json({ ok: true });
    res.status(502).json({ ok: false });
  } catch { res.status(502).json({ ok: false }); }
});

/* ===== Admin: Event Types CRUD ===== */
app.get('/api/admin/event-types', requireAuth, requireRole('app:admin'), async (req, res) => {
  try {
    const httpU = httpAsUser(req);
    // Prefer Mango
    const r = await httpU.post(`${COUCH_URL}/${encodeURIComponent(PRIMARY_DB)}/_find`, {
      selector: { kind: 'event_type' },
      fields: ['_id','code','name','active'],
      sort: [{ name: 'asc' }],
      limit: 1000
    });
    if (r.status === 200) {
      const rows = (r.data.docs || []).map(d => ({
        code: d.code || String(d._id).replace(/^eventtype:/,''),
        name: d.name || d.code,
        active: d.active !== false
      }));
      return res.json({ ok: true, rows });
    }
    // Fallback to _all_docs prefix scan
    const r2 = await httpU.get(`${COUCH_URL}/${encodeURIComponent(PRIMARY_DB)}/_all_docs`, {
      params: { include_docs: true, startkey: JSON.stringify('eventtype:'), endkey: JSON.stringify('eventtype;\uffff') }
    });
    if (r2.status === 200) {
      const rows = (r2.data.rows || []).map(x => x.doc).filter(Boolean).map(d => ({
        code: d.code || String(d._id).replace(/^eventtype:/,''),
        name: d.name || d.code,
        active: d.active !== false
      }));
      return res.json({ ok: true, rows });
    }
    res.status(502).json({ ok: false, message: 'list_failed' });
  } catch { res.status(502).json({ ok: false }); }
});

app.post('/api/admin/event-types', requireAuth, requireRole('app:admin'), async (req, res) => {
  try {
    const { code, name, active } = req.body || {};
    const c = String(code || '').trim();
    if (!c || !/^[a-z0-9._-]+$/i.test(c)) return res.status(400).json({ ok: false, message: 'Invalid code.' });
    const doc = {
      _id: `eventtype:${c}`,
      kind: 'event_type',
      code: c,
      name: String(name || c),
      active: active !== false,
      updatedAt: new Date().toISOString()
    };
    const httpU = httpAsUser(req);
    const put = await httpU.put(`${COUCH_URL}/${encodeURIComponent(PRIMARY_DB)}/${encodeURIComponent(doc._id)}`, doc);
    if (put.status === 201 || put.status === 202) return res.json({ ok: true });
    if (put.status === 409) return res.status(409).json({ ok: false, message: 'Type exists.' });
    res.status(502).json({ ok: false, message: 'create_failed' });
  } catch { res.status(502).json({ ok: false }); }
});

app.patch('/api/admin/event-types/:code', requireAuth, requireRole('app:admin'), async (req, res) => {
  try {
    const code = String(req.params.code || '').trim();
    if (!code) return res.status(400).json({ ok: false });
    const id = `eventtype:${code}`;
    const httpU = httpAsUser(req);
    const get = await httpU.get(`${COUCH_URL}/${encodeURIComponent(PRIMARY_DB)}/${encodeURIComponent(id)}`);
    if (get.status !== 200) return res.status(404).json({ ok: false });
    const doc = get.data;
    if (req.body.name !== undefined) doc.name = String(req.body.name || code);
    if (req.body.active !== undefined) doc.active = !!req.body.active;
    doc.updatedAt = new Date().toISOString();
    const put = await httpU.put(`${COUCH_URL}/${encodeURIComponent(PRIMARY_DB)}/${encodeURIComponent(id)}`, doc);
    if (put.status === 201 || put.status === 202) return res.json({ ok: true });
    res.status(502).json({ ok: false, message: 'update_failed' });
  } catch { res.status(502).json({ ok: false }); }
});

app.delete('/api/admin/event-types/:code', requireAuth, requireRole('app:admin'), async (req, res) => {
  try {
    const code = String(req.params.code || '').trim();
    const id = `eventtype:${code}`;
    const httpU = httpAsUser(req);
    const get = await httpU.get(`${COUCH_URL}/${encodeURIComponent(PRIMARY_DB)}/${encodeURIComponent(id)}`);
    if (get.status !== 200) return res.status(404).json({ ok: false });
    const del = await httpU.delete(`${COUCH_URL}/${encodeURIComponent(PRIMARY_DB)}/${encodeURIComponent(id)}`, { params: { rev: get.data._rev } });
    if (del.status === 200) return res.json({ ok: true });
    res.status(502).json({ ok: false, message: 'delete_failed' });
  } catch { res.status(502).json({ ok: false }); }
});

/* ===== Users Admin: include profile fields ===== */
app.get('/api/users', requireAuth, requireRole('app:admin'), async (_req, res) => {
  try {
    const adm = httpAsAdmin(); if (!adm) return res.status(500).json({ ok: false });
    const r = await adm.get(`${COUCH_URL}/_users/_all_docs`, {
      params: { include_docs: true, startkey: JSON.stringify('org.couchdb.user:'), endkey: JSON.stringify('org.couchdb.user;\uffff') }
    });
    const rows = (r.data?.rows || [])
      .map(x => x.doc)
      .filter(Boolean)
      .map(d => ({
        name: d.name,
        roles: d.roles || [],
        fullName: d.fullName || '',
        email: d.email || '',
        department: d.department || '',
        phone: d.phone || ''
      }))
      .filter(u => !!u.name);
    res.json({ ok: true, rows });
  } catch { res.status(502).json({ ok: false }); }
});

app.post('/api/users', requireAuth, requireRole('app:admin'), async (req, res) => {
  try {
    const { name, password, roles, fullName, email, department, phone } = req.body || {};
    if (!name || !password) return res.status(400).json({ ok: false, message: 'Username/Password required.' });
    const rs = Array.isArray(roles) ? roles : String(roles || '').split(',').map(s => s.trim()).filter(Boolean);
    const adm = httpAsAdmin(); if (!adm) return res.status(500).json({ ok: false });
    const id = `org.couchdb.user:${name}`;
    const payload = {
      _id: id, name, type: 'user', roles: rs, password,
      fullName: fullName || '', email: email || '', department: department || '', phone: phone || ''
    };
    const put = await adm.put(`${COUCH_URL}/_users/${encodeURIComponent(id)}`, payload);
    if (put.status === 201 || put.status === 202) return res.json({ ok: true });
    if (put.status === 409) return res.status(409).json({ ok: false, message: 'User exists.' });
    res.status(502).json({ ok: false, message: 'create_failed' });
  } catch { res.status(502).json({ ok: false }); }
});

app.patch('/api/users/:name', requireAuth, requireRole('app:admin'), async (req, res) => {
  try {
    const name = String(req.params.name);
    const { roles, password, fullName, email, department, phone } = req.body || {};
    const adm = httpAsAdmin(); if (!adm) return res.status(500).json({ ok: false });
    const id = `org.couchdb.user:${name}`;
    const get = await adm.get(`${COUCH_URL}/_users/${encodeURIComponent(id)}`);
    if (get.status !== 200) return res.status(404).json({ ok: false, message: 'Not found.' });
    const doc = get.data;
    if (roles !== undefined) doc.roles = (Array.isArray(roles) ? roles : String(roles || '').split(',').map(s => s.trim()).filter(Boolean));
    if (password) doc.password = String(password);
    if (fullName !== undefined) doc.fullName = String(fullName || '');
    if (email !== undefined) doc.email = String(email || '');
    if (department !== undefined) doc.department = String(department || '');
    if (phone !== undefined) doc.phone = String(phone || '');
    const put = await adm.put(`${COUCH_URL}/_users/${encodeURIComponent(id)}`, doc);
    if (put.status === 201 || put.status === 202) return res.json({ ok: true });
    res.status(502).json({ ok: false, message: 'update_failed' });
  } catch { res.status(502).json({ ok: false }); }
});

app.post('/api/admin/qr', requireAuth, requireRole('app:admin'), async (req, res) => {
  try {
    const {
      username = '',
      fullName = '',
      employeeId = '',
      department = '',
      phone = ''
    } = req.body || {};

    if (!username || !employeeId) {
      return res.status(400).json({ ok: false, message: 'username and employeeId are required' });
    }

    // Compact JSON payload (scan-friendly)
    const payload = {
      v: 1,
      uid: String(username).trim(),
      eid: String(employeeId).trim(),
      n: String(fullName || '').trim(),
      d: String(department || '').trim(),
      p: String(phone || '').trim(),
      iat: new Date().toISOString()
    };

    const text = JSON.stringify(payload);
    const dataUrl = await QRCode.toDataURL(text, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 520,
      scale: 8
    });

    const filename = `qr_${payload.uid}_${payload.eid}.png`.replace(/[^\w.-]+/g, '_');
    return res.json({
      ok: true,
      filename,
      mime: 'image/png',
      sizeHint: dataUrl.length, // bytes-ish (base64 length)
      payload,
      dataUrl
    });
  } catch (e) {
    console.error('[admin/qr] error', e?.message || e);
    res.status(500).json({ ok: false, message: 'qr_failed' });
  }
});


app.listen(PORT, HOST, () => {
  console.log(`Listening at http://${HOST}:${PORT}`);
  console.log(`CouchDB: ${COUCH_URL} | DB: ${PRIMARY_DB}`);
});
