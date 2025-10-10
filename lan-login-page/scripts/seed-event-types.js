/**
 * Seed event types into PRIMARY_DB.
 * Usage:
 *   node scripts/seed-event-types.js
 *   TYPES="late:Late Arrival,early:Early Leave" node scripts/seed-event-types.js
 * Env: COUCH_URL, COUCH_ADMIN_USER, COUCH_ADMIN_PASS, PRIMARY_DB
 * Why: centralized, repeatable creation/upsert of event types.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const axios = require('axios');
require('dotenv').config();

const COUCH_URL = (process.env.COUCH_URL || 'http://127.0.0.1:5984').replace(/\/+$/, '');
const DB = process.env.PRIMARY_DB || 'attendance';
const ADMIN = process.env.COUCH_ADMIN_USER;
const ADMIN_PASS = process.env.COUCH_ADMIN_PASS;

if (!ADMIN || !ADMIN_PASS) {
  console.error('Missing COUCH_ADMIN_USER/COUCH_ADMIN_PASS in .env');
  process.exit(2);
}

function loadTypes() {
  // Allows quick override via env TYPES="code:Name,code2:Name2"
  if (process.env.TYPES) {
    return String(process.env.TYPES)
      .split(',')
      .map(x => x.trim())
      .filter(Boolean)
      .map(pair => {
        const [code, ...rest] = pair.split(':');
        return { code: code.trim(), name: rest.join(':').trim() || code.trim(), active: true };
      });
  }
  const fp = path.join(process.cwd(), 'data', 'event-types.json');
  if (fs.existsSync(fp)) {
    const arr = JSON.parse(fs.readFileSync(fp, 'utf8'));
    return arr.map(x => ({ code: String(x.code).trim(), name: String(x.name||x.code).trim(), active: x.active !== false }));
  }
  // Fallback minimal set
  return [
    { code: 'checkin',  name: 'Check-in',  active: true },
    { code: 'checkout', name: 'Check-out', active: true }
  ];
}

function http() {
  return axios.create({
    baseURL: COUCH_URL,
    auth: { username: ADMIN, password: ADMIN_PASS },
    headers: { 'Content-Type': 'application/json' },
    validateStatus: () => true,
    timeout: 8000
  });
}

async function ensureDb(h) {
  const r = await h.put(`/${encodeURIComponent(DB)}`);
  if (r.status === 201) console.log(`Created DB "${DB}"`);
  else if (r.status === 412) console.log(`DB "${DB}" exists`);
  else if (r.status !== 200) console.log(`DB ensure: HTTP ${r.status}`);
}

async function upsertType(h, t) {
  const id = `eventtype:${t.code}`;
  const now = new Date().toISOString();
  // Try create
  const create = await h.put(`/${encodeURIComponent(DB)}/${encodeURIComponent(id)}`, {
    _id: id,
    kind: 'event_type',
    code: t.code,
    name: t.name,
    active: !!t.active,
    updatedAt: now
  });
  if (create.status === 201 || create.status === 202) return { id, created: true };
  if (create.status !== 409) return { id, error: `HTTP ${create.status}` };

  // Exists → fetch + update
  const get = await h.get(`/${encodeURIComponent(DB)}/${encodeURIComponent(id)}`);
  if (get.status !== 200) return { id, error: `GET ${get.status}` };
  const doc = get.data;
  doc.kind = 'event_type';
  doc.code = t.code;
  doc.name = t.name;
  doc.active = !!t.active;
  doc.updatedAt = now;
  const put = await h.put(`/${encodeURIComponent(DB)}/${encodeURIComponent(id)}`, doc);
  if (put.status === 201 || put.status === 202) return { id, updated: true };
  return { id, error: `PUT ${put.status}` };
}

(async () => {
  const types = loadTypes().filter(t => t.code && /^[a-z0-9._-]+$/i.test(t.code));
  if (!types.length) { console.error('No valid types to seed.'); process.exit(1); }

  const h = http();
  await ensureDb(h);

  const results = [];
  for (const t of types) {
    // Deduplicate on code in case of duplicates in file/env
    if (results.find(r => r.id === `eventtype:${t.code}`)) continue;
    try {
      const r = await upsertType(h, t);
      results.push(r);
      if (r.created)  console.log(`+ created ${r.id}`);
      else if (r.updated) console.log(`~ updated ${r.id}`);
      else if (r.error) console.log(`! ${r.id} -> ${r.error}`);
    } catch (e) {
      console.log(`! ${t.code} -> ${e.message}`);
    }
  }

  const stats = results.reduce((a, r) => {
    if (r.created) a.created++;
    else if (r.updated) a.updated++;
    else a.failed++;
    return a;
  }, { created:0, updated:0, failed:0 });
  console.log(`Done. created=${stats.created} updated=${stats.updated} failed=${stats.failed}`);
  process.exit(0);
})();
