/* Render: everything drawn during a match. Stages, fighters, hit effects and the fight HUD.
   Reads the match only; it never changes the simulation, so online play stays in sync.

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
   walking (1 forward / -1 back / 0), blocking, score (half points), rounds, name, color.
   M.stage (any whole number, shared online) picks the first stage of a match; each round moves to the next place.

   Extras: Render.drawFighter(ctx, f, opts) draws one fighter (feet at opts.x, opts.y);
   Render.backdrop(ctx, w, h, stage) draws a stage without fighters; Render.STAGES lists them.
   Art preview without the game: tools/render-preview.html. */
const Render = (function () {
  'use strict';
  const TAU = Math.PI * 2, D = Math.PI / 180;
  let clock = performance.now() / 1000;
  const now = () => clock;
  const cl = (v, a, b) => v < a ? a : v > b ? b : v;
  const mix = (a, b, t) => a + (b - a) * t;
  const ease = t => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  const easeOut = t => 1 - (1 - t) * (1 - t);
  const FT = () => (typeof Fight !== 'undefined' ? Fight : {});

  // ---------- colour helpers ----------
  function hexRgb(c) {
    if (!c || c[0] !== '#') return [220, 220, 220];
    if (c.length === 4) c = '#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3];
    const n = parseInt(c.slice(1, 7), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255];
  }
  const rgb = (a, al) => al == null ? 'rgb(' + (a[0] | 0) + ',' + (a[1] | 0) + ',' + (a[2] | 0) + ')' : 'rgba(' + (a[0] | 0) + ',' + (a[1] | 0) + ',' + (a[2] | 0) + ',' + al + ')';
  const shade = (c, k) => { const a = hexRgb(c); return rgb(k < 0 ? a.map(v => v * (1 + k)) : a.map(v => v + (255 - v) * k)); };
  function rrect(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
  function rand(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

  // ---------- poses ----------
  // Angles in degrees, in the fighter's own frame (positive = towards the opponent).
  // lean: torso tilt from upright. Arms: sh = upper arm from straight down, el = elbow bend added on top.
  // Legs: th = thigh from straight down, kn = knee bend (negative folds the shin back).
  // rot spins the whole body (flips, falls). The renderer grounds the lowest point on the floor.
  const P = {
    guard:  { lean: 6, head: 2, fa: [62, 78], ba: [28, 112], fl: [24, -22], bl: [-24, -12] },
    guard2: { lean: 8, head: 4, fa: [58, 84], ba: [24, 116], fl: [27, -27], bl: [-21, -16] },
    walkA:  { lean: 6, head: 2, fa: [62, 78], ba: [28, 112], fl: [34, -12], bl: [-14, -34] },
    walkB:  { lean: 6, head: 2, fa: [62, 78], ba: [28, 112], fl: [8, -34], bl: [-34, -8] },
    crouch: { lean: 18, head: -8, fa: [70, 70], ba: [36, 104], fl: [78, -118], bl: [-6, -112] },
    block:  { lean: -6, head: -6, fa: [128, 64], ba: [104, 92], fl: [20, -24], bl: [-30, -16] },
    blockLow: { lean: 14, head: -6, fa: [40, 30], ba: [70, 70], fl: [74, -114], bl: [-6, -108] },
    punchWind: { lean: -2, head: 0, fa: [40, 100], ba: [20, 120], fl: [26, -24], bl: [-28, -10] },
    punch:  { lean: 14, head: 6, fa: [92, 0], ba: [18, 124], fl: [32, -14], bl: [-34, -4] },
    punchHigh: { lean: 10, head: 10, fa: [118, 0], ba: [20, 124], fl: [30, -14], bl: [-34, -4] },
    revPunch: { lean: 16, head: 6, fa: [30, 116], ba: [94, 0], fl: [34, -16], bl: [-36, -2] },
    lowPunch: { lean: 26, head: 8, fa: [70, 2], ba: [30, 110], fl: [82, -120], bl: [-8, -110] },
    chamber: { lean: -8, head: 0, fa: [56, 80], ba: [34, 104], fl: [92, -110], bl: [-6, -8] },
    frontKick: { lean: -16, head: 6, fa: [48, 70], ba: [40, 100], fl: [94, -2], bl: [-8, -6] },
    highKick: { lean: -34, head: 12, fa: [40, 60], ba: [60, 70], fl: [140, -2], bl: [-6, -4] },
    sideChamber: { lean: -24, head: 4, fa: [60, 80], ba: [40, 90], fl: [100, -130], bl: [-4, -8] },
    sideKick: { lean: -46, head: 22, fa: [30, 60], ba: [80, 40], fl: [112, 0], bl: [-2, -4] },
    roundWind: { lean: -18, head: 4, fa: [70, 60], ba: [90, 40], fl: [118, -120], bl: [-4, -8] },
    roundKick: { lean: -38, head: 18, fa: [20, 40], ba: [110, 20], fl: [126, 0], bl: [-4, -4] },
    backKick: { lean: 48, head: -20, fa: [70, 90], ba: [40, 100], fl: [10, -10], bl: [-112, 0] },
    sweepWind: { lean: 30, head: 4, fa: [80, 40], ba: [40, 90], fl: [70, -130], bl: [-20, -120] },
    sweep:  { lean: 34, head: 6, fa: [100, 20], ba: [10, 80], fl: [86, 0], bl: [-10, -150] },
    lowKick: { lean: 4, head: 4, fa: [60, 80], ba: [30, 110], fl: [62, 0], bl: [-16, -12] },
    jump:   { lean: 4, head: 2, fa: [80, 70], ba: [40, 100], fl: [70, -110], bl: [40, -120] },
    jumpKick: { lean: -20, head: 10, fa: [50, 70], ba: [80, 50], fl: [108, 0], bl: [10, -130] },
    tuck:   { lean: 30, head: 10, fa: [100, 120], ba: [90, 120], fl: [110, -150], bl: [100, -150] },
    hit:    { lean: -26, head: -24, fa: [18, 50], ba: [-12, 60], fl: [16, -30], bl: [-34, -18] },
    hitHard: { lean: -40, head: -34, fa: [-20, 30], ba: [-40, 40], fl: [24, -20], bl: [-40, -10] },
    down:   { lean: 0, head: 0, fa: [170, 10], ba: [160, 20], fl: [6, -6], bl: [-4, -16], rot: 90 },
    getUp:  { lean: 40, head: 10, fa: [30, 40], ba: [10, 40], fl: [70, -130], bl: [-10, -120] },
    win:    { lean: 0, head: -4, fa: [176, 6], ba: [20, 120], fl: [12, -6], bl: [-12, -6] },
    bow:    { lean: 38, head: 24, fa: [10, 10], ba: [6, 10], fl: [4, -2], bl: [-4, -2] },
    stand:  { lean: 0, head: 0, fa: [8, 14], ba: [6, 18], fl: [6, -4], bl: [-6, -4] },
    lose:   { lean: 10, head: 30, fa: [6, 10], ba: [4, 12], fl: [8, -10], bl: [-8, -10] }
  };
  function lerpPose(a, b, t) {
    const o = {}; const L = (x, y) => mix(x || 0, y || 0, t);
    o.lean = L(a.lean, b.lean); o.head = L(a.head, b.head); o.rot = L(a.rot, b.rot);
    for (const k of ['fa', 'ba', 'fl', 'bl']) o[k] = [L(a[k][0], b[k][0]), L(a[k][1], b[k][1])];
    return o;
  }
  // A move = keyframes over its three phases: wind-up pose (startup), strike pose (active).
  const MOVE_ART = [
    // [test on the move name, wind-up, strike, trail limb ('fa'|'ba'|'fl'|'bl'|null)]
    [/sweep/, 'sweepWind', 'sweep', 'fl'],
    [/spin/, 'chamber', 'backKick', 'bl', true],
    [/back.?kick|reverse.?kick/, 'chamber', 'backKick', 'bl'],
    [/fly|jump.*kick|flying|air.?kick/, 'jump', 'jumpKick', 'fl'],
    [/lunge/, 'punchWind', 'revPunch', 'ba'],
    [/round|roundhouse|hook.?kick|crescent/, 'roundWind', 'roundKick', 'fl'],
    [/side.?kick|thrust|yoko/, 'sideChamber', 'sideKick', 'fl'],
    [/high.?kick|axe|head.?kick/, 'chamber', 'highKick', 'fl'],
    [/jump.*kick|flying|air.?kick/, 'jump', 'jumpKick', 'fl'],
    [/low.?kick|shin/, 'chamber', 'lowKick', 'fl'],
    [/kick/, 'chamber', 'frontKick', 'fl'],
    [/low.*punch|crouch.*punch|low.?jab/, 'crouch', 'lowPunch', 'fa'],
    [/rev|reverse|cross|straight/, 'punchWind', 'revPunch', 'ba'],
    [/high.*punch|upper|high.?jab/, 'punchWind', 'punchHigh', 'fa'],
    [/punch|jab|strike|chop|fist/, 'punchWind', 'punch', 'fa']
  ];
  const moveTable = () => FT().MOVES || {};
  // Seconds per phase for a move, from the sim's table when it has one.
  function phases(name) {
    const m = moveTable()[name] || {};
    const pick = (...ks) => { for (const k of ks) if (typeof m[k] === 'number') return m[k] > 2 ? m[k] / 60 : m[k]; return null; };
    return { s: pick('startup', 'start', 'su') ?? 0.1, a: pick('active', 'act') ?? 0.08, r: pick('recover', 'recovery', 'rec') ?? 0.16 };
  }
  // Works out the pose for a fighter from its state (name, phase, timers), plus what to trail.
  function poseFor(f, t, M) {
    const act = f.act || 'idle', mv = String(f.move || '').toLowerCase(), mt = f.t || 0, ph = f.phase;
    const breathe = (Math.sin(t * 3.2 + (f.idx || 0) * 1.7) + 1) / 2;
    const idle = lerpPose(P.guard, P.guard2, breathe);
    if (act === 'down') {
      const dn = FT().T_DOWN || 1.6, up = dn - 0.45;
      if (mt < up) return { pose: lerpPose(P.hitHard, P.down, easeOut(cl(mt / 0.28, 0, 1))) };
      const k = cl((mt - up) / 0.45, 0, 1);
      return { pose: k < 0.5 ? lerpPose(P.down, P.getUp, ease(k * 2)) : lerpPose(P.getUp, idle, ease(k * 2 - 1)) };
    }
    if (act === 'hit') {
      const k = mt < 0.08 ? 1 : 1 - ease(cl((mt - 0.08) / 0.45, 0, 1));
      return { pose: lerpPose(idle, P.hit, k) };
    }
    if (act === 'win') return { pose: lerpPose(P.stand, P.win, ease(cl(mt / 0.5, 0, 1))) };
    if (act === 'lose') return { pose: lerpPose(idle, P.lose, ease(cl(mt / 0.6, 0, 1))) };
    if (M && M.phase === 'intro' && M.introLong !== false && act === 'idle') {           // bow before the round
      const k = cl((M.phaseT || 0) / 1.2, 0, 1);
      return { pose: k < 0.75 ? lerpPose(P.stand, P.bow, Math.sin(k / 0.75 * Math.PI)) : lerpPose(P.stand, idle, ease((k - 0.75) / 0.25)) };
    }
    if (act === 'block') return { pose: f.crouch ? P.blockLow : P.block };
    if (act === 'attack' && mv) {
      for (const [re, wind, hitP, limb, spin] of MOVE_ART) {
        if (!re.test(mv)) continue;
        const d = phases(mv); let pose, strike = 0, turn = 0;
        const air = (f.y || 0) > 4 && /kick/.test(mv) ? 'jumpKick' : hitP;
        const p = ph || (mt < d.s ? 'startup' : mt < d.s + d.a ? 'active' : 'recover');
        if (p === 'startup') {
          const k = cl(mt / d.s, 0, 1);
          pose = k < 0.55 ? lerpPose(idle, P[wind], ease(k / 0.55)) : lerpPose(P[wind], P[air], ease((k - 0.55) / 0.45));
          strike = k > 0.55 ? (k - 0.55) / 0.45 : 0; turn = Math.PI * ease(k);
        } else if (p === 'active') {
          pose = P[air]; strike = 1; turn = Math.PI;
        } else {
          const k = cl((mt - d.s - d.a) / d.r, 0, 1);
          pose = lerpPose(P[air], idle, ease(k)); strike = 1 - k; turn = Math.PI * (1 + ease(k));
        }
        return { pose, limb, strike, turn: spin ? turn : 0 };
      }
    }
    if (act === 'jump' || (f.y || 0) > 4) return { pose: lerpPose(P.jump, P.tuck, cl(((f.y || 0) - 10) / 110, 0, 1) * 0.7) };
    if (act === 'crouch' || f.crouch) return { pose: P.crouch };
    if (act === 'walk') {
      const c = (Math.sin(mt * 11 * (f.walking || 1)) + 1) / 2;
      return { pose: lerpPose(P.walkA, P.walkB, c) };
    }
    return { pose: idle };
  }

  // ---------- skeleton ----------
  const SEG = { shin: 0.255, thigh: 0.25, torso: 0.29, neck: 0.035, head: 0.068, upper: 0.165, fore: 0.155, hipW: 0.03 };
  const dir = a => [Math.sin(a), -Math.cos(a)];          // 0 = straight down, 90 = forward
  function skeleton(pose) {
    const r = (pose.rot || 0) * D, lean = pose.lean * D;
    const J = {};
    J.hip = [0, 0];
    J.neck = [Math.sin(lean) * SEG.torso, Math.cos(lean) * SEG.torso];
    J.head = [J.neck[0] + Math.sin(lean + pose.head * D) * (SEG.neck + SEG.head), J.neck[1] + Math.cos(lean + pose.head * D) * (SEG.neck + SEG.head)];
    const sh = [J.neck[0] - Math.sin(lean) * 0.03, J.neck[1] - Math.cos(lean) * 0.03];
    for (const k of ['fa', 'ba']) {
      const off = k === 'fa' ? 0.012 : -0.012;
      const s = [sh[0] + off, sh[1]];
      const a1 = (pose[k][0] + pose.lean * 0.5) * D, a2 = a1 + pose[k][1] * D;
      const d1 = dir(a1), d2 = dir(a2);
      const e = [s[0] + d1[0] * SEG.upper, s[1] + d1[1] * SEG.upper];
      const h = [e[0] + d2[0] * SEG.fore, e[1] + d2[1] * SEG.fore];
      J[k] = [s, e, h];
    }
    for (const k of ['fl', 'bl']) {
      const off = k === 'fl' ? SEG.hipW : -SEG.hipW;
      const s = [off, 0];
      const a1 = pose[k][0] * D, a2 = a1 + pose[k][1] * D;
      const d1 = dir(a1), d2 = dir(a2);
      const kn = [s[0] + d1[0] * SEG.thigh, s[1] + d1[1] * SEG.thigh];
      const ft = [kn[0] + d2[0] * SEG.shin, kn[1] + d2[1] * SEG.shin];
      // toe points forward from the shin
      const raised = cl((pose[k][0] - 45) / 40, 0, 1), ta = mix(90 * D, a2 + 90 * D, raised);
      const toe = [ft[0] + Math.sin(ta) * 0.07, ft[1] - Math.cos(ta) * 0.07];
      J[k] = [s, kn, ft, toe];
    }
    if (r) {
      const c = Math.cos(r), s = Math.sin(r), R = p => [p[0] * c - p[1] * s, p[0] * s + p[1] * c];
      for (const k in J) J[k] = Array.isArray(J[k][0]) ? J[k].map(R) : R(J[k]);
    }
    // ground: lowest point sits on y = 0
    let low = Infinity;
    const scan = p => { low = Math.min(low, p[1]); };
    scan(J.head); J.fl.forEach(scan); J.bl.forEach(scan); J.fa.forEach(scan); J.ba.forEach(scan); scan(J.neck);
    const lowHead = J.head[1] - SEG.head; low = Math.min(low, lowHead);
    for (const k in J) J[k] = Array.isArray(J[k][0]) ? J[k].map(p => [p[0], p[1] - low]) : [J[k][0], J[k][1] - low];
    return J;
  }

  // ---------- fighter drawing ----------
  const SKIN = ['#e9b48e', '#c98d62', '#f1c7a4', '#a8714c'];
  const cache = {};                      // per-fighter render memory (trails, flash timers)
  function fcache(f, i) { const k = i ?? f.idx ?? 0; return cache[k] || (cache[k] = { trail: [], flash: 0, lastHit: -1 }); }

  function limb(g, pts, w, col, outline) {
    g.lineCap = 'round'; g.lineJoin = 'round';
    g.beginPath(); g.moveTo(pts[0][0], -pts[0][1]); for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], -pts[i][1]);
    g.strokeStyle = outline; g.lineWidth = w + 0.022; g.stroke();
    g.strokeStyle = col; g.lineWidth = w; g.stroke();
  }
  function blob(g, p, r, col, outline) {
    g.beginPath(); g.arc(p[0], -p[1], r, 0, TAU);
    g.fillStyle = outline; g.fill();
    g.beginPath(); g.arc(p[0], -p[1], r - 0.011, 0, TAU); g.fillStyle = col; g.fill();
  }

  // Draws a fighter with feet at (0,0), body height 1, facing +x. Caller scales and flips.
  function drawBody(g, J, look, t) {
    const ol = look.outline || '#16110f', gi = look.gi, giD = shade(gi, -0.28), giDD = shade(gi, -0.42), skin = look.skin, skinD = shade(skin, -0.22);
    const belt = look.belt, flutter = Math.sin(t * 11 + look.seed) * 0.02;
    // back limbs (darker)
    limb(g, J.bl.slice(0, 3), 0.085, giDD, ol);
    blob(g, J.bl[2], 0.03, skinD, ol); limb(g, [J.bl[2], J.bl[3]], 0.04, skinD, ol);
    limb(g, J.ba.slice(0, 2), 0.07, giDD, ol); limb(g, [J.ba[1], lerpP(J.ba[1], J.ba[2], 0.7)], 0.064, giDD, ol);
    blob(g, J.ba[2], 0.037, skinD, ol);
    // torso jacket
    const n = J.neck, h = J.hip, ax = n[0] - h[0], ay = n[1] - h[1], L = Math.hypot(ax, ay) || 1, px = -ay / L, py = ax / L;
    const wS = 0.085, wH = 0.072;
    g.beginPath();
    const sk = 0.07, ux = ax / L, uy = ay / L;          // jacket skirt hangs below the belt
    g.moveTo(n[0] + px * wS, -(n[1] + py * wS)); g.lineTo(h[0] + px * (wH + 0.012) - ux * sk, -(h[1] + py * (wH + 0.012) - uy * sk));
    g.lineTo(h[0] - px * (wH + 0.016) - ux * sk, -(h[1] - py * (wH + 0.016) - uy * sk));
    g.lineTo(n[0] - px * wS, -(n[1] - py * wS)); g.closePath();
    g.fillStyle = gi; g.strokeStyle = ol; g.lineWidth = 0.014; g.stroke(); g.fill();
    // shading on the back side of the jacket
    g.beginPath(); g.moveTo(n[0] - px * wS, -(n[1] - py * wS)); g.lineTo(h[0] - px * wH, -(h[1] - py * wH));
    g.lineTo(h[0] - px * 0.02, -(h[1] - py * 0.02)); g.lineTo(n[0] - px * 0.03, -(n[1] - py * 0.03)); g.closePath();
    g.fillStyle = 'rgba(0,0,0,0.16)'; g.fill();
    // lapel: V of skin and the overlapping fold
    const v = lerpP(h, n, 0.62);
    g.beginPath(); g.moveTo(n[0] + px * 0.04, -(n[1] + py * 0.04)); g.lineTo(v[0], -v[1]); g.lineTo(n[0] - px * 0.035, -(n[1] - py * 0.035)); g.closePath();
    g.fillStyle = skin; g.fill();
    g.beginPath(); g.moveTo(n[0] - px * 0.04, -(n[1] - py * 0.04)); g.lineTo(lerpP(h, n, 0.42)[0] + px * 0.03, -(lerpP(h, n, 0.42)[1] + py * 0.03));
    g.strokeStyle = giD; g.lineWidth = 0.012; g.stroke();
    // belt + tails
    const b = lerpP(h, n, 0.16);
    g.beginPath(); g.moveTo(b[0] + px * (wH + 0.008), -(b[1] + py * (wH + 0.008))); g.lineTo(b[0] - px * (wH + 0.012), -(b[1] - py * (wH + 0.012)));
    g.strokeStyle = ol; g.lineWidth = 0.05; g.stroke(); g.strokeStyle = belt; g.lineWidth = 0.034; g.stroke();
    const kx = b[0] + px * 0.03, ky = b[1] + py * 0.03;
    g.strokeStyle = belt; g.lineWidth = 0.022; g.lineCap = 'round';
    g.beginPath(); g.moveTo(kx, -ky); g.quadraticCurveTo(kx + 0.03, -(ky - 0.05), kx + 0.01 + flutter, -(ky - 0.11)); g.stroke();
    g.beginPath(); g.moveTo(kx, -ky); g.quadraticCurveTo(kx + 0.05, -(ky - 0.04), kx + 0.05 - flutter, -(ky - 0.1)); g.stroke();
    // head
    const hd = J.head, R = SEG.head;
    blob(g, lerpP(n, hd, 0.35), 0.03, skinD, ol);
    g.beginPath(); g.arc(hd[0], -hd[1], R + 0.008, 0, TAU); g.fillStyle = ol; g.fill();
    g.beginPath(); g.arc(hd[0], -hd[1], R, 0, TAU); g.fillStyle = skin; g.fill();
    const ha = Math.atan2(hd[0] - n[0], hd[1] - n[1]);      // head tilt
    g.save(); g.translate(hd[0], -hd[1]); g.rotate(ha);
    // hair cap (back of head)
    g.beginPath(); g.arc(0, 0, R, Math.PI * 0.95, Math.PI * 2.08); g.closePath(); g.fillStyle = look.hair; g.fill();
    g.beginPath(); g.arc(-R * 0.35, -R * 0.1, R * 0.72, Math.PI * 0.4, Math.PI * 1.5); g.fill();
    // headband with tails blowing back
    g.strokeStyle = look.band; g.lineWidth = 0.024; g.lineCap = 'butt';
    g.beginPath(); g.arc(0, 0, R + 0.002, Math.PI * 1.08, Math.PI * 1.92); g.stroke();
    g.lineCap = 'round'; g.lineWidth = 0.018;
    g.beginPath(); g.moveTo(-R * 0.9, -R * 0.35); g.quadraticCurveTo(-R * 1.8, -R * 0.1 + flutter * 2, -R * 2.6, R * 0.25 + flutter * 3); g.stroke();
    g.beginPath(); g.moveTo(-R * 0.9, -R * 0.3); g.quadraticCurveTo(-R * 1.6, R * 0.3, -R * 2.2, R * 0.8 - flutter * 3); g.stroke();
    // eye + brow
    g.fillStyle = ol; g.beginPath(); g.ellipse(R * 0.52, -R * 0.12, R * 0.09, R * 0.14, 0, 0, TAU); g.fill();
    g.lineWidth = 0.011; g.strokeStyle = ol; g.beginPath(); g.moveTo(R * 0.32, -R * 0.36); g.lineTo(R * 0.74, -R * 0.26); g.stroke();
    g.restore();
    // front limbs
    limb(g, J.fl.slice(0, 3), 0.088, gi, ol);
    // knee crease
    blob(g, J.fl[2], 0.03, skin, ol); limb(g, [J.fl[2], J.fl[3]], 0.042, skin, ol);
    limb(g, J.fa.slice(0, 2), 0.072, gi, ol); limb(g, [J.fa[1], lerpP(J.fa[1], J.fa[2], 0.7)], 0.066, gi, ol);
    blob(g, J.fa[2], 0.039, skin, ol);
    // sleeve cuff highlight
    limb(g, [lerpP(J.fa[0], J.fa[1], 0.15), lerpP(J.fa[0], J.fa[1], 0.55)], 0.018, shade(gi, 0.35), 'rgba(0,0,0,0)');
  }
  const lerpP = (a, b, t) => [mix(a[0], b[0], t), mix(a[1], b[1], t)];

  const GI = { white: '#f1eee4', red: '#c8323a', blue: '#2f5fd0', black: '#2a2a2e', green: '#2f8a4a', gold: '#d9a52b' };
  const BAND = { white: '#d8262a', red: '#f4f1ea', blue: '#f4d03f', black: '#d8262a', green: '#f4f1ea', gold: '#1b1b1b' };
  const BELT = { white: '#1b1b1b', red: '#1b1b1b', blue: '#1b1b1b', black: '#c0302a', green: '#1b1b1b', gold: '#1b1b1b' };
  function lookFor(f, i) {
    const side = f.idx ?? i ?? 0, c = f.color || (side ? 'red' : 'white');
    const gi = GI[c] || (c[0] === '#' ? c : GI.white);
    return { gi, belt: BELT[c] || '#1b1b1b', band: BAND[c] || '#d8262a', skin: SKIN[side % SKIN.length], hair: side ? '#2a1a12' : '#151515', seed: side * 2.3 };
  }

  // f: fighter state. opts: {x, y, scale, i, t, flash, alpha}
  function drawFighter(g, f, opts) {
    opts = opts || {};
    const t = opts.t ?? now(), i = opts.i ?? f.idx ?? 0;
    const { pose, limb: tl, strike, turn } = poseFor(f, t, opts.M);
    const J = skeleton(pose);
    const look = lookFor(f, i);
    const s = opts.scale || 155, face = (f.facing || 1) * (turn ? Math.cos(turn) : 1);
    g.save();
    g.translate(opts.x || 0, opts.y || 0);
    g.scale(s * (Math.abs(face) < 0.12 ? Math.sign(face || 1) * 0.12 : face), s);
    if (opts.alpha != null) g.globalAlpha = opts.alpha;
    if (opts.flash > 0) {            // white-hot flash on the frame a hit lands
      const k = cl(opts.flash, 0, 1) * 0.8;
      for (const key of ['gi', 'belt', 'band', 'skin', 'hair']) look[key] = shade(look[key], k);
      look.outline = shade('#16110f', k * 0.6);
    }
    drawBody(g, J, look, t);
    g.restore();
    // strike point in the caller's space (for trails)
    if (tl && strike > 0.3) {
      const p = tl[1] === 'a' ? J[tl][2] : J[tl][3];
      return { x: (opts.x || 0) + p[0] * s * face, y: (opts.y || 0) - p[1] * s, strike };  // face includes the spin
    }
    return null;
  }

  // ---------- effects ----------
  const fx = { parts: [], rings: [], shake: 0, flash: 0, seen: new WeakSet(), lastT: now(), slashes: [] };
  function emit(ev, toScreen, scale) {
    const p = toScreen(ev.x ?? 0, ev.y ?? 100);
    const type = ev.type || 'hit';
    const big = (ev.points || 1) > 1;
    if (type === 'hit') {
      const n = big ? 34 : 20;
      for (let k = 0; k < n; k++) {
        const a = Math.random() * TAU, v = (big ? 520 : 340) * (0.35 + Math.random());
        fx.parts.push({ x: p.x, y: p.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 60, life: 0.35 + Math.random() * 0.3, max: 0.65, r: (2 + Math.random() * 3) * scale, col: k % 3 ? '#fff4c2' : '#ffb13b', spark: true });
      }
      fx.rings.push({ x: p.x, y: p.y, t: 0, max: big ? 0.38 : 0.26, r: (big ? 90 : 60) * scale, col: '255,236,170' });
      fx.slashes.push({ x: p.x, y: p.y, t: 0, max: 0.16, a: Math.random() * Math.PI, r: (big ? 110 : 70) * scale });
      fx.shake = Math.max(fx.shake, big ? 16 : 8);
      fx.flash = Math.max(fx.flash, big ? 0.35 : 0.12);
    } else if (type === 'block' || type === 'clash') {
      const clash = type === 'clash';
      for (let k = 0; k < 14; k++) {
        const a = clash ? Math.random() * TAU : (Math.random() - 0.5) * 1.6 + (ev.dir === -1 ? 0 : Math.PI), v = 260 * (0.4 + Math.random());
        fx.parts.push({ x: p.x, y: p.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.25 + Math.random() * 0.2, max: 0.45, r: (1.6 + Math.random() * 2) * scale, col: clash ? '#ffd27a' : '#9fe3ff', spark: true });
      }
      fx.rings.push({ x: p.x, y: p.y, t: 0, max: clash ? 0.3 : 0.22, r: (clash ? 70 : 46) * scale, col: clash ? '255,210,120' : '150,220,255' });
      fx.shake = Math.max(fx.shake, clash ? 7 : 4);
    } else if (type === 'fall') {
      dust(p.x, p.y, 18, scale); fx.shake = Math.max(fx.shake, 9);
    } else if (type === 'begin') {
      fx.flash = Math.max(fx.flash, 0.18);
    }
  }
  function dust(x, y, n, scale) {
    for (let k = 0; k < n; k++) {
      const dx = (Math.random() - 0.5);
      fx.parts.push({ x: x + dx * 40 * scale, y, vx: dx * 160, vy: -20 - Math.random() * 50, life: 0.5 + Math.random() * 0.4, max: 0.9, r: (6 + Math.random() * 8) * scale, col: 'rgba(214,190,150,0.5)', dust: true });
    }
  }
  function stepFx(dt) {
    for (const p of fx.parts) {
      p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt;
      if (p.spark) { p.vy += 900 * dt; p.vx *= 0.96; } else { p.vx *= 0.92; p.vy *= 0.95; }
    }
    fx.parts = fx.parts.filter(p => p.life > 0);
    if (fx.parts.length > 500) fx.parts.splice(0, fx.parts.length - 500);
    for (const r of fx.rings) r.t += dt; fx.rings = fx.rings.filter(r => r.t < r.max);
    for (const r of fx.slashes) r.t += dt; fx.slashes = fx.slashes.filter(r => r.t < r.max);
    fx.shake = Math.max(0, fx.shake - dt * 60);
    fx.flash = Math.max(0, fx.flash - dt * 2.5);
  }
  function drawFx(g) {
    for (const p of fx.parts) {
      const a = cl(p.life / p.max, 0, 1);
      if (p.spark) {
        g.strokeStyle = p.col; g.globalAlpha = a; g.lineWidth = p.r; g.lineCap = 'round';
        g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(p.x - p.vx * 0.03, p.y - p.vy * 0.03); g.stroke();
      } else {
        g.globalAlpha = a * 0.7; g.fillStyle = p.col;
        g.beginPath(); g.arc(p.x, p.y, p.r * (1.8 - a), 0, TAU); g.fill();
      }
    }
    g.globalAlpha = 1;
    for (const r of fx.rings) {
      const k = r.t / r.max;
      g.strokeStyle = 'rgba(' + r.col + ',' + (1 - k) + ')'; g.lineWidth = 6 * (1 - k) + 1;
      g.beginPath(); g.arc(r.x, r.y, r.r * easeOut(k), 0, TAU); g.stroke();
    }
    for (const s of fx.slashes) {
      const k = s.t / s.max, w = s.r * (0.6 + k);
      g.save(); g.translate(s.x, s.y); g.rotate(s.a);
      g.fillStyle = 'rgba(255,255,255,' + (1 - k) + ')';
      g.beginPath(); g.moveTo(-w, 0); g.lineTo(0, -s.r * 0.07); g.lineTo(w, 0); g.lineTo(0, s.r * 0.07); g.closePath(); g.fill();
      g.rotate(Math.PI / 2); g.scale(0.55, 0.55);
      g.beginPath(); g.moveTo(-w, 0); g.lineTo(0, -s.r * 0.07); g.lineTo(w, 0); g.lineTo(0, s.r * 0.07); g.closePath(); g.fill();
      g.restore();
    }
  }
  function drawTrail(g, tr, col) {
    if (tr.length < 2) return;
    g.lineCap = 'round';
    for (let k = 1; k < tr.length; k++) {
      const a = tr[k - 1], b = tr[k], al = (k / tr.length) * 0.55 * b.s;
      g.strokeStyle = rgb(col, al); g.lineWidth = b.w * (k / tr.length);
      g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
    }
  }

  // ---------- stages ----------
  // Each stage: sky colours, an optional sun or moon, distant hills, a scene painter, a floor style,
  // what moves in the sky (sky), and what drifts through the air (air: petal | snow | leaf | rain | none).
  const STAGES = [
    { name: 'Sunset Shrine', sky: ['#2a1745', '#a8395a', '#f08a4b', '#ffd27a'], sun: { x: 0.5, y: 0.52, r: 0.12, col: '#fff1b8', stripes: true },
      hill: ['#5a2747', '#3c1b3a', '#25122a'], scene: 'shrine', floor: 'planks', fc: ['#b07b4b', '#7a4f2c'], mat: ['rgba(255,240,210,0.13)', 'rgba(150,30,30,0.55)'],
      sky2: 'clouds', cloud: 'rgba(255,180,160,0.18)', air: 'petal', airCol: '#ffc2d6', airN: 40 },
    { name: 'Moon Bamboo', sky: ['#060a1c', '#13224a', '#24407a', '#4a6aa8'], stars: true, sun: { x: 0.5, y: 0.28, r: 0.07, col: '#eef3ff', craters: true },
      hill: ['#1d3150', '#132339', '#0b1525'], scene: 'bamboo', floor: 'planks', fc: ['#6c7a6a', '#3e4a3e'], mat: ['rgba(180,200,190,0.10)', 'rgba(220,235,255,0.35)'],
      sky2: 'fireflies', air: 'leaf', airCol: '#d9f2c4', airN: 40 },
    { name: 'Mountain Dojo', sky: ['#5b8fc9', '#8fbce6', '#cfe6f5', '#f6efe0'], sun: { x: 0.8, y: 0.52, r: 0.12, col: '#ffffff' },
      hill: ['#7d9bb8', '#5d7b98', '#3d5b78'], snowCaps: true, scene: 'dojo', floor: 'planks', fc: ['#c49a64', '#8c6a40'], mat: ['rgba(255,240,210,0.13)', 'rgba(150,30,30,0.55)'],
      air: 'snow', airCol: '#ffffff', airN: 26 },
    { name: 'Harbour Dusk', sky: ['#1b1638', '#5a2d63', '#d0577a', '#ffb46b'], sun: { x: 0.68, y: 0.6, r: 0.09, col: '#ffe0a0' },
      hill: ['#3b2448'], scene: 'harbour', floor: 'deck', fc: ['#8a5a3a', '#4f3020'], mat: ['rgba(255,220,180,0.10)', 'rgba(255,220,150,0.45)'],
      sky2: 'gulls', air: 'none' },
    { name: 'Neon Rooftop', sky: ['#05040f', '#120c2e', '#2b1650', '#58205e'], stars: true,
      scene: 'rooftop', floor: 'stone', fc: ['#4a4a56', '#24242c'], mat: ['rgba(120,240,255,0.06)', 'rgba(255,70,200,0.55)'],
      sky2: 'blinks', air: 'rain', airCol: 'rgba(170,200,255,0.45)', airN: 70 },
    { name: 'Waterfall Gorge', sky: ['#4f8fb8', '#86bcd6', '#c7e4e6', '#e9f4e8'], sun: { x: 0.2, y: 0.2, r: 0.06, col: '#fffbe6' },
      hill: ['#6f9a8a', '#4f7d6a'], scene: 'gorge', floor: 'stone', fc: ['#8b8f84', '#585d52'], mat: ['rgba(255,255,255,0.08)', 'rgba(250,250,235,0.45)'],
      sky2: 'waterfall', air: 'leaf', airCol: '#7fbf5a', airN: 24 },
    { name: 'Palm Beach', sky: ['#2f7fd0', '#58a6e6', '#9fd2f2', '#dff2fb'], sun: { x: 0.85, y: 0.18, r: 0.06, col: '#fffbe0' },
      scene: 'beach', floor: 'sand', fc: ['#e8c88e', '#c9a46a'], mat: ['rgba(255,255,255,0.10)', 'rgba(200,60,40,0.55)'],
      sky2: 'beach', cloud: 'rgba(255,255,255,0.75)', air: 'none' }
  ];
  const stageCache = {};
  function stageCanvas(si, w, h, fyFrac) {
    fyFrac = fyFrac || 0.73;
    const key = si + ':' + w + 'x' + h + ':' + fyFrac;
    if (stageCache[key]) return stageCache[key];
    for (const k in stageCache) delete stageCache[k];
    const c = document.createElement('canvas'); c.width = Math.max(1, w); c.height = Math.max(1, h);
    const g = c.getContext('2d'), S = STAGES[si], R = rand(7 + si * 13), fy = h * fyFrac;
    // sky
    const sk = g.createLinearGradient(0, 0, 0, fy);
    S.sky.forEach((col, k) => sk.addColorStop(k / (S.sky.length - 1), col));
    g.fillStyle = sk; g.fillRect(0, 0, w, fy);
    if (S.stars) for (let k = 0; k < 140; k++) { g.fillStyle = 'rgba(255,255,255,' + (0.3 + R() * 0.7) + ')'; g.fillRect(R() * w, R() * fy * 0.7, R() < 0.1 ? 2 : 1, R() < 0.1 ? 2 : 1); }
    // sun / moon with glow
    if (S.sun) {
      const sx = w * S.sun.x, sy = fy * S.sun.y, sr = Math.min(w, h) * S.sun.r;
      const glow = g.createRadialGradient(sx, sy, sr * 0.5, sx, sy, sr * 4);
      glow.addColorStop(0, rgb(hexRgb(S.sun.col), 0.55)); glow.addColorStop(1, rgb(hexRgb(S.sun.col), 0));
      g.fillStyle = glow; g.fillRect(0, 0, w, fy);
      g.fillStyle = S.sun.col; g.beginPath(); g.arc(sx, sy, sr, 0, TAU); g.fill();
      if (S.sun.stripes) { g.fillStyle = S.sky[2]; for (let k = 0; k < 4; k++) g.fillRect(sx - sr, sy + sr * (0.2 + k * 0.2), sr * 2, sr * 0.06 * (k + 1)); }
      if (S.sun.craters) { g.fillStyle = 'rgba(160,175,210,0.35)'; [[-.3, -.2, .22], [.25, .2, .16], [.05, .35, .1]].forEach(([a, b, r]) => { g.beginPath(); g.arc(sx + a * sr, sy + b * sr, r * sr, 0, TAU); g.fill(); }); }
    }
    // distant ranges
    (S.hill || []).forEach((col, k) => {
      const base = fy - h * (0.2 - k * 0.055), amp = h * (0.12 - k * 0.025);
      g.fillStyle = col; g.beginPath(); g.moveTo(0, fy);
      for (let x = 0; x <= w + 20; x += 20) {
        const n = Math.sin(x * 0.004 + k * 3 + si) * 0.6 + Math.sin(x * 0.011 + k * 7) * 0.3 + Math.sin(x * 0.027 + k) * 0.1;
        g.lineTo(x, base - amp * (0.5 + n * 0.5) * (S.snowCaps && k === 0 ? 1.8 : 1));
      }
      g.lineTo(w, fy); g.closePath(); g.fill();
      if (S.snowCaps && k === 0) {
        g.save(); g.clip(); g.fillStyle = 'rgba(255,255,255,0.75)'; g.fillRect(0, 0, w, base - amp * 1.15); g.restore();
      }
      g.fillStyle = rgb(hexRgb(S.sky[2]), 0.12); g.fillRect(0, 0, w, fy);      // haze between layers
    });
    SCENES[S.scene](g, w, h, fy, R, S);
    drawFloor(g, w, h, fy, S);
    c.fy = fy;
    stageCache[key] = c;
    return c;
  }
  function pagoda(g, x, base, sc, col) {
    g.fillStyle = col;
    for (let k = 0; k < 4; k++) {
      const y = base - k * 46 * sc, rw = (88 - k * 14) * sc, bw = (52 - k * 8) * sc;
      g.fillRect(x - bw / 2, y - 34 * sc, bw, 34 * sc);
      g.beginPath(); g.moveTo(x - rw, y - 30 * sc); g.quadraticCurveTo(x - rw * 0.5, y - 36 * sc, x, y - 52 * sc); g.quadraticCurveTo(x + rw * 0.5, y - 36 * sc, x + rw, y - 30 * sc);
      g.lineTo(x + rw * 0.8, y - 38 * sc); g.lineTo(x - rw * 0.8, y - 38 * sc); g.closePath(); g.fill();
    }
    g.fillRect(x - 2 * sc, base - 4 * 46 * sc - 40 * sc, 4 * sc, 40 * sc);
  }
  function gate(g, x, base, sc, col, col2) {
    g.fillStyle = col;
    g.fillRect(x - 70 * sc, base - 150 * sc, 12 * sc, 150 * sc); g.fillRect(x + 58 * sc, base - 150 * sc, 12 * sc, 150 * sc);
    g.fillRect(x - 84 * sc, base - 124 * sc, 168 * sc, 10 * sc);
    g.beginPath(); g.moveTo(x - 100 * sc, base - 150 * sc); g.quadraticCurveTo(x, base - 140 * sc, x + 100 * sc, base - 150 * sc);
    g.lineTo(x + 104 * sc, base - 164 * sc); g.quadraticCurveTo(x, base - 152 * sc, x - 104 * sc, base - 164 * sc); g.closePath(); g.fill();
    g.fillStyle = col2; g.fillRect(x - 100 * sc, base - 166 * sc, 200 * sc, 4 * sc);
  }
  function drawShrine(g, w, h, fy, R) {
    const sc = h / 720;
    pagoda(g, w * 0.13, fy - h * 0.03, sc * 1.1, '#2a1027');
    pagoda(g, w * 0.88, fy - h * 0.05, sc * 0.8, '#3a1630');
    gate(g, w * 0.5, fy - h * 0.005, sc * 1.25, '#5a1420', '#22070e');
    // cherry trees at the edges
    for (const [tx, flip] of [[w * 0.02, 1], [w * 0.98, -1]]) {
      g.strokeStyle = '#2a1424'; g.lineCap = 'round';
      g.lineWidth = 18 * sc; g.beginPath(); g.moveTo(tx, fy); g.quadraticCurveTo(tx + 30 * sc * flip, fy - 160 * sc, tx + 120 * sc * flip, fy - 280 * sc); g.stroke();
      g.lineWidth = 8 * sc; g.beginPath(); g.moveTo(tx + 40 * sc * flip, fy - 160 * sc); g.quadraticCurveTo(tx + 120 * sc * flip, fy - 200 * sc, tx + 200 * sc * flip, fy - 210 * sc); g.stroke();
      for (let k = 0; k < 60; k++) {
        const a = R() * TAU, d = R();
        const cx = tx + (90 + Math.cos(a) * 120 * d) * sc * flip, cy = fy - (250 + Math.sin(a) * 70 * d) * sc;
        g.fillStyle = ['#ffb3c9', '#ff8fb0', '#ffd1df', '#e9739a'][k % 4]; g.globalAlpha = 0.75;
        g.beginPath(); g.arc(cx, cy, (14 + R() * 18) * sc, 0, TAU); g.fill();
      }
      g.globalAlpha = 1;
    }
  }
  function drawBamboo(g, w, h, fy, R) {
    const sc = h / 720;
    for (let layer = 0; layer < 3; layer++) {
      const col = ['#16304a', '#122a3a', '#0c1d28'][layer], n = 9 + layer * 3;
      for (let k = 0; k < n; k++) {
        const x = R() * w, bw = (8 + layer * 5 + R() * 4) * sc;
        if (layer === 2 && x > w * 0.22 && x < w * 0.78) continue;     // keep the centre clear
        g.fillStyle = col; g.fillRect(x, 0, bw, fy);
        g.fillStyle = 'rgba(255,255,255,0.05)'; g.fillRect(x + bw * 0.2, 0, bw * 0.2, fy);
        g.fillStyle = 'rgba(0,0,0,0.35)';
        for (let y = R() * 80 * sc; y < fy; y += (70 + R() * 30) * sc) g.fillRect(x - 1, y, bw + 2, 3 * sc);
        g.fillStyle = col;
        for (let j = 0; j < 4; j++) {
          const ly = R() * fy * 0.8, dir = R() < 0.5 ? -1 : 1;
          g.beginPath(); g.moveTo(x + bw / 2, ly); g.quadraticCurveTo(x + bw / 2 + dir * 30 * sc, ly - 10 * sc, x + bw / 2 + dir * 60 * sc, ly + 6 * sc);
          g.quadraticCurveTo(x + bw / 2 + dir * 30 * sc, ly + 2 * sc, x + bw / 2, ly + 4 * sc); g.fill();
        }
      }
    }
    // stone lanterns
    for (const x of [w * 0.2, w * 0.8]) {
      const b = fy - 2 * sc;
      g.fillStyle = '#2b3442';
      g.fillRect(x - 30 * sc, b - 14 * sc, 60 * sc, 14 * sc); g.fillRect(x - 8 * sc, b - 70 * sc, 16 * sc, 58 * sc);
      g.fillRect(x - 26 * sc, b - 78 * sc, 52 * sc, 10 * sc); g.fillRect(x - 20 * sc, b - 112 * sc, 40 * sc, 34 * sc);
      g.beginPath(); g.moveTo(x - 40 * sc, b - 112 * sc); g.lineTo(x, b - 140 * sc); g.lineTo(x + 40 * sc, b - 112 * sc); g.closePath(); g.fill();
      const lg = g.createRadialGradient(x, b - 95 * sc, 2, x, b - 95 * sc, 70 * sc);
      lg.addColorStop(0, 'rgba(255,200,110,0.9)'); lg.addColorStop(0.2, 'rgba(255,170,80,0.35)'); lg.addColorStop(1, 'rgba(255,170,80,0)');
      g.fillStyle = lg; g.fillRect(x - 70 * sc, b - 165 * sc, 140 * sc, 140 * sc);
      g.fillStyle = '#ffd38a'; g.fillRect(x - 10 * sc, b - 104 * sc, 20 * sc, 18 * sc);
    }
  }
  function drawDojo(g, w, h, fy, R) {
    const sc = h / 720, top = fy - h * 0.46;
    // open dojo frame: dark posts, low roof beam and a railing, so the mountains show through
    g.fillStyle = '#3b2616';
    g.fillRect(0, 0, w, top - 30 * sc);
    const beam = g.createLinearGradient(0, top - 30 * sc, 0, top + 10 * sc);
    beam.addColorStop(0, '#5a3a20'); beam.addColorStop(1, '#2c1b0e');
    g.fillStyle = beam; g.fillRect(0, top - 30 * sc, w, 40 * sc);
    // ceiling boards
    g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = 2;
    for (let x = 0; x < w; x += 60 * sc) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, top - 30 * sc); g.stroke(); }
    // hanging plain cloth banners
    for (const bx of [w * 0.3, w * 0.7]) {
      g.fillStyle = '#7a1a1a'; g.fillRect(bx - 22 * sc, top + 10 * sc, 44 * sc, 120 * sc);
      g.beginPath(); g.moveTo(bx - 22 * sc, top + 130 * sc); g.lineTo(bx, top + 146 * sc); g.lineTo(bx + 22 * sc, top + 130 * sc); g.fill();
      g.fillStyle = '#e9d9b0'; g.beginPath(); g.arc(bx, top + 60 * sc, 13 * sc, 0, TAU); g.fill();
      g.fillStyle = '#7a1a1a'; g.beginPath(); g.arc(bx, top + 60 * sc, 7 * sc, 0, TAU); g.fill();
    }
    // posts
    for (let k = 0; k <= 4; k++) {
      const x = k * w / 4 - (k === 4 ? 26 * sc : 0);
      g.fillStyle = '#2c1b0e'; g.fillRect(x, top - 30 * sc, 26 * sc, fy - top + 30 * sc);
      g.fillStyle = 'rgba(255,255,255,0.06)'; g.fillRect(x + 4 * sc, top, 5 * sc, fy - top);
    }
    // railing
    g.fillStyle = '#3b2616'; g.fillRect(0, fy - 62 * sc, w, 9 * sc);
    for (let x = 0; x < w; x += 34 * sc) g.fillRect(x, fy - 62 * sc, 5 * sc, 62 * sc);
    // side screens with lattice
    for (const [x0, x1] of [[0, w * 0.12], [w * 0.88, w]]) {
      g.fillStyle = '#eadfc6'; g.fillRect(x0, top + 10 * sc, x1 - x0, fy - top - 10 * sc);
      g.strokeStyle = '#4a3020'; g.lineWidth = 3 * sc;
      for (let x = x0; x <= x1; x += 28 * sc) { g.beginPath(); g.moveTo(x, top + 10 * sc); g.lineTo(x, fy); g.stroke(); }
      for (let y = top + 10 * sc; y <= fy; y += 36 * sc) { g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y); g.stroke(); }
    }
  }
  function drawFloor(g, w, h, fy, S) {
    const fh = h - fy, [fc, fcD] = S.fc, R = rand(99);
    const fg = g.createLinearGradient(0, fy, 0, h);
    fg.addColorStop(0, fcD); fg.addColorStop(0.25, fc); fg.addColorStop(1, shade(fc, -0.3));
    g.fillStyle = fg; g.fillRect(0, fy, w, fh);
    const vx = w / 2, vy = fy - h * 1.2, persp = xb => mix(vx, xb, (fy - vy) / (h - vy));
    const rowY = k => fy + fh * Math.pow(k, 1.6);
    if (S.floor === 'planks' || S.floor === 'deck') {      // boards in perspective, converging above the centre
      g.strokeStyle = 'rgba(0,0,0,' + (S.floor === 'deck' ? 0.35 : 0.22) + ')'; g.lineWidth = S.floor === 'deck' ? 2.5 : 1.5;
      const n = S.floor === 'deck' ? 13 : 18;
      for (let k = -22; k <= 22; k++) { const xb = w / 2 + k * w / n; g.beginPath(); g.moveTo(persp(xb), fy); g.lineTo(xb, h); g.stroke(); }
      for (let k = 1; k < 7; k++) { g.strokeStyle = 'rgba(0,0,0,' + (0.08 + k * 0.01) + ')'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(0, rowY(k / 7)); g.lineTo(w, rowY(k / 7)); g.stroke(); }
      if (S.floor === 'deck') {                               // nail heads
        g.fillStyle = 'rgba(30,20,10,0.45)';
        for (let r = 1; r < 7; r++) for (let k = -12; k <= 12; k++) { const y = rowY((r - 0.5) / 7), xb = w / 2 + (k + 0.15) * w / 13, x = mix(persp(xb), xb, (y - fy) / fh); g.fillRect(x, y, 2, 2); }
      }
    } else if (S.floor === 'stone') {                      // slabs with staggered joints
      g.strokeStyle = 'rgba(0,0,0,0.3)'; g.lineWidth = 1.5;
      for (let r = 0; r < 6; r++) {
        const y0 = rowY(r / 6), y1 = rowY((r + 1) / 6);
        g.beginPath(); g.moveTo(0, y1); g.lineTo(w, y1); g.stroke();
        for (let k = -12; k <= 12; k++) {
          const xb = w / 2 + (k + (r % 2) * 0.5) * w / 7, t0 = (y0 - fy) / fh, t1 = (y1 - fy) / fh;
          g.beginPath(); g.moveTo(mix(persp(xb), xb, t0), y0); g.lineTo(mix(persp(xb), xb, t1), y1); g.stroke();
        }
      }
      for (let k = 0; k < 260; k++) { g.fillStyle = R() < 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.08)'; g.fillRect(R() * w, fy + R() * fh, 2 + R() * 4, 1 + R() * 2); }
    } else if (S.floor === 'sand') {                       // speckles and wind ripples
      for (let k = 0; k < 900; k++) { g.fillStyle = R() < 0.5 ? 'rgba(255,255,255,0.18)' : 'rgba(120,80,30,0.14)'; g.fillRect(R() * w, fy + R() * fh, 1.5, 1.5); }
      g.strokeStyle = 'rgba(150,110,60,0.18)'; g.lineWidth = 2;
      for (let k = 0; k < 14; k++) {
        const y = fy + fh * (0.05 + R() * 0.95), x = R() * w, len = w * (0.08 + R() * 0.12);
        g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + len / 2, y - 4, x + len, y); g.stroke();
      }
    }
    // fighting square: inset mat with a painted border
    const mx = w * 0.06, mt = fy + fh * 0.12, mb = fy + fh * 0.62;
    const sh = (y) => (y - fy) / fh * w * 0.03;
    g.beginPath(); g.moveTo(mx + w * 0.02 - sh(mt), mt); g.lineTo(w - mx - w * 0.02 + sh(mt), mt); g.lineTo(w - mx + sh(mb), mb); g.lineTo(mx - sh(mb), mb); g.closePath();
    g.fillStyle = S.mat[0]; g.fill();
    g.strokeStyle = S.mat[1]; g.lineWidth = Math.max(2, h * 0.006); g.stroke();
    for (const f of (FT().START_X || [330, 630]).map(x => x / (FT().ARENA_W || 960))) {     // starting lines
      g.beginPath(); g.moveTo(w * f, mt + 6); g.lineTo(w * f + (f - 0.5) * w * 0.03, mb - 6); g.strokeStyle = 'rgba(255,255,255,0.28)'; g.stroke();
    }
    g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(0, fy, w, 2);      // horizon shine
    const vg = g.createRadialGradient(w / 2, h * 0.55, Math.min(w, h) * 0.35, w / 2, h * 0.55, Math.max(w, h) * 0.8);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.45)');
    g.fillStyle = vg; g.fillRect(0, 0, w, h);
  }

  // ---------- new places ----------
  function sea(g, w, h, fy, top, cols, R) {
    const sg = g.createLinearGradient(0, top, 0, fy);
    sg.addColorStop(0, cols[0]); sg.addColorStop(1, cols[1]);
    g.fillStyle = sg; g.fillRect(0, top, w, fy - top);
    g.fillStyle = 'rgba(255,255,255,0.10)';
    for (let k = 0; k < 90; k++) { const y = top + Math.pow(R(), 1.5) * (fy - top); g.fillRect(R() * w, y, (8 + R() * 30) * h / 720 * (0.5 + (y - top) / (fy - top)), 1.5); }
  }
  function boat(g, x, y, sc, col) {
    g.fillStyle = col;
    g.beginPath(); g.moveTo(x - 70 * sc, y - 18 * sc); g.lineTo(x + 80 * sc, y - 18 * sc); g.lineTo(x + 58 * sc, y); g.lineTo(x - 56 * sc, y); g.closePath(); g.fill();
    g.fillRect(x - 3 * sc, y - 140 * sc, 5 * sc, 124 * sc);
    g.fillRect(x - 40 * sc, y - 34 * sc, 50 * sc, 16 * sc);
    g.strokeStyle = col; g.lineWidth = 1.5 * sc;
    g.beginPath(); g.moveTo(x, y - 140 * sc); g.lineTo(x + 76 * sc, y - 18 * sc); g.moveTo(x, y - 140 * sc); g.lineTo(x - 66 * sc, y - 18 * sc); g.stroke();
  }
  function palm(g, x, base, sc, flip, R) {
    g.strokeStyle = '#6b4a2a'; g.lineCap = 'round'; g.lineWidth = 16 * sc;
    const tx = x + 70 * sc * flip, ty = base - 300 * sc;
    g.beginPath(); g.moveTo(x, base); g.quadraticCurveTo(x - 10 * sc * flip, base - 180 * sc, tx, ty); g.stroke();
    g.strokeStyle = 'rgba(0,0,0,0.18)'; g.lineWidth = 3 * sc;
    for (let k = 1; k < 12; k++) { const t = k / 12, px = mix(mix(x, x - 10 * sc * flip, t), mix(x - 10 * sc * flip, tx, t), t), py = mix(mix(base, base - 180 * sc, t), mix(base - 180 * sc, ty, t), t); g.beginPath(); g.moveTo(px - 8 * sc, py); g.lineTo(px + 8 * sc, py); g.stroke(); }
    for (let k = 0; k < 8; k++) {
      const a = -Math.PI / 2 + (k - 3.5) * 0.42 + flip * 0.2, len = (110 + R() * 40) * sc;
      const ex = tx + Math.cos(a) * len, ey = ty + Math.sin(a) * len * 0.6 + len * 0.45;
      g.strokeStyle = k % 2 ? '#2f7d3a' : '#3f9a48'; g.lineWidth = 12 * sc;
      g.beginPath(); g.moveTo(tx, ty); g.quadraticCurveTo(tx + Math.cos(a) * len * 0.6, ty + Math.sin(a) * len * 0.6 - 30 * sc, ex, ey); g.stroke();
    }
    g.fillStyle = '#5a3a1e'; for (let k = 0; k < 3; k++) { g.beginPath(); g.arc(tx + (k - 1) * 10 * sc, ty + 10 * sc, 8 * sc, 0, TAU); g.fill(); }
  }
  function harbour(g, w, h, fy, R) {
    const sc = h / 720, top = fy - h * 0.2;
    sea(g, w, h, fy, top, ['#6a3a6e', '#2c1d40'], R);
    // sun glitter path on the water
    for (let k = 0; k < 26; k++) { const y = top + (k / 26) * (fy - top), ww = (10 + k * 4) * sc; g.fillStyle = 'rgba(255,200,130,' + (0.5 - k * 0.012) + ')'; g.fillRect(w * 0.68 - ww / 2 + (R() - 0.5) * 20 * sc, y, ww, 2 * sc); }
    boat(g, w * 0.16, fy - h * 0.035, sc * 0.9, '#20142c'); boat(g, w * 0.86, fy - h * 0.05, sc * 0.7, '#2a1a36');
    // lamp posts with a string of warm lights between them
    const posts = [w * 0.08, w * 0.36, w * 0.64, w * 0.92], ph = 150 * sc;
    for (const x of posts) { g.fillStyle = '#1c1220'; g.fillRect(x - 5 * sc, fy - ph, 10 * sc, ph); g.fillRect(x - 12 * sc, fy - ph - 6 * sc, 24 * sc, 8 * sc); }
    for (let i = 0; i < posts.length - 1; i++) {
      const x0 = posts[i], x1 = posts[i + 1], y0 = fy - ph, sag = 34 * sc;
      g.strokeStyle = '#1c1220'; g.lineWidth = 1.5 * sc; g.beginPath(); g.moveTo(x0, y0); g.quadraticCurveTo((x0 + x1) / 2, y0 + sag * 2, x1, y0); g.stroke();
      for (let k = 1; k < 10; k++) {
        const t = k / 10, x = mix(x0, x1, t), y = y0 + sag * 4 * t * (1 - t);
        const lg = g.createRadialGradient(x, y, 0, x, y, 14 * sc); lg.addColorStop(0, 'rgba(255,214,140,0.9)'); lg.addColorStop(1, 'rgba(255,190,110,0)');
        g.fillStyle = lg; g.fillRect(x - 14 * sc, y - 14 * sc, 28 * sc, 28 * sc);
        g.fillStyle = '#fff0c8'; g.beginPath(); g.arc(x, y + 3 * sc, 3 * sc, 0, TAU); g.fill();
      }
    }
    // rope and bollards along the back of the pier
    g.fillStyle = '#2a1a14'; for (let x = w * 0.03; x < w; x += w * 0.12) { rrect(g, x - 9 * sc, fy - 34 * sc, 18 * sc, 36 * sc, 6 * sc); g.fill(); }
    g.strokeStyle = '#c9a77a'; g.lineWidth = 3 * sc;
    g.beginPath(); for (let x = w * 0.03; x < w - w * 0.12; x += w * 0.12) { g.moveTo(x, fy - 26 * sc); g.quadraticCurveTo(x + w * 0.06, fy - 10 * sc, x + w * 0.12, fy - 26 * sc); } g.stroke();
  }
  function rooftop(g, w, h, fy, R, S) {
    const sc = h / 720;
    S.blinks = [];
    const layers = [['#1a1236', 0.62, 0.05], ['#130d29', 0.48, 0.12], ['#0b0819', 0.34, 0.22]];
    layers.forEach(([col, maxH, lit], li) => {
      let x = -20 * sc;
      while (x < w) {
        const bw = (40 + R() * 90) * sc * (1 + li * 0.3), bh = fy * (0.2 + R() * maxH);
        g.fillStyle = col; g.fillRect(x, fy - bh, bw, bh);
        if (R() < 0.3) { g.fillRect(x + bw * 0.45, fy - bh - 40 * sc, 3 * sc, 40 * sc); S.blinks.push([(x + bw * 0.45) / w, (fy - bh - 40 * sc) / h]); }
        for (let wy = fy - bh + 10 * sc; wy < fy - 8 * sc; wy += 14 * sc * (1 + li * 0.2))
          for (let wx = x + 6 * sc; wx < x + bw - 8 * sc; wx += 11 * sc * (1 + li * 0.2))
            if (R() < lit) { g.fillStyle = R() < 0.7 ? 'rgba(255,214,120,0.85)' : 'rgba(150,220,255,0.8)'; g.fillRect(wx, wy, 4 * sc * (1 + li * 0.3), 6 * sc * (1 + li * 0.2)); }
        x += bw + (2 + R() * 10) * sc;
      }
    });
    // glowing signs: abstract shapes only
    const sign = (x, y, ww, hh, col, kind) => {
      g.save(); g.shadowColor = col; g.shadowBlur = 18 * sc; g.strokeStyle = col; g.lineWidth = 4 * sc;
      rrect(g, x, y, ww, hh, 8 * sc); g.stroke();
      if (kind === 0) { g.beginPath(); g.arc(x + ww / 2, y + hh / 2, hh * 0.28, 0, TAU); g.stroke(); }
      else { for (let k = 0; k < 3; k++) { g.beginPath(); g.moveTo(x + ww * 0.2, y + hh * (0.3 + k * 0.2)); g.lineTo(x + ww * (0.8 - k * 0.15), y + hh * (0.3 + k * 0.2)); g.stroke(); } }
      g.restore();
    };
    sign(w * 0.06, fy - h * 0.42, 90 * sc, 60 * sc, '#ff4fd8', 0);
    sign(w * 0.8, fy - h * 0.5, 120 * sc, 70 * sc, '#4ff0ff', 1);
    // water tank on legs, vents and the low wall at the roof edge
    const tx = w * 0.2, tb = fy - 36 * sc;
    g.fillStyle = '#16121f'; g.fillRect(tx - 40 * sc, tb - 70 * sc, 6 * sc, 70 * sc); g.fillRect(tx + 34 * sc, tb - 70 * sc, 6 * sc, 70 * sc);
    rrect(g, tx - 50 * sc, tb - 160 * sc, 100 * sc, 95 * sc, 10 * sc); g.fill();
    g.beginPath(); g.moveTo(tx - 54 * sc, tb - 158 * sc); g.lineTo(tx, tb - 196 * sc); g.lineTo(tx + 54 * sc, tb - 158 * sc); g.closePath(); g.fill();
    S.blinks.push([tx / w, (tb - 196 * sc) / h]);
    for (const vx of [w * 0.74, w * 0.84]) { g.fillStyle = '#1e1a2a'; g.fillRect(vx, fy - 80 * sc, 70 * sc, 50 * sc); g.strokeStyle = '#2f2a40'; g.lineWidth = 2 * sc; for (let k = 0; k < 5; k++) { g.beginPath(); g.moveTo(vx + 6 * sc, fy - 72 * sc + k * 9 * sc); g.lineTo(vx + 64 * sc, fy - 72 * sc + k * 9 * sc); g.stroke(); } }
    g.fillStyle = '#2a2833'; g.fillRect(0, fy - 34 * sc, w, 34 * sc);
    g.fillStyle = '#3a3846'; g.fillRect(0, fy - 34 * sc, w, 5 * sc);
  }
  function gorge(g, w, h, fy, R, S) {
    const sc = h / 720, fx0 = w * 0.44, fx1 = w * 0.56, ftop = fy * 0.18;
    S.fall = [fx0 / w, fx1 / w, ftop / h, (fy - 20 * sc) / h];
    // waterfall sheet and pool
    const wf = g.createLinearGradient(fx0, 0, fx1, 0);
    wf.addColorStop(0, '#a8d8e8'); wf.addColorStop(0.5, '#e8f7fb'); wf.addColorStop(1, '#9ccfe0');
    g.fillStyle = wf; g.fillRect(fx0, ftop, fx1 - fx0, fy - ftop);
    g.fillStyle = 'rgba(120,180,200,0.6)'; g.fillRect(0, fy - 34 * sc, w, 34 * sc);
    // cliffs on both sides, darker towards the front
    const cliff = (side, col, inset, rough) => {
      g.fillStyle = col; g.beginPath();
      const edge = side < 0 ? fx0 - inset : fx1 + inset, outer = side < 0 ? -20 : w + 20;
      g.moveTo(outer, fy); g.lineTo(outer, ftop - 60 * sc);
      for (let k = 0; k <= 10; k++) {
        const t = k / 10, y = mix(ftop - 40 * sc, fy, t);
        g.lineTo(edge + side * (Math.sin(t * 9 + rough) * 14 + R() * 10) * sc + side * t * 30 * sc, y);
      }
      g.lineTo(outer, fy); g.closePath(); g.fill();
    };
    cliff(-1, '#5d6b5e', 0, 1); cliff(1, '#5a685a', 0, 2);
    cliff(-1, '#465446', w * 0.12, 3); cliff(1, '#435143', w * 0.12, 4);
    // ledges and moss
    for (let k = 0; k < 26; k++) {        // rock strata with moss on top
      const side = k % 2 ? 1 : -1, x = side < 0 ? R() * (fx0 - 80 * sc) : fx1 + 40 * sc + R() * (w - fx1), y = ftop + R() * (fy - ftop), len = (60 + R() * 120) * sc;
      g.strokeStyle = 'rgba(0,0,0,0.22)'; g.lineWidth = 3 * sc; g.beginPath(); g.moveTo(x, y); g.lineTo(x + len, y + (R() - 0.5) * 12 * sc); g.stroke();
      g.strokeStyle = 'rgba(110,170,80,0.6)'; g.lineWidth = 4 * sc; g.beginPath(); g.moveTo(x + len * 0.1, y - 3 * sc); g.lineTo(x + len * 0.6, y - 3 * sc); g.stroke();
    }
    const shadeL = g.createLinearGradient(0, 0, w, 0);            // depth: darker at the outer edges
    shadeL.addColorStop(0, 'rgba(0,20,10,0.35)'); shadeL.addColorStop(0.3, 'rgba(0,0,0,0)'); shadeL.addColorStop(0.7, 'rgba(0,0,0,0)'); shadeL.addColorStop(1, 'rgba(0,20,10,0.35)');
    g.fillStyle = shadeL; g.fillRect(0, 0, w, fy);
    // trees on the rims
    for (let k = 0; k < 14; k++) {
      const x = k < 7 ? R() * fx0 * 0.9 : fx1 + 20 * sc + R() * (w - fx1), y = ftop - 40 * sc + R() * 20 * sc, r = (22 + R() * 22) * sc;
      g.fillStyle = ['#2e5a35', '#3c7042', '#264d2c'][k % 3]; g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
    }
    // mist where the water lands
    const mg = g.createRadialGradient(w / 2, fy - 20 * sc, 10 * sc, w / 2, fy - 20 * sc, 200 * sc);
    mg.addColorStop(0, 'rgba(255,255,255,0.75)'); mg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = mg; g.fillRect(w / 2 - 200 * sc, fy - 220 * sc, 400 * sc, 220 * sc);
  }
  function beach(g, w, h, fy, R) {
    const sc = h / 720, top = fy - h * 0.16;
    sea(g, w, h, fy, top, ['#1f6fb2', '#4fb3c9'], R);
    // distant sailboat and island
    g.fillStyle = '#5c8fa8'; g.beginPath(); g.ellipse(w * 0.22, top + 2, 120 * sc, 22 * sc, 0, Math.PI, TAU); g.fill();
    g.fillStyle = '#ffffff'; g.beginPath(); g.moveTo(w * 0.5, top + 6 * sc); g.lineTo(w * 0.5, top - 40 * sc); g.lineTo(w * 0.525, top + 4 * sc); g.closePath(); g.fill();
    g.fillStyle = '#7a4a2a'; g.fillRect(w * 0.485, top + 4 * sc, 44 * sc, 5 * sc);
    // wet sand band
    g.fillStyle = 'rgba(200,170,120,0.9)'; g.fillRect(0, fy - 16 * sc, w, 16 * sc);
    palm(g, w * 0.05, fy + 6 * sc, sc * 1.1, 1, R); palm(g, w * 0.95, fy + 6 * sc, sc * 0.95, -1, R);
    // beach umbrella
    const ux = w * 0.82, ub = fy - 4 * sc;
    g.strokeStyle = '#ddd'; g.lineWidth = 4 * sc; g.beginPath(); g.moveTo(ux, ub); g.lineTo(ux - 10 * sc, ub - 110 * sc); g.stroke();
    for (let k = 0; k < 6; k++) { g.fillStyle = k % 2 ? '#ffffff' : '#e8463b'; g.beginPath(); g.moveTo(ux - 10 * sc, ub - 118 * sc); g.arc(ux - 10 * sc, ub - 96 * sc, 70 * sc, Math.PI + k * Math.PI / 6, Math.PI + (k + 1) * Math.PI / 6); g.closePath(); g.fill(); }
  }
  const SCENES = { shrine: (...a) => drawShrine(...a), bamboo: (...a) => drawBamboo(...a), dojo: (...a) => drawDojo(...a), harbour, rooftop, gorge, beach };

  // live (animated) parts of the stage
  const petals = [];
  let lastAir = -1;
  function drawAmbient(g, si, w, h, fy, t, dt) {
    const S = STAGES[si], u = h / 720;
    if (S.cloud) {                     // drifting clouds
      g.fillStyle = S.cloud;
      for (let k = 0; k < 5; k++) {
        const x = ((k * 0.27 + t * (0.006 + k * 0.002)) % 1.3 - 0.15) * w, y = fy * (0.12 + k * 0.07);
        for (let j = 0; j < 4; j++) { g.beginPath(); g.ellipse(x + j * 40 * u, y + Math.sin(j * 2) * 6, 60 * u, 16 * u, 0, 0, TAU); g.fill(); }
      }
    }
    if (S.sky2 === 'fireflies') {
      for (let k = 0; k < 18; k++) {
        const x = (Math.sin(t * 0.3 + k * 2.1) * 0.5 + 0.5) * w, y = fy * (0.45 + 0.45 * (Math.sin(t * 0.47 + k * 1.3) * 0.5 + 0.5));
        const a = (Math.sin(t * 3 + k) + 1) / 2;
        g.fillStyle = 'rgba(220,255,140,' + a * 0.8 + ')'; g.beginPath(); g.arc(x, y, 2.2 * u, 0, TAU); g.fill();
        g.fillStyle = 'rgba(220,255,140,' + a * 0.15 + ')'; g.beginPath(); g.arc(x, y, 8 * u, 0, TAU); g.fill();
      }
    }
    if (S.sky2 === 'gulls' || S.sky2 === 'beach') {
      g.strokeStyle = S.sky2 === 'beach' ? 'rgba(255,255,255,0.9)' : 'rgba(30,20,40,0.8)'; g.lineWidth = 2 * u; g.lineCap = 'round';
      for (let k = 0; k < 4; k++) {
        const x = ((k * 0.31 + t * (0.02 + k * 0.006)) % 1.2 - 0.1) * w, y = fy * (0.2 + k * 0.09) + Math.sin(t * 1.3 + k) * 8 * u, f = Math.sin(t * 7 + k * 2) * 5 * u;
        g.beginPath(); g.moveTo(x - 12 * u, y - f); g.quadraticCurveTo(x - 5 * u, y - 6 * u, x, y); g.quadraticCurveTo(x + 5 * u, y - 6 * u, x + 12 * u, y - f); g.stroke();
      }
    }
    if (S.sky2 === 'beach') {          // waves washing in
      const k = (Math.sin(t * 0.9) + 1) / 2, y = fy - 16 * u + k * 10 * u;
      g.fillStyle = 'rgba(255,255,255,0.75)';
      g.beginPath(); g.moveTo(0, y); for (let x = 0; x <= w; x += 20 * u) g.lineTo(x, y + Math.sin(x * 0.02 + t * 2) * 3 * u); g.lineTo(w, y - 6 * u); g.lineTo(0, y - 6 * u); g.closePath(); g.fill();
      g.fillStyle = 'rgba(80,190,210,0.35)'; g.fillRect(0, y - 22 * u, w, 16 * u);
    }
    if (S.sky2 === 'blinks' && S.blinks) {
      const on = Math.floor(t * 1.4) % 2 === 0;
      for (const [bx, by] of S.blinks) if (on) {
        g.fillStyle = 'rgba(255,60,60,0.95)'; g.beginPath(); g.arc(bx * w, by * h, 2.5 * u, 0, TAU); g.fill();
        g.fillStyle = 'rgba(255,60,60,0.2)'; g.beginPath(); g.arc(bx * w, by * h, 9 * u, 0, TAU); g.fill();
      }
    }
    if (S.sky2 === 'waterfall' && S.fall) {   // streaks sliding down the falls, spray at the bottom
      const [x0, x1, y0, y1] = S.fall;
      g.save(); g.beginPath(); g.rect(x0 * w, y0 * h, (x1 - x0) * w, (y1 - y0) * h); g.clip();
      g.strokeStyle = 'rgba(255,255,255,0.7)'; g.lineWidth = 2 * u;
      for (let k = 0; k < 22; k++) {
        const x = mix(x0, x1, (k * 0.618) % 1) * w, sp = 0.5 + (k % 5) * 0.12, y = y0 * h + (((t * sp + k * 0.37) % 1) * (y1 - y0) * h * 1.2) - 40 * u;
        g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + 40 * u); g.stroke();
      }
      g.restore();
      for (let k = 0; k < 8; k++) {
        const a = (t * 0.6 + k / 8) % 1, x = (0.5 + Math.sin(k * 2.3) * 0.08) * w, y = y1 * h - a * 60 * u;
        g.fillStyle = 'rgba(255,255,255,' + (0.35 * (1 - a)) + ')'; g.beginPath(); g.arc(x, y, (14 + a * 30) * u, 0, TAU); g.fill();
      }
    }
    // things in the air: petals, leaves, snow, rain
    if (si !== lastAir) { petals.length = 0; lastAir = si; }
    if (S.air === 'none') return;
    const want = S.airN || 30;
    while (petals.length < want) petals.push({ x: Math.random(), y: Math.random(), s: 0.5 + Math.random(), p: Math.random() * TAU });
    g.fillStyle = S.airCol; g.strokeStyle = S.airCol;
    for (const p of petals) {
      if (S.air === 'rain') { p.y += dt * 1.6 * p.s; p.x += dt * 0.08; }
      else { p.y += dt * 0.05 * p.s; p.x += dt * (0.03 + Math.sin(t + p.p) * 0.02) * (S.air === 'snow' ? 0.3 : 1); }
      if (p.y > 1.02) { p.y = -0.02; p.x = Math.random(); }
      if (p.x > 1.02) p.x = -0.02;
      if (S.air === 'rain') { g.lineWidth = 1.2 * u; g.beginPath(); g.moveTo(p.x * w, p.y * h); g.lineTo(p.x * w - 4 * u, p.y * h - 22 * u * p.s); g.stroke(); continue; }
      g.save(); g.translate(p.x * w, p.y * h); g.rotate(t * 2 * p.s + p.p);
      g.globalAlpha = 0.85; g.beginPath();
      if (S.air === 'snow') g.arc(0, 0, 2.2 * p.s * u, 0, TAU); else g.ellipse(0, 0, 4 * p.s * u, 2 * p.s * u, 0, 0, TAU);
      g.fill(); g.restore();
    }
    g.globalAlpha = 1;
  }

  // ---------- world ----------
  // A match keeps one starting stage (M.stage, shared online) and moves on one place each round.
  // Without M.stage each screen picks its own random start for that match.
  const localStart = new WeakMap();
  function stageOf(M) {
    let base = M.stage;
    if (typeof base !== 'number') { if (!localStart.has(M)) localStart.set(M, Math.floor(Math.random() * STAGES.length)); base = localStart.get(M); }
    const n = STAGES.length;
    return (((Math.floor(base) + (M.round || 1) - 1) % n) + n) % n;
  }
  const dims = () => ({ W: FT().ARENA_W || 960, H: FT().STAGE_H || 540, FY: FT().FLOOR_Y || 440 });
  const HORIZON = 46;                 // the back edge of the floor sits this far above the feet line
  function pixelScale(g) { try { const m = g.getTransform(); return Math.max(0.5, Math.min(4, Math.hypot(m.a, m.b))); } catch (e) { return 1; } }
  // The pre-drawn stage, built at screen resolution so it stays sharp.
  function stageImage(g, si, W, H, FY) {
    const k = pixelScale(g);
    const c = stageCanvas(si, Math.round(W * k), Math.round(H * k), (FY - HORIZON) / H);
    return c;
  }

  function drawWorld(g, M, view) {
    view = view || {};
    const t = view.t ?? performance.now() / 1000; clock = t;
    const dt = cl(view.dt ?? 1 / 60, 0, 0.1);
    const { W, H, FY } = dims(), si = stageOf(M), fy = FY - HORIZON;
    const toScreen = (x, y) => ({ x, y: FY - y });
    for (const ev of M.events || []) if (ev && typeof ev === 'object' && !fx.seen.has(ev)) { fx.seen.add(ev); emit(ev, toScreen, 1); }
    const fs = M.fighters || [];
    fs.forEach((f, i) => {          // falls raise dust when the body meets the floor
      const c = fcache(f, i);
      if (f.act === 'down' && (f.t || 0) > 0.22 && !c.fell && (f.y || 0) < 4) { c.fell = true; emit({ type: 'fall', x: f.x - (f.facing || 1) * 40, y: 0 }, toScreen, 1); }
      if (f.act !== 'down') c.fell = false;
    });
    for (const ev of M.events || []) if (ev && (ev.type === 'land' || ev.type === 'jump') && ev.by != null && fs[ev.by]) dust(fs[ev.by].x, FY, ev.type === 'land' ? 8 : 5, 1);
    stepFx(dt);
    g.save();
    const sx = fx.shake ? (Math.random() - 0.5) * fx.shake : 0, sy = fx.shake ? (Math.random() - 0.5) * fx.shake : 0;
    g.translate(sx, sy);
    g.drawImage(stageImage(g, si, W, H, FY), -12, -12, W + 24, H + 24);
    drawAmbient(g, si, W, H, fy, t, dt);
    const fh = (FT().STAND_H || 150) / 0.97;
    fs.forEach(f => {               // shadows
      const up = cl((f.y || 0) / 220, 0, 0.7);
      g.fillStyle = 'rgba(0,0,0,' + (0.38 * (1 - up)) + ')';
      g.beginPath(); g.ellipse(f.x, FY + 2, fh * 0.3 * (1 - up * 0.5), fh * 0.05, 0, 0, TAU); g.fill();
    });
    // the fighter mid-attack draws on top
    const order = fs.map((f, i) => [f, i]).sort((a, b) => (a[0].act === 'attack' ? 1 : 0) - (b[0].act === 'attack' ? 1 : 0));
    for (const [f, i] of order) {
      const c = fcache(f, i), hurt = f.act === 'hit' || f.act === 'down';
      if (hurt && !c.wasHurt) c.flash = 1;
      c.wasHurt = hurt;
      c.flash = Math.max(0, c.flash - dt * 7);
      drawTrail(g, c.trail, [255, 255, 255]);
      const hitP = drawFighter(g, f, { x: f.x, y: FY - (f.y || 0), scale: fh, i, t, flash: c.flash, M });
      if (hitP) c.trail.push({ x: hitP.x, y: hitP.y, s: hitP.strike, w: fh * 0.07 });
      else if (c.trail.length) c.trail.shift();
      if (c.trail.length > 7) c.trail.shift();
    }
    drawFx(g);
    g.restore();
    if (fx.flash > 0) { g.fillStyle = 'rgba(255,255,255,' + fx.flash * 0.5 + ')'; g.fillRect(0, 0, W, H); }
  }

  // ---------- HUD ----------
  const FONT = '-apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif';
  function text(g, str, x, y, size, col, align, weight, stroke) {
    g.font = (weight || '800') + ' ' + size + 'px ' + FONT; g.textAlign = align || 'left'; g.textBaseline = 'middle';
    if (stroke) { g.lineJoin = 'round'; g.lineWidth = size * 0.18; g.strokeStyle = stroke; g.strokeText(str, x, y); }
    g.fillStyle = 'rgba(0,0,0,0.5)'; g.fillText(str, x + 2, y + 2);
    g.fillStyle = col || '#fff'; g.fillText(str, x, y);
  }
  function panel(g, x, y, w, h, r) { g.fillStyle = 'rgba(10,12,20,0.72)'; rrect(g, x, y, w, h, r ?? 10); g.fill(); }
  const msgAnim = { text: '', t0: 0 };

  function drawHUD(g, M, view) {
    view = view || {};
    const { W, H } = dims(), t = view.t ?? now(), fs = M.fighters || [];
    const pips = Math.ceil((FT().POINTS_TO_WIN || 4) / 2), roundsNeed = FT().ROUNDS_TO_WIN || 2;
    fs.slice(0, 2).forEach((f, i) => {
      const right = i === 1, pw = 290, x = right ? W - 18 - pw : 18, y = 16;
      const col = GI[f.color] || f.color || (i ? GI.red : GI.white);
      const grd = g.createLinearGradient(x, 0, x + pw, 0);
      grd.addColorStop(right ? 1 : 0, 'rgba(12,8,10,0.86)'); grd.addColorStop(right ? 0 : 1, 'rgba(12,8,10,0.2)');
      g.fillStyle = grd; rrect(g, x, y, pw, 58, 12); g.fill();
      g.fillStyle = col; rrect(g, right ? x + pw - 8 : x, y, 8, 58, 4); g.fill();
      const name = ((view.labels && view.labels[i]) || f.name || 'PLAYER ' + (i + 1)).toUpperCase();
      text(g, name, right ? x + pw - 22 : x + 22, y + 18, 18, '#fff', right ? 'right' : 'left', '900');
      // round wins: small gold diamonds
      for (let k = 0; k < roundsNeed; k++) {
        const cx = right ? x + 24 + k * 20 : x + pw - 24 - k * 20, cy = y + 18, won = k < (f.rounds || 0);
        g.save(); g.translate(cx, cy); g.rotate(Math.PI / 4);
        g.fillStyle = won ? '#ffd84a' : 'rgba(255,255,255,0.14)'; g.fillRect(-6, -6, 12, 12);
        g.strokeStyle = won ? '#fff3b0' : 'rgba(255,255,255,0.35)'; g.lineWidth = 1.5; g.strokeRect(-6, -6, 12, 12);
        g.restore();
      }
      // points: a full medallion per point, half filled for a half point
      const sc = (f.score || 0) / 2;
      for (let k = 0; k < pips; k++) {
        const cx = right ? x + pw - 34 - k * 32 : x + 34 + k * 32, cy = y + 41, v = cl(sc - k, 0, 1);
        g.fillStyle = 'rgba(255,255,255,0.13)'; g.beginPath(); g.arc(cx, cy, 11, 0, TAU); g.fill();
        if (v > 0) {
          const grad = g.createRadialGradient(cx - 3, cy - 3, 1, cx, cy, 11);
          grad.addColorStop(0, '#fff6c4'); grad.addColorStop(1, '#e9a91a');
          g.fillStyle = grad; g.beginPath();
          if (v < 1) { g.moveTo(cx, cy); g.arc(cx, cy, 11, Math.PI / 2, Math.PI * 1.5, right); g.closePath(); }
          else g.arc(cx, cy, 11, 0, TAU);
          g.fill();
        }
        g.strokeStyle = 'rgba(255,255,255,0.6)'; g.lineWidth = 1.5; g.beginPath(); g.arc(cx, cy, 11, 0, TAU); g.stroke();
      }
    });
    // timer medallion
    if (M.timer != null) {
      const cx = W / 2, cy = 46, r = 33, low = M.phase === 'fight' && M.timer <= 10;
      g.fillStyle = 'rgba(12,8,10,0.86)'; g.beginPath(); g.arc(cx, cy, r, 0, TAU); g.fill();
      const tot = FT().ROUND_TIME || 30;
      g.strokeStyle = 'rgba(255,255,255,0.12)'; g.lineWidth = 4; g.beginPath(); g.arc(cx, cy, r - 4, 0, TAU); g.stroke();
      g.strokeStyle = low ? '#ff5a4d' : '#ffd84a'; g.beginPath(); g.arc(cx, cy, r - 4, -Math.PI / 2, -Math.PI / 2 + TAU * cl(M.timer / tot, 0, 1)); g.stroke();
      const pulse = low ? 1 + 0.08 * Math.sin(t * 10) : 1;
      text(g, String(Math.max(0, Math.ceil(M.timer))), cx, cy + 1, 30 * pulse, low ? '#ff8a80' : '#fff', 'center', '900');
      if (M.round) text(g, 'ROUND ' + M.round, cx, cy + r + 13, 12, '#e8dccb', 'center', '800');
    }
    // where we are, shown under the banner while the round is announced
    if (M.phase === 'intro' && M.introLong !== false && M.message) {
      const a = cl((M.phaseT || 0) / 0.3, 0, 1);
      g.globalAlpha = a; text(g, '— ' + STAGES[stageOf(M)].name.toUpperCase() + ' —', W / 2, H * 0.36 + 88, 17, '#ffe9b0', 'center', '800'); g.globalAlpha = 1;
    }
    // big centre message, slammed in then held
    const msg = M.message || '';
    if (msg) {
      if (msg !== msgAnim.text) { msgAnim.text = msg; msgAnim.t0 = t; }
      const k = cl((t - msgAnim.t0) / 0.22, 0, 1), sz = Math.min(76, W / (msg.length * 0.62 + 1.5)) * (1 + (1 - easeOut(k)) * 0.8);
      const cy = H * 0.36, band = Math.min(76, W / (msg.length * 0.62 + 1.5)) * 0.8;
      const grd = g.createLinearGradient(0, 0, W, 0);
      grd.addColorStop(0, 'rgba(0,0,0,0)'); grd.addColorStop(0.2, 'rgba(0,0,0,' + 0.5 * k + ')'); grd.addColorStop(0.8, 'rgba(0,0,0,' + 0.5 * k + ')'); grd.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grd; g.fillRect(0, cy - band, W * k + (1 - k) * W * 0.5, band * 2);
      g.fillStyle = 'rgba(255,216,74,' + 0.9 * k + ')'; g.fillRect(W * 0.2, cy - band, W * 0.6, 2); g.fillRect(W * 0.2, cy + band - 2, W * 0.6, 2);
      g.globalAlpha = k;
      text(g, msg.toUpperCase(), W / 2, cy, sz, '#fff', 'center', '900', '#9e1016');
      g.globalAlpha = 1;
    } else msgAnim.text = '';
  }

  // ---------- menu backdrop ----------
  function backdrop(g, w, h, stage, t, dt) {
    const si = ((stage || 0) % STAGES.length + STAGES.length) % STAGES.length;
    t = t ?? performance.now() / 1000; clock = t;
    const c = stageCanvas(si, Math.round(w * pixelScale(g)), Math.round(h * pixelScale(g)), 0.73);
    g.drawImage(c, 0, 0, w, h); drawAmbient(g, si, w, h, h * 0.73, t, dt ?? 1 / 60);
  }

  return { drawWorld, drawHUD, drawFighter, backdrop, text, panel, STAGES, POSES: P, poseFor, fx };
})();
