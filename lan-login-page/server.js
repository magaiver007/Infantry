// File: server.js
// Minimal comments; doc over inline comments by design.

const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const express = require('express');
const session = require('express-session');
const morgan = require('morgan');
const helmet = require('helmet');
const axios = require('axios');
const crypto = require('crypto');
const QRCode = require('qrcode');

// ── runtime/env loading (works for pkg single-EXE too)
const isPkg = typeof process.pkg !== 'undefined';
const exeDir = isPkg ? path.dirname(process.execPath) : __dirname;
require('dotenv').config({ path: path.join(exeDir, '.env') });

// ── config
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 3000);

const HTTPS_ENABLED = String(process.env.HTTPS_ENABLED || '').toLowerCase() === 'true';
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 3443);
const TLS_PFX = process.env.TLS_PFX ? (path.isAbsolute(process.env.TLS_PFX) ? process.env.TLS_PFX : path.join(exeDir, process.env.TLS_PFX)) : '';
const TLS_PFX_PASSPHRASE = process.env.TLS_PFX_PASSPHRASE || '';
const TLS_KEY = process.env.TLS_KEY ? (path.isAbsolute(process.env.TLS_KEY) ? process.env.TLS_KEY : path.join(exeDir, process.env.TLS_KEY)) : '';
const TLS_CERT = process.env.TLS_CERT ? (path.isAbsolute(process.env.TLS_CERT) ? process.env.TLS_CERT : path.join(exeDir, process.env.TLS_CERT)) : '';

const SESSION_SECRET = process.env.SESSION_SECRET || (crypto.randomBytes(32).toString('hex') + crypto.randomBytes(32).toString('hex'));

const COUCH_URL = process.env.COUCH_URL || 'http://127.0.0.1:5984';
const PRIMARY_DB = process.env.PRIMARY_DB || 'attendance';
const ADM_USER = process.env.COUCH_ADMIN_USER || '';
const ADM_PASS = process.env.COUCH_ADMIN_PASS || '';

// ── helpers
const uuid = () => crypto.randomUUID();
const file = (...p) => path.join(__dirname, ...p);
const pub = (...p) => path.join(__dirname, 'public', ...p);
const prot = (...p) => path.join(__dirname, 'protected', ...p);

// ── axios helpers
function httpAsUser(req, extra = {}) {
  const inst = axios.create({
    baseURL: COUCH_URL,
    headers: { Cookie: req.session?.couchCookie || '', 'Content-Type': 'application/json', ...(extra.headers || {}) },
    validateStatus: () => true,
    timeout: 15000,
  });
  return inst;
}
function httpAsAdmin(extra = {}) {
  if (!ADM_USER || !ADM_PASS) return null;
  return axios.create({
    baseURL: COUCH_URL,
    auth: { username: ADM_USER, password: ADM_PASS },
    headers: { 'Content-Type': 'application/json', ...(extra.headers || {}) },
    validateStatus: () => true,
    timeout: 15000,
  });
}

// ── express app
const app = express();
app.set('trust proxy', true);

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "img-src": ["'self'", "data:"],
      "script-src": ["'self'"],
      "style-src": ["'self'", "'unsafe-inline'"],
      "connect-src": ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: { policy: 'same-origin' },
  crossOriginResourcePolicy: { policy: 'same-origin' },
}));

app.use(morgan('dev'));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(session({
  name: 'sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { sameSite: 'lax', httpOnly: true, secure: false, maxAge: 1000 * 60 * 60 * 8 },
}));

// static
app.use(express.static(pub()));

// ── auth guards
function requireAuth(req, res, next) {
  if (req.session?.user?.name) return next();
  return res.status(302).redirect('/');
}
function requireRole(role) {
  return (req, res, next) => {
    const roles = req.session?.user?.roles || [];
    if (roles.includes(role)) return next();
    return res.status(403).json({ ok: false, message: 'forbidden' });
  };
}

// ── routes: pages
app.get('/', (req, res) => res.sendFile(pub('login.html')));
app.get('/dashboard', requireAuth, (req, res) => res.sendFile(prot('dashboard.html')));
app.get('/event-new', requireAuth, (req, res) => res.sendFile(prot('event-new.html')));
app.get('/profile', requireAuth, (req, res) => res.sendFile(prot('profile.html')));
// shared partial
app.get('/partials/sidebar.html', requireAuth, (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.sendFile(pub('partials', 'sidebar.html'));
});

// ── sessions: login/logout/me
app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ ok: false, message: 'Missing credentials' });
    const r = await axios({
      method: 'post',
      url: `${COUCH_URL}/_session`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: new URLSearchParams({ name: username, password }),
      validateStatus: () => true,
    });

    if (r.status !== 200 || !r.data?.ok) return res.status(401).json({ ok: false, message: 'Invalid credentials' });

    const setCookie = r.headers['set-cookie'] || [];
    const couchCookie = setCookie.find(x => x.startsWith('AuthSession=')) || '';
    const roles = Array.isArray(r.data?.roles) ? r.data.roles : (r.data?.userCtx?.roles || []);
    const name = r.data?.name || r.data?.userCtx?.name || username;

    req.session.couchCookie = couchCookie;
    req.session.user = { name, roles };
    return res.json({ ok: true, user: req.session.user });
  } catch (e) {
    return res.status(502).json({ ok: false, message: 'login_failed' });
  }
});

app.post('/logout', requireAuth, async (req, res) => {
  try {
    if (req.session?.couchCookie) {
      await axios({ method: 'delete', url: `${COUCH_URL}/_session`, headers: { Cookie: req.session.couchCookie }, validateStatus: () => true }).catch(() => null);
    }
  } finally {
    req.session.destroy(() => {});
    res.clearCookie('sid');
    res.redirect('/');
  }
});

app.get('/me', requireAuth, (req, res) => {
  res.json({ ok: true, user: req.session.user || null });
});

// ── API: summary
app.get('/api/summary', requireAuth, async (req, res) => {
  try {
    const httpU = httpAsUser(req);
    const up = await axios.get(`${COUCH_URL}/_up`, { validateStatus: () => true }).catch(() => ({ status: 0, data: {} }));
    const online = up.status === 200 && up.data?.status === 'ok';

    const info = await httpU.get(`/${encodeURIComponent(PRIMARY_DB)}`, { validateStatus: () => true });
    const active = info.status === 200;
    const sizes = info.data?.sizes || {};
    const sizeBytes = sizes.file ?? sizes.active ?? sizes.external ?? 0;
    const docCount = info.data?.doc_count ?? 0;

    let usersCount = null;
    const adm = httpAsAdmin();
    if (adm) {
      const ur = await adm.get(`/_users/_all_docs`, {
        params: { startkey: JSON.stringify('org.couchdb.user:'), endkey: JSON.stringify('org.couchdb.user;\uffff'), include_docs: false },
      });
      usersCount = Array.isArray(ur.data?.rows) ? ur.data.rows.length : null;
    }

    res.json({ ok: true, db: PRIMARY_DB, sizeBytes, docCount, usersCount, online, active });
  } catch (e) {
    res.status(502).json({ ok: false, message: 'summary_failed' });
  }
});

// ── API: db-details
app.get('/api/db-details', requireAuth, async (req, res) => {
  try {
    const httpU = httpAsUser(req);
    const details = await httpU.get(`/${encodeURIComponent(PRIMARY_DB)}`, { validateStatus: () => true });
    if (details.status !== 200) return res.status(502).json({ ok: false, message: 'db_info_failed', status: details.status });

    const out = { ok: true, db: PRIMARY_DB, details: details.data || {} };

    const adm = httpAsAdmin();
    if (adm) {
      const sec = await adm.get(`/${encodeURIComponent(PRIMARY_DB)}/_security`, { validateStatus: () => true });
      if (sec.status === 200) out.details.security = sec.data;
    }
    res.json(out);
  } catch (e) {
    res.status(502).json({ ok: false, message: 'db_details_failed' });
  }
});

// ── API: users admin
app.get('/api/users', requireAuth, requireRole('app:admin'), async (_req, res) => {
  try {
    const adm = httpAsAdmin(); if (!adm) return res.status(500).json({ ok: false, message: 'admin_not_configured' });
    const r = await adm.get(`/_users/_all_docs`, {
      params: { include_docs: true, startkey: JSON.stringify('org.couchdb.user:'), endkey: JSON.stringify('org.couchdb.user;\uffff') },
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
        phone: d.phone || '',
      }))
      .filter(u => !!u.name);
    res.json({ ok: true, rows });
  } catch {
    res.status(502).json({ ok: false });
  }
});

app.post('/api/users', requireAuth, requireRole('app:admin'), async (req, res) => {
  try {
    const { name, password, roles, fullName, email, department, phone } = req.body || {};
    if (!name || !password) return res.status(400).json({ ok: false, message: 'Username/Password required' });
    const rs = Array.isArray(roles) ? roles : String(roles || '').split(',').map(s => s.trim()).filter(Boolean);
    const adm = httpAsAdmin(); if (!adm) return res.status(500).json({ ok: false, message: 'admin_not_configured' });
    const id = `org.couchdb.user:${name}`;
    const payload = { _id: id, name, type: 'user', roles: rs, password, fullName: fullName || '', email: email || '', department: department || '', phone: phone || '' };
    const put = await adm.put(`/_users/${encodeURIComponent(id)}`, payload);
    if (put.status === 201 || put.status === 202) return res.json({ ok: true });
    if (put.status === 409) return res.status(409).json({ ok: false, message: 'User exists' });
    res.status(502).json({ ok: false, message: 'create_failed' });
  } catch { res.status(502).json({ ok: false }); }
});

app.patch('/api/users/:name', requireAuth, requireRole('app:admin'), async (req, res) => {
  try {
    const name = String(req.params.name);
    const { roles, password, fullName, email, department, phone } = req.body || {};
    const adm = httpAsAdmin(); if (!adm) return res.status(500).json({ ok: false, message: 'admin_not_configured' });
    const id = `org.couchdb.user:${name}`;
    const get = await adm.get(`/_users/${encodeURIComponent(id)}`);
    if (get.status !== 200) return res.status(404).json({ ok: false, message: 'Not found' });
    const doc = get.data;
    if (roles !== undefined) doc.roles = (Array.isArray(roles) ? roles : String(roles || '').split(',').map(s => s.trim()).filter(Boolean));
    if (password) doc.password = String(password);
    if (fullName !== undefined) doc.fullName = String(fullName || '');
    if (email !== undefined) doc.email = String(email || '');
    if (department !== undefined) doc.department = String(department || '');
    if (phone !== undefined) doc.phone = String(phone || '');
    const put = await adm.put(`/_users/${encodeURIComponent(id)}`, doc);
    if (put.status === 201 || put.status === 202) return res.json({ ok: true });
    res.status(502).json({ ok: false, message: 'update_failed' });
  } catch { res.status(502).json({ ok: false }); }
});

app.delete('/api/users/:name', requireAuth, requireRole('app:admin'), async (req, res) => {
  try {
    const name = String(req.params.name);
    const id = `org.couchdb.user:${name}`;
    const adm = httpAsAdmin(); if (!adm) return res.status(500).json({ ok: false, message: 'admin_not_configured' });
    const get = await adm.get(`/_users/${encodeURIComponent(id)}`);
    if (get.status !== 200) return res.status(404).json({ ok: false, message: 'Not found' });
    const del = await adm.delete(`/_users/${encodeURIComponent(id)}`, { params: { rev: get.data._rev } });
    if (del.status === 200) return res.json({ ok: true });
    res.status(502).json({ ok: false, message: 'delete_failed' });
  } catch { res.status(502).json({ ok: false }); }
});

// ── API: event types (public list for UI filters)
app.get('/api/event-types', requireAuth, async (req, res) => {
  try {
    const httpU = httpAsUser(req);
    const r = await httpU.post(`/${encodeURIComponent(PRIMARY_DB)}/_find`, {
      selector: { kind: 'event_type', active: { "$ne": false } },
      fields: ['code', 'name', 'active'],
      sort: [{ name: 'asc' }],
      limit: 1000,
    });
    if (r.status !== 200) return res.status(502).json({ ok: false, message: 'types_failed' });
    const rows = (r.data?.docs || []).map(d => ({ code: d.code || String(d._id).replace(/^eventtype:/, ''), name: d.name || d.code, active: d.active !== false }));
    res.json({ ok: true, rows });
  } catch { res.status(502).json({ ok: false }); }
});

// ── API: admin event types CRUD
app.get('/api/admin/event-types', requireAuth, requireRole('app:admin'), async (req, res) => {
  try {
    const httpU = httpAsUser(req);
    const r = await httpU.post(`/${encodeURIComponent(PRIMARY_DB)}/_find`, {
      selector: { kind: 'event_type' },
      fields: ['_id', 'code', 'name', 'active'],
      sort: [{ name: 'asc' }],
      limit: 1000,
    });
    if (r.status === 200) {
      const rows = (r.data.docs || []).map(d => ({ code: d.code || String(d._id).replace(/^eventtype:/, ''), name: d.name || d.code, active: d.active !== false }));
      return res.json({ ok: true, rows });
    }
    res.status(502).json({ ok: false, message: 'list_failed' });
  } catch { res.status(502).json({ ok: false }); }
});
app.post('/api/admin/event-types', requireAuth, requireRole('app:admin'), async (req, res) => {
  try {
    const { code, name, active } = req.body || {};
    const c = String(code || '').trim();
    if (!c || !/^[a-z0-9._-]+$/i.test(c)) return res.status(400).json({ ok: false, message: 'Invalid code' });
    const doc = { _id: `eventtype:${c}`, kind: 'event_type', code: c, name: String(name || c), active: active !== false, updatedAt: new Date().toISOString() };
    const httpU = httpAsUser(req);
    const put = await httpU.put(`/${encodeURIComponent(PRIMARY_DB)}/${encodeURIComponent(doc._id)}`, doc);
    if (put.status === 201 || put.status === 202) return res.json({ ok: true });
    if (put.status === 409) return res.status(409).json({ ok: false, message: 'Type exists' });
    res.status(502).json({ ok: false, message: 'create_failed' });
  } catch { res.status(502).json({ ok: false }); }
});
app.patch('/api/admin/event-types/:code', requireAuth, requireRole('app:admin'), async (req, res) => {
  try {
    const code = String(req.params.code || '').trim();
    const id = `eventtype:${code}`;
    const httpU = httpAsUser(req);
    const get = await httpU.get(`/${encodeURIComponent(PRIMARY_DB)}/${encodeURIComponent(id)}`);
    if (get.status !== 200) return res.status(404).json({ ok: false });
    const doc = get.data;
    if (req.body.name !== undefined) doc.name = String(req.body.name || code);
    if (req.body.active !== undefined) doc.active = !!req.body.active;
    doc.updatedAt = new Date().toISOString();
    const put = await httpU.put(`/${encodeURIComponent(PRIMARY_DB)}/${encodeURIComponent(id)}`, doc);
    if (put.status === 201 || put.status === 202) return res.json({ ok: true });
    res.status(502).json({ ok: false, message: 'update_failed' });
  } catch { res.status(502).json({ ok: false }); }
});
app.delete('/api/admin/event-types/:code', requireAuth, requireRole('app:admin'), async (req, res) => {
  try {
    const code = String(req.params.code || '').trim();
    const id = `eventtype:${code}`;
    const httpU = httpAsUser(req);
    const get = await httpU.get(`/${encodeURIComponent(PRIMARY_DB)}/${encodeURIComponent(id)}`);
    if (get.status !== 200) return res.status(404).json({ ok: false });
    const del = await httpU.delete(`/${encodeURIComponent(PRIMARY_DB)}/${encodeURIComponent(id)}`, { params: { rev: get.data._rev } });
    if (del.status === 200) return res.json({ ok: true });
    res.status(502).json({ ok: false, message: 'delete_failed' });
  } catch { res.status(502).json({ ok: false }); }
});

// ── API: events (list)
app.get('/api/events', requireAuth, async (req, res) => {
  try {
    const { limit, bookmark, type, createdBy } = req.query || {};
    const lim = Math.max(1, Math.min(100, parseInt(limit, 10) || 25));
    const selector = { kind: 'event' };
    if (type) selector.type = String(type);
    if (createdBy) selector.createdBy = String(createdBy);

    const httpU = httpAsUser(req);
    let body = { selector, limit: lim, sort: [{ ts: 'desc' }] };
    if (bookmark) body.bookmark = String(bookmark);

    let r = await httpU.post(`/${encodeURIComponent(PRIMARY_DB)}/_find`, body);
    if (r.status !== 200) {
      const fb = { selector, limit: lim };
      if (bookmark) fb.bookmark = String(bookmark);
      r = await httpU.post(`/${encodeURIComponent(PRIMARY_DB)}/_find`, fb);
      if (r.status !== 200) return res.status(502).json({ ok: false, message: 'find_failed', status: r.status });
      if (Array.isArray(r.data?.docs)) r.data.docs.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
    }
    const docs = Array.isArray(r.data?.docs) ? r.data.docs : [];
    const rows = docs.map(d => ({ _id: d._id, ts: d.ts, type: d.type, qrData: d.qrData, createdBy: d.createdBy }));
    res.json({ ok: true, rows, bookmark: r.data?.bookmark || null });
  } catch {
    res.status(502).json({ ok: false, message: 'events_failed' });
  }
});

// ── API: events (create) — used by event-new.html
app.post('/api/events', requireAuth, async (req, res) => {
  try {
    const { type, qrData } = req.body || {};
    if (!type || !qrData) return res.status(400).json({ ok: false, message: 'type and qrData required' });
    const doc = {
      _id: `event:${uuid()}`,
      kind: 'event',
      ts: new Date().toISOString(),
      type: String(type),
      qrData: String(qrData),
      createdBy: req.session.user?.name || 'unknown',
    };
    const httpU = httpAsUser(req);
    const put = await httpU.put(`/${encodeURIComponent(PRIMARY_DB)}/${encodeURIComponent(doc._id)}`, doc);
    if (put.status === 201 || put.status === 202) return res.json({ ok: true, id: doc._id });
    res.status(502).json({ ok: false, message: 'create_event_failed' });
  } catch { res.status(502).json({ ok: false }); }
});

// ── API: admin QR generator
app.post('/api/admin/qr', requireAuth, requireRole('app:admin'), async (req, res) => {
  try {
    const { username = '', fullName = '', employeeId = '', department = '', phone = '' } = req.body || {};
    if (!username || !employeeId) return res.status(400).json({ ok: false, message: 'username and employeeId are required' });
    const payload = {
      v: 1,
      uid: String(username).trim(),
      eid: String(employeeId).trim(),
      n: String(fullName || '').trim(),
      d: String(department || '').trim(),
      p: String(phone || '').trim(),
      iat: new Date().toISOString(),
    };
    const text = JSON.stringify(payload);
    const dataUrl = await QRCode.toDataURL(text, { errorCorrectionLevel: 'M', margin: 2, width: 520, scale: 8 });
    const filename = `qr_${payload.uid}_${payload.eid}.png`.replace(/[^\w.-]+/g, '_');
    res.json({ ok: true, filename, mime: 'image/png', sizeHint: dataUrl.length, payload, dataUrl });
  } catch { res.status(500).json({ ok: false, message: 'qr_failed' }); }
});

// ── tiny routes inspector (optional; dev)
app.get('/__routes', (req, res) => {
  const routes = [];
  app._router.stack.forEach(mw => {
    if (mw.route) routes.push({ method: Object.keys(mw.route.methods)[0]?.toUpperCase(), path: mw.route.path });
    else if (mw.name === 'router' && mw.handle.stack) {
      mw.handle.stack.forEach(h => h.route && routes.push({ method: Object.keys(h.route.methods)[0]?.toUpperCase(), path: h.route.path }));
    }
  });
  res.json(routes);
});

// ── start servers
const httpServer = http.createServer(app);
httpServer.listen(PORT, HOST, () => {
  console.log(`HTTP listening at http://${HOST}:${PORT}`);
});

if (HTTPS_ENABLED) {
  try {
    let creds = null;
    if (TLS_PFX && fs.existsSync(TLS_PFX)) {
      creds = { pfx: fs.readFileSync(TLS_PFX), passphrase: TLS_PFX_PASSPHRASE || undefined };
      https.createServer(creds, app).listen(HTTPS_PORT, HOST, () => {
        console.log(`HTTPS listening at https://${HOST}:${HTTPS_PORT}  (PFX: ${path.basename(TLS_PFX)})`);
      });
    } else if (TLS_KEY && TLS_CERT && fs.existsSync(TLS_KEY) && fs.existsSync(TLS_CERT)) {
      creds = { key: fs.readFileSync(TLS_KEY), cert: fs.readFileSync(TLS_CERT) };
      https.createServer(creds, app).listen(HTTPS_PORT, HOST, () => {
        console.log(`HTTPS listening at https://${HOST}:${HTTPS_PORT}  (certs: ${path.basename(TLS_CERT)})`);
      });
    } else {
      console.log('HTTPS enabled but no TLS_PFX or key/cert present — serving HTTP only.');
    }
  } catch (e) {
    console.log('HTTPS failed to start — serving HTTP only.');
  }
}
