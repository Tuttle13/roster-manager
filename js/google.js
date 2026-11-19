// Google sign-in (browser OAuth, redirect flow) and API helpers for Calendar and Drive.
//
// Redirect flow is used rather than a popup because popups are unreliable in iPad home-screen apps.
// Access tokens last about an hour and there is no refresh token (browser-only apps don't get one),
// so after an hour Sync/Backup sends you through Google sign-in again. Usually it's one tap.

import { addDays } from './dates.js';
import { APP_TAG } from './events.js';

export const SCOPES = [
  'https://www.googleapis.com/auth/calendar.app.created', // only calendars this app creates
  'https://www.googleapis.com/auth/drive.file',           // only files/folders this app creates
];

const TOKEN_KEY = 'prm_gtoken';
const STATE_KEY = 'prm_oauth_state';
const RETURN_KEY = 'prm_oauth_return';

export class AuthError extends Error {}

export function redirectUri() {
  return location.origin + location.pathname.replace(/index\.html$/, '');
}

export function getToken() {
  try {
    const t = JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null');
    if (t && t.exp > Date.now() + 60000) return t;
  } catch { /* ignore */ }
  localStorage.removeItem(TOKEN_KEY);
  return null;
}

export function signIn(clientId, returnRoute) {
  if (!clientId) throw new Error('Add your Google OAuth Client ID in Settings first.');
  const state = crypto.randomUUID();
  localStorage.setItem(STATE_KEY, state);
  localStorage.setItem(RETURN_KEY, returnRoute || location.hash || '#/');
  const p = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri(), response_type: 'token',
    scope: SCOPES.join(' '), include_granted_scopes: 'true', state,
  });
  location.assign(`https://accounts.google.com/o/oauth2/v2/auth?${p}`);
}

// Call on startup. Returns { handled, error, returnRoute }.
export function handleRedirect() {
  const h = location.hash;
  if (!/(access_token|error)=/.test(h)) return { handled: false };
  const p = new URLSearchParams(h.slice(1));
  const expected = localStorage.getItem(STATE_KEY);
  const returnRoute = localStorage.getItem(RETURN_KEY) || '#/';
  localStorage.removeItem(STATE_KEY);
  localStorage.removeItem(RETURN_KEY);
  history.replaceState(null, '', location.pathname + returnRoute);
  if (p.get('error')) return { handled: true, error: `Google sign-in failed: ${p.get('error')}`, returnRoute };
  if (!expected || p.get('state') !== expected) return { handled: true, error: 'Google sign-in response did not match the request. Try again.', returnRoute };
  const granted = (p.get('scope') || '').split(' ');
  const missing = SCOPES.filter(s => !granted.includes(s));
  localStorage.setItem(TOKEN_KEY, JSON.stringify({
    token: p.get('access_token'), exp: Date.now() + (+p.get('expires_in') || 3600) * 1000, scope: p.get('scope'),
  }));
  const error = missing.length ? `Some permissions were not granted: ${missing.map(s => s.split('/').pop()).join(', ')}. Sign in again and tick every box.` : null;
  return { handled: true, error, returnRoute };
}

export async function signOut() {
  const t = getToken();
  localStorage.removeItem(TOKEN_KEY);
  if (t) { try { await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(t.token)}`, { method: 'POST' }); } catch { /* offline is fine */ } }
}

// fetch with auth, timeout, readable errors, and a single retry for rate limits / Google-side errors.
export async function gfetch(url, { method = 'GET', body, headers = {}, raw = false, timeout = 30000 } = {}) {
  const t = getToken();
  if (!t) throw new AuthError('Not signed in to Google (or the session expired).');
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    let res;
    try {
      res = await fetch(url, {
        method, body, signal: ctl.signal,
        headers: { Authorization: `Bearer ${t.token}`, ...(body && typeof body === 'string' && !headers['Content-Type'] ? { 'Content-Type': 'application/json' } : {}), ...headers },
      });
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') throw new Error('Google did not respond in time. Check your connection.');
      throw new Error(`Network error talking to Google: ${e.message}`);
    }
    clearTimeout(timer);
    if (res.status === 401) { localStorage.removeItem(TOKEN_KEY); throw new AuthError('Google session expired. Sign in again.'); }
    if ((res.status === 429 || res.status >= 500) && attempt === 0) { await new Promise(r => setTimeout(r, 2000)); continue; }
    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`;
      try { const j = await res.json(); msg = j.error?.message || msg; } catch { /* ignore */ }
      const err = new Error(`Google API error: ${msg}`); err.status = res.status; throw err;
    }
    if (raw) return res;
    if (res.status === 204) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }
  throw new Error('Google API kept failing. Try again later.');
}

// ---------------- Calendar ----------------
const CAL = 'https://www.googleapis.com/calendar/v3';

export async function ensureCalendar(calendarId, name, timeZone) {
  if (calendarId) {
    try { return await gfetch(`${CAL}/calendars/${encodeURIComponent(calendarId)}`); } catch (e) {
      if (e instanceof AuthError) throw e;
      if (e.status !== 404 && e.status !== 403) throw e;
    }
  }
  return gfetch(`${CAL}/calendars`, { method: 'POST', body: JSON.stringify({ summary: name || 'VA Roster', timeZone, description: 'Created and managed by Roster Manager.' }) });
}

export async function listAppEvents(calendarId, period) {
  const out = [];
  let pageToken = '';
  do {
    const p = new URLSearchParams({
      privateExtendedProperty: `prmApp=${APP_TAG}`, singleEvents: 'true', showDeleted: 'false', maxResults: '2500',
      timeMin: `${addDays(period.start, -2)}T00:00:00Z`, timeMax: `${addDays(period.end, 3)}T00:00:00Z`,
    });
    if (pageToken) p.set('pageToken', pageToken);
    const r = await gfetch(`${CAL}/calendars/${encodeURIComponent(calendarId)}/events?${p}`);
    out.push(...(r.items || []));
    pageToken = r.nextPageToken || '';
  } while (pageToken);
  return out;
}

// Runs an approved plan one change at a time. Failures are recorded and the rest continue; because
// every event carries its key, re-running sync afterwards picks up exactly what didn't happen.
export async function executePlan(calendarId, plan, approvedRemovalIds, onProgress = () => {}) {
  const base = `${CAL}/calendars/${encodeURIComponent(calendarId)}/events`;
  const ops = [
    ...plan.create.map(x => ({ kind: 'create', label: x.body.summary, date: x.duty.date, run: () => gfetch(base, { method: 'POST', body: JSON.stringify(x.body) }) })),
    ...plan.update.map(x => ({ kind: 'update', label: x.body.summary, date: x.duty.date, run: () => gfetch(`${base}/${encodeURIComponent(x.event.id)}`, { method: 'PUT', body: JSON.stringify(x.body) }) })),
    ...plan.remove.filter(x => approvedRemovalIds.has(x.event.id)).map(x => ({
      kind: 'remove', label: x.event.summary, date: x.event.extendedProperties?.private?.prmDate,
      run: () => gfetch(`${base}/${encodeURIComponent(x.event.id)}`, { method: 'DELETE' }).catch(e => { if (e.status === 410 || e.status === 404) return null; throw e; }),
    })),
  ];
  const results = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    onProgress(i, ops.length, op);
    try { await op.run(); results.push({ kind: op.kind, label: op.label, date: op.date, ok: true }); } catch (e) {
      results.push({ kind: op.kind, label: op.label, date: op.date, ok: false, error: e.message });
      if (e instanceof AuthError) { // no point continuing without a session
        for (const rest of ops.slice(i + 1)) results.push({ kind: rest.kind, label: rest.label, date: rest.date, ok: false, error: 'Skipped: Google session expired.' });
        break;
      }
    }
  }
  onProgress(ops.length, ops.length, null);
  return results;
}

// ---------------- Drive ----------------
const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
export const FOLDERS = ['Original Rosters', 'Processed Rosters', 'Capture History', 'Backups'];
const FOLDER_MIME = 'application/vnd.google-apps.folder';

async function findFolder(name, parentId) {
  const q = [`name = '${name.replace(/'/g, "\\'")}'`, `mimeType = '${FOLDER_MIME}'`, 'trashed = false', parentId ? `'${parentId}' in parents` : `'root' in parents`].join(' and ');
  const r = await gfetch(`${DRIVE}/files?${new URLSearchParams({ q, fields: 'files(id,name)', spaces: 'drive' })}`);
  return r.files?.[0] || null;
}

async function createFolder(name, parentId) {
  return gfetch(`${DRIVE}/files?fields=id,name`, { method: 'POST', body: JSON.stringify({ name, mimeType: FOLDER_MIME, ...(parentId ? { parents: [parentId] } : {}) }) });
}

// Returns { rootId, ids: { 'Original Rosters': id, ... } }. Reuses saved ids when they still exist.
export async function ensureFolders(saved, rootName = 'My Roster') {
  const valid = async id => { if (!id) return false; try { const f = await gfetch(`${DRIVE}/files/${id}?fields=id,trashed`); return f && !f.trashed; } catch (e) { if (e instanceof AuthError) throw e; return false; } };
  let rootId = saved?.rootId;
  if (!(await valid(rootId))) rootId = (await findFolder(rootName, null))?.id || (await createFolder(rootName, null)).id;
  const ids = {};
  for (const name of FOLDERS) {
    let id = saved?.rootId === rootId ? saved?.ids?.[name] : null;
    if (!(await valid(id))) id = (await findFolder(name, rootId))?.id || (await createFolder(name, rootId)).id;
    ids[name] = id;
  }
  return { rootId, rootName, ids };
}

// Always creates a new file. Never overwrites, so history is kept.
export async function uploadJson(folderId, name, data) {
  const boundary = `prm${crypto.randomUUID().replace(/-/g, '')}`;
  const meta = { name, parents: [folderId], mimeType: 'application/json' };
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(data, null, 1)}\r\n--${boundary}--`;
  return gfetch(`${UPLOAD}/files?uploadType=multipart&fields=id,name,createdTime`, { method: 'POST', body, headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, timeout: 60000 });
}

export async function listFiles(folderId) {
  const q = `'${folderId}' in parents and trashed = false`;
  const r = await gfetch(`${DRIVE}/files?${new URLSearchParams({ q, fields: 'files(id,name,createdTime,size)', orderBy: 'createdTime desc', pageSize: '100' })}`);
  return r.files || [];
}

export async function downloadJson(fileId) {
  return gfetch(`${DRIVE}/files/${fileId}?alt=media`, { timeout: 60000 });
}
