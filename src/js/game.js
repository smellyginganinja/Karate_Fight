/* =====================================================================
   KARATE FIGHT - an original two-fighter karate game
   Modes: 1 player vs CPU, 2 players on one computer, and online versus.
   Game rules live in fight.js, drawing in render.js, online transport in net.js.
   ===================================================================== */

const STEP = 1 / 120;
const W = Fight.ARENA_W, H = Fight.STAGE_H;
const settings = Object.assign({ name: '', level: 1 }, store.get('settings', {}));
const saveSettings = () => store.set('settings', settings);
const LEVELS = ['Easy', 'Normal', 'Hard'];

let state = 'menu';          // menu | help | online | lobby | play | paused
let mode = 'cpu';            // cpu | duo | online
let match = null, cpu = null, labels = null, net = null;
let menuSel = 0, menuNote = null;
const demo = { m: null, a: null, b: null };
const note = t => { menuNote = { text: t, until: performance.now() + 5000 }; };

// ---------- controls ----------
const BIND = {
  solo: { l: ['ArrowLeft', 'KeyA'], r: ['ArrowRight', 'KeyD'], u: ['ArrowUp', 'KeyW'], d: ['ArrowDown', 'KeyS'], p: ['KeyF', 'KeyZ', 'Period'], k: ['KeyG', 'KeyX', 'Slash'] },
  p1: { l: ['KeyA'], r: ['KeyD'], u: ['KeyW'], d: ['KeyS'], p: ['KeyF'], k: ['KeyG'] },
  p2: { l: ['ArrowLeft'], r: ['ArrowRight'], u: ['ArrowUp'], d: ['ArrowDown'], p: ['Period'], k: ['Slash'] }
};
function readInput(bind, pad) {
  const held = list => list.some(c => keys[c]), count = list => list.reduce((s, c) => s + (presses[c] || 0), 0);
  const gp = pad >= 0 ? GamepadInput.pads[pad] : null;
  return {
    l: held(bind.l) || !!(gp && gp.l), r: held(bind.r) || !!(gp && gp.r),
    u: held(bind.u) || !!(gp && gp.u), d: held(bind.d) || !!(gp && gp.d),
    pc: count(bind.p) + (gp ? gp.pc : 0), kc: count(bind.k) + (gp ? gp.kc : 0), jc: count(bind.u) + (gp ? gp.jc : 0)
  };
}
// in 2-player mode: two pads -> one each; one pad -> player 2 (player 1 has the keyboard)
function duoPads() { const a = GamepadInput.pads[0].active, b = GamepadInput.pads[1].active; return a && b ? [0, 1] : a ? [-1, 0] : [-1, -1]; }
function localInputs() {
  if (mode === 'duo') { const p = duoPads(); return [readInput(BIND.p1, p[0]), readInput(BIND.p2, p[1])]; }
  return [readInput(BIND.solo, 0), null];
}

// ---------- starting matches ----------
function startMatch(m, names) {
  mode = m;
  labels = null;
  if (m === 'cpu') { cpu = makeCpu([0.25, 0.6, 0.95][settings.level]); names = [settings.name || 'You', 'CPU']; }
  else cpu = null;
  if (m === 'duo') names = ['Player 1', 'Player 2'];
  match = Fight.create({ p1: { name: names[0].toUpperCase(), color: 'white' }, p2: { name: names[1].toUpperCase(), color: 'red' } });
  if (m === 'online') labels = net.roster.map(r => r.name.toUpperCase() + (r.id === net.me ? ' (YOU)' : ''));
  state = 'play'; acc = 0;
  Sound.play('menuSelect');
}
function goMenu() { leaveOnline(true); match = null; state = 'menu'; }

// ---------- online play ----------
// Host-authoritative, as in Drift Rivals: the host runs the fight and sends snapshots 30 times a
// second; the joiner sends its controls (with press counts, so no tap is lost) and draws what the host sends.
function onlineHost(name) {
  leaveOnline(true);
  const code = Net.newCode(), t = Net.connect(code, 'host');
  net = { role: 'host', t, code, me: t.id, roster: [{ id: t.id, name }], input: null, seen: {}, sendAcc: 0, evq: [] };
  t.onMessage(hostOnMessage);
  state = 'lobby'; Sound.play('menuSelect');
}
function onlineJoin(name, code) {
  leaveOnline(true);
  const t = Net.connect(code, 'join');
  net = { role: 'client', t, code: Net.cleanCode(code), me: t.id, hostId: null, roster: [], name, status: 'Looking for room ' + Net.cleanCode(code) + '…',
    helloAt: 0, startedAt: performance.now(), lastIn: 0, lastSent: '', lastSnap: 0 };
  t.onMessage(clientOnMessage);
  state = 'lobby'; Sound.play('menuSelect');
}
function leaveOnline(silent) {
  if (!net) return;
  try { net.t.broadcast(net.role === 'host' ? { t: 'closed' } : { t: 'bye' }); net.t.close(); } catch (e) {}
  net = null;
  if (!silent) { match = null; state = 'menu'; }
}
addEventListener('beforeunload', () => leaveOnline(true));

function voiceAvailable() { return !!(net && net.t.voiceStart); }
function toggleVoice() {
  if (!voiceAvailable()) { note('Voice chat works in online rooms over the internet'); return; }
  if (net.voice) { net.voice = false; net.t.voiceStop(); setMyVoice(false); return; }
  net.voiceAsk = true;
  net.t.voiceStart().then(() => { if (!net) return; net.voice = true; net.voiceAsk = false; setMyVoice(true); Sound.play('menuSelect'); })
    .catch(() => { if (net) net.voiceAsk = false; note('Microphone not available. Check your browser or Mac privacy settings.'); });
}
function setMyVoice(on) {
  const me = net.roster.find(r => r.id === net.me); if (me) me.voice = on;
  if (net.role === 'host') broadcastRoster(); else if (net.hostId) net.t.send(net.hostId, { t: 'voice', on });
  syncVoice();
}
function syncVoice() { if (net && net.voice && net.t.voiceSync) net.t.voiceSync(net.roster.filter(r => r.voice && r.id !== net.me).map(r => r.id)); }

function broadcastRoster() { if (net && net.role === 'host') net.t.broadcast({ t: 'roster', roster: net.roster }); }
function dropOpponent(id) {
  const i = net.roster.findIndex(r => r.id === id); if (i <= 0) return;
  const gone = net.roster.splice(i, 1)[0];
  delete net.seen[id]; net.input = null;
  note(gone.name + ' left');
  if (state === 'play' || state === 'paused') { match = null; state = 'lobby'; }
  broadcastRoster();
}
function hostOnMessage(from, m) {
  if (!m || !net) return;
  net.seen[from] = performance.now();
  if (m.t === 'neterr') { leaveOnline(); note(m.msg); return; }
  if (m.t === 'voice') { const r = net.roster.find(r => r.id === from); if (r) { r.voice = !!m.on; broadcastRoster(); syncVoice(); } return; }
  if (m.t === 'hello') {
    const known = net.roster.find(r => r.id === from);
    if (known) Object.assign(known, { name: String(m.name || 'Player').slice(0, 12), voice: !!m.voice });
    else if (net.roster.length >= 2) { net.t.send(from, { t: 'full' }); return; }
    else if (state !== 'lobby') { net.t.send(from, { t: 'busy' }); return; }
    else { net.roster.push({ id: from, name: String(m.name || 'Player').slice(0, 12), voice: !!m.voice }); Sound.play('menuMove'); }
    broadcastRoster();
  } else if (m.t === 'input' && m.c && net.roster[1] && net.roster[1].id === from) {
    const c = m.c;
    net.input = { l: !!c.l, r: !!c.r, u: !!c.u, d: !!c.d, pc: c.pc | 0, kc: c.kc | 0, jc: c.jc | 0 };
  } else if (m.t === 'bye') dropOpponent(from);
}
function hostStart() {
  if (!net || net.role !== 'host' || net.roster.length < 2) return;
  net.input = null;
  net.t.broadcast({ t: 'start', roster: net.roster });
  startMatch('online', net.roster.map(r => r.name));
}
function hostSend(dt, evs) {
  if (state !== 'play' && state !== 'paused') return;
  net.evq.push(...evs);
  net.sendAcc += dt;
  if (net.sendAcc < 1 / 30) return;
  net.sendAcc = 0;
  const s = Fight.snapshot(match);
  s.t = 'snap'; s.ev = net.evq.filter(e => e.type !== 'whiff').map(e => [e.type, Math.round(e.x || 0), Math.round(e.y || 0), e.by, e.points || 0]);
  net.t.broadcast(s);
  net.evq = [];
}
function clientOnMessage(from, m) {
  if (!m || !net) return;
  if (m.t === 'neterr') { leaveOnline(); note(m.msg); return; }
  if (net.hostId && from !== net.hostId) return;
  net.lastIn = performance.now();
  if (m.t === 'roster') {
    if (!m.roster.some(r => r.id === net.me)) return;
    net.hostId = from; net.roster = m.roster; net.status = 'In the room. Waiting for the host to start…';
    syncVoice();
  } else if (m.t === 'full' || m.t === 'busy') {
    leaveOnline(); note(m.t === 'full' ? 'That room already has two fighters' : 'That room is mid-fight; try again in a moment');
  } else if (m.t === 'start') {
    net.roster = m.roster; startMatch('online', m.roster.map(r => r.name));
  } else if (m.t === 'snap') {
    if (!match) return;
    Fight.applySnapshot(match, m);
    net.lastSnap = performance.now();
    const evs = (m.ev || []).map(a => ({ type: a[0], x: a[1], y: a[2], by: a[3], points: a[4] }));
    net.pendingEv = (net.pendingEv || []).concat(evs);
    Sound.events(evs);
  } else if (m.t === 'lobby') { match = null; state = 'lobby'; }
  else if (m.t === 'closed') { leaveOnline(); note('The host closed the room'); }
}
function hostToLobby() { if (!net || net.role !== 'host') return; match = null; state = 'lobby'; net.t.broadcast({ t: 'lobby' }); broadcastRoster(); }
function netPoll() {
  if (!net) return;
  const now = performance.now();
  if (net.voice && now - (net.voiceAt || 0) > 2000) { net.voiceAt = now; syncVoice(); }
  if (net.role === 'client') {
    if (!net.hostId) {
      if (now - net.helloAt > 1000) { net.helloAt = now; net.t.broadcast({ t: 'hello', name: net.name, voice: !!net.voice }); }
      if (now - net.startedAt > (net.t.kind === 'peer' ? 20000 : 8000)) { const code = net.code; leaveOnline(); note('No room found with code ' + code); }
      return;
    }
    const k = readInput(BIND.solo, 0), sig = JSON.stringify(k);
    if (sig !== net.lastSent || now - (net.lastOut || 0) > 500) { net.lastSent = sig; net.lastOut = now; net.t.send(net.hostId, { t: 'input', c: k }); }
    if (now - net.lastIn > 8000) { leaveOnline(); note('Lost the connection to the host'); }
  } else {
    if (net.roster[1] && now - (net.seen[net.roster[1].id] || now) > 6000) dropOpponent(net.roster[1].id);
  }
}

// lobby + join form (HTML so typing works on every keyboard)
const onlineForm = (() => {
  const d = document.createElement('div');
  d.style.cssText = 'position:fixed;inset:0;display:none;align-items:center;justify-content:center;z-index:5;pointer-events:none';
  d.innerHTML = '<div style="pointer-events:auto;background:rgba(18,12,10,0.94);border-radius:16px;padding:26px 30px;width:min(420px,90vw);color:#fff;font:15px -apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;box-shadow:0 10px 40px rgba(0,0,0,.5)">'
    + '<div style="font-weight:800;font-size:24px;margin-bottom:14px">Online versus</div>'
    + '<label style="display:block;color:#d9c3a8;font-size:13px;margin-bottom:4px">Your name</label>'
    + '<input id="kf-name" maxlength="12" style="width:100%;box-sizing:border-box;font:inherit;padding:10px 12px;border-radius:10px;border:1px solid #543;background:#231a15;color:#fff;margin-bottom:16px">'
    + '<button id="kf-host" style="width:100%;font:inherit;font-weight:700;padding:12px;border:0;border-radius:10px;background:#c0302a;color:#fff;cursor:pointer">Host a new room</button>'
    + '<div style="text-align:center;color:#8a7766;margin:14px 0;font-size:13px">or join a friend</div>'
    + '<div style="display:flex;gap:8px"><input id="kf-code" maxlength="6" placeholder="ROOM CODE" style="flex:1;min-width:0;font:inherit;letter-spacing:3px;text-transform:uppercase;padding:10px 12px;border-radius:10px;border:1px solid #543;background:#231a15;color:#fff">'
    + '<button id="kf-join" style="font:inherit;font-weight:700;padding:10px 18px;border:0;border-radius:10px;background:rgba(255,255,255,.14);color:#fff;cursor:pointer">Join</button></div>'
    + '<button id="kf-back" style="margin-top:16px;width:100%;font:inherit;padding:10px;border:0;border-radius:10px;background:transparent;color:#d9c3a8;cursor:pointer">Back (Esc)</button></div>';
  document.body.appendChild(d);
  const $ = id => d.querySelector('#' + id);
  const name = () => { const v = $('kf-name').value.trim() || 'Player'; settings.name = v; saveSettings(); return v; };
  $('kf-host').onclick = () => onlineHost(name());
  $('kf-join').onclick = () => { const c = Net.cleanCode($('kf-code').value); if (c.length >= 4) onlineJoin(name(), c); else $('kf-code').focus(); };
  $('kf-code').addEventListener('keydown', e => { if (e.key === 'Enter') $('kf-join').onclick(); });
  $('kf-back').onclick = () => goMenu();
  d.addEventListener('keydown', e => { if (e.key === 'Escape') goMenu(); });
  d.open = () => { $('kf-name').value = settings.name || ''; setTimeout(() => ($('kf-name').value ? $('kf-code') : $('kf-name')).focus(), 30); };
  return d;
})();

// ---------- UI helpers (stage coordinates) ----------
let uiButtons = [], stageS = 1, stageX = 0, stageY = 0;
function text(str, x, y, size, col, align, weight) {
  ctx.font = (weight || '700') + ' ' + size + 'px -apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif';
  ctx.fillStyle = col; ctx.textAlign = align || 'left'; ctx.textBaseline = 'middle'; ctx.fillText(str, x, y);
}
function panel(x, y, w, h) { ctx.fillStyle = 'rgba(18,12,10,0.78)'; rr(ctx, x, y, w, h, 12); ctx.fill(); }
function button(label, x, y, w, h, action, primary) {
  uiButtons.push({ x, y, w, h, action });
  ctx.fillStyle = primary ? '#c0302a' : 'rgba(255,255,255,0.14)'; rr(ctx, x, y, w, h, 10); ctx.fill();
  text(label, x + w / 2, y + h / 2 + 1, 16, '#fff', 'center', '700');
}
cvs.addEventListener('pointerdown', e => {
  const x = (e.clientX - stageX) / stageS, y = (e.clientY - stageY) / stageS;
  for (const b of uiButtons) if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) { b.action(); break; }
});

const MENU = [
  { label: () => '1 PLAYER vs CPU', go: () => startMatch('cpu') },
  { label: () => '2 PLAYERS (same computer)', go: () => startMatch('duo') },
  { label: () => 'ONLINE VERSUS', go: () => { state = 'online'; onlineForm.open(); Sound.play('menuSelect'); } },
  { label: () => 'CPU LEVEL:  ◀ ' + LEVELS[settings.level] + ' ▶', go: () => shiftLevel(1), side: d => shiftLevel(d) },
  { label: () => 'HOW TO PLAY', go: () => { state = 'help'; Sound.play('menuSelect'); } }
];
function shiftLevel(d) { settings.level = (settings.level + d + 3) % 3; saveSettings(); Sound.play('menuMove'); }

function drawMenu(t) {
  text('KARATE FIGHT', W / 2, 92, 72, '#fff', 'center', '900');
  text('Two fighters. One point at a time.', W / 2, 140, 18, '#ffe7c4', 'center', '600');
  MENU.forEach((it, i) => {
    const y = 190 + i * 54, sel = i === menuSel;
    uiButtons.push({ x: W / 2 - 200, y, w: 400, h: 44, action: () => { menuSel = i; it.go(); } });
    ctx.fillStyle = sel ? '#c0302a' : 'rgba(18,12,10,0.7)'; rr(ctx, W / 2 - 200, y, 400, 44, 10); ctx.fill();
    text(it.label(), W / 2, y + 23, 19, '#fff', 'center', '800');
  });
  if (menuNote && performance.now() < menuNote.until) text(menuNote.text, W / 2, 482, 16, '#ffd84a', 'center', '700');
  text('Arrows + Enter to choose  ·  M mute  ·  N music  ·  F11 / ⌃⌘F fullscreen', W / 2, 515, 13, 'rgba(255,255,255,0.7)', 'center', '500');
}
function drawHelp() {
  panel(70, 40, W - 140, H - 80);
  text('HOW TO PLAY', W / 2, 78, 32, '#fff', 'center', '900');
  const rows = [
    ['Score', 'Clean hit = half or full point. First to 2 full points wins the round; best of 3 rounds.'],
    ['Block', 'Hold away from your opponent. Crouch-block (down + away) stops sweeps.'],
    ['Punch', 'Jab · forward+punch: lunge · down+punch: low punch  (half points)'],
    ['Kick', 'Front kick (half) · forward+kick: roundhouse · away+kick: spin kick · down+kick: sweep (full)'],
    ['Jump', 'Up to jump (with a direction to leap), then kick or punch for a flying kick (full point).'],
    ['1 player', 'Arrows or WASD to move · Z / F / . punch · X / G / / kick'],
    ['2 players', 'P1: W A S D, F punch, G kick  ·  P2: arrows, . punch, / kick'],
    ['Pads', 'Stick/d-pad move · X/Square punch · B/Circle or Y/Triangle kick · A/Cross jump'],
    ['Online', 'Host a room and share the 4-letter code, or join with a code. V = voice chat.']
  ];
  rows.forEach((r, i) => { text(r[0], 110, 130 + i * 38, 16, '#ffd84a', 'left', '800'); text(r[1], 220, 130 + i * 38, 15, '#fff', 'left', '500'); });
  button('Back (Esc)', W / 2 - 90, H - 92, 180, 40, () => { state = 'menu'; }, true);
}
function drawLobby() {
  panel(180, 40, W - 360, H - 80);
  const cx = W / 2, host = net && net.role === 'host';
  text('ONLINE VERSUS', cx, 78, 32, '#fff', 'center', '900');
  if (!net) return;
  text('Room code', cx, 118, 14, '#d9c3a8', 'center', '600');
  text(net.code, cx, 154, 52, '#ffd84a', 'center', '900');
  for (let k = 0; k < 2; k++) {
    const r = net.roster[k], y = 214 + k * 44;
    ctx.fillStyle = k ? '#d63a32' : '#f1f1ea'; ctx.beginPath(); ctx.arc(cx - 160, y, 10, 0, Math.PI * 2); ctx.fill();
    text(r ? r.name + (r.id === net.me ? '  (you)' : '') + (k === 0 ? '  ★ host' : '') + (r.voice ? '  🎤' : '') : '— waiting for a fighter —', cx - 138, y, 18, r ? '#fff' : '#8a7766', 'left', '700');
  }
  if (host) {
    if (net.roster.length >= 2) button('START FIGHT (Enter)', cx - 120, 310, 240, 48, hostStart, true);
    else text('Share the code with a friend so they can join.', cx, 334, 15, '#d9c3a8', 'center', '600');
  } else text(net.status, cx, 334, 15, '#d9c3a8', 'center', '600');
  if (voiceAvailable()) button(net.voiceAsk ? 'Allow the mic…' : net.voice ? '🎤 Voice on (V)' : 'Voice chat off (V)', cx - 200, 390, 190, 42, toggleVoice, net.voice);
  button('Leave (Esc)', cx + (voiceAvailable() ? 10 : -95), 390, 190, 42, () => leaveOnline());
  if (Net.transportName === 'local') text('Preview mode: open the game in another window on this computer and join with the code.', cx, 460, 12, '#8a7766', 'center', '500');
  if (menuNote && performance.now() < menuNote.until) text(menuNote.text, cx, 480, 15, '#ffd84a', 'center', '700');
}
function overActive() { return match && match.phase === 'matchOver' && match.phaseT > 1.4; }
function drawOver() {
  const cx = W / 2;
  if (mode === 'online' && net && net.role === 'client') { text('Waiting for the host…  (Esc to leave)', cx, 300, 18, '#fff', 'center', '700'); return; }
  button('Rematch (Enter)', cx - 200, 290, 190, 46, rematch, true);
  button(mode === 'online' ? 'Lobby (Esc)' : 'Menu (Esc)', cx + 10, 290, 190, 46, () => mode === 'online' ? hostToLobby() : goMenu());
}
function rematch() { if (mode === 'online') hostStart(); else startMatch(mode); }
function drawPause() {
  ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(0, 0, W, H);
  text('PAUSED', W / 2, 200, 48, '#fff', 'center', '900');
  button('Resume (P)', W / 2 - 200, 260, 190, 46, () => { state = 'play'; }, true);
  button('Quit (Esc)', W / 2 + 10, 260, 190, 46, goMenu);
}

function handleKeys() {
  if (tap('KeyM')) Sound.toggleMute();
  if (tap('KeyN')) Sound.toggleMusic();
  if (state === 'menu') {
    if (tap('ArrowUp') || tap('KeyW')) { menuSel = (menuSel + MENU.length - 1) % MENU.length; Sound.play('menuMove'); }
    if (tap('ArrowDown') || tap('KeyS')) { menuSel = (menuSel + 1) % MENU.length; Sound.play('menuMove'); }
    if (MENU[menuSel].side) { if (tap('ArrowLeft')) MENU[menuSel].side(-1); if (tap('ArrowRight')) MENU[menuSel].side(1); }
    if (tap('Enter') || tap('Space')) MENU[menuSel].go();
  } else if (state === 'help') { if (tap('Escape') || tap('Enter')) state = 'menu'; }
  else if (state === 'online') { if (tap('Escape')) goMenu(); }
  else if (state === 'lobby') {
    if (tap('Escape')) leaveOnline();
    if (tap('KeyV')) toggleVoice();
    if (tap('Enter')) hostStart();
  } else if (state === 'paused') {
    if (tap('KeyP') || tap('Enter')) state = 'play';
    if (tap('Escape')) goMenu();
  } else if (state === 'play') {
    if (mode === 'online') {
      if (tap('KeyV')) toggleVoice();
      if (tap('Escape')) {
        if (overActive() && net && net.role === 'host') hostToLobby();
        else if (net && performance.now() - (net.leaveArm || 0) < 2500) leaveOnline();
        else if (net) { net.leaveArm = performance.now(); note('Press Esc again to leave'); }
      }
      if (overActive() && tap('Enter')) rematch();
    } else if (overActive()) { if (tap('Enter')) rematch(); if (tap('Escape')) goMenu(); }
    else if (tap('KeyP') || tap('Escape')) state = 'paused';
  }
}

// ---------- main loop ----------
let last = performance.now(), acc = 0;
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  GamepadInput.poll();
  handleKeys();
  netPoll();
  let evs = [];
  if (state === 'play' && match) {
    if (net && net.role === 'client') { match.events = net.pendingEv || []; net.pendingEv = []; Fight.coast(match, dt); }
    else {
      acc += dt;
      while (acc >= STEP) {
        const inp = localInputs();
        if (mode === 'cpu') inp[1] = cpu(match, 1, STEP);
        if (mode === 'online') inp[1] = net && net.input;
        evs = evs.concat(Fight.step(match, inp, STEP));
        acc -= STEP;
      }
      match.events = evs;
      Sound.events(evs);
    }
  }
  if (net && net.role === 'host') hostSend(dt, evs);

  // menu backdrop: two CPUs sparring
  const inMenus = state !== 'play' && state !== 'paused';
  Sound.music(inMenus ? 'menu' : 'fight');
  if (inMenus) {
    if (!demo.m || demo.m.phase === 'matchOver') { demo.m = Fight.create({ p1: { name: 'WHITE' }, p2: { name: 'RED', color: 'red' } }); demo.a = makeCpu(0.5); demo.b = makeCpu(0.5); }
    let e = []; for (let k = 0; k < Math.round(dt / STEP); k++) e = e.concat(Fight.step(demo.m, [demo.a(demo.m, 0, STEP), demo.b(demo.m, 1, STEP)], STEP));
    demo.m.events = e;
  }

  onlineForm.style.display = state === 'online' ? 'flex' : 'none';
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.fillStyle = '#120c0a'; ctx.fillRect(0, 0, VW, VH);
  stageS = Math.min(VW / W, VH / H); stageX = (VW - W * stageS) / 2; stageY = (VH - H * stageS) / 2;
  ctx.setTransform(DPR * stageS, 0, 0, DPR * stageS, DPR * stageX, DPR * stageY);
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.clip();
  uiButtons = [];
  const view = { t: now / 1000, dt, labels };
  if (inMenus) {
    Render.drawWorld(ctx, demo.m, view);
    ctx.fillStyle = 'rgba(10,6,4,0.45)'; ctx.fillRect(0, 0, W, H);
    if (state === 'menu') drawMenu(now / 1000); else if (state === 'help') drawHelp(); else if (state === 'lobby') drawLobby();
    else text('KARATE FIGHT', W / 2, 70, 56, '#fff', 'center', '900');
  } else if (match) {
    Render.drawWorld(ctx, match, view);
    Render.drawHUD(ctx, match, view);
    if (mode === 'online' && net && net.voice) text('🎤', W / 2, 100, 16, '#222', 'center');
    if (overActive()) drawOver();
    if (state === 'paused') drawPause();
    if (menuNote && performance.now() < menuNote.until) text(menuNote.text, W / 2, H - 30, 16, '#fff', 'center', '700');
  }
  ctx.restore();
  for (const k in pressed) pressed[k] = false;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// hooks for automated testing (harmless in normal play)
window.__game = { get net() { return net; }, get match() { return match; }, get state() { return state; }, get mode() { return mode; },
  onlineHost, onlineJoin, hostStart, leaveOnline, startMatch, goMenu, rematch, hostToLobby };
