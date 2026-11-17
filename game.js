'use strict';

/* ---------- Levels ----------
 * Difficulty ramps smoothly from level 1 to 50:
 *   board width   8 -> 30 columns
 *   board height  8 -> 20 rows
 *   mine density 10% -> 23%   (classic Expert is ~20.6%)
 * Mine count is forced to rise every level, so each one is strictly harder.
 */
const LEVEL_COUNT = 50;
const LEVELS = (() => {
  const out = [];
  let prev = 0;
  for (let i = 0; i < LEVEL_COUNT; i++) {
    const t = i / (LEVEL_COUNT - 1);
    const cols = Math.round(8 + t * 22);
    const rows = Math.round(8 + t * 12);
    const density = 0.10 + t * 0.13;
    const mines = Math.max(prev + 1, Math.round(cols * rows * density));
    out.push({ n: i + 1, cols, rows, mines });
    prev = mines;
  }
  return out;
})();
const TIERS = ['Beginner', 'Easy', 'Medium', 'Hard', 'Expert'];
const tierOf = n => Math.min(5, Math.ceil(n / 10));

/* ---------- Progress (saved in the browser) ---------- */
const STORAGE_KEY = 'minesweeper50.progress.v1';
function loadProgress() {
  try {
    const p = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (p && typeof p.unlocked === 'number') {
      return { unlocked: Math.min(LEVEL_COUNT, Math.max(1, p.unlocked)), best: p.best || {} };
    }
  } catch (e) { /* storage unavailable */ }
  return { unlocked: 1, best: {} };
}
function saveProgress() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(progress)); } catch (e) { /* ignore */ }
}
let progress = loadProgress();
const clearedCount = () => Object.keys(progress.best).length;

/* ---------- Helpers ---------- */
const $ = s => document.querySelector(s);
function fmt(sec) {
  if (sec < 60) return sec.toFixed(1) + 's';
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
function show(screen) {
  $('#levelScreen').classList.toggle('hidden', screen !== 'levels');
  $('#gameScreen').classList.toggle('hidden', screen !== 'game');
}

/* ---------- Level select ---------- */
function renderLevels() {
  const grid = $('#levelGrid');
  grid.innerHTML = '';
  const firstUncleared = nextUnplayed();
  LEVELS.forEach(L => {
    const tier = tierOf(L.n);
    if ((L.n - 1) % 10 === 0) {
      const h = document.createElement('div');
      h.className = 'tier-heading';
      h.dataset.tier = tier;
      h.textContent = `${TIERS[tier - 1]} · Levels ${L.n}–${L.n + 9}`;
      grid.appendChild(h);
    }
    const done = progress.best[L.n] != null;
    const b = document.createElement('button');
    b.className = 'lvl' + (done ? ' done' : '') + (L.n === firstUncleared ? ' current' : '');
    b.dataset.tier = tier;
    b.innerHTML = `<span class="num">${L.n}</span>
      <span class="meta">${L.cols}×${L.rows} · ${L.mines} mines</span>
      <span class="best">${done ? '★ ' + fmt(progress.best[L.n]) : 'Play →'}</span>`;
    b.addEventListener('click', () => startLevel(L.n));
    grid.appendChild(b);
  });
  const c = clearedCount();
  $('#progressText').textContent = `${c} / ${LEVEL_COUNT} cleared`;
  $('#progressFill').style.width = (c / LEVEL_COUNT * 100) + '%';
  const next = nextUnplayed();
  $('#continueBtn').textContent = next ? `Play level ${next} →` : 'All levels cleared! Replay level 50';
}
function nextUnplayed() {
  for (let n = 1; n <= LEVEL_COUNT; n++) if (progress.best[n] == null) return n;
  return null;
}

/* ---------- Game state ---------- */
let G = null;
let flagMode = false;

function startLevel(n) {
  hideOverlay();
  stopTimer();
  const L = LEVELS[n - 1];
  const total = L.rows * L.cols;
  // On a portrait phone screen, turn wide boards sideways so they fit better.
  // Same cell and mine count, so the difficulty doesn't change.
  const portrait = window.innerHeight > window.innerWidth;
  const turn = portrait && L.cols > L.rows;
  G = {
    L, total,
    cols: turn ? L.rows : L.cols,
    rows: turn ? L.cols : L.rows,
    cells: Array.from({ length: total }, () => ({ mine: false, adj: 0, open: false, flag: false, el: null })),
    started: false, over: false, opened: 0, flags: 0,
    startTime: 0, elapsed: 0, timerId: null,
  };
  const board = $('#board');
  board.innerHTML = '';
  board.style.gridTemplateColumns = `repeat(${G.cols}, var(--cell))`;
  const frag = document.createDocumentFragment();
  G.cells.forEach((c, i) => {
    const el = document.createElement('div');
    el.className = 'cell';
    el.dataset.i = i;
    c.el = el;
    frag.appendChild(el);
  });
  board.appendChild(frag);

  // Every level has one fixed layout (same mines and same starting point every time).
  // On a turned board, the same layout is shown rotated 90°.
  const layout = levelLayout(L);
  const toIdx = ([r, c]) => turn ? c * G.cols + (L.rows - 1 - r) : r * G.cols + c;
  for (const m of layout.mines) G.cells[toIdx(m)].mine = true;
  G.cells.forEach((cell, i) => {
    cell.adj = neighbours(i).reduce((s, j) => s + (G.cells[j].mine ? 1 : 0), 0);
  });
  G.start = toIdx(layout.start);
  paint(G.start);

  $('#levelTitle').textContent = `Level ${n}`;
  $('#levelMeta').textContent = `${TIERS[tierOf(n) - 1]} · ${L.cols}×${L.rows} · ${L.mines} mines`;
  $('#prevBtn').disabled = n <= 1;
  $('#nextBtn').disabled = n >= LEVEL_COUNT;
  $('#faceBtn').textContent = '🙂';
  updateBest();
  updateHud();
  show('game');
  fitBoard();
}

function neighbours(i) {
  const { cols, rows } = G;
  const r = Math.floor(i / cols), c = i % cols;
  const out = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const rr = r + dr, cc = c + dc;
      if (rr >= 0 && rr < rows && cc >= 0 && cc < cols) out.push(rr * cols + cc);
    }
  }
  return out;
}

// Seeded random numbers: the same seed always gives the same sequence.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The fixed layout for a level, as [row, col] pairs on the level's normal (wide) board.
// The starting point and its 8 neighbours never hold a mine, so it always opens an area.
// Changing LAYOUT_SALT would give every level a new layout.
const LAYOUT_SALT = 0x4D696E65;
function levelLayout(L) {
  const rng = mulberry32(Math.imul(L.n, 0x9E3779B1) ^ LAYOUT_SALT);
  const R = L.rows, C = L.cols;
  const sr = Math.floor(R * (0.25 + rng() * 0.5));
  const sc = Math.floor(C * (0.25 + rng() * 0.5));
  const pool = [];
  for (let r = 0; r < R; r++) {
    for (let c = 0; c < C; c++) {
      if (Math.abs(r - sr) > 1 || Math.abs(c - sc) > 1) pool.push([r, c]);
    }
  }
  for (let k = 0; k < L.mines; k++) {
    const j = k + Math.floor(rng() * (pool.length - k));
    [pool[k], pool[j]] = [pool[j], pool[k]];
  }
  return { start: [sr, sc], mines: pool.slice(0, L.mines) };
}

function reveal(i) {
  if (G.over) return;
  const cell = G.cells[i];
  if (cell.open || cell.flag) return;
  if (!G.started) {
    G.started = true;
    startTimer();
    paint(G.start); // clear the starting-point marker
  }
  if (cell.mine) { lose(i); return; }
  const stack = [i];
  while (stack.length) {
    const j = stack.pop();
    const c = G.cells[j];
    if (c.open || c.flag || c.mine) continue;
    c.open = true;
    G.opened++;
    paint(j);
    if (c.adj === 0) for (const k of neighbours(j)) if (!G.cells[k].open) stack.push(k);
  }
  if (G.opened === G.total - G.L.mines) win();
}

// Clicking an opened number whose flags are all placed reveals the rest of its neighbours.
function chord(i) {
  if (G.over) return;
  const cell = G.cells[i];
  if (!cell.open || cell.adj === 0) return;
  const nb = neighbours(i);
  const flagged = nb.filter(j => G.cells[j].flag).length;
  if (flagged !== cell.adj) return;
  for (const j of nb) {
    if (G.over) return;
    reveal(j);
  }
}

function toggleFlag(i) {
  if (G.over) return;
  const c = G.cells[i];
  if (c.open) return;
  c.flag = !c.flag;
  G.flags += c.flag ? 1 : -1;
  paint(i);
  updateHud();
}

function paint(i) {
  const c = G.cells[i];
  let cls = 'cell', txt = '';
  if (c.open) {
    cls += ' open';
    if (c.adj) { cls += ` has-n n${c.adj}`; txt = c.adj; }
  } else if (c.flag) {
    cls += ' flag'; txt = '🚩';
  } else if (!G.started && i === G.start) {
    cls += ' start';
  }
  c.el.className = cls;
  c.el.textContent = txt;
}

/* ---------- Timer & HUD ---------- */
function startTimer() {
  G.startTime = performance.now();
  G.timerId = setInterval(() => {
    G.elapsed = (performance.now() - G.startTime) / 1000;
    $('#timer').textContent = G.elapsed < 1000 ? G.elapsed.toFixed(1) : Math.floor(G.elapsed);
  }, 100);
}
function stopTimer() {
  if (G && G.timerId) {
    clearInterval(G.timerId);
    G.timerId = null;
    G.elapsed = (performance.now() - G.startTime) / 1000;
  }
}
function updateHud() {
  $('#mineCount').textContent = G.L.mines - G.flags;
  if (!G.started) $('#timer').textContent = '0.0';
}
function updateBest() {
  const b = progress.best[G.L.n];
  $('#bestText').textContent = b != null ? `★ Best: ${fmt(b)}` : 'Not cleared yet';
}

/* ---------- End of game ---------- */
function lose(i) {
  G.over = true;
  stopTimer();
  $('#faceBtn').textContent = '😵';
  G.cells.forEach((c, j) => {
    if (c.mine && !c.flag) { c.el.className = 'cell mine'; c.el.textContent = '💣'; }
    else if (!c.mine && c.flag) { c.el.className = 'cell wrong'; c.el.textContent = '✖'; }
  });
  G.cells[i].el.className = 'cell boom';
  const pct = Math.floor(G.opened / (G.total - G.L.mines) * 100);
  const game = G;
  setTimeout(() => {
    if (G !== game || $('#gameScreen').classList.contains('hidden')) return; // restarted or left meanwhile
    showOverlay('💥', 'Boom!', `You cleared ${pct}% of level ${G.L.n}.`, [
      ['Try again', 'primary', () => startLevel(G.L.n)],
      ['Levels', '', goToLevels],
    ]);
  }, 700);
}

function win() {
  G.over = true;
  stopTimer();
  $('#faceBtn').textContent = '😎';
  G.cells.forEach((c, j) => { if (c.mine && !c.flag) { c.flag = true; paint(j); } });
  G.flags = G.L.mines;
  updateHud();

  const n = G.L.n;
  const time = Math.round(G.elapsed * 10) / 10;
  const prevBest = progress.best[n];
  const newBest = prevBest == null || time < prevBest;
  if (newBest) progress.best[n] = time;
  saveProgress();
  updateBest();

  let text = `Time: ${fmt(time)}`;
  if (prevBest != null) text += newBest ? ` — new best! (was ${fmt(prevBest)})` : ` · Best: ${fmt(prevBest)}`;
  const buttons = [];
  if (n < LEVEL_COUNT) buttons.push([`Level ${n + 1} →`, 'primary', () => startLevel(n + 1)]);
  buttons.push(['Replay', n < LEVEL_COUNT ? '' : 'primary', () => startLevel(n)]);
  buttons.push(['Levels', '', goToLevels]);
  const title = n === LEVEL_COUNT ? 'You beat all 50 levels!' : `Level ${n} cleared!`;
  const game = G;
  setTimeout(() => {
    if (G !== game || $('#gameScreen').classList.contains('hidden')) return;
    showOverlay(n === LEVEL_COUNT ? '🏆' : '🎉', title, text, buttons);
  }, 350);
}

function showOverlay(emoji, title, text, buttons) {
  $('#resultEmoji').textContent = emoji;
  $('#resultTitle').textContent = title;
  $('#resultText').innerText = text;
  const box = $('#resultButtons');
  box.innerHTML = '';
  for (const [label, kind, fn] of buttons) {
    const b = document.createElement('button');
    b.className = 'btn ' + kind;
    b.textContent = label;
    b.addEventListener('click', () => { hideOverlay(); fn(); });
    box.appendChild(b);
  }
  $('#overlay').classList.remove('hidden');
  box.firstChild && box.firstChild.focus();
}
function hideOverlay() { $('#overlay').classList.add('hidden'); }

function goToLevels() {
  hideOverlay();
  stopTimer();
  if (G) G.over = true;
  renderLevels();
  show('levels');
}

/* ---------- Board sizing ---------- */
function fitBoard() {
  if (!G) return;
  const { cols, rows } = G;
  const touch = window.matchMedia('(pointer: coarse)').matches;
  const gap = 2, pad = touch ? 10 : 18;
  const availW = $('#boardWrap').clientWidth || window.innerWidth - 32;
  const availH = window.innerHeight - 250;
  const byW = Math.floor((availW - pad - gap * (cols - 1)) / cols);
  const byH = Math.floor((availH - pad - gap * (rows - 1)) / rows);
  // Shrink to fit the screen, but keep squares big enough to hit
  // (fingers need bigger squares); past that the board scrolls instead.
  const min = touch ? 28 : 22, max = touch ? 44 : 36;
  const size = Math.max(min, Math.min(max, byW, Math.max(byH, 26)));
  $('#board').style.setProperty('--cell', size + 'px');
}
window.addEventListener('resize', fitBoard);

/* ---------- Input ---------- */
const board = $('#board');
let press = null;

board.addEventListener('contextmenu', e => e.preventDefault());

board.addEventListener('pointerdown', e => {
  const t = e.target.closest('.cell');
  if (!t || !G || G.over) return;
  const i = +t.dataset.i;
  if (e.pointerType === 'mouse') {
    if (e.button === 2) toggleFlag(i);
    else if (e.button === 1) { e.preventDefault(); chord(i); }
    else if (e.button === 0) press = { i, long: false };
    return;
  }
  // Touch / pen: long-press flags, tap reveals.
  press = { i, long: false };
  press.timer = setTimeout(() => {
    if (!press) return;
    press.long = true;
    if (G.cells[i].open) chord(i); else toggleFlag(i);
    if (navigator.vibrate) navigator.vibrate(25);
  }, 380);
});

board.addEventListener('pointerup', e => {
  if (!press) return;
  const p = press;
  press = null;
  clearTimeout(p.timer);
  if (p.long || !G || G.over) return;
  const under = document.elementFromPoint(e.clientX, e.clientY);
  const t = under && under.closest('.cell');
  if (!t || +t.dataset.i !== p.i) return; // dragged off the cell
  primaryAction(p.i);
});

board.addEventListener('pointercancel', () => {
  if (press) clearTimeout(press.timer);
  press = null;
});

function primaryAction(i) {
  const c = G.cells[i];
  if (c.open) chord(i);
  else if (flagMode) toggleFlag(i);
  else reveal(i);
}

function setFlagMode(on) {
  flagMode = on;
  const b = $('#flagModeBtn');
  b.textContent = `🚩 Flag mode: ${on ? 'on' : 'off'}`;
  b.classList.toggle('on', on);
}

$('#flagModeBtn').addEventListener('click', () => setFlagMode(!flagMode));
$('#faceBtn').addEventListener('click', () => startLevel(G.L.n));
$('#backBtn').addEventListener('click', goToLevels);
$('#prevBtn').addEventListener('click', () => G.L.n > 1 && startLevel(G.L.n - 1));
$('#nextBtn').addEventListener('click', () => {
  const n = G.L.n + 1;
  if (n <= LEVEL_COUNT) startLevel(n);
});
$('#continueBtn').addEventListener('click', () => startLevel(nextUnplayed() || LEVEL_COUNT));
$('#resetBtn').addEventListener('click', () => {
  if (confirm('Reset all progress and best times? This cannot be undone.')) {
    progress = { unlocked: 1, best: {} };
    saveProgress();
    renderLevels();
  }
});

document.addEventListener('keydown', e => {
  if ($('#gameScreen').classList.contains('hidden')) return;
  if (e.key === 'Escape') {
    if (!$('#overlay').classList.contains('hidden')) hideOverlay();
    else goToLevels();
  } else if (e.key === 'r' || e.key === 'R') startLevel(G.L.n);
  else if (e.key === 'f' || e.key === 'F') setFlagMode(!flagMode);
});

/* ---------- Boot ---------- */
renderLevels();
show('levels');

// Offline support: once loaded, the game works with no internet connection.
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
// Ask the browser to keep saved progress even if the phone runs low on space.
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
