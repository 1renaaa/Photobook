/*
 * Architecture overview
 * ─────────────────────
 * All state lives in spreads[] — an array of cover/spread objects. Photos are stored
 * as base64 data-URLs in memory (lost on page refresh; no persistence layer).
 *
 * render() tears down and rebuilds the visible spread from scratch, then bindAll()
 * attaches fresh listeners to the new DOM nodes.
 *
 * Page flip: go() pre-renders the destination spread underneath, overlays a CSS 3D
 * flipper on top, then removes the flipper on animationend — the destination is already
 * correct underneath so no second render is needed.
 *
 * HEIC images use a three-tier decode fallback:
 *   1. createImageBitmap  — native (Safari, Chrome w/ OS codec)
 *   2. <img> tag decode   — some browsers support HEIC via OS codecs
 *   3. VideoDecoder API   — manual HEVC bitstream extraction + GPU decode
 */

/* ══════════════════════════════════════════════════════════
   STATE & DATA MODEL
   ══════════════════════════════════════════════════════════ */

let bookMode   = 'closed'; // 'closed' | 'open'
const shareId  = new URLSearchParams(location.search).get('share');
let isReadMode = false;

/* ── BOOK DATA API ── */
const BOOK_VERSION = 1;

function getBookData() {
  const cover = spreads[0];
  return {
    version:    BOOK_VERSION,
    title:      cover.title,
    subtitle:   cover.sub,
    coverPhoto: cover.photo,
    spreads,
    current,
  };
}

function loadBookData(data) {
  if (!data?.spreads) return false;
  spreads = data.spreads;
  current = data.current ?? 0;
  render();
  return true;
}

const openBookSound = new Audio('audio_big-paper-sound.m4a');
openBookSound.preload = 'auto';
openBookSound.volume  = 0.45;

let spreads = [
  { type:'cover', title:'My Photobook', sub:'Paris 2026', photo:null, imprint:'' },
  { type:'spread', left:{layout:'single',photos:[null],caption:''}, right:{layout:'two',photos:[null,null],caption:''} },
  { type:'spread', left:{layout:'two',photos:[null,null],caption:''}, right:{layout:'single',photos:[null],caption:''} },
];
let current   = 0;
let animating = false;

/* ── CROP HELPERS ──
   Stored: spreads[si][side].crops[pi] = { scale, ox, oy }
   - scale: zoom factor (1–3)
   - ox, oy: normalized pan offset as a fraction of the slot's own size.
             e.g. ox=0.1 means "shifted 10% of the slot width to the right".
   Clamping: |ox| ≤ (scale-1)/2,  |oy| ≤ (scale-1)/2
   This ensures the image always covers the viewport with no empty edges,
   and renders identically regardless of the slot's pixel dimensions. */
function getCrop(si, side, pi) {
  if (side === 'cover') return spreads[0].coverCrop || { scale:1, ox:0, oy:0 };
  return spreads[si]?.[side]?.crops?.[pi] || { scale:1, ox:0, oy:0 };
}
function setCrop(si, side, pi, crop) {
  if (side === 'cover') { spreads[0].coverCrop = crop; scheduleSave(); return; }
  const page = spreads[si][side];
  if (!page.crops) page.crops = [];
  page.crops[pi] = crop;
  scheduleSave();
}
function clampCrop(scale, ox, oy) {
  const lim = (scale - 1) / 2;
  return { scale, ox: Math.max(-lim, Math.min(lim, ox)), oy: Math.max(-lim, Math.min(lim, oy)) };
}
/* img must be position:absolute; left:50%; top:50%; width:100%; height:100% */
function applyCropToImg(img, crop) {
  img.style.transform =
    `translate(-50%,-50%) translate(${crop.ox * 100}%,${crop.oy * 100}%) scale(${crop.scale})`;
}

const flipSound  = new Audio('audio_page-flip.mp3');
flipSound.preload = 'auto';
flipSound.volume  = 0.25;

const clickSound  = new Audio('audio_UI-click.mp3');
clickSound.preload = 'auto';
clickSound.volume  = 0.15;

function playFlipSfx()  { flipSound.currentTime  = 0; flipSound.play().catch(() => {}); }
function playClickSfx() { clickSound.currentTime = 0; clickSound.play().catch(() => {}); }

/* ══════════════════════════════════════════════════════════
   UTILITIES
   ══════════════════════════════════════════════════════════ */

// Shorthand element factory. Named `elt` to avoid shadowing `el =>` forEach parameters.
function elt(tag, cls) {
  const d = document.createElement(tag);
  if (cls) d.className = cls;
  return d;
}

// Number of photo slots per layout name
const LAYOUT_PHOTO_COUNT = { single:1, two:2, trio:3, quad:4 };

// Numeric page label for a single slot (only meaningful for si > 0)
function pageNum(si, side) { return side === 'left' ? si*2-1 : si*2; }

// Human-readable spread label used in the nav indicator and tray thumbnails
function spreadLabel(i) { return i === 0 ? 'Cover' : `${i*2-1}–${i*2}`; }

// Remove a drag-highlight class from all currently highlighted elements
function clearDragOver(cls) {
  document.querySelectorAll('.' + cls).forEach(node => node.classList.remove(cls));
}

// Copy inline background styles from a built .page element onto a .flipper-face element.
// Flipper faces don't share the .page class, so CSS backgrounds must be applied inline.
function applyPageBg(pageEl, faceEl) {
  if (pageEl.classList.contains('cover-l')) {
    faceEl.style.cssText += ';background:linear-gradient(160deg,#f0ebe2,#e5dece);align-items:center;justify-content:center';
  } else if (pageEl.classList.contains('cover-r')) {
    faceEl.style.cssText += ';background:linear-gradient(135deg,#5a2e10,#2e1508);flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:20px 16px';
  } else if (pageEl.classList.contains('left-page')) {
    faceEl.style.background = 'linear-gradient(to right,#ddd4be,var(--cream))';
  } else {
    faceEl.style.background = 'linear-gradient(to left,#ddd4be,var(--cream))';
  }
}

// Append a cover-fit thumbnail image to a tray half-cell
function appendThumbnailImage(container, src) {
  const im = new Image();
  im.src = src;
  im.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover';
  container.style.position = 'relative';
  container.appendChild(im);
}

/* ══════════════════════════════════════════════════════════
   PERSISTENCE  (IndexedDB primary · localStorage fallback)
   ══════════════════════════════════════════════════════════ */

const DB_NAME = 'photobookDB', DB_VER = 1, DB_STORE = 'state', LS_KEY = 'photobook_v1';
let idbAvail = null, saveTimer = null, _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = e => e.target.result.createObjectStore(DB_STORE);
    r.onsuccess = e => { _db = e.target.result; res(_db); };
    r.onerror   = e => rej(e.target.error);
  });
}
async function idbReady() {
  if (idbAvail !== null) return idbAvail;
  try { await openDB(); idbAvail = true; } catch(_) { idbAvail = false; }
  return idbAvail;
}

function dataURLtoBlob(url) {
  const [hdr, b64] = url.split(',');
  const mime = hdr.match(/:(.*?);/)[1];
  const bin  = atob(b64);
  const buf  = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new Blob([buf], { type: mime });
}
function blobToDataURL(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload  = e => res(e.target.result);
    r.onerror = () => rej(new Error('blob read'));
    r.readAsDataURL(blob);
  });
}

// data-URLs → Blobs for IDB storage (avoids large base64 in the store)
function spreadsOut(arr) {
  return arr.map(s => {
    if (s.type === 'cover') return { ...s, photo: s.photo ? dataURLtoBlob(s.photo) : null };
    const p = x => ({ ...x, photos: x.photos.map(ph => ph ? dataURLtoBlob(ph) : null) });
    return { ...s, left: p(s.left), right: p(s.right) };
  });
}
// Blobs → data-URLs when restoring from IDB
async function spreadsIn(arr) {
  const out = [];
  for (const s of arr) {
    if (s.type === 'cover') {
      const photo = s.photo instanceof Blob ? await blobToDataURL(s.photo) : (s.photo || null);
      out.push({ ...s, photo }); continue;
    }
    const p = async x => ({ ...x, photos: await Promise.all(x.photos.map(ph => ph ? blobToDataURL(ph) : null)) });
    out.push({ ...s, left: await p(s.left), right: await p(s.right) });
  }
  return out;
}

async function persistSave() {
  if (await idbReady()) {
    try {
      const db = await openDB();
      await new Promise((res, rej) => {
        const tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).put({ spreads: spreadsOut(spreads), current }, 'main');
        tx.oncomplete = res;
        tx.onerror    = e => rej(e.target.error);
      });
      return;
    } catch(e) { console.warn('IDB save:', e); }
  }
  // localStorage fallback — stores data-URLs as JSON
  try { localStorage.setItem(LS_KEY, JSON.stringify(getBookData())); } catch(_) {}
}

async function persistLoad() {
  if (await idbReady()) {
    try {
      const db  = await openDB();
      const rec = await new Promise((res, rej) => {
        const tx = db.transaction(DB_STORE, 'readonly');
        const r  = tx.objectStore(DB_STORE).get('main');
        r.onsuccess = e => res(e.target.result);
        r.onerror   = e => rej(e.target.error);
      });
      if (rec) {
        spreads = await spreadsIn(rec.spreads);
        current = rec.current ?? 0;
        render(); return;
      }
    } catch(e) { console.warn('IDB load:', e); }
  }
  // localStorage fallback (also handles migration from LS → IDB on next save)
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw && loadBookData(JSON.parse(raw))) return;
  } catch(_) {}
  render();
}

async function persistClear() {
  if (await idbReady()) {
    try {
      const db = await openDB();
      await new Promise((res, rej) => {
        const tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).delete('main');
        tx.oncomplete = res;
        tx.onerror    = e => rej(e.target.error);
      });
    } catch(_) {}
  }
  localStorage.removeItem(LS_KEY);
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persistSave, 400);
}

function resetBook() {
  if (!confirm('Reset this book? This will remove all photos and captions saved on this device.')) return;
  clearTimeout(saveTimer);
  persistClear();
  spreads = [
    { type:'cover', title:'My Photobook', sub:'Paris 2026', photo:null, imprint:'' },
    { type:'spread', left:{layout:'single',photos:[null],caption:''}, right:{layout:'two',photos:[null,null],caption:''} },
    { type:'spread', left:{layout:'two',photos:[null,null],caption:''}, right:{layout:'single',photos:[null],caption:''} },
  ];
  current = 0;
  render();
}

/* ══════════════════════════════════════════════════════════
   RENDER
   ══════════════════════════════════════════════════════════ */

function render() {
  // Always pre-render the spread (non-interactive in closed mode) so it's
  // ready behind the closed cover for the opening transition.
  const book = document.getElementById('book');
  book.innerHTML = '';
  const spreadEl = buildSpread(current, bookMode === 'open' && !isReadMode);
  spreadEl.classList.add('spread');
  book.appendChild(spreadEl);
  book.appendChild(elt('div', 'spine-line'));

  if (bookMode === 'closed') { renderClosedBook(); return; }
  updateUI();
  bindAll();
}

function renderClosedBook() {
  const face = document.getElementById('closedFace');
  if (!face) return;
  face.innerHTML = '';
  const s = spreads[0];

  // Title — reuses cover-title class for identical styling
  const title = elt('div', 'cover-title');
  title.contentEditable = 'true'; title.textContent = s.title;
  title.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); title.blur(); } });
  title.addEventListener('blur', () => {
    const v = title.textContent.trim();
    spreads[0].title = v || 'My Photobook';
    if (!v) title.textContent = 'My Photobook';
    scheduleSave();
  });
  face.appendChild(title);

  face.appendChild(elt('div', 'cover-divider'));

  // Subtitle — reuses cover-field / cover-sub for identical styling + pen affordance
  const subField = elt('div', 'cover-field');
  const subInp   = elt('input', 'cover-sub');
  subInp.type = 'text'; subInp.value = s.sub;
  subInp.addEventListener('blur', () => { spreads[0].sub = subInp.value.trim() || 'Paris 2026'; scheduleSave(); });
  subField.appendChild(subInp);
  face.appendChild(subField);

  // CTA
  const btn = elt('button', 'open-btn');
  btn.textContent = 'Open Book';
  btn.onclick = openBook;
  face.appendChild(btn);
}

function openBook() {
  openBookSound.currentTime = 0;
  openBookSound.play().catch(() => {});

  const bookWrap   = document.querySelector('.book-wrap');
  const closedBook = document.getElementById('closedBook');

  // X so the cover's right edge lands on the spread's right edge at animation end.
  // Formula: X = wrapRight − coverRight  (both measured before any transform runs)
  const shiftX = bookWrap.getBoundingClientRect().right
               - closedBook.getBoundingClientRect().right;
  closedBook.style.setProperty('--openShiftX', shiftX + 'px');

  bookWrap.classList.add('opening');   // triggers spreadReveal on #book
  closedBook.classList.add('opening'); // triggers coverOpen on .closed-book

  // Switch to interactive mode exactly when the cover animation ends — no gap.
  closedBook.addEventListener('animationend', function handler(e) {
    if (e.animationName !== 'coverOpen') return;
    closedBook.removeEventListener('animationend', handler);
    bookWrap.classList.remove('opening');
    bookMode = 'open';
    if (isReadMode) current = 0; // read mode always opens to cover
    document.body.classList.replace('mode-closed', 'mode-open');
    render(); // rebuilds spread as interactive + bindAll
  });
}

function buildSpread(si, interactive) {
  const wrap = elt('div');
  wrap.appendChild(buildPage(si, 'left',  interactive));
  wrap.appendChild(buildPage(si, 'right', interactive));
  return wrap;
}

function buildPage(si, side, interactive) {
  const s   = spreads[si];
  const div = elt('div', `page ${side}-page`);

  if (s.type === 'cover') {
    if (side === 'left') {
      div.classList.add('cover-l');
      const imprint = elt('div', 'cover-imprint');
      imprint.dataset.placeholder = 'your name · year';
      if (interactive) {
        imprint.contentEditable = 'true';
        imprint.textContent = s.imprint || '';
        imprint.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); imprint.blur(); } });
        imprint.addEventListener('blur', () => { spreads[0].imprint = imprint.textContent.trim(); scheduleSave(); });
      } else {
        imprint.textContent = s.imprint || '';
      }
      div.appendChild(imprint);
    } else {
      div.classList.add('cover-r');

      // 1. Title
      if (interactive) {
        const inp = elt('div', 'cover-title');
        inp.contentEditable = 'true'; inp.textContent = s.title;
        inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
        inp.addEventListener('blur', () => {
          const val = inp.textContent.trim();
          spreads[0].title = val || 'My Photobook';
          if (!val) inp.textContent = 'My Photobook';
          scheduleSave();
        });
        div.appendChild(inp);
      } else {
        const h2 = elt('div', 'cover-title'); h2.textContent = s.title; div.appendChild(h2);
      }

      // 2. Divider
      div.appendChild(elt('div', 'cover-divider'));

      // 3. Cover photo slot
      const photoSlot = elt('div', 'cover-photo-slot' + (s.photo ? ' has-photo' : ''));
      if (s.photo) {
        const img = elt('img');
        img.src = s.photo;
        if (!interactive) img.draggable = false;
        applyCropToImg(img, getCrop(0, 'cover', 0));
        if (!img.complete) {
          img.style.opacity = '0';
          img.style.transition = 'opacity .4s ease';
          img.onload = () => { img.style.opacity = '1'; };
        }
        const coverWrap = elt('div', 'photo-crop-wrap');
        coverWrap.appendChild(img);
        photoSlot.appendChild(coverWrap);
        photoSlot.appendChild(elt('div', 'photo-hover-overlay'));
        if (interactive) {
          const coverBtns = elt('div', 'photo-hover-btns');
          const coverEdit = elt('button', 'photo-btn photo-edit-btn');
          coverEdit.title = 'Edit photo';
          coverEdit.dataset.s = 0; coverEdit.dataset.d = 'cover'; coverEdit.dataset.p = 0;
          coverEdit.innerHTML = '<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M1 5L1 1L5 1"/><path d="M13 9L13 13L9 13"/></svg>';
          coverBtns.appendChild(coverEdit);
          const coverRm = elt('button', 'photo-btn');
          coverRm.title = 'Remove photo';
          coverRm.innerHTML = '<svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M1 1L11 11M11 1L1 11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
          coverRm.addEventListener('click', e => {
            e.stopPropagation();
            spreads[0].photo = null; render(); scheduleSave();
          });
          coverBtns.appendChild(coverRm);
          photoSlot.appendChild(coverBtns);
        }
      } else {
        const icon = elt('div', 'add-icon'); icon.textContent = '＋';
        const lbl  = elt('div', 'add-label'); lbl.textContent = interactive ? 'Cover Photo' : '';
        photoSlot.appendChild(icon); photoSlot.appendChild(lbl);
        if (interactive) {
          const fileInp = elt('input');
          fileInp.type = 'file'; fileInp.accept = 'image/*,.heic,.heif';
          fileInp.style.cssText = 'position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%;z-index:1';
          fileInp.addEventListener('change', async e => {
            const file = e.target.files[0]; if (!file) return;
            photoSlot.classList.add('converting');
            try {
              spreads[0].photo = await readImageToDataURL(file);
              render(); scheduleSave();
            } catch(_) { photoSlot.classList.remove('converting'); }
          });
          photoSlot.appendChild(fileInp);
        }
      }
      div.appendChild(photoSlot);

      // 4. Subtitle
      if (interactive) {
        const subInp = elt('input', 'cover-sub');
        subInp.type = 'text'; subInp.value = s.sub;
        subInp.addEventListener('blur', () => { spreads[0].sub = subInp.value.trim() || 'Paris 2026'; scheduleSave(); });
        const subField = elt('div', 'cover-field');
        subField.appendChild(subInp);
        div.appendChild(subField);
      } else {
        const subField = elt('div', 'cover-field');
        const sub = elt('input', 'cover-sub');
        sub.type = 'text'; sub.value = s.sub;
        sub.readOnly = true; sub.style.pointerEvents = 'none';
        subField.appendChild(sub);
        div.appendChild(subField);
      }
    }
    return div;
  }

  const p = s[side];

  // Photo grid
  const grid = elt('div', `photo-grid ${p.layout}`);
  grid.style.cssText = 'flex:1;width:100%;';
  p.photos.forEach((photo, pi) => grid.appendChild(buildSlot(si, side, pi, photo, interactive)));
  div.appendChild(grid);

  // Caption
  const capWrap = elt('div', 'caption-wrap');
  const capInp  = elt('input');
  capInp.type        = 'text';
  capInp.placeholder = 'Caption…';
  capInp.value       = p.caption || '';
  if (interactive) {
    capInp.classList.add('cap');
    capInp.dataset.s = si;
    capInp.dataset.d = side;
  } else {
    capInp.readOnly            = true;
    capInp.style.pointerEvents = 'none';
  }
  capWrap.appendChild(capInp);
  div.appendChild(capWrap);

  // Page number
  const pgNum = elt('span', 'pg-num');
  pgNum.textContent = pageNum(si, side);
  div.appendChild(pgNum);

  // Layout picker (interactive spreads only)
  if (interactive) div.appendChild(buildLayoutBar(si, side, p.layout));

  return div;
}

function buildSlot(si, side, pi, photo, interactive) {
  const slot = elt('div', 'photo-slot' + (photo ? ' has-photo' : ''));
  slot.dataset.si   = si;
  slot.dataset.side = side;
  slot.dataset.pi   = pi;

  if (photo) {
    const img = elt('img'); img.src = photo;
    if (!interactive) img.draggable = false;
    applyCropToImg(img, getCrop(si, side, pi));
    const wrap = elt('div', 'photo-crop-wrap');
    wrap.appendChild(img);
    slot.appendChild(wrap);
    slot.appendChild(elt('div', 'photo-hover-overlay'));
    if (interactive) {
      const btns = elt('div', 'photo-hover-btns');
      // Edit button — opens crop modal
      const edit = elt('button', 'photo-btn photo-edit-btn');
      edit.title = 'Edit photo';
      edit.dataset.s = si; edit.dataset.d = side; edit.dataset.p = pi;
      edit.innerHTML = '<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M1 5L1 1L5 1"/><path d="M13 9L13 13L9 13"/></svg>';
      btns.appendChild(edit);
      // Remove button
      const rm = elt('button', 'photo-btn rm');
      rm.title = 'Remove photo';
      rm.innerHTML = '<svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M1 1L11 11M11 1L1 11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
      rm.dataset.s = si; rm.dataset.d = side; rm.dataset.p = pi;
      btns.appendChild(rm);
      slot.appendChild(btns);
      slot.draggable = true;
      slot.tabIndex = 0;
    }
  } else if (interactive) {
    const icon  = elt('div', 'add-icon');  icon.textContent  = '＋';
    const label = elt('div', 'add-label'); label.textContent = 'Add Photo';
    slot.appendChild(icon);
    slot.appendChild(label);
    const inp = elt('input');
    inp.type   = 'file';
    inp.accept = 'image/*,.heic,.heif';
    inp.dataset.s = si; inp.dataset.d = side; inp.dataset.p = pi;
    slot.appendChild(inp);
  }
  return slot;
}

function buildLayoutBar(si, side, activeLayout) {
  const bar = elt('div', 'layout-bar');
  (([s,r]) => [
    { key:'single', label:`${s}<rect x="1" y="1" width="10" height="10" rx="0.5"/>${r}` },
    { key:'two',    label:`${s}<rect x="1" y="1" width="10" height="4" rx="0.5"/><rect x="1" y="7" width="10" height="4" rx="0.5"/>${r}` },
    { key:'trio',   label:`${s}<rect x="1" y="1" width="10" height="4" rx="0.5"/><rect x="1" y="7" width="4" height="4" rx="0.5"/><rect x="7" y="7" width="4" height="4" rx="0.5"/>${r}` },
    { key:'quad',   label:`${s}<rect x="1" y="1" width="4" height="4" rx="0.5"/><rect x="7" y="1" width="4" height="4" rx="0.5"/><rect x="1" y="7" width="4" height="4" rx="0.5"/><rect x="7" y="7" width="4" height="4" rx="0.5"/>${r}` },
  ])([
    `<svg width="13" height="13" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">`,
    `</svg>`
  ])
  .forEach(({ key, label }) => {
    const btn = elt('button', 'layout-btn' + (activeLayout === key ? ' active' : ''));
    btn.innerHTML = label; btn.title = key;
    btn.onclick = e => { e.stopPropagation(); playClickSfx(); setLayout(si, side, key); };
    bar.appendChild(btn);
  });
  return bar;
}

function setLayout(si, side, layout) {
  const p = spreads[si][side];
  const existing = p.photos.filter(x => x);
  p.photos = Array.from({ length: LAYOUT_PHOTO_COUNT[layout] }, (_, i) => existing[i] || null);
  p.layout = layout;

  // Surgical update — replace only the photo grid so the layout bar stays in the
  // DOM and hover state is preserved (no full render() → no flicker).
  const pageEl = document.querySelector(`.${side}-page`);
  if (!pageEl) { render(); scheduleSave(); return; } // safety fallback during flip

  const oldGrid = pageEl.querySelector('.photo-grid');
  const newGrid = elt('div', `photo-grid ${layout}`);
  newGrid.style.cssText = 'flex:1;width:100%;';
  p.photos.forEach((photo, pi) => newGrid.appendChild(buildSlot(si, side, pi, photo, true)));
  pageEl.replaceChild(newGrid, oldGrid);

  // Sync active state on layout bar without rebuilding it
  pageEl.querySelectorAll('.layout-btn').forEach(btn =>
    btn.classList.toggle('active', btn.title === layout)
  );

  bindAll(newGrid); // bind only the new slots (file inputs, rm buttons, drag)
  scheduleSave();
}

// Copy children + classes + background from a built .page element into a .flipper-face element
function clonePageContent(pageEl, faceEl) {
  pageEl.childNodes.forEach(n => faceEl.appendChild(n.cloneNode(true)));
  faceEl.className += ' ' + pageEl.className;   // carry over cover-l / cover-r / etc.
  applyPageBg(pageEl, faceEl);
}

/* ══════════════════════════════════════════════════════════
   NAVIGATION & FLIP
   ══════════════════════════════════════════════════════════ */

function go(dir, onDone, nextOverride) {
  if (animating) return;
  const next = nextOverride !== undefined ? nextOverride : current + dir;
  if (next < 0 || next >= spreads.length) return;
  playFlipSfx();
  animating = true;

  const book    = document.getElementById('book');
  const forward = dir > 0;

  // Capture old spread before any DOM changes.
  const oldSpread = book.querySelector('.spread');

  // Build flipper faces from current spread — underlying spread is NOT changed yet.
  // front = the page being "lifted"; back = what's revealed as it lands.
  const fc = elt('div', `flipper-container ${forward ? 'flip-forward' : 'flip-backward'}`);

  const frontSide = forward ? 'right' : 'left';
  const front     = elt('div', `flipper-face face-front ${frontSide}-page`);
  clonePageContent(buildPage(current, frontSide, false), front);
  fc.appendChild(front);

  const backSide = forward ? 'left' : 'right';
  const back     = elt('div', `flipper-face face-back ${backSide}-page`);
  clonePageContent(buildPage(next, backSide, false), back);
  fc.appendChild(back);

  // Prebuild next spread at full opacity, inserted BEHIND oldSpread (before it in DOM).
  // oldSpread is on top and fully opaque, so newSpread is occluded but fully painted —
  // no opacity:0 deferral, so fonts and layout render immediately.
  const newSpread = buildSpread(next, !isReadMode);
  newSpread.classList.add('spread');
  book.insertBefore(newSpread, oldSpread);

  // Append flipper — CSS animation starts now. Underlying spreads stay as-is.
  book.appendChild(fc);

  // Shadow strip at the spine — animated with WAAPI so timing is always reliable.
  const shadow = elt('div', 'flip-mid-shadow');
  book.appendChild(shadow);
  shadow.animate([{opacity:0},{opacity:1},{opacity:0}], {duration:700, easing:'ease-in-out'});

  // At ~50% the flipper is edge-on (90°). Crossfade old→new spread over 100ms so
  // the non-flipping side dissolves in without a hard pop.
  const FADE_MS = 100;
  let switched  = false;
  const anim     = fc.getAnimations()[0];
  const duration = anim ? anim.effect.getTiming().duration : 350;
  function pollMidpoint() {
    if (switched) return;
    const t = anim ? (anim.currentTime ?? 0) : duration;
    if (t >= duration * 0.5) {
      switched = true;
      current  = next;
      scheduleSave();
      updateUI();
      // Fade oldSpread OUT over newSpread — newSpread was always opacity:1 so it's
      // fully painted (no font-lag). oldSpread acts as cover until it fades away.
      oldSpread.animate(
        [{ opacity: 1 }, { opacity: 0 }],
        { duration: FADE_MS, easing: 'ease-in-out', fill: 'forwards' }
      ).onfinish = () => {
        oldSpread.remove();
        bindAll();
      };
    } else {
      requestAnimationFrame(pollMidpoint);
    }
  }
  requestAnimationFrame(pollMidpoint);

  // finishFlip runs exactly once on the container's own animationend; bubbled
  // events from child elements are ignored via the e.target guard.
  function finishFlip(e) {
    if (e.target !== fc) return;
    fc.removeEventListener('animationend', finishFlip);
    fc.remove();
    shadow.remove();
    animating = false;
    if (onDone) onDone();
  }
  fc.addEventListener('animationend', finishFlip);
}

// Single flip directly to target spread index (used by tray click-to-navigate).
function goTo(target) {
  if (target === current) return;
  const forward = target > current;
  go(forward ? 1 : -1, null, target);
}

function addPages() {
  if (animating) return;
  spreads.splice(current + 1, 0, {
    type:  'spread',
    left:  { layout:'single', photos:[null],       caption:'' },
    right: { layout:'two',    photos:[null, null],  caption:'' },
  });
  go(1);
}

function deletePage() {
  if (animating) return;
  if (current === 0) return;         // cover is undeletable
  if (spreads.length <= 2) return;   // always keep at least one spread
  if (!confirm('Delete this spread?')) return;
  spreads.splice(current, 1);
  if (current >= spreads.length) current = spreads.length - 1;
  render();
  scheduleSave();
}

function positionControls() {
  const bookWrap = document.querySelector('.book-wrap');
  const controls = document.querySelector('.controls');
  const title    = document.querySelector('h1');
  if (!bookWrap) return;
  const r = bookWrap.getBoundingClientRect();
  const cx = (r.left + r.width / 2) + 'px';
  if (controls) {
    controls.style.left      = cx;
    controls.style.top       = (r.bottom + 24) + 'px';
    controls.style.transform = 'translateX(-50%)';
  }
  if (title) {
    title.style.left      = cx;
    title.style.top       = (r.top - 24 - title.offsetHeight) + 'px';
    title.style.transform = 'translateX(-50%)';
  }
}

function updateUI() {
  document.getElementById('prevBtn').disabled = current === 0;
  document.getElementById('nextBtn').disabled = current === spreads.length - 1;
  document.getElementById('delBtn').disabled  = current === 0 || spreads.length <= 2;
  document.getElementById('ind').textContent  = current === 0
    ? 'Cover'
    : `Pages ${spreadLabel(current)} / ${(spreads.length - 1) * 2}`;
  requestAnimationFrame(positionControls);
}

window.addEventListener('resize', positionControls);

/* ══════════════════════════════════════════════════════════
   PHOTO UPLOAD & IMAGE DECODING
   ══════════════════════════════════════════════════════════ */

// HEIC decode fallback chain:
//   1. createImageBitmap — native (Safari, Chrome w/ OS codec)
//   2. <img> tag         — some browsers support HEIC via OS codecs
//   3. VideoDecoder API  — manual HEVC bitstream extraction + GPU decode
async function readImageToDataURL(file) {
  const name   = file.name || '';
  const mime   = file.type || '';
  const isHEIC = /\.(heic|heif)$/i.test(name) || mime === 'image/heic' || mime === 'image/heif';
  if (!isHEIC) {
    try { return bitmapToDataURL(await createImageBitmap(file)); } catch(_) {}
    return imgTagDecode(file);
  }
  // HEIC: try each tier in order, throw only if all fail
  try { return bitmapToDataURL(await createImageBitmap(file)); } catch(_) {}
  try { return await imgTagDecode(file); }                       catch(_) {}
  if (typeof VideoDecoder !== 'undefined') {
    try { return await decodeHEICwithVideoDecoder(file); } catch(e) { console.warn('VideoDecoder:', e.message); }
  }
  throw new Error('HEIC_UNSUPPORTED');
}

function imgTagDecode(blob) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      res(c.toDataURL('image/jpeg', .88));
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('img fail')); };
    img.src = url;
  });
}

function bitmapToDataURL(bmp) {
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  c.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close();
  return c.toDataURL('image/jpeg', .88);
}

// Low-level ISOBMFF / HEVC bitstream helpers for decodeHEICwithVideoDecoder
function r32(d,p){return((d[p]<<24)|(d[p+1]<<16)|(d[p+2]<<8)|d[p+3])>>>0;}
function r16(d,p){return(d[p]<<8)|d[p+1];}
function r64(d,p){return r32(d,p)*4294967296+r32(d,p+4);}
function fcc(d,p){return String.fromCharCode(d[p],d[p+1],d[p+2],d[p+3]);}
function parseBoxes(d,s,e){const l=[];let p=s;while(p+8<=e){let sz=r32(d,p),hdr=8;const t=fcc(d,p+4);if(sz===1){sz=r64(d,p+8);hdr=16;}if(sz===0)sz=e-p;if(sz<hdr||p+sz>e)break;l.push({type:t,s:p,e:p+sz,d:p+hdr});p+=sz;}return l;}
function findBox(d,s,e,t){return parseBoxes(d,s,e).find(b=>b.type===t);}

async function decodeHEICwithVideoDecoder(file) {
  const data=new Uint8Array(await file.arrayBuffer()),N=data.length;
  const tops=parseBoxes(data,0,N),meta=tops.find(b=>b.type==='meta');
  if(!meta) throw new Error('No meta');
  const mc=meta.d+4,me=meta.e;
  const pitm=findBox(data,mc,me,'pitm'),pitmVer=pitm?data[pitm.d]:0;
  const primaryId=pitm?(pitmVer===0?r16(data,pitm.d+4):r32(data,pitm.d+4)):1;
  const iloc=findBox(data,mc,me,'iloc'); if(!iloc) throw new Error('No iloc');
  const ilocVer=data[iloc.d],fd=iloc.d+4;
  const offSz=(data[fd]>>4)&0xf,lenSz=data[fd]&0xf,baseSz=(data[fd+1]>>4)&0xf;
  const cntSz=ilocVer<2?2:4,itemCount=cntSz===2?r16(data,fd+2):r32(data,fd+2);
  let ip=fd+2+cntSz,chunkOffset=-1,chunkLength=-1;
  for(let i=0;i<itemCount;i++){
    const id=ilocVer<2?r16(data,ip):r32(data,ip); ip+=ilocVer<2?2:4;
    if(ilocVer===1||ilocVer===2)ip+=2; ip+=2;
    let base=0;
    if(baseSz===4){base=r32(data,ip);ip+=4;}else if(baseSz===8){base=r64(data,ip);ip+=8;}
    const extCnt=r16(data,ip);ip+=2;
    for(let e=0;e<extCnt;e++){
      let off=0,elen=0;
      if(offSz===4){off=r32(data,ip);ip+=4;}else if(offSz===8){off=r64(data,ip);ip+=8;}
      if(lenSz===4){elen=r32(data,ip);ip+=4;}else if(lenSz===8){elen=r64(data,ip);ip+=8;}
      if(id===primaryId){chunkOffset=base+off;chunkLength=elen;}
    }
  }
  if(chunkOffset<0) throw new Error('Primary item not found in iloc');
  const iprp=findBox(data,mc,me,'iprp');if(!iprp)throw new Error('No iprp');
  const ipco=findBox(data,iprp.d,iprp.e,'ipco');if(!ipco)throw new Error('No ipco');
  const hvcCBox=findBox(data,ipco.d,ipco.e,'hvcC');if(!hvcCBox)throw new Error('No hvcC');
  const hvcC=data.slice(hvcCBox.d,hvcCBox.e);
  const ps=(hvcC[1]>>6)&0x3,tier=(hvcC[1]>>5)&0x1,pidc=hvcC[1]&0x1f,lvl=hvcC[12];
  const codec=`hvc1.${['','A','B','C'][ps]}${pidc}.4.${tier?'H':'L'}${lvl}.B0`;
  const ispe=findBox(data,ipco.d,ipco.e,'ispe');
  const width=ispe?r32(data,ispe.d+4):1920,height=ispe?r32(data,ispe.d+8):1080;
  const raw=data.slice(chunkOffset,chunkOffset+chunkLength);
  const naluLenSize=(hvcC[21]&0x3)+1,SC=new Uint8Array([0,0,0,1]),parts=[];
  let hp=22,na=hvcC[hp++];
  for(let a=0;a<na;a++){hp++;const cnt=(hvcC[hp]<<8)|hvcC[hp+1];hp+=2;for(let n=0;n<cnt;n++){const nl=(hvcC[hp]<<8)|hvcC[hp+1];hp+=2;parts.push(SC,hvcC.slice(hp,hp+nl));hp+=nl;}}
  let ri=0;while(ri+naluLenSize<=raw.length){let nl=0;for(let b=0;b<naluLenSize;b++)nl=(nl<<8)|raw[ri+b];ri+=naluLenSize;if(nl<=0||ri+nl>raw.length)break;parts.push(SC,raw.slice(ri,ri+nl));ri+=nl;}
  const tot=parts.reduce((n,p)=>n+p.length,0),annexB=new Uint8Array(tot);let off=0;
  for(const part of parts){annexB.set(part,off);off+=part.length;}
  return new Promise((res,rej)=>{
    const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
    const ctx=canvas.getContext('2d');let done=false;
    const dec=new VideoDecoder({
      output:frame=>{if(!done){done=true;ctx.drawImage(frame,0,0);frame.close();dec.close();res(canvas.toDataURL('image/jpeg',.88));}else frame.close();},
      error:e=>{if(!done){done=true;rej(e);}}
    });
    dec.configure({codec,description:hvcC.buffer.slice(hvcC.byteOffset,hvcC.byteOffset+hvcC.byteLength),codedWidth:width,codedHeight:height});
    dec.decode(new EncodedVideoChunk({type:'key',timestamp:0,data:annexB}));
    dec.flush().catch(e=>{if(!done){done=true;rej(e);}});
  });
}

function showHeicHelp() {
  document.getElementById('heic-toast')?.remove();
  const t = document.createElement('div'); t.id = 'heic-toast';
  t.innerHTML=`<div id="heic-overlay" style="position:fixed;inset:0;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center;z-index:200;font-family:'Lato',sans-serif;"><div style="background:#2a1608;border:1px solid rgba(201,168,76,.4);border-radius:14px;padding:26px 28px;max-width:360px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,.6);color:#e8dcc8;line-height:1.6;"><div style="font-size:2rem;margin-bottom:8px;">📸</div><div style="font-family:'Playfair Display',serif;color:#c9a84c;font-size:1rem;margin-bottom:10px;">HEIC photo — quick fix</div><div style="background:rgba(255,255,255,.06);border-radius:8px;padding:11px;margin-bottom:7px;font-size:.77rem;">📱 iPhone: Settings → Camera → Formats → <b>Most Compatible</b></div><div style="background:rgba(255,255,255,.06);border-radius:8px;padding:11px;margin-bottom:7px;font-size:.77rem;">💻 Mac: Open in Preview → File → Export → JPEG</div><div style="background:rgba(255,255,255,.06);border-radius:8px;padding:11px;margin-bottom:16px;font-size:.77rem;">🌐 Online: <b>heictojpg.com</b></div><button onclick="document.getElementById('heic-toast').remove()" style="width:100%;padding:9px;border-radius:8px;background:rgba(201,168,76,.2);border:1px solid rgba(201,168,76,.5);color:#c9a84c;font-size:.78rem;letter-spacing:.1em;text-transform:uppercase;cursor:pointer;">Got it</button></div></div>`;
  document.body.appendChild(t);
  document.getElementById('heic-overlay').addEventListener('click', e => { if (e.target === e.currentTarget) t.remove(); });
}

/* ══════════════════════════════════════════════════════════
   DRAG & DROP
   ══════════════════════════════════════════════════════════ */

let dragSrc = null;    // { si, side, pi } — source photo slot for the current drag
let dragPreview = null; // off-screen element used as the custom drag ghost

function swapPhotos(src, dst) {
  const srcPage = spreads[src.si][src.side];
  const dstPage = spreads[dst.si][dst.side];
  const defaultCrop = { scale:1, ox:0, oy:0 };

  // Ensure crops arrays exist
  if (!srcPage.crops) srcPage.crops = [];
  if (!dstPage.crops) dstPage.crops = [];

  // Swap photos
  const tmpPhoto = srcPage.photos[src.pi];
  srcPage.photos[src.pi] = dstPage.photos[dst.pi];
  dstPage.photos[dst.pi] = tmpPhoto;

  // Swap crops alongside their photos
  const tmpCrop = srcPage.crops[src.pi] ?? { ...defaultCrop };
  srcPage.crops[src.pi] = dstPage.crops[dst.pi] ?? { ...defaultCrop };
  dstPage.crops[dst.pi] = tmpCrop;
}

function bindPhotoDrag(root = document) {
  root.querySelectorAll('.photo-slot[draggable]').forEach(slot => {
    slot.addEventListener('dragstart', e => {
      dragSrc = { si:+slot.dataset.si, side:slot.dataset.side, pi:+slot.dataset.pi };
      e.dataTransfer.effectAllowed = 'move';

      // Build a custom drag ghost that visibly follows the cursor
      const img = slot.querySelector('img');
      const preview = document.createElement('div');
      preview.style.cssText = [
        'position:fixed', 'top:-9999px', 'left:-9999px',
        'width:80px', 'height:80px', 'border-radius:8px', 'overflow:hidden',
        'box-shadow:0 12px 32px rgba(0,0,0,.6),0 3px 10px rgba(0,0,0,.35)',
        'pointer-events:none', 'background:#e5dece',
        'outline:1.5px solid rgba(201,168,76,.55)'
      ].join(';');
      if (img) {
        const ci = img.cloneNode();
        ci.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;';
        preview.appendChild(ci);
      }
      document.body.appendChild(preview);
      e.dataTransfer.setDragImage(preview, 40, 40);
      dragPreview = preview;

      // Defer so the browser captures the ghost before the transform applies
      requestAnimationFrame(() => slot.classList.add('dragging'));
    });
    slot.addEventListener('dragend', () => {
      slot.classList.remove('dragging');
      clearDragOver('drag-over');
      if (dragPreview) { dragPreview.remove(); dragPreview = null; }
    });
  });

  root.querySelectorAll('.photo-slot').forEach(slot => {
    slot.addEventListener('dragover', e => {
      if (!dragSrc) return;
      e.preventDefault(); e.dataTransfer.dropEffect = 'move';
      slot.classList.add('drag-over');
    });
    slot.addEventListener('dragleave', () => slot.classList.remove('drag-over'));
    slot.addEventListener('drop', e => {
      e.preventDefault();
      slot.classList.remove('drag-over');
      if (!dragSrc) return;
      const dst = { si:+slot.dataset.si, side:slot.dataset.side, pi:+slot.dataset.pi };
      if (dragSrc.si===dst.si && dragSrc.side===dst.side && dragSrc.pi===dst.pi) return;
      const src = { ...dragSrc };
      swapPhotos(dragSrc, dst);
      dragSrc = null;
      render();
      // Snap both affected slots into place
      [src, dst].forEach(({ si, side, pi }) => {
        const el = document.querySelector(`.photo-slot[data-si="${si}"][data-side="${side}"][data-pi="${pi}"]`);
        if (el) { el.classList.add('snap'); el.addEventListener('animationend', () => el.classList.remove('snap'), { once:true }); }
      });
    });
  });
}

/* ══════════════════════════════════════════════════════════
   PAGE TRAY
   ══════════════════════════════════════════════════════════ */

let trayDragIdx = null; // index of the spread being dragged within the tray

function openTray()  { renderTray(); document.getElementById('trayOverlay').classList.add('open'); }
function closeTray() { document.getElementById('trayOverlay').classList.remove('open'); }
function closeTrayIfBg(e) { if (e.target === document.getElementById('trayOverlay')) closeTray(); }

function renderTray() {
  const scroll = document.getElementById('trayScroll');
  scroll.innerHTML = '';
  spreads.forEach((s, i) => {
    const item = elt('div', 'tray-item' + (i === current ? ' current-tray' : ''));
    item.draggable   = i > 0 && !isReadMode; // cover is not draggable; disabled in read mode
    item.dataset.idx = i;

    // Thumbnail
    const thumb = elt('div', 'tray-thumb');
    const lh = elt('div'), rh = elt('div');
    if (s.type === 'cover') {
      lh.className = 'tray-half light-l'; rh.className = 'tray-half dark';
      if (s.photo) {
        appendThumbnailImage(rh, s.photo);
      } else {
        rh.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;font-size:.55rem;color:rgba(201,168,76,.7);font-family:'Playfair Display',serif;padding:2px;text-align:center">${s.title}</div>`;
      }
    } else {
      lh.className = 'tray-half light-l'; rh.className = 'tray-half light-r';
      const lp = s.left.photos.find(x => x), rp = s.right.photos.find(x => x);
      if (lp) appendThumbnailImage(lh, lp);
      if (rp) appendThumbnailImage(rh, rp);
    }
    thumb.appendChild(lh); thumb.appendChild(rh);
    item.appendChild(thumb);

    const label = elt('div', 'tray-label');
    label.textContent = spreadLabel(i);
    item.appendChild(label);

    item.addEventListener('click', () => { closeTray(); goTo(i); });

    // Drag-to-reorder within the tray
    item.addEventListener('dragstart', e => {
      if (isReadMode || i === 0) { e.preventDefault(); return; }
      trayDragIdx = i;
      item.classList.add('dragging-tray');
      e.dataTransfer.effectAllowed = 'move';
    });
    item.addEventListener('dragend', () => {
      item.classList.remove('dragging-tray');
      clearDragOver('drag-tray-over');
      trayDragIdx = null;
    });
    item.addEventListener('dragover', e => {
      if (isReadMode || trayDragIdx === null || i === 0 || i === trayDragIdx) return;
      e.preventDefault(); item.classList.add('drag-tray-over');
    });
    item.addEventListener('dragleave', () => item.classList.remove('drag-tray-over'));
    item.addEventListener('drop', e => {
      e.preventDefault(); item.classList.remove('drag-tray-over');
      if (isReadMode || trayDragIdx === null || i === 0 || i === trayDragIdx) return;
      const moved = spreads.splice(trayDragIdx, 1)[0];
      const newPos = i > trayDragIdx ? i : i; // NOTE: both branches return i (pre-existing)
      spreads.splice(newPos, 0, moved);
      // Adjust current to follow its spread to its new index after the reorder
      if      (current === trayDragIdx)                   current = newPos;
      else if (current > trayDragIdx && current <= newPos) current--;
      else if (current < trayDragIdx && current >= newPos) current++;
      trayDragIdx = null;
      render(); renderTray();
      scheduleSave();
    });

    scroll.appendChild(item);
  });
}

/* ══════════════════════════════════════════════════════════
   EVENT BINDING
   ══════════════════════════════════════════════════════════ */

function bindAll(root = document) {
  // File upload — async to handle image decode; 'converting' class shown while loading
  root.querySelectorAll('input[type=file]').forEach(inp => {
    inp.addEventListener('change', async e => {
      e.stopPropagation();
      const file = e.target.files[0]; if (!file) return;
      const si = +inp.dataset.s, side = inp.dataset.d, pi = +inp.dataset.p;
      const slot = inp.closest('.photo-slot');
      if (!slot) return; // cover photo slot has its own inline handler
      slot.classList.add('converting');
      try {
        const dataUrl = await readImageToDataURL(file);
        spreads[si][side].photos[pi] = dataUrl;
        render();
        scheduleSave();
      } catch(err) {
        slot.classList.remove('converting');
        if (err.message === 'HEIC_UNSUPPORTED') showHeicHelp();
        else alert('Could not load image. Please use JPEG, PNG, or WEBP.');
      }
    });
  });

  // Caption: update data model only — no re-render needed
  root.querySelectorAll('.cap').forEach(inp => {
    inp.addEventListener('input', () => { spreads[+inp.dataset.s][inp.dataset.d].caption = inp.value; scheduleSave(); });
  });

  // Remove photo button
  root.querySelectorAll('.rm').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      spreads[+btn.dataset.s][btn.dataset.d].photos[+btn.dataset.p] = null;
      render();
      scheduleSave();
    });
  });

  // Edit photo button — opens crop modal
  root.querySelectorAll('.photo-edit-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      openCropModal(+btn.dataset.s, btn.dataset.d, +btn.dataset.p);
    });
  });

  // Mobile: tap photo to toggle hover controls; tap outside to dismiss
  root.querySelectorAll('.photo-slot.has-photo, .cover-photo-slot.has-photo').forEach(slot => {
    slot.addEventListener('touchstart', e => {
      const already = slot.classList.contains('photo-active');
      document.querySelectorAll('.photo-active').forEach(s => s.classList.remove('photo-active'));
      if (!already) slot.classList.add('photo-active');
      e.stopPropagation(); // prevent doc-level listener from clearing the class we just set
    }, { passive: true });
  });

  bindPhotoDrag(root);
}

/* ══════════════════════════════════════════════════════════
   CROP MODAL
   ══════════════════════════════════════════════════════════ */

let _cropCtx   = null;          // { si, side, pi }
let _cropState = { scale:1, ox:0, oy:0 };
let _cropDrag  = null;          // { sx, sy, ox0, oy0 } — drag origin

function openCropModal(si, side, pi) {
  const photo = side === 'cover' ? spreads[si].photo : spreads[si][side].photos[pi];
  if (!photo) return;
  _cropCtx   = { si, side, pi };
  _cropState = { ...getCrop(si, side, pi) };

  // Size the viewport to match the slot's aspect ratio, capped at 480px wide
  const slot = side === 'cover'
    ? document.querySelector('.cover-photo-slot')
    : document.querySelector(`.photo-slot[data-si="${si}"][data-side="${side}"][data-pi="${pi}"]`);
  const r    = slot ? slot.getBoundingClientRect() : { width: 1, height: 1 };
  const ar   = r.width / r.height;
  const vpW  = Math.min(window.innerWidth * 0.78, 480);
  const vpH  = vpW / ar;
  const vp   = document.getElementById('cropViewport');
  vp.style.width  = vpW + 'px';
  vp.style.height = vpH + 'px';

  const img = document.getElementById('cropImg');
  img.src = photo;
  _cropUpdateImg();

  const slider = document.getElementById('cropZoom');
  slider.value = _cropState.scale;
  document.getElementById('cropZoomVal').textContent = _cropState.scale.toFixed(2) + '×';

  document.getElementById('cropOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeCropModal() {
  document.getElementById('cropOverlay').classList.remove('open');
  document.body.style.overflow = '';
  _cropDrag = null;
}

function applyCrop() {
  const { si, side, pi } = _cropCtx;
  setCrop(si, side, pi, { ..._cropState });
  render();
  closeCropModal();
}

function _cropUpdateImg() {
  const img = document.getElementById('cropImg');
  const { scale, ox, oy } = _cropState;
  img.style.transform = `translate(-50%,-50%) translate(${ox*100}%,${oy*100}%) scale(${scale})`;
}

// ── Drag to pan ──
const _cropVp = document.getElementById('cropViewport');

_cropVp.addEventListener('mousedown', e => {
  _cropDrag = { sx: e.clientX, sy: e.clientY, ox0: _cropState.ox, oy0: _cropState.oy };
  e.preventDefault();
});
document.addEventListener('mousemove', e => {
  if (!_cropDrag) return;
  const vp  = document.getElementById('cropViewport');
  const dox = (e.clientX - _cropDrag.sx) / vp.offsetWidth;
  const doy = (e.clientY - _cropDrag.sy) / vp.offsetHeight;
  _cropState = clampCrop(_cropState.scale, _cropDrag.ox0 + dox, _cropDrag.oy0 + doy);
  _cropUpdateImg();
});
document.addEventListener('mouseup', () => { _cropDrag = null; });

// ── Touch drag ──
_cropVp.addEventListener('touchstart', e => {
  const t = e.touches[0];
  _cropDrag = { sx: t.clientX, sy: t.clientY, ox0: _cropState.ox, oy0: _cropState.oy };
}, { passive: true });
_cropVp.addEventListener('touchmove', e => {
  if (!_cropDrag) return;
  const t  = e.touches[0];
  const vp = document.getElementById('cropViewport');
  const dox = (t.clientX - _cropDrag.sx) / vp.offsetWidth;
  const doy = (t.clientY - _cropDrag.sy) / vp.offsetHeight;
  _cropState = clampCrop(_cropState.scale, _cropDrag.ox0 + dox, _cropDrag.oy0 + doy);
  _cropUpdateImg();
  e.preventDefault();
}, { passive: false });
_cropVp.addEventListener('touchend', () => { _cropDrag = null; }, { passive: true });

// ── Zoom slider ──
document.getElementById('cropZoom').addEventListener('input', e => {
  const scale = +e.target.value;
  document.getElementById('cropZoomVal').textContent = scale.toFixed(2) + '×';
  _cropState = clampCrop(scale, _cropState.ox, _cropState.oy);
  _cropUpdateImg();
});

// Mobile: dismiss photo-active controls when tapping outside any photo slot
document.addEventListener('touchstart', () => {
  document.querySelectorAll('.photo-active').forEach(s => s.classList.remove('photo-active'));
}, { passive: true });

// Arrow-key navigation; skip when focus is inside an input
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeCropModal(); return; }
  if (e.target.tagName === 'INPUT') return;
  if (e.key === 'ArrowRight') go(1);
  if (e.key === 'ArrowLeft')  go(-1);
});

/* ══════════════════════════════════════════════════════════
   SUPABASE
   ══════════════════════════════════════════════════════════ */

const SUPABASE_URL      = 'https://gdrsguikhuclrdmdrvhc.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdkcnNndWlraHVjbHJkbWRydmhjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIyMjYzMjcsImV4cCI6MjA4NzgwMjMyN30.6vSPoNPK_yBamRuMW7pijF9LNfQqNjzKpE3KlgLH0XU';
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* ══════════════════════════════════════════════════════════
   SHARE
   ══════════════════════════════════════════════════════════ */

const SHARE_ID_KEY = 'photobook_shareId';
const OWNER_KEY_LS = 'photobook_ownerKey';

function getOrCreateShareId() {
  let id = localStorage.getItem(SHARE_ID_KEY);
  if (!id) { id = crypto.randomUUID(); localStorage.setItem(SHARE_ID_KEY, id); }
  return id;
}

function getOrCreateOwnerKey() {
  let k = localStorage.getItem(OWNER_KEY_LS);
  if (!k) { k = crypto.randomUUID(); localStorage.setItem(OWNER_KEY_LS, k); }
  return k;
}

// Deep-copies book data, uploads any data-URL photos to Storage,
// and replaces them with storage paths (resolved to signed URLs at read time).
async function prepareBookDataForUpload(bookId) {
  const d  = JSON.parse(JSON.stringify(getBookData()));
  const up = async (dataUrl, path) => {
    if (!dataUrl?.startsWith('data:')) return dataUrl ?? null;
    const blob = dataURLtoBlob(dataUrl);
    const ext  = (blob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
    const full = `${bookId}/${path}.${ext}`;
    const { error } = await sb.storage.from('book-assets')
      .upload(full, blob, { upsert: true, contentType: blob.type });
    if (error) throw error;
    return full; // store path, not URL
  };
  d.spreads[0].photo = await up(d.spreads[0].photo, 'cover');
  d.coverPhoto = d.spreads[0].photo;
  for (let i = 1; i < d.spreads.length; i++) {
    for (const side of ['left', 'right']) {
      const photos = d.spreads[i][side].photos;
      for (let j = 0; j < photos.length; j++)
        photos[j] = await up(photos[j], `s${i}_${side}_${j}`);
    }
  }
  return d;
}

// Walks stored book data, converts storage paths → signed URLs (1h expiry).
// Leaves data: and http(s): values untouched (backwards compat).
async function resolveSignedUrls(data) {
  const d = JSON.parse(JSON.stringify(data));
  const resolve = async (val) => {
    if (!val || val.startsWith('data:') || val.startsWith('http')) return val;
    const { data: signed, error } = await sb.storage.from('book-assets').createSignedUrl(val, 3600);
    if (error) { console.warn('[signedUrl]', error.message, val); return val; }
    return signed.signedUrl;
  };
  // Cover photo
  d.spreads[0].photo = await resolve(d.spreads[0].photo);
  d.coverPhoto = d.spreads[0].photo;
  // Spread photos — all slots per spread resolved in parallel
  await Promise.all(d.spreads.slice(1).map(async (spread) => {
    for (const side of ['left', 'right'])
      spread[side].photos = await Promise.all(spread[side].photos.map(resolve));
  }));
  return d;
}

let _shareDotsTimer = null;
function _startDots(input) {
  const base = 'Generating link';
  let n = 0;
  input.value = base + '…';
  _shareDotsTimer = setInterval(() => {
    n = (n + 1) % 4;
    input.value = base + '.'.repeat(n || 3).replace(/^$/, '…');
  }, 300);
}
function _stopDots() {
  if (_shareDotsTimer) { clearInterval(_shareDotsTimer); _shareDotsTimer = null; }
}

function setShareState(state, url) {
  const btn    = document.getElementById('shareCopyBtn');
  const input  = document.getElementById('shareUrlInput');
  const helper = document.getElementById('shareHelper');
  btn.classList.remove('copied');
  if (state === 'working') {
    _startDots(input);
    input.classList.remove('copyable');
    btn.disabled = true;
    helper.textContent = 'Anyone with this link can view your book.';
    helper.classList.remove('confirmed');
  } else if (state === 'ready') {
    _stopDots();
    input.value  = url;
    input.classList.add('copyable');
    btn.disabled = false;
  } else if (state === 'copied') {
    btn.classList.add('copied');
    btn.textContent = 'Copied';
    btn.disabled = false;
    helper.textContent = '✓ Link copied — share it with anyone you like.';
    helper.classList.add('confirmed');
  } else if (state === 'error') {
    _stopDots();
    input.value  = url;
    input.classList.remove('copyable');
    btn.disabled = false;
  }
}

async function openShareModal() {
  const btn = document.getElementById('shareCopyBtn');
  setShareState('working');
  document.getElementById('shareOverlay').classList.add('open');
  try {
    const ownerKey = getOrCreateOwnerKey();
    const bookId   = getOrCreateShareId();
    const data     = await prepareBookDataForUpload(bookId);
    const { data: id, error } = await sb.rpc('upsert_book',
      { p_id: bookId, p_owner_key: ownerKey, p_data: data });
    if (error) throw error;
    localStorage.setItem(SHARE_ID_KEY, id);
    const url = `${location.origin}${location.pathname}?share=${id}`;
    setShareState('ready', url);
  } catch(err) {
    setShareState('error', 'Upload failed — try again.');
    console.error('Share error:', err);
  }
}

function closeShareModal() {
  document.getElementById('shareOverlay').classList.remove('open');
}

function closeShareIfBg(e) {
  if (e.target === document.getElementById('shareOverlay')) closeShareModal();
}

function shareInputClick() {
  const input = document.getElementById('shareUrlInput');
  if (!input.classList.contains('copyable')) return;
  input.select();
  copyShareLink();
}

function copyShareLink() {
  const input = document.getElementById('shareUrlInput');
  const url   = input.value;
  navigator.clipboard.writeText(url).then(() => {
    setShareState('copied');
  }).catch(() => {
    input.focus();
    input.select();
    document.execCommand('copy');
    setShareState('copied'); // show feedback even via fallback path
  });
}

/* ══════════════════════════════════════════════════════════
   EXPORT / IMPORT
   ══════════════════════════════════════════════════════════ */

function exportBook() {
  const date = new Date().toISOString().slice(0,10).replace(/-/g,'');
  const json = JSON.stringify(getBookData(), null, 2);
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(new Blob([json], { type:'application/json' }));
  a.download = `photobook-${date}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function importBookPicker() {
  document.getElementById('importInput').value = '';
  document.getElementById('importInput').click();
}

function importBook(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const data = JSON.parse(ev.target.result);
      if (!data?.spreads) { alert('Invalid photobook file.'); return; }
      if (!confirm('Import will replace your current book. Continue?')) return;
      loadBookData(data);
      scheduleSave();
    } catch(_) { alert('Could not read file.'); }
  };
  reader.readAsText(file);
}

/* ── READ MODE STARTUP ── */
if (shareId) {
  (async () => {
    try {
      const { data: row, error } = await sb.from('books')
        .select('data').eq('id', shareId).single();
      if (!error && row?.data) {
        const resolved = await resolveSignedUrls(row.data);
        isReadMode = true;
        // Stay in closed-cover state; user must tap to open (same UX as edit mode).
        document.body.classList.add('mode-read');
        spreads = resolved.spreads ?? spreads;
        current = 0; // always start from cover in read mode
        render(); // bookMode is still 'closed' → render() calls renderClosedBook()
      } else {
        showShareNotFound();
      }
    } catch(_) { showShareNotFound(); }
  })();
} else {
  persistLoad(); // normal editor startup
}

function showShareNotFound() {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:300;background:rgba(10,5,2,.85);display:flex;align-items:center;justify-content:center;';
  overlay.innerHTML = `
    <div style="background:linear-gradient(160deg,#2a1a0e,#1a0e06);border:1px solid rgba(201,168,76,.25);
      border-radius:14px;padding:36px 32px;max-width:380px;text-align:center;
      box-shadow:0 24px 60px rgba(0,0,0,.6);display:flex;flex-direction:column;gap:14px;">
      <div style="font-size:2rem;">📖</div>
      <h2 style="font-family:'Playfair Display',serif;color:#f5f0e8;font-size:1.1rem;margin:0;">Book not available</h2>
      <p style="color:rgba(232,220,200,.5);font-size:.8rem;line-height:1.6;margin:0;">
        This shared book could not be found.<br>
        The link may be invalid or the book may have been removed.
      </p>
    </div>`;
  document.body.appendChild(overlay);
}
