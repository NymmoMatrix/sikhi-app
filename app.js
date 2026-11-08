/* ============================================================
   Sikhi — app logic
   Everything runs on-device: no server, no accounts, no tracking.
   ============================================================ */
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

/* ───────────── storage ───────────── */
const store = {
  get(k, d) { try { const v = localStorage.getItem('sikhi:' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('sikhi:' + k, JSON.stringify(v)); } catch {} },
};

/* ───────────── daily rotation (deterministic, no server) ───────────── */
function dayNumber(dt = new Date()) {
  return Math.floor(Date.UTC(dt.getFullYear(), dt.getMonth(), dt.getDate()) / 86400000);
}
const today = dayNumber();
const pairToday = today % 2 === 0 ? 'A' : 'B';          // evening / night alternation
const quoteToday = today % 1e9;                          // index into the quote pool
const imgToday = (today * 37) % 1e9;                     // different stride -> different image

/* ───────────── state ───────────── */
const S = {
  banis: [], quotes: [], images: [],
  hukam: null, hukamToday: null, hukamError: null,
  hukamDate: null, hukamIndex: null,
  view: 'today',
  reader: null,
  read: store.get('readDays', []),       // dates marked read
  display: store.get('display', { gurmukhi: true, translit: true, english: true }),
  scale: store.get('scale', 1),
  simran: store.get('simran', { mantra: 'ikonkar', count: 0, total: 0, malas: 0 }),
};

/* ───────────── data ───────────── */
async function loadJSON(path) {
  const r = await fetch(path, { cache: 'no-cache' });
  if (!r.ok) throw new Error(path + ' → ' + r.status);
  return r.json();
}

async function boot() {
  const [index, quotes] = await Promise.all([
    loadJSON('data/bani-index.json'), loadJSON('data/quotes.json'),
  ]);
  S.banis = index.banis;
  S.quotes = quotes.quotes;
  S.images = [];                  // photos are yours alone: they live in device storage
  loadJSON('data/calendar.json').then(d => {      // Sikh dates (optional, never fatal)
    S.dates = d.days || [];
    S.datesSource = d.source || '';
    renderDates();
  }).catch(() => {});
  await refreshLocalKeys();       // which banis already have your own audio on this device
  await refreshPhotos();          // and which photos you have imported here
  // iOS can unload an installed PWA while the file picker is open. If we are
  // back with the flag still set, the pick came to nothing — say it out loud.
  if (sessionStorage.getItem('pickerPending')) {
    sessionStorage.removeItem('pickerPending');
    setTimeout(() => toast('The picker closed the app — tap "Import the zip" again', 8000), 1500);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') sessionStorage.removeItem('pickerPending');
  });

  applyDisplay(); applyScale();
  renderNitnem(); renderToday(); renderReflect(); renderSaakhi(); renderGallery();
  loadHukamnama();
  loadHukamIndex();
  $('#hukamDateJump').onchange = e => { if (e.target.value) openHukamDate(e.target.value); };
  registerSW();
  prefetchDaily();          // pull today's banis in the background for offline
}

/* Verses load per bani on demand (the full set is 452 KB — too slow to block
   the first screen on a phone connection). Cache in memory once fetched. */
const verseCache = {};
async function versesFor(id) {
  if (verseCache[id]) return verseCache[id];
  const d = await loadJSON('data/bani-' + id + '.json');
  verseCache[id] = d.verses || [];
  return verseCache[id];
}

/* Warm the cache with the banis today's rotation needs. */
async function prefetchDaily() {
  const due = dueNow();
  for (const id of due.ids) {
    try { await versesFor(id); } catch {}
  }
}

/* ───────────── date helpers ───────────── */
const fmtDate = d => d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
const dateKey = (d = new Date()) => d.toISOString().slice(0, 10);

/* ───────────── which bani is due now ───────────── */
function dueNow() {
  const h = new Date().getHours();
  const byId = id => S.banis.find(b => b.id === id);
  if (h < 12) {
    return { slot: 'Amrit Vela', title: 'Japji Sahib', sub: 'The morning reading, with Ardaas',
             ids: ['japji_sahib_poetic', 'ardaas'] };
  }
  if (h < 20) {
    const ev = S.banis.filter(b => b.slot === 'evening').sort((a, b) => a.pair.localeCompare(b.pair));
    const pick = ev.find(b => b.pair === pairToday) || ev[0];
    return { slot: 'Evening', title: pick ? pick.name : 'Rehras Sahib',
             sub: 'Today’s evening bani' + (ev.length > 1 ? ` · alternates with ${ev.find(b => b !== pick)?.name}` : ''),
             ids: pick ? [pick.id] : [] };
  }
  const ni = S.banis.filter(b => b.slot === 'night').sort((a, b) => a.pair.localeCompare(b.pair));
  const pick = ni.find(b => b.pair === pairToday) || ni[0];
  return { slot: 'Night', title: pick ? pick.name : 'Kirtan Sohila',
           sub: 'Today’s night bani' + (ni.length > 1 ? ` · alternates with ${ni.find(b => b !== pick)?.name}` : ''),
           ids: pick ? [pick.id] : [] };
}

function renderToday() {
  const due = dueNow();
  $('#topSub').textContent = fmtDate(new Date());
  $('#nowKicker').textContent = due.slot;
  $('#nowTitle').textContent = due.title;
  $('#nowSub').textContent = due.sub;
  $('#nowRead').onclick = () => openReader(due.ids[0]);
  $('#nowCard').dataset.ids = due.ids.join(',');

  // streak + today's read state
  const todayK = dateKey();
  const readSet = new Set(S.read);
  $('#readTodayNum').textContent = readSet.has(todayK) ? '1' : '0';
  $('#streakNum').textContent = streak();
  $('#markRead').textContent = readSet.has(todayK) ? 'Read ✓' : 'Mark today read';
  $('#markRead').onclick = () => {
    const s = new Set(S.read);
    s.has(todayK) ? s.delete(todayK) : s.add(todayK);
    S.read = [...s]; store.set('readDays', S.read);
    renderToday();
  };

  // hukamnama card
  renderHukamCard();

  // reflection card
  const q = S.quotes[quoteToday % Math.max(S.quotes.length, 1)];
  $('#reflectQuote').textContent = q ? q.text : '';
}

function streak() {
  const s = new Set(S.read);
  let n = 0;
  const d = new Date();
  for (;;) {
    const k = dateKey(d);
    if (s.has(k)) { n++; d.setDate(d.getDate() - 1); }
    else if (n === 0 && k === dateKey(new Date())) { d.setDate(d.getDate() - 1); }
    else break;
  }
  return n;
}

/* ───────────── Hukamnama ───────────── */
async function loadHukamnama() {
  S.hukamDate = null;                       // the live view is always today
  const key = dateKey();
  const cached = store.get('hukam:' + key, null);
  if (cached) { S.hukam = cached; S.hukamToday = cached; renderHukam(); renderHukamCard(); return; }
  try {
    const r = await fetch('https://api.banidb.com/v2/hukamnamas/today', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    S.hukam = data; S.hukamToday = data; store.set('hukam:' + key, data);
  } catch (e) {
    S.hukamError = String(e.message || e);
    try { S.hukam = await loadJSON('data/hukamnama.json'); S.hukam._stale = true; S.hukamToday = S.hukam; } catch {}
  }
  renderHukam(); renderHukamCard();
}

function firstLine(h) {
  const sh = h?.shabads?.[0];
  const v = sh?.verses?.[0];
  return v?.verse?.unicode || '';
}
function hukamMeta(h) {
  const sh = h?.shabads?.[0]?.shabadInfo;
  if (!sh) return 'From Sri Harmandir Sahib';
  const d = h.date?.gregorian;
  const date = d ? new Date(d.year, d.month - 1, d.date).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '';
  return `${date} · ${sh.raag?.english || ''} · ${sh.writer?.english || ''}`;
}

function renderHukamCard() {
  const h = S.hukamToday;      // the Today card always shows today, never an archived day
  $('#hukamMeta').textContent = h ? hukamMeta(h) : (S.hukamError ? 'Tap to retry' : 'From Sri Harmandir Sahib');
  $('#hukamLine').textContent = h ? firstLine(h) : '…';
}

function renderHukam() {
  const el = $('#hukamBody');
  const h = S.hukam;
  if (!h) {
    const msg = S.hukamError
      ? (S.hukamDate ? esc(S.hukamError)
                     : 'Could not load today’s Hukamnama.<br><small>' + esc(S.hukamError) + '</small>')
      : 'Loading…';
    el.innerHTML = `<div class="loading">${msg}</div>`
      + (S.hukamDate
        ? '<div class="hukam-head"><button class="btn-ghost hukam-back" id="hukamToday">← Back to today</button></div>'
        : '');
    const b = $('#hukamToday');
    if (b) b.onclick = () => loadHukamnama().then(renderHukamArchive);
    return;
  }
  const d = h.date?.gregorian;
  const dateStr = d ? new Date(d.year, d.month - 1, d.date).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : '';
  let html = `<div class="hukam-head">
      <p class="card-kicker">${S.hukamDate ? 'Hukamnama · archive' : 'Hukamnama'}</p>
      <h2>${esc(dateStr)}</h2>
      <p class="hukam-meta">From Sri Harmandir Sahib · daily order</p>
      ${h._stale ? '<p class="hukam-src">offline copy — will refresh when online</p>' : ''}
      ${S.hukamDate ? '<button class="btn-ghost hukam-back" id="hukamToday">← Back to today</button>' : ''}
    </div>`;
  for (const sh of (h.shabads || [])) {
    const info = sh.shabadInfo || {};
    html += `<div class="shabad-head">${esc(info.raag?.english || '')} · ${esc(info.writer?.english || '')} · Ang ${esc(info.pageNo ?? '')}</div>`;
    for (const v of (sh.verses || [])) {
      const g = v.verse?.unicode || '';
      const t = v.transliteration?.english || '';
      const e = v.translation?.en?.bdb || '';
      if (!g && !e) continue;
      html += `<div class="verse">
        ${g ? `<p class="verse-g">${esc(g)}</p>` : ''}
        ${t ? `<p class="verse-t">${esc(t)}</p>` : ''}
        ${e ? `<p class="verse-e">${esc(e)}</p>` : ''}
      </div>`;
    }
  }
  el.innerHTML = html;
  const back = $('#hukamToday');
  if (back) back.onclick = () => loadHukamnama().then(renderHukamArchive);
}

/* ───────────── Hukamnama archive (browse by date) ───────────── */
const longDate = iso => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined,
    { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
};
const shortDate = iso => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined,
    { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
};

async function loadHukamIndex() {
  try { S.hukamIndex = await loadJSON('data/hukam-index.json'); }
  catch { S.hukamIndex = null; }
  renderHukamArchive();
}

function renderHukamArchive() {
  const idx = S.hukamIndex;
  const sub = $('#archiveSub'), list = $('#hukamList'), jump = $('#hukamDateJump');
  if (!sub) return;
  if (!idx || !idx.count) {
    sub.textContent = idx
      ? 'Nothing archived yet — today is the first entry.'
      : 'The archive is not available offline yet.';
    list.innerHTML = '';
    return;
  }
  const n = idx.count;
  sub.textContent = `${n} day${n === 1 ? '' : 's'} kept · ${shortDate(idx.first)} → ${shortDate(idx.last)}`;
  jump.min = idx.first;
  jump.max = idx.last;
  list.innerHTML = idx.days.map(d => `
    <button class="hukam-item${d.date === S.hukamDate ? ' on' : ''}" data-date="${esc(d.date)}">
      <span class="hi-row"><strong>${esc(shortDate(d.date))}</strong>
        <em>${esc(d.raag)}${d.writer ? ' · ' + esc(d.writer) : ''}</em></span>
      <span class="hi-verse">${esc(d.first || '')}</span>
    </button>`).join('');
  $$('#hukamList .hukam-item').forEach(el =>
    el.addEventListener('click', () => openHukamDate(el.dataset.date)));
}

async function openHukamDate(iso) {
  if (iso === dateKey()) {                  // that date is today: use the live copy
    await loadHukamnama();
    renderHukamArchive();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  S.hukamDate = iso;
  $('#hukamBody').innerHTML = '<div class="loading">Loading…</div>';
  try {
    S.hukam = await loadJSON('data/hukam/' + iso + '.json');
    S.hukamError = null;
  } catch {
    S.hukam = null;
    S.hukamError = 'Nothing archived for ' + longDate(iso);
  }
  renderHukam();
  renderHukamArchive();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ───────────── Nitnem list ───────────── */
function renderNitnem() {
  const slots = [['morning', 'Amrit Vela'], ['evening', 'Evening'], ['night', 'Night'], ['extra', 'More banis']];
  const due = dueNow();
  let html = '';
  for (const [slot, label] of slots) {
    const items = S.banis.filter(b => b.slot === slot);
    if (!items.length) continue;
    html += `<p class="slot-head">${label}</p>`;
    for (const b of items) {
      const isDue = due.ids.includes(b.id);
      const glyph = (b.gurmukhiTitle || '☬').slice(0, 2);
      html += `<button class="bani-item" data-bani="${esc(b.id)}">
        <span class="bani-badge">${esc(glyph)}</span>
        <span class="bani-main"><strong>${esc(b.name)}${hasAudio(b) ? ' <span class="bani-audio" title="Audio available">♪</span>' : ''}</strong>
          <em>${b.verseCount} ${b.verseCount === 1 ? 'verse' : 'verses'} · ${esc(b.blurb || '')}</em></span>
        ${isDue ? '<span class="bani-today">Today</span>' : ''}
      </button>`;
    }
  }
  $('#baniList').innerHTML = html;
  $$('#baniList .bani-item').forEach(el =>
    el.addEventListener('click', () => openReader(el.dataset.bani)));
}

/* ───────────── reader ───────────── */
function openReader(id) {
  const b = S.banis.find(x => x.id === id);
  if (!b) return;
  S.reader = b;
  $('#readerName').textContent = b.name;
  $('#readerSub').textContent = `${b.verseCount} verses${b.script === 'english' ? ' · poetic' : ''}`;
  $('#reader').hidden = false;
  const body = $('#readerBody');
  body.onscroll = null;
  body.scrollTop = 0;

  if (!verseCache[id]) {
    body.innerHTML = '<div class="loading">Loading…</div>';
    versesFor(id).then(verses => {
      if (S.reader !== b) return;                 // user navigated away
      paintVerses(verses);
    }).catch(() => {
      body.innerHTML = '<div class="loading">Could not load this bani.<br><small>Check your connection once.</small></div>';
    });
    return;
  }
  paintVerses(verseCache[id]);

  function paintVerses(verses) {
    body.innerHTML = verses.map(v => `<div class="verse">
        ${v.question ? `<p class="verse-q">${esc(v.question)}</p>` : ''}
        ${v.gurmukhi ? `<p class="verse-g">${esc(v.gurmukhi)}</p>` : ''}
        ${v.translit ? `<p class="verse-t">${esc(v.translit)}</p>` : ''}
        ${v.english ? `<p class="verse-e${v.gurmukhi ? '' : ' only'}">${esc(v.english)}</p>` : ''}
      </div>`).join('');
    applyDisplay();                               // honour the saved display prefs
    body.scrollTop = store.get('scroll:' + id, 0);
    body.onscroll = () => store.set('scroll:' + id, body.scrollTop);
    setupAudio(b);
  }
}
function closeReader() {
  if (S.reader) store.set('scroll:' + S.reader.id, $('#readerBody').scrollTop);
  if (AU.el) { savePos(); AU.el.pause(); }
  $('#reader').hidden = true; S.reader = null;
}

/* display options */
function applyDisplay() {
  const d = S.display;
  $$('.reader-body .verse').forEach(v => {
    const g = $('.verse-g', v), t = $('.verse-t', v), e = $('.verse-e', v);
    if (g) g.style.display = d.gurmukhi ? '' : 'none';
    if (t) t.style.display = d.translit ? '' : 'none';
    if (e) e.style.display = d.english ? '' : 'none';
  });
  $$('#readerOptsPanel .chip[data-opt]').forEach(c => c.classList.toggle('on', !!d[c.dataset.opt]));
}
function applyScale() {
  document.documentElement.style.setProperty('--read', S.scale);
}

/* ───────────── listen-along audio ─────────────
   A bani may carry a recitation (audio/<id>.<ext>, advertised in
   data/bani-index.json). The player is optional — a bani with no audio file
   shows no player at all. Audio is pulled into the service-worker cache the
   first time a reader opens, so a bani you have listened to once keeps working
   with no signal. If the audio came with per-verse timings the verse being
   recited is highlighted, and optionally followed. */
const AU = {
  el: null, bani: null, marks: null, lastSave: 0,
  local: false, blobUrl: null,
  rate: store.get('audioRate', 1),
  follow: store.get('audioFollow', true),
};
const RATES = [0.75, 1, 1.25, 1.5];

/* ───────────── audio you supply yourself (kept on this device) ─────────────
   A bani may ship with a bundled recitation, but you can also load your own
   file. Imported files live in this browser's IndexedDB and play from a blob
   URL: nothing is uploaded, nothing is shared, and it works with no signal.
   A local file always wins over a bundled one. */
const AUDIO_DB = 'sikhi-audio';
let LOCAL_KEYS = new Set();

function idbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(AUDIO_DB, 3);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
      if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos');
      if (!db.objectStoreNames.contains('sakhis')) db.createObjectStore('sakhis');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbDo(mode, fn) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction('files', mode);
    const req = fn(tx.objectStore('files'));
    let out;
    if (req) req.onsuccess = () => { out = req.result; };
    tx.oncomplete = () => { db.close(); res(out); };
    tx.onerror = () => { db.close(); rej(tx.error); };
  });
}
const localAudio = {
  get: id => idbDo('readonly', s => s.get(id)),
  put: (id, rec) => idbDo('readwrite', s => s.put(rec, id)),
  del: id => idbDo('readwrite', s => s.delete(id)),
  keys: () => idbDo('readonly', s => s.getAllKeys()),
};
async function refreshLocalKeys() {
  try { LOCAL_KEYS = new Set(await localAudio.keys()); } catch {}
}
const hasAudio = b => !!(b.audio || LOCAL_KEYS.has(b.id));

/* Photos work the same way: imported once on this device, never uploaded.
   They used to be published in the repo; that is exactly what this replaces. */
const PHOTO = { recs: [], urls: {} };
async function photoRecords() {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction('photos', 'readonly');
    const req = tx.objectStore('photos').getAll();
    let out = [];
    req.onsuccess = () => { out = req.result || []; };
    tx.oncomplete = () => { db.close(); res(out); };
    tx.onerror = () => { db.close(); rej(tx.error); };
  });
}
async function savePhotos(files) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction('photos', 'readwrite');
    const st = tx.objectStore('photos');
    for (const f of files)
      st.put({ blob: f, name: f.name, type: f.type, size: f.size, added: Date.now() }, f.name);
    tx.oncomplete = () => { db.close(); res(files.length); };
    tx.onerror = () => { db.close(); rej(tx.error); };
  });
}
async function refreshPhotos() {
  for (const u of Object.values(PHOTO.urls)) URL.revokeObjectURL(u);
  PHOTO.urls = {};
  try { PHOTO.recs = (await photoRecords()).sort((a, b) => a.name.localeCompare(b.name)); }
  catch { PHOTO.recs = []; }
  for (const r of PHOTO.recs) PHOTO.urls[r.name] = URL.createObjectURL(r.blob);
  S.images = PHOTO.recs.map(r => r.name);
}


function mmss(s) {
  if (!isFinite(s) || s < 0) s = 0;
  return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
}

function audioEl() {
  if (AU.el) return AU.el;
  const el = new Audio();
  el.preload = 'metadata';
  el.setAttribute('playsinline', '');
  el.addEventListener('play', () => setPlayIcon(true));
  el.addEventListener('pause', () => setPlayIcon(false));
  el.addEventListener('ended', () => { setPlayIcon(false); savePos(true); });
  el.addEventListener('timeupdate', onAudioTick);
  el.addEventListener('loadedmetadata', updateTimes);
  el.addEventListener('error', () => setPlayIcon(false));
  AU.el = el;
  return el;
}

function setPlayIcon(playing) {
  const b = $('#audioPlay');
  if (!b) return;
  b.textContent = playing ? '❚❚' : '▶';
  b.setAttribute('aria-label', playing ? 'Pause' : 'Play');
}

/* Keyed on the element's own bani, never on AU.bani: the 'pause' event fires
   asynchronously, so after a bani switch AU.bani is already the NEW bani while
   the element still holds the old position — saving then would clobber it. */
function savePos(done) {
  if (!AU.el) return;
  const id = AU.el.dataset.bani;
  if (id) store.set('audioPos:' + id, done ? 0 : Math.floor(AU.el.currentTime));
}

function updateTimes() {
  const el = AU.el;
  if (!el) return;
  $('#audioNow').textContent = mmss(el.currentTime);
  if (isFinite(el.duration)) $('#audioDur').textContent = mmss(el.duration);
  const seek = $('#audioSeek');
  if (seek && !seek.dataset.dragging && isFinite(el.duration) && el.duration > 0)
    seek.value = String(Math.round(el.currentTime / el.duration * 1000));
}

function onAudioTick() {
  updateTimes();
  if (Date.now() - AU.lastSave > 5000) { AU.lastSave = Date.now(); savePos(); }
  if (!AU.marks || !AU.marks.length) return;
  const t = AU.el.currentTime + 0.25;
  let vi = AU.marks[0].v;
  for (const m of AU.marks) { if (m.t <= t) vi = m.v; else break; }
  const vs = $$('#readerBody .verse');
  const cur = vs[Math.min(vi, vs.length - 1)];
  if (!cur || cur.classList.contains('on')) return;
  vs.forEach(v => v.classList.remove('on'));
  cur.classList.add('on');
  if (AU.follow) cur.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

/* Pull the audio through the service worker so it is cached for offline use.
   A plain page fetch carries no Range header, so the worker stores the whole
   file; done here rather than in the player so it never interrupts playback. */
async function warmAudio(b) {
  try {
    if (!('caches' in window)) return;
    if (await caches.match(new URL(b.audio.file, location.href).href)) return;
    await fetch(b.audio.file, { cache: 'no-cache' });
  } catch {}
}

async function loadMarks(b) {
  if (!b.audio || !b.audio.marks) return;
  try {
    const d = await loadJSON('data/audio-marks-' + b.id + '.json');
    if (AU.bani === b) AU.marks = d.marks || [];
  } catch {}
}

function setSource(src, key) {
  const el = audioEl();
  if (AU.blobUrl && AU.blobUrl !== src) { URL.revokeObjectURL(AU.blobUrl); AU.blobUrl = null; }
  if (src.startsWith('blob:')) AU.blobUrl = src;
  if (el.dataset.bani !== key || el.getAttribute('src') !== src) {
    el.dataset.bani = key;
    el.src = src;
    const at = store.get('audioPos:' + key, 0);
    if (at > 3) el.addEventListener('loadedmetadata', () => { el.currentTime = at; }, { once: true });
    setPlayIcon(false);
  }
}

async function setupAudio(b) {
  const bar = $('#audioBar'), addBar = $('#addAudioBar');
  if (AU.el) { savePos(); AU.el.pause(); }   // save against the bani it was playing
  AU.bani = b;
  AU.marks = null;
  $$('#readerBody .verse').forEach(v => v.classList.remove('on'));

  let rec = null;
  try { rec = await localAudio.get(b.id); } catch {}
  if (AU.bani !== b) return;                 // another bani opened while we waited

  const src = rec ? URL.createObjectURL(rec.blob) : (b.audio && b.audio.file);
  AU.local = !!rec;
  $('#audioSwap').hidden = !src;
  $('#audioClear').hidden = !rec;
  $('#addAudioNote').textContent = 'stays on this device';
  if (!src) {                                // nothing to play yet: offer the import row
    bar.hidden = true;
    if (AU.blobUrl) { URL.revokeObjectURL(AU.blobUrl); AU.blobUrl = null; }
    addBar.hidden = false;
    return;
  }
  addBar.hidden = true;
  bar.hidden = false;

  const el = audioEl();
  setSource(src, b.id);
  el.playbackRate = AU.rate;
  $('#audioRate').textContent = AU.rate + '×';
  const useMarks = !!(b.audio && b.audio.marks && !rec);  // timings only match the bundled file
  $('#audioFollow').hidden = !useMarks;
  $('#audioFollow').classList.toggle('on', !!AU.follow);
  updateTimes();
  if (useMarks) loadMarks(b);
  if (!rec) warmAudio(b);                    // bundled files get cached; local ones are already here
  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: b.name, artist: 'Nitnem', album: 'Sikhi',
      });
      navigator.mediaSession.setActionHandler('play', () => audioEl().play().catch(() => {}));
      navigator.mediaSession.setActionHandler('pause', () => audioEl().pause());
    } catch {}
  }
}

/* ───────────── Saakhi ─────────────
   Sakhis live in this device's storage — written, imported, edited and deleted
   here, never uploaded. Three traditional sakhis are seeded on first run so the
   section is not empty; they can be edited or removed like any other. */
const SAAKHI = { list: [] };
const SAAKHI_SEED = [
  { id: 'seed-lalo', title: 'Malik Bhago and Bhai Lalo', source: 'Traditional sakhi',
    body: 'Guru Nanak was invited to a feast by Malik Bhago, a wealthy official who had grown rich on the labour of the village. The Guru declined, and went instead to the house of Bhai Lalo, a carpenter who earned his bread honestly.\n\nWhen Malik Bhago pressed him, the Guru took a piece of the rich man\'s bread in one hand and a piece of Bhai Lalo\'s coarse bread in the other, and squeezed. From the rich man\'s bread came blood; from the carpenter\'s came milk.\n\nThe lesson was plain: what is earned by exploiting others cannot nourish. Truthful earning is not a detail of the teaching \u2014 it is its foundation.' },
  { id: 'seed-kanhaiya', title: "Bhai Kanhaiya's water", source: 'Traditional sakhi',
    body: 'During the siege at Anandpur, Bhai Kanhaiya carried water to the wounded on the battlefield. Some Sikhs complained to Guru Gobind Singh: he was giving water to the enemy as well as to their own.\n\nThe Guru called him and asked what he was doing. Bhai Kanhaiya answered that he had been taught to see the Guru\'s light in every face, and so could not tell friend from foe.\n\nGuru Gobind Singh did not rebuke him. He gave him ointment as well as water, so he could also dress the wounded \u2014 and from that service grew the tradition of the sewadar who tends to all, without asking who they are.' },
  { id: 'seed-janeu', title: 'The thread that does not break', source: 'Traditional sakhi',
    body: 'At the ceremony where boys of his caste were given the janeu \u2014 the sacred thread \u2014 the young Nanak refused to accept it.\n\nHe asked what would happen to the thread when it wore out, when it broke, when the body aged. A thread of cotton could not hold anyone to truth, he said. If there were a thread worth wearing, it would be one of compassion, contentment and restraint \u2014 a thread that could not be broken, lost or burned.\n\nThe priests had no answer. What he described was not a ritual to be put on, but a way of living to be carried.' },
];

async function saakhiAll() {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction('sakhis', 'readonly');
    const req = tx.objectStore('sakhis').getAll();
    let out = [];
    req.onsuccess = () => { out = req.result || []; };
    tx.oncomplete = () => { db.close(); res(out.sort((a, b) => (a.added || 0) - (b.added || 0))); };
    tx.onerror = () => { db.close(); rej(tx.error); };
  });
}
async function saakhiPut(rec) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction('sakhis', 'readwrite');
    tx.objectStore('sakhis').put(rec, rec.id);
    tx.oncomplete = () => { db.close(); res(rec); };
    tx.onerror = () => { db.close(); rej(tx.error); };
  });
}
async function saakhiRemove(id) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction('sakhis', 'readwrite');
    tx.objectStore('sakhis').delete(id);
    tx.oncomplete = () => { db.close(); res(); };
    tx.onerror = () => { db.close(); rej(tx.error); };
  });
}

async function renderSaakhi() {
  try { SAAKHI.list = await saakhiAll(); } catch { SAAKHI.list = []; }
  if (!SAAKHI.list.length && !store.get('saakhiSeeded', false)) {
    for (const s of SAAKHI_SEED) await saakhiPut({ ...s, added: Date.now() });
    store.set('saakhiSeeded', true);
    try { SAAKHI.list = await saakhiAll(); } catch {}
  }
  const el = $('#saakhiList');
  el.innerHTML = SAAKHI.list.length
    ? SAAKHI.list.map(s => {
        const first = (s.body || '').replace(/\s+/g, ' ').slice(0, 88).trim();
        return '<button class="saakhi-item" data-id="' + esc(s.id) + '">'
          + '<strong>' + esc(s.title || 'Untitled') + '</strong>'
          + '<span>' + esc(first) + ((s.body || '').length > 88 ? '…' : '') + '</span>'
          + (s.source ? '<em>' + esc(s.source) + '</em>' : '')
          + '</button>';
      }).join('')
    : '<p class="saakhi-empty">No sakhis yet. Write one, or import a text file.</p>';
  $$('#saakhiList .saakhi-item').forEach(b => { b.onclick = () => openSaakhi(b.dataset.id); });
  // the retired simran counter keeps a visible record
  const sm = store.get('simran', null);
  if (sm && (sm.total > 0 || sm.count > 0) && !store.get('simranArchive', null)) {
    store.set('simranArchive', { total: sm.total || 0, malas: sm.malas || 0, at: Date.now() });
  }
  const arc = store.get('simranArchive', null);
  const line = $('#simranArchiveLine');
  if (arc) {
    line.hidden = false;
    line.textContent = 'Simran counter retired — ' + arc.total + ' lifetime, '
      + arc.malas + ' malas, archived ' + new Date(arc.at).toLocaleDateString() + '.';
  }
}

function openSaakhi(id) {
  const s = SAAKHI.list.find(x => x.id === id);
  if (!s) return;
  SAAKHI.open = s;
  $('#saakhiTitle').textContent = s.title || 'Untitled';
  $('#saakhiSub').textContent = s.source || 'kept on this device';
  $('#saakhiBody').innerHTML = (s.body || '').split(/\n\s*\n/).map(p =>
    '<p>' + esc(p).replace(/\n/g, '<br>') + '</p>').join('');
  $('#saakhiBody').scrollTop = 0;
  $('#saakhiView').hidden = false;
}

/* ───────────── Reflections + gallery ───────────── */
let reflectIndex = null;
function renderReflect() {
  const i = reflectIndex === null ? (quoteToday % Math.max(S.quotes.length, 1)) : reflectIndex;
  const q = S.quotes[i];
  $('#reflectKicker').textContent = reflectIndex === null ? 'Today’s reflection' : 'Reflection';
  $('#reflectBig').textContent = q ? q.text : '';
  $('#reflectSource').textContent = q && q.source && q.source !== 'personal' ? q.source : '';
  const img = S.images.length ? S.images[imgToday % S.images.length] : null;
  const im = $('#reflectImg');
  if (img && PHOTO.urls[img]) { im.src = PHOTO.urls[img]; im.style.display = ''; } else im.style.display = 'none';
}
function renderGallery() {
  const gal = $('#gallery');
  $('#galCount').textContent = S.images.length;
  if (!S.images.length) {
    gal.innerHTML = '<div class="gal-empty"><p>Your photos stay on this device.</p>'
      + '<button class="aa-btn" id="galImportMany">Import photos</button>'
      + '<span class="aa-note">choose the whole folder · never uploaded</span>'
      + '<button class="link-btn" id="galImport">or import a .zip</button></div>';
  } else {
    gal.innerHTML = S.images.map(f =>
      `<button data-img="${esc(f)}"><img loading="lazy" src="${PHOTO.urls[f] || ''}" alt=""></button>`).join('')
      + '<button class="gal-add" id="galImport" aria-label="Import photos">＋</button>';
  }
  const imp = $('#galImport');
  // armed on tap, disarmed as soon as we are visible again; if the app is
  // unloaded while the picker is up, the flag survives and boot() says so
  const arm = sel => { sessionStorage.setItem('pickerPending', '1'); $(sel).click(); };
  if (imp) imp.onclick = () => arm('#photoFile');
  const impMany = $('#galImportMany');
  if (impMany) impMany.onclick = () => arm('#photoFileMany');
  $$('#gallery button[data-img]').forEach(b => b.addEventListener('click', () => {
    $('#lightboxImg').src = PHOTO.urls[b.dataset.img] || '';
    $('#lightbox').hidden = false;
  }));
}

/* ───────────── Sikh dates ─────────────
   Store-and-show only: the dates come from data/calendar.json, which cites its
   source. Entries flagged "varies" follow the lunar calendar and are NOT
   computed here — showing a guessed gurpurab date would be worse than none. */
const MN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const mdOf = d => String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

function daysUntil(md) {
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const [m, d] = md.split('-').map(Number);
  let t = new Date(now.getFullYear(), m - 1, d);
  if (t < now) t = new Date(now.getFullYear() + 1, m - 1, d);
  return Math.round((t - now) / 86400000);
}

function renderDates() {
  const list = (S.dates || []).map(x => ({ ...x, in: daysUntil(x.md) }));
  const next = list.slice().sort((a, b) => a.in - b.in).slice(0, 3);
  $('#datesNext').innerHTML = next.length ? next.map(x => {
    const [m, d] = x.md.split('-').map(Number);
    const when = x.in === 0 ? 'today' : x.in === 1 ? 'tomorrow' : 'in ' + x.in + ' days';
    return '<li><span class="dn-date">' + d + ' ' + MN[m - 1] + '</span>'
      + '<span class="dn-name">' + esc(x.name) + '</span>'
      + '<span class="dn-when">' + when + (x.varies ? ' · date varies' : '') + '</span></li>';
  }).join('') : '<li class="dn-empty">No dates loaded</li>';
}

function openDates() {
  const now = mdOf(new Date());
  const all = (S.dates || []).slice().sort((a, b) => (a.md < b.md ? -1 : 1));
  $('#datesSub').textContent = S.datesSource || '';
  $('#datesBody').innerHTML = all.map(x => {
    const [m, d] = x.md.split('-').map(Number);
    return '<div class="date-row' + (x.md < now ? ' past' : '') + '">'
      + '<span class="dr-md">' + d + ' ' + MN[m - 1] + '</span>'
      + '<div class="dr-main"><strong>' + esc(x.name) + '</strong>'
      + '<span>' + esc(x.note || '') + '</span>'
      + (x.varies ? '<em>follows the lunar calendar — this date shifts yearly</em>' : '')
      + '</div></div>';
  }).join('')
    + '<p class="date-credit">Source: ' + esc(S.datesSource || 'unknown')
    + '. Fixed Nanakshahi dates repeat; lunar dates move each year — check the current panjika.</p>';
  $('#datesView').hidden = false;
  $('#datesBody').scrollTop = 0;
}

/* ───────────── navigation ───────────── */
function show(view) {
  S.view = view;
  for (const v of ['today', 'hukamnama', 'nitnem', 'saakhi', 'reflect'])
    $('#view-' + v).hidden = v !== view;
  $$('.tab').forEach(t => t.classList.toggle('on', t.dataset.view === view));
  $('#topTitle').textContent = { today: 'Sikhi', hukamnama: 'Hukamnama', nitnem: 'Nitnem',
                                 saakhi: 'Saakhi', reflect: 'Reflections' }[view];
  window.scrollTo({ top: 0 });
  store.set('view', view);
}

/* ───────────── wire up ───────────── */
$$('.tab').forEach(t => t.addEventListener('click', () => show(t.dataset.view)));
$('#readerBack').onclick = closeReader;
$('#readerOpts').onclick = () => { $('#readerOptsPanel').hidden = !$('#readerOptsPanel').hidden; };
$$('#readerOptsPanel .chip[data-opt]').forEach(c => c.addEventListener('click', () => {
  S.display[c.dataset.opt] = !S.display[c.dataset.opt];
  store.set('display', S.display); applyDisplay();
}));
$('#fontUp').onclick = () => { S.scale = Math.min(1.6, +(S.scale + 0.1).toFixed(2)); store.set('scale', S.scale); applyScale(); };
$('#fontDown').onclick = () => { S.scale = Math.max(0.85, +(S.scale - 0.1).toFixed(2)); store.set('scale', S.scale); applyScale(); };
const SCALES = [0.9, 1, 1.15, 1.3, 1.5];
$('#textSizeBtn').onclick = () => {
  const i = SCALES.findIndex(s => Math.abs(s - S.scale) < 0.03);
  S.scale = SCALES[(i + 1) % SCALES.length];
  store.set('scale', S.scale); applyScale();
  $('#textSizeBtn').textContent = S.scale > 1.2 ? 'Aa⁺' : (S.scale < 1 ? 'Aa⁻' : 'Aa');
};
$('#hukamCard').onclick = () => show('hukamnama');
$('#reflectCard').onclick = () => show('reflect');
$('#saakhiAdd').onclick = () => {
  $('#saakhiTitleIn').value = '';
  $('#saakhiBodyIn').value = '';
  $('#saakhiEdit').hidden = false;
  $('#saakhiTitleIn').focus();
};
$('#saakhiEditCancel').onclick = () => { $('#saakhiEdit').hidden = true; };
$('#saakhiEditSave').onclick = async () => {
  const title = $('#saakhiTitleIn').value.trim();
  const body = $('#saakhiBodyIn').value.trim();
  if (!body) { toast('Nothing to save'); return; }
  await saakhiPut({ id: 'sk_' + Date.now(), title: title || 'Untitled', body,
                    source: 'added by you', added: Date.now() });
  $('#saakhiEdit').hidden = true;
  await renderSaakhi();
  toast('Saakhi saved');
};
$('#saakhiBack').onclick = () => { $('#saakhiView').hidden = true; };
$('#saakhiDel').onclick = async () => {
  const s = SAAKHI.open;
  if (!s) return;
  if (!confirm('Delete "' + (s.title || 'Untitled') + '" from this device?')) return;
  await saakhiRemove(s.id);
  $('#saakhiView').hidden = true;
  SAAKHI.open = null;
  await renderSaakhi();
  toast('Deleted');
};
$('#saakhiImport').onclick = () => $('#saakhiFile').click();
$('#saakhiFile').onchange = async e => {
  const f = (e.target.files || [])[0];
  e.target.value = '';
  if (!f) return;
  try {
    const text = await f.text();
    const name = f.name.replace(/\.[^.]+$/, '');
    let made = 0;
    if (/\.json$/i.test(f.name)) {
      const d = JSON.parse(text);
      const arr = Array.isArray(d) ? d : (d.sakhis || (d.title ? [d] : []));
      for (const s of arr) {
        const body = s && (s.body || s.text);
        if (!body) continue;
        await saakhiPut({ id: 'sk_' + Date.now() + '_' + made, title: s.title || 'Untitled',
                          body, source: s.source || '', added: Date.now() });
        made++;
      }
    } else {
      const t = text.trim();
      if (t) {
        await saakhiPut({ id: 'sk_' + Date.now(), title: name || 'Imported', body: t,
                          source: 'imported', added: Date.now() });
        made = 1;
      }
    }
    await renderSaakhi();
    toast(made ? 'Imported ' + made + (made === 1 ? ' saakhi' : ' sakhis') : 'No saakhi text found');
  } catch (err) {
    toast('Could not read that file');
  }
};
$('#reflectNext').onclick = () => {
  reflectIndex = ((reflectIndex === null ? quoteToday : reflectIndex) + 1) % S.quotes.length;
  renderReflect();
};
$('#reflectToday').onclick = () => { reflectIndex = null; renderReflect(); };
$('#datesCard').onclick = openDates;
$('#datesBack').onclick = () => { $('#datesView').hidden = true; };
$('#lightbox').onclick = () => { $('#lightbox').hidden = true; };

/* listen-along player */
$('#audioPlay').onclick = () => {
  const el = audioEl();
  if (el.paused) el.play().catch(() => {}); else el.pause();
};
$('#audioRate').onclick = () => {
  AU.rate = RATES[(RATES.indexOf(AU.rate) + 1) % RATES.length];
  store.set('audioRate', AU.rate);
  if (AU.el) AU.el.playbackRate = AU.rate;
  $('#audioRate').textContent = AU.rate + '×';
};
const seekEl = $('#audioSeek');
seekEl.addEventListener('input', () => {
  seekEl.dataset.dragging = '1';                 // don't fight the drag
  const el = AU.el;
  if (el && isFinite(el.duration)) $('#audioNow').textContent = mmss(seekEl.value / 1000 * el.duration);
});
const commitSeek = () => {
  const el = AU.el;
  if (el && isFinite(el.duration)) el.currentTime = seekEl.value / 1000 * el.duration;
  delete seekEl.dataset.dragging;
};
seekEl.addEventListener('change', commitSeek);
seekEl.addEventListener('touchend', commitSeek);
$('#audioFollow').onclick = () => {
  AU.follow = !AU.follow;
  store.set('audioFollow', AU.follow);
  $('#audioFollow').classList.toggle('on', AU.follow);
  const on = $('#readerBody .verse.on');
  if (AU.follow && on) on.scrollIntoView({ block: 'center', behavior: 'smooth' });
};
/* import your own recording — stored on the device, never uploaded */
function pickAudio() { $('#audioFile').click(); }
$('#addAudioBtn').onclick = pickAudio;
$('#audioSwap').onclick = pickAudio;
$('#audioFile').onchange = async e => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f || !AU.bani) return;
  const bani = AU.bani;
  if (!/^audio\//.test(f.type) && !/\.(m4a|mp3|aac|m4b|opus|ogg|oga|wav)$/i.test(f.name)) {
    $('#addAudioNote').textContent = 'that file is not audio';
    return;
  }
  try {
    await localAudio.put(bani.id, { blob: f, name: f.name, type: f.type, size: f.size, added: Date.now() });
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    await refreshLocalKeys();
    renderNitnem();                          // picks up the \u266a badge
    setupAudio(bani);
  } catch (err) {
    $('#addAudioNote').textContent = 'could not save that file here';
  }
};
$('#audioClear').onclick = async () => {
  if (!AU.bani) return;
  const b = AU.bani;
  if (!confirm('Remove the audio you added for ' + b.name + ' from this device?')) return;
  try {
    await localAudio.del(b.id);
    await refreshLocalKeys();
    store.set('audioPos:' + b.id, 0);
    renderNitnem();
  } catch {}
  if (AU.bani === b) setupAudio(b);
};
/* iOS hands over files, not folders, so a bundle arrives as a .zip. Unpack it
   here instead of making you unzip in Files first: read the central directory,
   inflate each entry with DecompressionStream (Safari 16.4+), keep the images. */
async function imagesFromZip(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const dv = new DataView(buf.buffer);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 65558; i--)
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip');
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const method = dv.getUint16(off + 10, true);
    const csize = dv.getUint32(off + 20, true);
    const namelen = dv.getUint16(off + 28, true);
    const extralen = dv.getUint16(off + 30, true);
    const commentlen = dv.getUint16(off + 32, true);
    const lho = dv.getUint32(off + 42, true);
    const name = new TextDecoder().decode(buf.subarray(off + 46, off + 46 + namelen));
    off += 46 + namelen + extralen + commentlen;
    if (name.endsWith('/') || !/\.(jpe?g|png|webp|gif)$/i.test(name)) continue;
    if (dv.getUint32(lho, true) !== 0x04034b50) continue;
    const lnamelen = dv.getUint16(lho + 26, true);
    const lextralen = dv.getUint16(lho + 28, true);
    const start = lho + 30 + lnamelen + lextralen;
    const raw = buf.subarray(start, start + csize);
    let bytes;
    if (method === 0) bytes = raw;
    else if (method === 8) {
      const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    } else continue;
    const base = name.split('/').pop();
    const type = /\.png$/i.test(base) ? 'image/png'
               : /\.webp$/i.test(base) ? 'image/webp'
               : /\.gif$/i.test(base) ? 'image/gif' : 'image/jpeg';
    out.push(new File([bytes], base, { type }));
  }
  return out;
}

/* A tiny message strip: import failures must never be silent (iOS pickers can
   hand back nothing at all, and an alert can be missed). */
function toast(msg, ms) {
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('on'), ms || 3200);
}

/* import your own photos — same rules: they stay on this device */
async function takePhotoFiles(list) {
  let files = [...list];
  if (!files.length) { toast('Nothing was chosen — try again'); return; }
  const zip = files.find(f => /\.zip$/i.test(f.name) || f.type === 'application/zip');
  try {
    if (zip) {
      toast('Opening ' + zip.name + ' (' + (zip.size / 1e6).toFixed(1) + ' MB)…', 6000);
      if (typeof DecompressionStream === 'undefined') {
        toast('This iOS cannot unzip in the app — unzip the file in Files, then choose the photos', 8000);
        return;
      }
      files = await imagesFromZip(zip);
    } else {
      files = files.filter(f => /^image\//.test(f.type));
    }
    if (!files.length) {
      toast('No photos found in that file — pick Sikhi-App-Photos.zip', 6000);
      return;
    }
    if (files.length > 1) toast('Saving ' + files.length + ' photos…', 8000);
    await savePhotos(files);
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    sessionStorage.removeItem('pickerPending');
    await refreshPhotos();
    renderGallery();
    renderReflect();          // the reflection card shows one of your photos
    toast('Imported ' + files.length + (files.length === 1 ? ' photo' : ' photos'));
  } catch (err) {
    toast('Could not read that file: ' + (err && err.message ? err.message : 'unknown error'), 8000);
  }
}
$('#photoFile').onchange = e => { const f = [...(e.target.files || [])]; e.target.value = ''; takePhotoFiles(f); };
$('#photoFileMany').onchange = e => { const f = [...(e.target.files || [])]; e.target.value = ''; takePhotoFiles(f); };
window.addEventListener('pagehide', () => savePos());

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { $('#lightbox').hidden = true; if (!$('#reader').hidden) closeReader(); }
});

/* sw.js does not skipWaiting, so a new worker waits for consent: the running
   app is never swapped out mid-read. Tapping Reload hands control to the new
   worker, and the page reloads once that worker has actually taken over. */
function applyUpdate(reg) {
  const w = reg.waiting || reg.installing;
  if (w) w.postMessage({ type: 'SKIP_WAITING' });
  navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
  setTimeout(() => location.reload(), 1500);   // belt and braces
}

function showUpdateBar(reg) {
  if (document.getElementById('updateBar')) return;
  const bar = document.createElement('div');
  bar.id = 'updateBar';
  bar.innerHTML = '<span>New version ready</span><button id="updateReload">Reload</button>';
  document.body.appendChild(bar);
  $('#updateReload').onclick = () => applyUpdate(reg);
}

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').then(reg => {
    // a worker reaching 'installed' while a controller already exists == an update
    const watch = w => w && w.addEventListener('statechange', () => {
      if (w.state === 'installed' && navigator.serviceWorker.controller) showUpdateBar(reg);
    });
    watch(reg.installing);
    if (reg.waiting && navigator.serviceWorker.controller) showUpdateBar(reg);
    reg.addEventListener('updatefound', () => watch(reg.installing));
    // check on launch, and again whenever the app returns to the foreground
    // (iOS keeps installed PWAs suspended rather than reloading them)
    const check = () => reg.update().catch(() => {});
    check();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') check();
    });
  }).catch(() => {});
}

boot().catch(err => {
  $('#main').innerHTML = `<div class="loading">Could not start: ${esc(err.message)}</div>`;
});
