/* Render: everything drawn during a match. PLACEHOLDER ART - the graphics work replaces this file.

   Contract with game.js:
     Render.drawWorld(ctx, M, view)  arena + both fighters + effects
     Render.drawHUD(ctx, M, view)    scores, rounds, timer, message banner
   Before each call game.js sets ctx's transform so 1 unit = 1 logical stage pixel on a
   Fight.ARENA_W x Fight.STAGE_H (960 x 540) stage; the floor line is at y = Fight.FLOOR_Y.
   view = { t: seconds since page load, dt: frame time, labels: [p1 label, p2 label] or null }.
   M is a Fight match (see fight.js): M.phase, M.phaseT, M.round, M.timer, M.message, M.winner,
   M.events (this frame's events: hit / block / clash / whiff / swing / jump / land / begin /
   time / roundOver / matchOver, with x, y (height above floor), by, points), and
   M.fighters[i]: x, y (height above floor), vx, vy, facing (1 right / -1 left), act, move,
   phase ('startup' | 'active' | 'recover' while attacking), t (seconds in act), crouch,
   walking (1 forward / -1 back / 0), blocking, score (half points), rounds, name, color. */
const Render = (() => {
  const GI = { white: '#f1f1ea', red: '#d63a32', blue: '#2f5fd0', black: '#222' };
  const BELT = { white: '#c0302a', red: '#111', blue: '#f4d03f', black: '#c0302a' };
  let sparks = [];

  function drawWorld(g, M, view) {
    const W = Fight.ARENA_W, H = Fight.STAGE_H, FY = Fight.FLOOR_Y;
    const sky = g.createLinearGradient(0, 0, 0, FY);
    sky.addColorStop(0, '#f6b26b'); sky.addColorStop(1, '#fbe3c0');
    g.fillStyle = sky; g.fillRect(0, 0, W, FY);
    g.fillStyle = '#b9895a'; g.fillRect(0, FY, W, H - FY);
    g.fillStyle = 'rgba(0,0,0,0.15)'; g.fillRect(0, FY, W, 4);
    for (const e of M.events || []) if (e.type === 'hit' || e.type === 'block' || e.type === 'clash')
      for (let i = 0; i < (e.type === 'hit' ? 14 : 7); i++) sparks.push({ x: e.x, y: FY - e.y, vx: (Math.random() - 0.5) * 400, vy: (Math.random() - 0.8) * 300, life: 0.3, col: e.type === 'hit' ? '#fff3a0' : '#cfe8ff' });
    M.fighters.forEach(f => drawFighter(g, f, view.t));
    sparks.forEach(s => { s.x += s.vx * view.dt; s.y += s.vy * view.dt; s.life -= view.dt; g.fillStyle = s.col; g.fillRect(s.x - 2, s.y - 2, 4, 4); });
    sparks = sparks.filter(s => s.life > 0);
  }

  // A simple posed stick figure. Joint angles per pose (radians, 0 = pointing forward).
  function drawFighter(g, f, t) {
    const FY = Fight.FLOOR_Y, x = f.x, base = FY - f.y, s = f.facing;
    g.fillStyle = 'rgba(0,0,0,0.2)'; g.beginPath(); g.ellipse(x, FY + 2, 30, 6, 0, 0, Math.PI * 2); g.fill();
    let hip = 78, lean = 0, armF = [1.2, 0.6], armB = [1.9, 1.0], legF = [1.75, 1.6], legB = [1.4, 1.6];
    const phase = f.phase, ext = phase === 'active' ? 1 : phase === 'startup' ? 0.4 : phase === 'recover' ? 0.6 : 0;
    if (f.crouch || f.act === 'crouch') { hip = 44; legF = [0.6, 2.4]; legB = [2.4, 0.7]; }
    if (f.act === 'walk') { const w = Math.sin(f.t * 12) * 0.3; legF = [1.57 - w, 1.57]; legB = [1.57 + w, 1.57]; }
    if (f.act === 'jump') { hip = 80; legF = [0.6, 2.2]; legB = [2.0, 0.8]; }
    if (f.blocking || f.act === 'block') { armF = [0.6, -1.0]; armB = [0.9, -0.8]; }
    if (f.act === 'attack') {
      const m = f.move;
      if (m === 'jab' || m === 'lunge') armF = [lerp(1.2, 0.05, ext), lerp(0.6, 0, ext)];
      if (m === 'lowpunch') armF = [lerp(1.2, 0.3, ext), 0];
      if (m === 'frontkick') legF = [lerp(1.6, 0.25, ext), lerp(1.6, 0.25, ext)];
      if (m === 'roundhouse') { legF = [lerp(1.6, -0.1, ext), lerp(1.6, -0.2, ext)]; lean = 0.25 * ext; }
      if (m === 'spinkick') { legF = [lerp(1.6, -0.2, ext), lerp(1.6, -0.25, ext)]; lean = 0.35 * ext; }
      if (m === 'sweep') { hip = 30; legF = [lerp(1.2, 0.1, ext), 0.1]; legB = [2.6, 1.0]; }
      if (m === 'flykick') { hip = 80; legF = [0.15, 0.15]; legB = [2.0, 1.0]; lean = 0.3; }
    }
    if (f.act === 'hit') { lean = -0.4; armF = [2.4, 2.0]; }
    if (f.act === 'down') { drawDown(g, f); return; }
    if (f.act === 'win') { armF = [-1.4, -1.4]; armB = [-1.6, -1.6]; }
    const col = GI[f.color] || GI.white, belt = BELT[f.color] || '#c0302a';
    const hx = x, hy = base - hip;
    const torso = 60, nx = hx + Math.sin(lean) * torso * s, ny = hy - Math.cos(lean) * torso;
    const P = (ox, oy, a, len) => [ox + Math.cos(a) * len * s, oy + Math.sin(a) * len];
    const limb = (ox, oy, a1, a2, l1, l2, w, c) => { const [kx, ky] = P(ox, oy, a1, l1), [fx, fy] = P(kx, ky, a2, l2); g.strokeStyle = c; g.lineWidth = w; g.lineCap = 'round'; g.beginPath(); g.moveTo(ox, oy); g.lineTo(kx, ky); g.lineTo(fx, fy); g.stroke(); };
    limb(hx, hy, legB[0], legB[1], 42, 42, 13, shade(col));
    limb(nx, ny + 6, armB[0], armB[1], 30, 30, 10, shade(col));
    g.strokeStyle = col; g.lineWidth = 22; g.beginPath(); g.moveTo(hx, hy); g.lineTo(nx, ny + 8); g.stroke();
    g.strokeStyle = belt; g.lineWidth = 6; g.beginPath(); g.moveTo(hx - 12, hy - 4); g.lineTo(hx + 12, hy - 4); g.stroke();
    limb(hx, hy, legF[0], legF[1], 42, 42, 14, col);
    g.fillStyle = '#e8b98a'; g.beginPath(); g.arc(nx + 2 * s, ny - 12, 13, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#222'; g.fillRect(nx - 12, ny - 26, 24, 6);
    limb(nx, ny + 6, armF[0], armF[1], 30, 30, 11, col);
  }
  function drawDown(g, f) {
    const FY = Fight.FLOOR_Y, col = GI[f.color] || GI.white, x = f.x - f.facing * 20;
    g.strokeStyle = col; g.lineWidth = 20; g.lineCap = 'round';
    g.beginPath(); g.moveTo(x - 50 * f.facing, FY - 12); g.lineTo(x + 40 * f.facing, FY - 12); g.stroke();
    g.fillStyle = '#e8b98a'; g.beginPath(); g.arc(x - 66 * f.facing, FY - 14, 13, 0, Math.PI * 2); g.fill();
  }
  function shade(c) { return c === GI.white ? '#d2d2c8' : c === GI.red ? '#a82a24' : '#1f469e'; }

  function drawHUD(g, M, view) {
    const W = Fight.ARENA_W;
    g.textBaseline = 'middle';
    M.fighters.forEach((f, i) => {
      const left = i === 0, x = left ? 30 : W - 30;
      g.textAlign = left ? 'left' : 'right';
      g.font = '800 22px -apple-system,Helvetica,Arial,sans-serif'; g.fillStyle = '#222';
      g.fillText((view.labels && view.labels[i]) || f.name, x, 32);
      // points: two circles, half-filled for a half point
      for (let k = 0; k < 2; k++) {
        const cx = left ? x + 14 + k * 34 : x - 14 - k * 34, cy = 66, v = clamp(f.score - k * 2, 0, 2);
        g.strokeStyle = '#222'; g.lineWidth = 3; g.beginPath(); g.arc(cx, cy, 13, 0, Math.PI * 2); g.stroke();
        if (v) { g.fillStyle = '#c0302a'; g.beginPath(); if (v === 2) g.arc(cx, cy, 11, 0, Math.PI * 2); else { g.arc(cx, cy, 11, Math.PI / 2, Math.PI * 1.5); } g.fill(); }
      }
      for (let k = 0; k < Fight.ROUNDS_TO_WIN; k++) {
        const cx = left ? x + 6 + k * 18 : x - 6 - k * 18;
        g.fillStyle = k < f.rounds ? '#f4d03f' : 'rgba(0,0,0,0.2)'; g.fillRect(cx - 6, 88, 12, 12);
      }
    });
    g.textAlign = 'center'; g.fillStyle = '#222'; g.font = '900 40px -apple-system,Helvetica,Arial,sans-serif';
    g.fillText(Math.ceil(M.timer), W / 2, 40);
    g.font = '700 14px -apple-system,Helvetica,Arial,sans-serif'; g.fillText('ROUND ' + M.round, W / 2, 72);
    if (M.message) {
      g.font = '900 46px -apple-system,Helvetica,Arial,sans-serif';
      g.lineWidth = 8; g.strokeStyle = 'rgba(0,0,0,0.55)'; g.strokeText(M.message, W / 2, 200);
      g.fillStyle = '#fff'; g.fillText(M.message, W / 2, 200);
    }
  }

  return { drawWorld, drawHUD, drawFighter };
})();
