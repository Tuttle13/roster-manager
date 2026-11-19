import { kv, captures, log, exportAll, importAll, wipeAll, requestPersistence } from './db.js';
import { defaultPeriod, validatePeriod, periodEnd, prettyDate, prettyRange, addDays } from './dates.js';
import { setOverrides, isValidTz, tzFor, stampToUtc, utcToZoned } from './tz.js';
import { DUTY_TYPES, newDuty, validateRoster, validateDuty, sortDuties, assignKeys, isAllDay } from './model.js';
import { readClipboardPayload, parseCapture, captureText } from './parser.js';
import { planSync, eventTitle } from './events.js';
import * as G from './google.js';

export const APP_VERSION = '0.1.0';

const DEFAULT_SETTINGS = {
  sabreUrl: 'https://cia.virginaustralia.com/cia/index.page',
  msEmail: 'piran.gartner@virginaustralia.com',
  sabreUserId: '21032',
  googleClientId: '',
  calendarName: 'VA Roster',
  calendarId: '',
  drive: null,
  driveRootName: 'My Roster',
  includeDaysOff: true,
  daysOffBusy: false,
  tzOverrides: {},
};

let settings = { ...DEFAULT_SETTINGS };
const main = document.getElementById('main');

// ---------------- helpers ----------------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const fmtWhen = iso => (iso ? new Date(iso).toLocaleString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
const fileStamp = () => new Date().toISOString().replace(/[:]/g, '').replace(/\..+/, '');

async function saveSettings(patch) {
  settings = { ...settings, ...patch };
  await kv.set('settings', settings);
  setOverrides(settings.tzOverrides);
}

export function toast(msg, kind = 'info', ms = 4500) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function modal(html, { onMount } = {}) {
  const dlg = document.createElement('dialog');
  dlg.className = 'modal';
  dlg.innerHTML = html;
  document.body.appendChild(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  $$('[data-close]', dlg).forEach(b => b.addEventListener('click', () => dlg.close()));
  dlg.showModal();
  if (onMount) onMount(dlg);
  return dlg;
}

function confirmBox(message, okLabel = 'OK', danger = false) {
  return new Promise(resolve => {
    const dlg = modal(`<div class="modal-body"><p>${esc(message)}</p></div>
      <div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${esc(okLabel)}</button></div>`);
    let ok = false;
    $('[data-ok]', dlg).addEventListener('click', () => { ok = true; dlg.close(); });
    dlg.addEventListener('close', () => resolve(ok));
  });
}

function setBusy(btn, busy, label) {
  if (!btn) return;
  if (busy) { btn.dataset.label = btn.textContent; btn.textContent = label || 'Working…'; btn.disabled = true; } else { btn.textContent = btn.dataset.label || btn.textContent; btn.disabled = false; }
}

function bookmarkletLink() {
  return `bookmarklet.html#${new URLSearchParams({ email: settings.msEmail || '', id: settings.sabreUserId || '' })}`;
}

function nav(hash) { if (location.hash === hash) route(); else location.hash = hash; }

function setActiveTab(name) {
  $$('.tabbar a').forEach(a => a.classList.toggle('active', a.dataset.tab === name));
}

function stampTime(stamp) {
  if (!stamp?.dt) return '';
  if (stamp.basis === 'utc') {
    const tz = tzFor(stamp.port);
    const ms = stampToUtc(stamp);
    return tz && ms != null ? utcToZoned(ms, tz).slice(11, 16) : `${stamp.dt.slice(11, 16)}Z`;
  }
  return stamp.dt.slice(11, 16);
}

function dutyLine(d) {
  if (isAllDay(d)) return 'All day';
  const s = stampTime(d.start); const e = stampTime(d.end);
  const rep = d.report?.dt ? `Rpt ${stampTime(d.report)} · ` : '';
  const fin = d.release?.dt ? ` · Fin ${stampTime(d.release)}` : '';
  return `${rep}${s}–${e} local${fin}`;
}

// ---------------- Google helpers used by several views ----------------
function googleReady() {
  if (!settings.googleClientId) return { ok: false, reason: 'Add your Google OAuth Client ID in Settings.' };
  if (!G.getToken()) return { ok: false, reason: 'signin' };
  return { ok: true };
}

function googleSignInBlock(returnRoute, purpose) {
  const r = googleReady();
  if (r.ok) return '';
  if (r.reason !== 'signin') return `<div class="notice warn">${esc(r.reason)} <a href="#/settings">Open Settings</a></div>`;
  return `<div class="notice">Sign in to Google to ${esc(purpose)}. <button class="btn primary sm" data-signin="${esc(returnRoute)}">Sign in to Google</button></div>`;
}

function bindSignIn(root) {
  $$('[data-signin]', root).forEach(b => b.addEventListener('click', () => {
    try { G.signIn(settings.googleClientId, b.dataset.signin); } catch (e) { toast(e.message, 'error'); }
  }));
}

async function ensureDrive() {
  const d = await G.ensureFolders(settings.drive, settings.driveRootName || 'My Roster');
  await saveSettings({ drive: d });
  return d;
}

// Saves capture files + capture history + a full app backup. Never includes credentials (none are stored).
async function backupToDrive(capture, onStep = () => {}) {
  const result = { at: new Date().toISOString(), ok: false, files: [] };
  try {
    onStep('Checking Drive folders…');
    const d = await ensureDrive();
    const stamp = fileStamp();
    if (capture) {
      const base = `${capture.period.start}_to_${capture.period.end}__${stamp}`;
      if (capture.raw && !capture.drive?.raw) {
        onStep('Saving original roster…');
        await G.uploadJson(d.ids['Original Rosters'], `original_${base}.json`, capture.raw);
        result.files.push('Original roster');
      }
      onStep('Saving processed roster…');
      await G.uploadJson(d.ids['Processed Rosters'], `processed_${base}.json`, {
        format: 'prm-processed', version: 1, captureId: capture.id, period: capture.period, capturedAt: capture.createdAt,
        confirmedAt: capture.confirmedAt, parserId: capture.parserId, duties: capture.duties, syncResults: capture.syncResults || null,
      });
      result.files.push('Processed roster');
      capture.drive = { ...(capture.drive || {}), raw: true, processedAt: result.at };
      await captures.put(capture);
    }
    onStep('Saving capture history…');
    const caps = await captures.list();
    await G.uploadJson(d.ids['Capture History'], `history_${stamp}.json`, {
      format: 'prm-history', version: 1, at: result.at,
      captures: caps.map(c => ({ id: c.id, createdAt: c.createdAt, period: c.period, status: c.status, duties: c.duties?.length || 0, syncedAt: c.syncedAt || null })),
      log: await log.list(),
    });
    result.files.push('Capture history');
    onStep('Saving full backup…');
    await G.uploadJson(d.ids.Backups, `backup_${stamp}.json`, await exportAll());
    result.files.push('Full backup');
    result.ok = true;
  } catch (e) {
    result.error = e.message;
    result.auth = e instanceof G.AuthError;
  }
  await kv.set('lastBackup', result);
  await log.add({ kind: 'backup', ok: result.ok, message: result.ok ? `Drive backup saved (${result.files.join(', ')})` : `Drive backup failed: ${result.error}` });
  return result;
}

// ---------------- views ----------------
async function viewHome() {
  setActiveTab('home');
  const [lastCapture, lastSync, lastBackup, caps] = await Promise.all([kv.get('lastCapture'), kv.get('lastSync'), kv.get('lastBackup'), captures.list()]);
  const pending = caps.find(c => c.status === 'imported' || c.status === 'confirmed' || c.status === 'sync-partial');
  const syncState = !lastSync ? ['none', 'Not synced yet'] : lastSync.ok ? ['ok', `Synced ${fmtWhen(lastSync.at)}`] : ['bad', `Last sync had problems (${fmtWhen(lastSync.at)})`];
  const backupState = !lastBackup ? ['none', 'No backup yet'] : lastBackup.ok ? ['ok', `Backed up ${fmtWhen(lastBackup.at)}`] : ['bad', `Backup failed ${fmtWhen(lastBackup.at)}`];
  main.innerHTML = `
    <section class="hero">
      <a class="capture-btn" href="#/capture">Capture Roster</a>
      ${pending ? `<a class="btn wide" href="#/${pending.status === 'imported' ? 'review' : 'sync'}/${pending.id}">Continue: ${esc(prettyRange(pending.period.start, pending.period.end))} (${pending.status === 'imported' ? 'needs review' : 'needs sync'})</a>` : ''}
    </section>
    <section class="cards">
      <div class="card"><h3>Last capture</h3>
        <p class="big">${lastCapture ? esc(prettyRange(lastCapture.start, lastCapture.end)) : '—'}</p>
        <p class="muted">${lastCapture ? `Captured ${esc(fmtWhen(lastCapture.at))}` : 'No roster captured yet'}</p></div>
      <div class="card"><h3>Google Calendar</h3>
        <p class="status ${syncState[0]}">${esc(syncState[1])}</p>
        ${lastSync ? `<p class="muted">${lastSync.created || 0} added · ${lastSync.updated || 0} updated · ${lastSync.removed || 0} removed${lastSync.failed ? ` · ${lastSync.failed} failed` : ''}</p>` : ''}</div>
      <div class="card"><h3>Google Drive backup</h3>
        <p class="status ${backupState[0]}">${esc(backupState[1])}</p>
        ${lastBackup && !lastBackup.ok ? `<p class="muted">${esc(lastBackup.error || '')}</p>` : ''}</div>
    </section>
    ${!settings.googleClientId ? '<div class="notice warn">Google isn\'t set up yet. Add your OAuth Client ID in <a href="#/settings">Settings</a> before syncing.</div>' : ''}`;
}

async function viewCapture() {
  setActiveTab('capture');
  const lastCapture = await kv.get('lastCapture');
  const def = defaultPeriod(lastCapture);
  main.innerHTML = `
    <h2>Capture roster</h2>
    <section class="panel">
      <h3>1. Roster period</h3>
      <div class="row">
        <label>Start<input type="date" id="pStart" value="${def.start}"></label>
        <label>End<input type="date" id="pEnd" value="${def.end}"></label>
      </div>
      <label class="check"><input type="checkbox" id="pAuto" checked> Keep a 28-day period (end follows start)</label>
      <p class="muted">${lastCapture ? `Last capture: ${esc(prettyRange(lastCapture.start, lastCapture.end))}` : 'No previous capture. Defaulting to today.'}</p>
      <div id="pMsgs"></div>
    </section>
    <section class="panel">
      <h3>2. Open the roster in Sabre</h3>
      <p>Opens in Safari. Log in (Safari's Passwords fills both logins), then open this period's roster.</p>
      <a class="btn primary" id="openSabre" href="${esc(settings.sabreUrl)}" target="_blank" rel="noopener">Open Sabre</a>
      <p class="muted">The app only contacts Sabre when you tap this. Nothing runs in the background.</p>
    </section>
    <section class="panel">
      <h3>3. Capture and import</h3>
      <ol class="steps"><li>On the roster page, tap the <b>Capture Roster</b> bookmark, then <b>Copy</b>.</li><li>Come back here and tap <b>Import from clipboard</b>.</li></ol>
      <button class="btn primary" id="importClip">Import from clipboard</button>
      <details><summary>Paste manually instead</summary>
        <textarea id="pasteBox" rows="5" placeholder="Paste the copied capture here"></textarea>
        <button class="btn" id="importPaste">Import pasted text</button></details>
      <details><summary>No capture: enter duties by hand</summary>
        <p class="muted">Creates an empty roster for this period that you fill in on the Review screen.</p>
        <button class="btn" id="manualStart">Start empty roster</button></details>
      <p class="muted"><a href="${bookmarkletLink()}" target="_blank" rel="noopener">Install or reinstall the Capture Roster bookmark</a></p>
    </section>`;

  const s = $('#pStart'); const e = $('#pEnd'); const auto = $('#pAuto');
  let lastMsgKey = '';
  const check = () => {
    const v = validatePeriod(s.value, e.value, { lastCapture });
    const key = JSON.stringify(v);
    if (key === lastMsgKey) return v; // unchanged: keep the user's acknowledgement tick
    lastMsgKey = key;
    $('#pMsgs').innerHTML = [
      ...v.errors.map(m => `<div class="notice error">${esc(m)}</div>`),
      ...v.warnings.map(m => `<div class="notice warn">${esc(m)}</div>`),
      v.warnings.length && !v.errors.length ? '<label class="check"><input type="checkbox" id="pAck"> I\'ve checked these dates</label>' : '',
    ].join('');
    return v;
  };
  s.addEventListener('change', () => { if (auto.checked && s.value) e.value = periodEnd(s.value); check(); });
  e.addEventListener('change', () => { if (auto.checked && s.value && e.value !== periodEnd(s.value)) auto.checked = false; check(); });
  auto.addEventListener('change', () => { if (auto.checked && s.value) e.value = periodEnd(s.value); check(); });
  check();

  const periodOk = () => {
    const v = check();
    if (v.errors.length) { toast('Fix the period dates first.', 'error'); return null; }
    if (v.warnings.length && !$('#pAck')?.checked) { toast('Tick "I\'ve checked these dates" to continue.', 'error'); return null; }
    return { start: s.value, end: e.value };
  };

  const doImport = async (text, btn) => {
    const period = periodOk(); if (!period) return;
    let raw;
    try { raw = readClipboardPayload(text); } catch (err) { toast(err.message, 'error', 7000); return; }
    setBusy(btn, true, 'Importing…');
    try {
      const parsed = parseCapture(raw, period);
      const c = {
        id: crypto.randomUUID(), createdAt: new Date().toISOString(), period, status: 'imported',
        raw, parserId: parsed.parserId, parseWarnings: parsed.warnings, duties: parsed.duties,
      };
      await captures.put(c);
      await log.add({ kind: 'capture', ok: true, captureId: c.id, message: `Imported capture for ${period.start} to ${period.end} (${c.duties.length} duties, parser: ${c.parserId})` });
      nav(`#/review/${c.id}`);
    } catch (err) {
      toast(`Import failed: ${err.message}`, 'error', 7000);
      await log.add({ kind: 'capture', ok: false, message: `Import failed: ${err.message}` });
    } finally { setBusy(btn, false); }
  };

  $('#importClip').addEventListener('click', async ev => {
    let text = '';
    try { text = await navigator.clipboard.readText(); } catch {
      toast('Clipboard access was blocked. Use "Paste manually instead".', 'error', 7000);
      $('details').open = true; return;
    }
    doImport(text, ev.currentTarget);
  });
  $('#importPaste').addEventListener('click', ev => doImport($('#pasteBox').value, ev.currentTarget));
  $('#manualStart').addEventListener('click', async () => {
    const period = periodOk(); if (!period) return;
    const c = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), period, status: 'imported', raw: null, parserId: 'manual', parseWarnings: [], duties: [] };
    await captures.put(c);
    await log.add({ kind: 'capture', ok: true, captureId: c.id, message: `Started manual roster for ${period.start} to ${period.end}` });
    nav(`#/review/${c.id}`);
  });
}

async function viewReview(id) {
  setActiveTab('capture');
  const c = await captures.get(id);
  if (!c) { main.innerHTML = '<div class="notice error">Capture not found.</div>'; return; }
  const duties = sortDuties(c.duties || []);
  const v = validateRoster(duties, c.period);
  const byDate = new Map();
  for (const d of duties) { if (!byDate.has(d.date)) byDate.set(d.date, []); byDate.get(d.date).push(d); }
  const days = [];
  for (let day = c.period.start; day <= c.period.end; day = addDays(day, 1)) days.push(day);
  const outside = [...byDate.keys()].filter(dd => dd < c.period.start || dd > c.period.end);
  const allDays = [...days, ...outside].sort();

  const row = d => {
    const r = v.results.get(d.id);
    const flag = r.errors.length ? '<span class="flag error">!</span>' : r.warnings.length ? '<span class="flag warn">?</span>' : '';
    return `<button class="duty ${esc(d.type.toLowerCase())}" data-edit="${esc(d.id)}">
      <span class="badge">${esc(DUTY_TYPES[d.type]?.label || d.type)}</span>
      <span class="title">${esc(eventTitle(d))}</span>
      <span class="times">${esc(dutyLine(d))}</span>${flag}
      ${r.errors.length || r.warnings.length ? `<span class="issues">${esc([...r.errors, ...r.warnings].join(' '))}</span>` : ''}
    </button>`;
  };

  main.innerHTML = `
    <h2>Review roster</h2>
    <p class="muted">${esc(prettyRange(c.period.start, c.period.end))} · captured ${esc(fmtWhen(c.createdAt))} · ${duties.length} duties · status: ${esc(c.status)}</p>
    ${(c.parseWarnings || []).map(w => `<div class="notice warn">${esc(w)}</div>`).join('')}
    ${v.errors ? `<div class="notice error">${v.errors} problem(s) must be fixed before confirming.</div>` : ''}
    <div class="toolbar">
      <button class="btn" id="addDuty">Add duty</button>
      ${c.raw ? '<button class="btn" id="viewRaw">View captured page</button>' : ''}
      <button class="btn danger" id="discard">Discard</button>
    </div>
    <div class="days">${allDays.map(day => `
      <div class="day ${day < c.period.start || day > c.period.end ? 'outside' : ''}">
        <div class="date">${esc(prettyDate(day))}</div>
        <div class="list">${(byDate.get(day) || []).map(row).join('') || '<span class="muted empty">No duty captured</span>'}</div>
      </div>`).join('')}</div>
    <div class="sticky-actions">
      <button class="btn primary wide" id="confirm" ${v.errors || !duties.length ? 'disabled' : ''}>Confirm roster (${duties.length} duties)</button>
    </div>`;

  $$('[data-edit]').forEach(b => b.addEventListener('click', () => editDuty(c, b.dataset.edit)));
  $('#addDuty').addEventListener('click', () => editDuty(c, null));
  $('#viewRaw')?.addEventListener('click', () => modal(`<div class="modal-body"><h3>Captured page</h3><p class="muted">${esc(c.raw.title || '')} · ${esc(c.raw.url || '')} · ${esc(fmtWhen(c.raw.capturedAt))}</p><pre class="raw">${esc(captureText(c.raw))}</pre></div><div class="modal-actions"><button class="btn" data-close>Close</button></div>`));
  $('#discard').addEventListener('click', async () => {
    if (!(await confirmBox('Discard this capture? It is removed from this iPad only. Your calendar and Drive are not touched.', 'Discard', true))) return;
    await captures.del(c.id);
    await log.add({ kind: 'capture', ok: true, message: `Discarded capture ${c.period.start} to ${c.period.end}` });
    nav('#/');
  });
  $('#confirm').addEventListener('click', async () => {
    c.status = 'confirmed';
    c.confirmedAt = new Date().toISOString();
    await captures.put(c);
    // The "last successful capture" reference only moves once a roster is retrieved, reviewed and saved.
    await kv.set('lastCapture', { start: c.period.start, end: c.period.end, at: c.createdAt, captureId: c.id });
    await log.add({ kind: 'confirm', ok: true, captureId: c.id, message: `Confirmed roster ${c.period.start} to ${c.period.end} (${duties.length} duties)` });
    nav(`#/sync/${c.id}`);
  });
}

function stampField(name, label, stamp) {
  const basis = stamp?.basis || 'local';
  return `<div class="stamp"><label>${esc(label)}<input type="datetime-local" name="${name}_dt" value="${esc(stamp?.dt || '')}"></label>
    <select name="${name}_basis"><option value="local" ${basis === 'local' ? 'selected' : ''}>Local</option><option value="utc" ${basis === 'utc' ? 'selected' : ''}>UTC</option></select></div>`;
}

function editDuty(c, dutyId) {
  const existing = dutyId ? c.duties.find(d => d.id === dutyId) : null;
  const d = existing ? { ...existing } : newDuty({ date: c.period.start });
  const dlg = modal(`
    <form class="modal-body edit" method="dialog">
      <h3>${existing ? 'Edit duty' : 'Add duty'}</h3>
      ${existing?.raw ? `<details><summary>Source text</summary><pre class="raw">${esc(existing.raw)}</pre></details>` : ''}
      <div class="row">
        <label>Type<select name="type">${Object.entries(DUTY_TYPES).map(([k, t]) => `<option value="${k}" ${d.type === k ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}</select></label>
        <label>Roster date<input type="date" name="date" value="${esc(d.date)}" required></label>
      </div>
      <div class="row">
        <label>Flight no.<input name="flightNumber" value="${esc(d.flightNumber)}" autocapitalize="characters" placeholder="VA123"></label>
        <label>Duty code<input name="code" value="${esc(d.code)}" autocapitalize="characters" placeholder="SBY, OFF…"></label>
      </div>
      <div class="row">
        <label>From (IATA)<input name="dep" value="${esc(d.dep)}" maxlength="3" autocapitalize="characters" placeholder="BNE"></label>
        <label>To (IATA)<input name="arr" value="${esc(d.arr)}" maxlength="3" autocapitalize="characters" placeholder="SYD"></label>
      </div>
      <p class="muted">Local times are at the departure airport (start/report/actual departure) or arrival airport (end/finish/actual arrival). For non-flying duties with one airport, use From.</p>
      ${stampField('report', 'Report', d.report)}
      ${stampField('start', 'Departs / starts', d.start)}
      ${stampField('end', 'Arrives / ends', d.end)}
      ${stampField('release', 'Duty finish', d.release)}
      <details ${d.actualStart || d.actualEnd ? 'open' : ''}><summary>Actual times</summary>
        ${stampField('actualStart', 'Actual departure', d.actualStart)}
        ${stampField('actualEnd', 'Actual arrival', d.actualEnd)}
      </details>
      <div class="row"><label>Aircraft<input name="aircraft" value="${esc(d.aircraft)}"></label></div>
      <label>Notes<textarea name="notes" rows="3">${esc(d.notes)}</textarea></label>
      <div id="editMsgs"></div>
    </form>
    <div class="modal-actions">
      ${existing ? '<button class="btn danger" data-del>Delete</button>' : ''}
      <span class="spacer"></span>
      <button class="btn" data-close>Cancel</button>
      <button class="btn primary" data-save>Save</button>
    </div>`);
  const form = $('form', dlg);
  const read = () => {
    const f = new FormData(form);
    const g = k => String(f.get(k) || '').trim();
    const dep = g('dep').toUpperCase(); const arr = g('arr').toUpperCase();
    const portFor = { report: dep, start: dep, actualStart: dep, end: arr || dep, release: arr || dep, actualEnd: arr || dep };
    const st = k => (g(`${k}_dt`) ? { dt: g(`${k}_dt`).slice(0, 16), basis: g(`${k}_basis`) || 'local', port: portFor[k] } : null);
    return {
      ...d, type: g('type'), date: g('date'), flightNumber: g('flightNumber').toUpperCase().replace(/\s+/g, ''), code: g('code').toUpperCase(),
      dep, arr, report: st('report'), start: st('start'), end: st('end'), release: st('release'), actualStart: st('actualStart'), actualEnd: st('actualEnd'),
      aircraft: g('aircraft'), notes: g('notes'), edited: true,
    };
  };
  const showMsgs = () => {
    const r = validateDuty(read(), c.period);
    $('#editMsgs', dlg).innerHTML = [...r.errors.map(m => `<div class="notice error">${esc(m)}</div>`), ...r.warnings.map(m => `<div class="notice warn">${esc(m)}</div>`)].join('');
  };
  form.addEventListener('change', showMsgs);
  showMsgs();
  $('[data-save]', dlg).addEventListener('click', async () => {
    const nd = read();
    if (!nd.date) { toast('Date is required.', 'error'); return; }
    c.duties = existing ? c.duties.map(x => (x.id === nd.id ? nd : x)) : [...c.duties, nd];
    if (c.status !== 'imported') c.status = 'imported'; // edited after confirming: needs re-confirming
    await captures.put(c);
    dlg.close();
    route();
  });
  $('[data-del]', dlg)?.addEventListener('click', async () => {
    c.duties = c.duties.filter(x => x.id !== d.id);
    c.status = 'imported';
    await captures.put(c);
    dlg.close();
    route();
  });
}

let currentPlan = null;

async function viewSync(id) {
  setActiveTab('capture');
  const c = await captures.get(id);
  if (!c) { main.innerHTML = '<div class="notice error">Capture not found.</div>'; return; }
  if (c.status === 'imported') { main.innerHTML = `<div class="notice warn">This roster hasn't been confirmed yet. <a href="#/review/${esc(c.id)}">Review it first</a>.</div>`; return; }
  const ret = `#/sync/${c.id}`;
  main.innerHTML = `
    <h2>Sync to Google Calendar</h2>
    <p class="muted">${esc(prettyRange(c.period.start, c.period.end))} · ${c.duties.length} duties · calendar “${esc(settings.calendarName)}”</p>
    ${googleSignInBlock(ret, 'compare with your calendar')}
    <div id="planArea">${googleReady().ok ? '<button class="btn primary" id="prepare">Compare with calendar</button>' : ''}</div>
    <div id="resultArea"></div>`;
  bindSignIn(main);
  $('#prepare')?.addEventListener('click', ev => preparePlan(c, ev.currentTarget));
  if (googleReady().ok && currentPlan?.captureId === c.id) renderPlan(c, currentPlan);
}

async function preparePlan(c, btn) {
  setBusy(btn, true, 'Comparing…');
  try {
    const tzName = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Australia/Sydney';
    const cal = await G.ensureCalendar(settings.calendarId, settings.calendarName, tzName);
    if (cal.id !== settings.calendarId) await saveSettings({ calendarId: cal.id });
    const existing = await G.listAppEvents(cal.id, c.period);
    let duties = c.duties.filter(d => validateDuty(d, c.period).errors.length === 0);
    if (!settings.includeDaysOff) duties = duties.filter(d => d.type !== 'DAY_OFF');
    const keyed = assignKeys(duties);
    const plan = planSync(keyed, existing, c.period, { allDayBusy: settings.daysOffBusy });
    currentPlan = { captureId: c.id, calendarId: cal.id, plan, keyed };
    renderPlan(c, currentPlan);
  } catch (e) {
    toast(e.message, 'error', 8000);
    if (e instanceof G.AuthError) route();
  } finally { setBusy(btn, false); }
}

function renderPlan(c, { plan }) {
  const item = (x, extra = '') => `<li><span class="date">${esc(prettyDate(x.duty?.date || x.event?.extendedProperties?.private?.prmDate))}</span> ${esc(x.body?.summary || x.event?.summary)} ${extra}</li>`;
  const changes = plan.create.length + plan.update.length + plan.remove.length;
  $('#planArea').innerHTML = `
    <section class="panel plan">
      <div class="counts">
        <div><b>${plan.create.length}</b><span>new</span></div>
        <div><b>${plan.update.length}</b><span>changed</span></div>
        <div><b>${plan.unchanged.length}</b><span>unchanged</span></div>
        <div><b>${plan.remove.length}</b><span>removed from roster</span></div>
      </div>
      ${plan.create.length ? `<details open><summary>New events (${plan.create.length})</summary><ul>${plan.create.map(x => item(x)).join('')}</ul></details>` : ''}
      ${plan.update.length ? `<details open><summary>Changed events (${plan.update.length})</summary><ul>${plan.update.map(x => item(x, x.event.summary !== x.body.summary ? `<span class="muted">(was ${esc(x.event.summary)})</span>` : '<span class="muted">(times/details changed)</span>')).join('')}</ul></details>` : ''}
      ${plan.remove.length ? `<div class="removals"><h4>No longer on the roster</h4><p class="muted">Ticked events will be deleted from the “${esc(settings.calendarName)}” calendar. Unticked ones are left alone.</p>
        ${plan.remove.map(x => `<label class="check"><input type="checkbox" data-remove="${esc(x.event.id)}" ${x.duplicate ? 'checked' : ''}> ${esc(prettyDate(x.event.extendedProperties.private.prmDate))} · ${esc(x.event.summary)} <span class="muted">(${esc(x.reason)})</span></label>`).join('')}</div>` : ''}
      ${changes ? '<button class="btn primary wide" id="apply">Apply changes to calendar</button>' : '<div class="notice ok">Calendar already matches this roster.</div><button class="btn wide" id="apply">Finish (back up to Drive)</button>'}
      <div id="progress"></div>
    </section>`;
  $('#apply').addEventListener('click', ev => applyPlan(c, ev.currentTarget));
}

async function applyPlan(c, btn) {
  const { plan, calendarId } = currentPlan;
  const approved = new Set($$('[data-remove]').filter(x => x.checked).map(x => x.dataset.remove));
  setBusy(btn, true, 'Updating calendar…');
  $$('[data-remove]').forEach(x => { x.disabled = true; });
  const prog = $('#progress');
  const results = await G.executePlan(calendarId, plan, approved, (i, n, op) => {
    prog.innerHTML = `<div class="bar"><span style="width:${n ? Math.round((i / n) * 100) : 100}%"></span></div><p class="muted">${op ? `${i + 1} of ${n}: ${esc(op.kind)} ${esc(op.label)}` : 'Calendar done.'}</p>`;
  });
  const failed = results.filter(r => !r.ok);
  const summary = {
    at: new Date().toISOString(), ok: failed.length === 0, captureId: c.id,
    created: results.filter(r => r.ok && r.kind === 'create').length,
    updated: results.filter(r => r.ok && r.kind === 'update').length,
    removed: results.filter(r => r.ok && r.kind === 'remove').length,
    failed: failed.length, keptRemovals: plan.remove.length - approved.size,
  };
  c.syncResults = { ...summary, results };
  c.status = failed.length ? 'sync-partial' : 'synced';
  c.syncedAt = summary.at;
  await captures.put(c);
  await kv.set('lastSync', summary);
  await log.add({ kind: 'sync', ok: summary.ok, captureId: c.id, message: `Calendar sync: ${summary.created} added, ${summary.updated} updated, ${summary.removed} removed${failed.length ? `, ${failed.length} failed` : ''}` });
  currentPlan = null;

  prog.innerHTML = `<div class="notice ${failed.length ? 'error' : 'ok'}">Calendar: ${summary.created} added, ${summary.updated} updated, ${summary.removed} removed${failed.length ? `, <b>${failed.length} failed</b>` : ''}.</div>
    ${failed.length ? `<ul class="failures">${failed.map(f => `<li>${esc(f.kind)} ${esc(f.label)}: ${esc(f.error)}</li>`).join('')}</ul><p>Nothing else was changed. Tap <b>Compare with calendar</b> again to retry only what's left.</p>` : ''}
    <p id="backupMsg" class="muted">Backing up to Google Drive…</p>`;
  const b = await backupToDrive(c, step => { const el = $('#backupMsg'); if (el) el.textContent = step; });
  const el = $('#backupMsg');
  if (el) el.outerHTML = b.ok ? `<div class="notice ok">Drive backup saved (${esc(b.files.join(', '))}).</div>` : `<div class="notice error">Drive backup failed: ${esc(b.error)}. Your calendar changes are kept. Retry from Settings → Back up now.</div>`;
  // Swap in a fresh button so the old "apply" handler can't fire a second time.
  const done = document.createElement('button');
  done.className = 'btn primary wide';
  done.textContent = failed.length ? 'Back to sync' : 'Done';
  done.addEventListener('click', () => (failed.length ? route() : nav('#/')));
  btn.replaceWith(done);
}

async function viewHistory() {
  setActiveTab('history');
  const [caps, logs] = await Promise.all([captures.list(), log.list()]);
  main.innerHTML = `
    <h2>Capture history</h2>
    ${caps.length ? `<div class="history">${caps.map(c => `
      <a class="hist" href="#/review/${esc(c.id)}">
        <span class="title">${esc(prettyRange(c.period.start, c.period.end))}</span>
        <span class="muted">${esc(fmtWhen(c.createdAt))} · ${c.duties?.length || 0} duties</span>
        <span class="pill ${esc(c.status)}">${esc(c.status)}</span>
      </a>`).join('')}</div>` : '<p class="muted">No captures yet.</p>'}
    <h3>Activity log</h3>
    <ul class="log">${logs.slice(0, 200).map(l => `<li class="${l.ok ? '' : 'bad'}"><span class="muted">${esc(fmtWhen(l.at))}</span> ${esc(l.message)}</li>`).join('') || '<li class="muted">Nothing yet.</li>'}</ul>`;
}

async function viewSettings() {
  setActiveTab('settings');
  const [lastCapture, persisted] = await Promise.all([kv.get('lastCapture'), navigator.storage?.persisted?.().catch(() => false)]);
  const tok = G.getToken();
  const tzText = Object.entries(settings.tzOverrides || {}).map(([k, v]) => `${k}=${v}`).join('\n');
  main.innerHTML = `
    <h2>Settings</h2>
    <section class="panel">
      <h3>Work logins</h3>
      <label>Sabre portal URL<input id="sabreUrl" type="url" value="${esc(settings.sabreUrl)}"></label>
      <label>Microsoft email<input id="msEmail" type="email" value="${esc(settings.msEmail)}" autocomplete="off"></label>
      <label>Sabre User ID<input id="sabreUserId" value="${esc(settings.sabreUserId)}" autocomplete="off"></label>
      <div class="notice">Passwords aren't stored in this app. iPadOS doesn't let one site fill another site's login form, so only Safari's own Passwords (iCloud Keychain, encrypted, behind Face ID) can fill them on the Microsoft and Sabre pages. When a password changes, Safari offers to update it. The usernames above are built into the Capture bookmark, which can fill them if Safari doesn't. Reinstall the bookmark after changing them.</div>
      <button class="btn" id="saveLogins">Save</button> <a class="btn" href="${bookmarkletLink()}" target="_blank" rel="noopener">Install Capture bookmark</a>
    </section>
    <section class="panel">
      <h3>Google account</h3>
      <label>OAuth Client ID<input id="clientId" value="${esc(settings.googleClientId)}" placeholder="xxxx.apps.googleusercontent.com" autocomplete="off"></label>
      <p class="muted">Authorised JavaScript origin: <code>${esc(location.origin)}</code><br>Authorised redirect URI: <code>${esc(G.redirectUri())}</code></p>
      <p class="status ${tok ? 'ok' : 'none'}">${tok ? `Signed in (session valid until ${new Date(tok.exp).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })})` : 'Not signed in'}</p>
      <button class="btn" id="saveClient">Save Client ID</button>
      ${tok ? '<button class="btn" id="signOut">Sign out</button>' : '<button class="btn primary" data-signin="#/settings">Sign in to Google</button>'}
    </section>
    <section class="panel">
      <h3>Google Calendar</h3>
      <label>Calendar name<input id="calName" value="${esc(settings.calendarName)}"></label>
      <p class="muted">${settings.calendarId ? `Using calendar <code>${esc(settings.calendarId)}</code>` : 'Created on first sync.'} The app can only see and change calendars it created itself, so your other calendars can't be touched.</p>
      <label class="check"><input type="checkbox" id="incOff" ${settings.includeDaysOff ? 'checked' : ''}> Add days off to the calendar</label>
      <label class="check"><input type="checkbox" id="offBusy" ${settings.daysOffBusy ? 'checked' : ''}> Show days off/leave as busy</label>
      <button class="btn" id="saveCal">Save</button> <button class="btn" id="newCal">Create a new calendar</button>
    </section>
    <section class="panel">
      <h3>Google Drive</h3>
      <label>Backup folder name<input id="driveRoot" value="${esc(settings.driveRootName)}"></label>
      <p class="muted">${settings.drive?.rootId ? `Folder ready: ${esc(settings.drive.rootName)}/ (Original Rosters, Processed Rosters, Capture History, Backups)` : 'Created on first backup.'} The app can only see files it created.</p>
      <button class="btn" id="saveDrive">Save</button>
    </section>
    <section class="panel">
      <h3>Backup &amp; restore</h3>
      <div class="toolbar">
        <button class="btn" id="backupNow">Back up to Drive now</button>
        <button class="btn" id="restoreDrive">Restore from Drive…</button>
        <button class="btn" id="exportFile">Export backup file</button>
        <label class="btn filebtn">Import backup file<input type="file" id="importFile" accept="application/json,.json"></label>
      </div>
      <p class="muted">Backups contain rosters, history and settings. They never contain passwords or Google tokens.</p>
    </section>
    <section class="panel">
      <h3>Airport time zones</h3>
      <p class="muted">Add or override ports, one per line, e.g. <code>XYZ=Australia/Brisbane</code>. Built-in list covers the Virgin network.</p>
      <textarea id="tzBox" rows="3">${esc(tzText)}</textarea>
      <button class="btn" id="saveTz">Save time zones</button>
    </section>
    <section class="panel">
      <h3>About</h3>
      <p>Last capture: ${lastCapture ? `${esc(prettyRange(lastCapture.start, lastCapture.end))} (${esc(fmtWhen(lastCapture.at))})` : '—'}</p>
      <p>Version ${APP_VERSION} · Storage ${persisted ? 'persistent' : 'standard'}</p>
      <button class="btn danger" id="wipe">Erase all data on this iPad</button>
    </section>`;
  bindSignIn(main);

  const need = async (btn, fn) => {
    if (!googleReady().ok) { toast(googleReady().reason === 'signin' ? 'Sign in to Google first.' : googleReady().reason, 'error'); return; }
    setBusy(btn, true);
    try { await fn(); } catch (e) { toast(e.message, 'error', 8000); } finally { setBusy(btn, false); }
  };

  $('#saveLogins').addEventListener('click', async () => { await saveSettings({ sabreUrl: $('#sabreUrl').value.trim(), msEmail: $('#msEmail').value.trim(), sabreUserId: $('#sabreUserId').value.trim() }); toast('Saved.'); });
  $('#saveClient').addEventListener('click', async () => { await saveSettings({ googleClientId: $('#clientId').value.trim() }); toast('Client ID saved.'); route(); });
  $('#signOut')?.addEventListener('click', async () => { await G.signOut(); toast('Signed out of Google.'); route(); });
  $('#saveCal').addEventListener('click', async () => { await saveSettings({ calendarName: $('#calName').value.trim() || 'VA Roster', includeDaysOff: $('#incOff').checked, daysOffBusy: $('#offBusy').checked }); toast('Saved.'); });
  $('#newCal').addEventListener('click', async () => {
    if (!(await confirmBox('Create a new, empty roster calendar? The old one stays in Google Calendar but the app will stop updating it.', 'Create'))) return;
    await saveSettings({ calendarId: '', calendarName: $('#calName').value.trim() || 'VA Roster' });
    toast('A new calendar will be created on the next sync.');
    route();
  });
  $('#saveDrive').addEventListener('click', async () => {
    const name = $('#driveRoot').value.trim() || 'My Roster';
    await saveSettings({ driveRootName: name, drive: name === settings.drive?.rootName ? settings.drive : null });
    toast('Saved.');
  });
  $('#backupNow').addEventListener('click', ev => need(ev.currentTarget, async () => {
    const caps = await captures.list();
    const b = await backupToDrive(caps[0] || null);
    toast(b.ok ? 'Backup saved to Drive.' : `Backup failed: ${b.error}`, b.ok ? 'ok' : 'error', 7000);
  }));
  $('#restoreDrive').addEventListener('click', ev => need(ev.currentTarget, async () => {
    const d = await ensureDrive();
    const files = (await G.listFiles(d.ids.Backups)).filter(f => f.name.startsWith('backup_'));
    if (!files.length) { toast('No backups found in Drive.', 'error'); return; }
    const dlg = modal(`<div class="modal-body"><h3>Restore from Drive</h3><p>Replaces everything on this iPad with the chosen backup.</p>
      ${files.slice(0, 30).map(f => `<label class="check"><input type="radio" name="bk" value="${esc(f.id)}"> ${esc(fmtWhen(f.createdTime))} <span class="muted">${esc(f.name)}</span></label>`).join('')}</div>
      <div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn danger" data-ok>Restore</button></div>`);
    $('[data-ok]', dlg).addEventListener('click', async () => {
      const id = $('input[name=bk]:checked', dlg)?.value;
      if (!id) { toast('Choose a backup.', 'error'); return; }
      try {
        const data = await G.downloadJson(id);
        await importAll(data, { replace: true });
        await loadSettings();
        await log.add({ kind: 'restore', ok: true, message: 'Restored from Drive backup' });
        dlg.close(); toast('Restored.', 'ok'); route();
      } catch (e) { toast(`Restore failed: ${e.message}`, 'error', 8000); }
    });
  }));
  $('#exportFile').addEventListener('click', async () => {
    const data = await exportAll();
    const file = new File([JSON.stringify(data, null, 1)], `roster-manager-backup_${fileStamp()}.json`, { type: 'application/json' });
    if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file] }); return; } catch (e) { if (e.name === 'AbortError') return; } }
    const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  });
  $('#importFile').addEventListener('change', async ev => {
    const f = ev.target.files?.[0]; if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (!(await confirmBox('Replace everything on this iPad with this backup file?', 'Restore', true))) return;
      await importAll(data, { replace: true });
      await loadSettings();
      await log.add({ kind: 'restore', ok: true, message: `Restored from file ${f.name}` });
      toast('Restored.', 'ok'); route();
    } catch (e) { toast(`Import failed: ${e.message}`, 'error', 8000); }
  });
  $('#saveTz').addEventListener('click', async () => {
    const map = {}; const bad = [];
    for (const line of $('#tzBox').value.split('\n').map(l => l.trim()).filter(Boolean)) {
      const m = /^([A-Za-z]{3})\s*=\s*(\S+)$/.exec(line);
      if (!m || !isValidTz(m[2])) bad.push(line); else map[m[1].toUpperCase()] = m[2];
    }
    if (bad.length) { toast(`Not valid: ${bad.join(', ')}`, 'error', 7000); return; }
    await saveSettings({ tzOverrides: map }); toast('Time zones saved.');
  });
  $('#wipe').addEventListener('click', async () => {
    if (!(await confirmBox('Erase all rosters, history and settings on this iPad? Google Calendar and Drive are not touched.', 'Erase', true))) return;
    await wipeAll(); await G.signOut(); await loadSettings(); toast('Erased.'); nav('#/');
  });
}

// ---------------- router & startup ----------------
async function route() {
  const h = location.hash || '#/';
  const [, view, id] = h.split('/');
  try {
    if (!view) await viewHome();
    else if (view === 'capture') await viewCapture();
    else if (view === 'review' && id) await viewReview(id);
    else if (view === 'sync' && id) await viewSync(id);
    else if (view === 'history') await viewHistory();
    else if (view === 'settings') await viewSettings();
    else await viewHome();
  } catch (e) {
    console.error(e);
    main.innerHTML = `<div class="notice error">Something went wrong: ${esc(e.message)}</div>`;
  }
  window.scrollTo(0, 0);
}

async function loadSettings() {
  settings = { ...DEFAULT_SETTINGS, ...((await kv.get('settings')) || {}) };
  setOverrides(settings.tzOverrides);
}

function updateOnline() { document.body.classList.toggle('offline', !navigator.onLine); }

async function start() {
  const r = G.handleRedirect();
  await loadSettings();
  requestPersistence();
  window.addEventListener('hashchange', route);
  window.addEventListener('online', updateOnline);
  window.addEventListener('offline', updateOnline);
  updateOnline();
  await route();
  if (r.handled) toast(r.error || 'Signed in to Google.', r.error ? 'error' : 'ok', r.error ? 9000 : 3000);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

start();
