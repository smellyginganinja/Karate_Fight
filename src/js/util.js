/* Shared helpers, storage and keyboard input. Loaded first. */

// ---------- canvas ----------
const cvs = document.getElementById('c'), ctx = cvs.getContext('2d');
let VW = 0, VH = 0, DPR = 1;
function resize() {
  DPR = window.devicePixelRatio || 1; VW = innerWidth; VH = innerHeight;
  cvs.width = Math.round(VW * DPR); cvs.height = Math.round(VH * DPR);
  cvs.style.width = VW + 'px'; cvs.style.height = VH + 'px';
}
addEventListener('resize', resize); resize();

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;
function rr(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }

const store = {
  get(k, d) { try { const v = localStorage.getItem('karatefight.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('karatefight.' + k, JSON.stringify(v)); } catch (e) {} }
};

// ---------- keyboard ----------
// keys: held state. pressed: edge flags for menus (cleared each frame).
// presses: running count of keydowns per key, so a tap shorter than one game step is never lost
// (the fight sim and online play compare counts rather than held state for punch, kick and jump).
const keys = {}, pressed = {}, presses = {};
addEventListener('keydown', e => {
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Tab', 'Slash', 'Period', 'Comma', 'Quote'].includes(e.code)) e.preventDefault();
  if (!keys[e.code]) { pressed[e.code] = true; presses[e.code] = (presses[e.code] || 0) + 1; }
  keys[e.code] = true;
});
addEventListener('keyup', e => { keys[e.code] = false; });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; });
const tap = code => { if (pressed[code]) { pressed[code] = false; return true; } return false; };
