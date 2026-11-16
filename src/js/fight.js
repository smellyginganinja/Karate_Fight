/* Fight: the match simulation. Pure game rules, no drawing, no sound, no DOM.
   The host (or the local game) owns a match and calls Fight.step(match, [input0, input1], dt)
   at a fixed rate. render.js reads the match to draw it; net play sends Fight.snapshot(match).

   Coordinates: x runs 0..ARENA_W left to right; a fighter's y is its height ABOVE the floor
   (0 = standing on it). On screen the floor line sits at FLOOR_Y in a 960 x 540 logical stage.

   An input is { l, r, u, d, pc, kc, jc }: l/r/u/d are held directions, and pc/kc/jc are running
   press counts for punch, kick and jump. A press is "the count went up since last step", so a
   quick tap is never missed, even online.

   Scoring: a clean hit scores a half point (1) or a full point (2). The first fighter to 2 full
   points (score 4) takes the round; first to 2 rounds wins the match. After every point both
   fighters go back to their marks. A round that times out goes to the higher score; a tie is a
   draw and the round is fought again. */
const Fight = (() => {
  const ARENA_W = 960, FLOOR_Y = 440, STAGE_H = 540;
  const START_X = [330, 630];
  const EDGE = 40, MIN_GAP = 64;
  const WALK = 175, BACK_WALK = 135, JUMP_V = 640, JUMP_X = 190, GRAV = 1900;
  const ROUND_TIME = 30, POINTS_TO_WIN = 4, ROUNDS_TO_WIN = 2;
  const STAND_H = 150, CROUCH_H = 95;
  // phase lengths in seconds
  const T_INTRO = 1.9, T_REMARK = 1.2, T_POINT = 2.0, T_ROUND = 2.8;

  // Moves. startup/active/recover in seconds. reach: how far in front of the attacker's centre it lands.
  // height: 'high' misses a crouching fighter, 'low' misses a jumping one, 'mid' hits both standing and crouching.
  // points: 1 = half point, 2 = full point. crouch: done from a crouch. air: done in a jump.
  // step: forward speed during startup (a lunge).
  const MOVES = {
    jab:        { startup: 0.06, active: 0.08, recover: 0.14, reach: 82,  height: 'high', points: 1 },
    lunge:      { startup: 0.10, active: 0.08, recover: 0.22, reach: 96,  height: 'mid',  points: 1, step: 230 },
    lowpunch:   { startup: 0.07, active: 0.08, recover: 0.16, reach: 78,  height: 'mid',  points: 1, crouch: true },
    frontkick:  { startup: 0.12, active: 0.10, recover: 0.22, reach: 106, height: 'mid',  points: 1 },
    roundhouse: { startup: 0.20, active: 0.10, recover: 0.30, reach: 118, height: 'high', points: 2 },
    spinkick:   { startup: 0.26, active: 0.10, recover: 0.34, reach: 130, height: 'high', points: 2 },
    sweep:      { startup: 0.16, active: 0.12, recover: 0.34, reach: 116, height: 'low',  points: 2, crouch: true },
    flykick:    { startup: 0.08, active: 0.30, recover: 0.12, reach: 100, height: 'high', points: 2, air: true }
  };
  const MOVE_NAMES = Object.keys(MOVES);
  // Fighter states (act). How long the timed ones last:
  const ACTS = ['idle', 'walk', 'crouch', 'block', 'jump', 'attack', 'hit', 'down', 'win', 'lose'];
  const T_BLOCK = 0.22, T_HIT = 0.55, T_DOWN = 1.6;

  const NEUTRAL = { l: false, r: false, u: false, d: false, pc: 0, kc: 0, jc: 0 };

  function newFighter(idx, opts) {
    return { idx, name: opts.name || ('Player ' + (idx + 1)), color: opts.color || (idx ? 'red' : 'white'),
      x: START_X[idx], y: 0, vx: 0, vy: 0, facing: idx ? -1 : 1,
      act: 'idle', move: null, t: 0, phase: null, connected: false,
      crouch: false, walking: 0, blocking: false,
      score: 0, rounds: 0, lp: null, lk: null, lj: null };
  }

  function create(opts) {
    opts = opts || {};
    const M = { ARENA_W, FLOOR_Y, phase: 'intro', phaseT: 0, round: 1, timer: ROUND_TIME, message: 'ROUND 1',
      fighters: [newFighter(0, opts.p1 || {}), newFighter(1, opts.p2 || {})], events: [], winner: -1, pointBy: -1, time: 0, introLong: true };
    return M;
  }

  function toMarks(M) {
    M.fighters.forEach((f, i) => Object.assign(f, { x: START_X[i], y: 0, vx: 0, vy: 0, facing: i ? -1 : 1, act: 'idle', move: null, t: 0,
      phase: null, connected: false, crouch: false, walking: 0, blocking: false }));
  }
  function setPhase(M, p, msg) { M.phase = p; M.phaseT = 0; if (msg !== undefined) M.message = msg; }
  const ev = (M, type, extra) => M.events.push(Object.assign({ type }, extra || {}));

  // ---------- one fighter ----------
  function moveFor(f, inp, punch, kick) {
    const fwd = f.facing > 0 ? inp.r : inp.l, back = f.facing > 0 ? inp.l : inp.r;
    if (punch) return inp.d ? 'lowpunch' : fwd ? 'lunge' : 'jab';
    if (kick) return inp.d ? 'sweep' : fwd ? 'roundhouse' : back ? 'spinkick' : 'frontkick';
    return null;
  }
  function attackPhase(f) {
    const mv = MOVES[f.move];
    if (f.t < mv.startup) return 'startup';
    if (f.t < mv.startup + mv.active) return 'active';
    return 'recover';
  }

  function updFighter(M, f, o, inp, dt, live) {
    const punch = f.lp !== null && inp.pc !== f.lp, kick = f.lk !== null && inp.kc !== f.lk, jump = f.lj !== null && inp.jc !== f.lj;
    f.lp = inp.pc; f.lk = inp.kc; f.lj = inp.jc;
    const fwd = f.facing > 0 ? inp.r : inp.l, back = f.facing > 0 ? inp.l : inp.r;
    const air = f.y > 0 || f.vy > 0;
    f.t += dt;
    f.walking = 0;

    if (f.act === 'attack') {
      const mv = MOVES[f.move], before = f.phase;
      f.phase = attackPhase(f);
      if (before === 'active' && f.phase === 'recover' && !f.connected) ev(M, 'whiff', { x: f.x + f.facing * mv.reach * 0.8, y: 100, by: f.idx, move: f.move });
      if (mv.step && f.phase === 'startup') f.vx = mv.step * f.facing; else if (!air) f.vx = 0;
      if (!mv.air && f.t >= mv.startup + mv.active + mv.recover) { f.act = mv.crouch && inp.d ? 'crouch' : 'idle'; f.move = null; f.phase = null; f.t = 0; }
    } else if (f.act === 'block') {
      f.vx = -f.facing * 60;
      if (f.t >= T_BLOCK) { f.act = f.crouch ? 'crouch' : 'idle'; f.t = 0; }
    } else if (f.act === 'hit') {
      f.vx = -f.facing * 90 * Math.max(0, 1 - f.t / T_HIT);
      if (f.t >= T_HIT) { f.act = 'idle'; f.t = 0; }
    } else if (f.act === 'down') {
      f.vx = 0;
      if (f.t >= T_DOWN && live) { f.act = 'idle'; f.t = 0; }
    } else if (f.act === 'win' || f.act === 'lose') {
      f.vx = 0;
    } else if (f.act === 'jump') {
      if (live && (punch || kick)) { f.act = 'attack'; f.move = 'flykick'; f.t = 0; f.phase = 'startup'; f.connected = false; ev(M, 'swing', { by: f.idx, move: 'flykick' }); }
    } else if (live) {
      // grounded and free: idle / walk / crouch
      const mv = moveFor(f, inp, punch, kick);
      if (mv) {
        f.act = 'attack'; f.move = mv; f.t = 0; f.phase = 'startup'; f.connected = false; f.crouch = !!MOVES[mv].crouch; f.vx = 0;
        ev(M, 'swing', { by: f.idx, move: mv });
      } else if (jump) {
        f.act = 'jump'; f.t = 0; f.vy = JUMP_V; f.vx = fwd ? JUMP_X * f.facing : back ? -JUMP_X * f.facing : 0; f.crouch = false;
        ev(M, 'jump', { by: f.idx });
      } else if (inp.d) {
        if (f.act !== 'crouch') { f.act = 'crouch'; f.t = 0; }
        f.crouch = true; f.vx = 0;
      } else {
        f.crouch = false;
        if (fwd || back) { if (f.act !== 'walk') { f.act = 'walk'; f.t = 0; } f.walking = fwd ? 1 : -1; f.vx = fwd ? WALK * f.facing : -BACK_WALK * f.facing; }
        else { if (f.act !== 'idle') { f.act = 'idle'; f.t = 0; } f.vx = 0; }
      }
    } else if (!air) { f.vx = 0; if (f.act === 'walk') { f.act = 'idle'; f.t = 0; } }

    // blocking: holding back while free on the ground (or already in block stun)
    f.blocking = live && !air && back && (f.act === 'idle' || f.act === 'walk' || f.act === 'crouch' || f.act === 'block');

    // physics
    if (air || f.vy > 0) {
      f.vy -= GRAV * dt; f.y += f.vy * dt;
      if (f.y <= 0) {
        f.y = 0; f.vy = 0; f.vx = 0;
        if (f.act === 'jump' || (f.act === 'attack' && MOVES[f.move].air)) { f.act = 'idle'; f.move = null; f.phase = null; f.t = 0; ev(M, 'land', { by: f.idx, x: f.x }); }
      }
    }
    f.x += f.vx * dt;
    f.x = clamp(f.x, EDGE, ARENA_W - EDGE);
    if (f.act === 'idle' || f.act === 'walk' || f.act === 'crouch') f.facing = o.x >= f.x ? 1 : -1;
  }

  function separate(M) {
    const [a, b] = M.fighters;
    if (Math.abs(a.y - b.y) > 90) return;          // one is jumping over the other
    const dx = b.x - a.x, gap = Math.abs(dx);
    if (gap >= MIN_GAP) return;
    const push = (MIN_GAP - gap) / 2, s = dx >= 0 ? 1 : -1;
    a.x -= push * s; b.x += push * s;
    // against a wall, push the other one instead
    if (a.x < EDGE) { b.x += EDGE - a.x; a.x = EDGE; } if (a.x > ARENA_W - EDGE) { b.x -= a.x - (ARENA_W - EDGE); a.x = ARENA_W - EDGE; }
    if (b.x < EDGE) { a.x += EDGE - b.x; b.x = EDGE; } if (b.x > ARENA_W - EDGE) { a.x -= b.x - (ARENA_W - EDGE); b.x = ARENA_W - EDGE; }
  }

  // ---------- hits ----------
  const HEIGHT_Y = { high: 125, mid: 88, low: 22 };
  function check(a, d) {
    if (a.act !== 'attack' || a.phase !== 'active' || a.connected) return null;
    const mv = MOVES[a.move];
    const ahead = (d.x - a.x) * a.facing;
    if (ahead <= 0 || ahead > mv.reach + 18) return null;
    const dAir = d.y > 24, dCrouch = d.crouch && !dAir;
    const ay = mv.air ? a.y + 95 : HEIGHT_Y[mv.height];
    if (Math.abs(ay - (d.y + (dCrouch ? CROUCH_H : STAND_H) / 2)) > (dCrouch ? CROUCH_H : STAND_H) / 2 + 30) return null;  // vertical miss
    if (mv.height === 'high' && dCrouch) return null;
    if (mv.height === 'low' && dAir) return null;
    const canBlock = d.blocking && !dAir && (dCrouch ? mv.height !== 'high' : mv.height !== 'low');
    return { kind: canBlock ? 'block' : 'hit', points: mv.points, x: d.x - a.facing * 14, y: ay };
  }

  function resolveHits(M) {
    const [f0, f1] = M.fighters;
    const r0 = check(f0, f1), r1 = check(f1, f0);
    if (r0 && r1 && r0.kind === 'hit' && r1.kind === 'hit') {
      f0.connected = f1.connected = true;
      for (const f of M.fighters) { f.act = 'block'; f.t = 0; f.move = null; f.phase = null; }
      ev(M, 'clash', { x: (f0.x + f1.x) / 2, y: (r0.y + r1.y) / 2, by: -1 });
      return;
    }
    for (const [a, d, r] of [[f0, f1, r0], [f1, f0, r1]]) {
      if (!r) continue;
      a.connected = true;
      if (r.kind === 'block') {
        d.act = 'block'; d.t = 0; d.facing = a.x <= d.x ? -1 : 1;
        ev(M, 'block', { x: r.x, y: r.y, by: a.idx });
      } else if (M.phase === 'fight') {
        a.score += r.points;
        d.act = r.points >= 2 ? 'down' : 'hit'; d.t = 0; d.move = null; d.phase = null; d.crouch = false;
        if (d.y > 0 && d.act === 'hit') d.act = 'down';
        M.pointBy = a.idx;
        ev(M, 'hit', { x: r.x, y: r.y, by: a.idx, points: r.points });
        setPhase(M, 'point', (r.points >= 2 ? 'FULL POINT' : 'HALF POINT') + ' - ' + a.name);
        return;
      }
    }
  }

  // ---------- the match ----------
  function step(M, inputs, dt) {
    M.events = [];
    M.time += dt; M.phaseT += dt;
    const [f0, f1] = M.fighters, live = M.phase === 'fight';
    const i0 = (inputs && inputs[0]) || NEUTRAL, i1 = (inputs && inputs[1]) || NEUTRAL;
    // outside "fight" the fighters still finish what they were doing but take no new commands
    updFighter(M, f0, f1, live ? i0 : Object.assign({}, NEUTRAL, { pc: i0.pc, kc: i0.kc, jc: i0.jc }), dt, live);
    updFighter(M, f1, f0, live ? i1 : Object.assign({}, NEUTRAL, { pc: i1.pc, kc: i1.kc, jc: i1.jc }), dt, live);
    separate(M);
    if (live) {
      resolveHits(M);
      if (M.phase === 'fight') {
        M.timer = Math.max(0, M.timer - dt);
        if (M.timer <= 0) timeUp(M);
      }
    } else if (M.phase === 'intro') {
      if (M.introLong && M.phaseT > T_INTRO * 0.55) M.message = 'BEGIN';
      if (M.phaseT >= (M.introLong ? T_INTRO : T_REMARK)) { setPhase(M, 'fight', ''); ev(M, 'begin'); }
    } else if (M.phase === 'point') {
      if (M.phaseT >= T_POINT) {
        const a = M.fighters[M.pointBy];
        if (a.score >= POINTS_TO_WIN) endRound(M, a.idx, a.name + ' WINS ROUND ' + M.round);
        else { toMarks(M); M.introLong = false; setPhase(M, 'intro', 'BEGIN'); }
      }
    } else if (M.phase === 'roundOver') {
      if (M.phaseT >= T_ROUND) {
        const champ = M.fighters.find(f => f.rounds >= ROUNDS_TO_WIN);
        if (champ) { M.winner = champ.idx; setPhase(M, 'matchOver', champ.name + ' WINS!'); ev(M, 'matchOver', { by: champ.idx }); champ.act = 'win'; M.fighters[1 - champ.idx].act = 'lose'; }
        else nextRound(M);
      }
    }
    return M.events;
  }
  function timeUp(M) {
    const [a, b] = M.fighters;
    ev(M, 'time');
    if (a.score === b.score) endRound(M, -1, 'TIME - DRAW');
    else { const w = a.score > b.score ? a : b; endRound(M, w.idx, 'TIME - ' + w.name + ' WINS ROUND ' + M.round); }
  }
  function endRound(M, w, msg) {
    if (w >= 0) { M.fighters[w].rounds++; M.fighters[w].act = 'win'; M.fighters[1 - w].act = 'lose'; M.fighters.forEach(f => { f.t = 0; f.move = null; f.phase = null; f.crouch = false; }); }
    ev(M, 'roundOver', { by: w });
    setPhase(M, 'roundOver', msg);
  }
  function nextRound(M) {
    M.round++; M.timer = ROUND_TIME;
    M.fighters.forEach(f => { f.score = 0; });
    toMarks(M); M.introLong = true;
    setPhase(M, 'intro', 'ROUND ' + M.round);
  }

  // ---------- network snapshots (host -> joiner) ----------
  const r1 = v => Math.round(v * 10) / 10, r3 = v => Math.round(v * 1000) / 1000;
  function snapshot(M) {
    return { p: M.phase, pt: r3(M.phaseT), r: M.round, tm: r3(M.timer), msg: M.message, w: M.winner, pb: M.pointBy, il: M.introLong ? 1 : 0,
      f: M.fighters.map(f => [r1(f.x), r1(f.y), r1(f.vx), r1(f.vy), f.facing, ACTS.indexOf(f.act), f.move ? MOVE_NAMES.indexOf(f.move) : -1,
        r3(f.t), f.score, f.rounds, (f.crouch ? 1 : 0) | (f.blocking ? 2 : 0) | (f.connected ? 4 : 0), f.walking]) };
  }
  function applySnapshot(M, s) {
    M.phase = s.p; M.phaseT = s.pt; M.round = s.r; M.timer = s.tm; M.message = s.msg; M.winner = s.w; M.pointBy = s.pb; M.introLong = !!s.il;
    s.f.forEach((a, i) => {
      const f = M.fighters[i];
      f.nx = a[0]; f.y = a[1]; f.vx = a[2]; f.vy = a[3]; f.facing = a[4]; f.act = ACTS[a[5]] || 'idle';
      f.move = a[6] >= 0 ? MOVE_NAMES[a[6]] : null; f.t = a[7]; f.score = a[8]; f.rounds = a[9];
      f.crouch = !!(a[10] & 1); f.blocking = !!(a[10] & 2); f.connected = !!(a[10] & 4); f.walking = a[11];
      f.phase = f.move ? attackPhase(f) : null;
      if (f.x === undefined || Math.abs(f.x - f.nx) > 120) f.x = f.nx;
    });
  }
  // between snapshots a joiner keeps animations moving and eases toward the host's positions
  function coast(M, dt) {
    M.phaseT += dt;
    if (M.phase === 'fight') M.timer = Math.max(0, M.timer - dt);
    for (const f of M.fighters) {
      f.t += dt;
      if (f.move) f.phase = attackPhase(f);
      if (f.nx !== undefined) { f.nx += f.vx * dt; f.x = lerp(f.x, f.nx, Math.min(1, dt * 18)); }
      if (f.y > 0 || f.vy > 0) { f.vy -= GRAV * dt; f.y = Math.max(0, f.y + f.vy * dt); }
    }
  }

  return { ARENA_W, FLOOR_Y, STAGE_H, START_X, MOVES, ACTS, ROUND_TIME, POINTS_TO_WIN, ROUNDS_TO_WIN, T_BLOCK, T_HIT, T_DOWN, STAND_H, CROUCH_H, NEUTRAL,
    create, step, snapshot, applySnapshot, coast, attackPhase };
})();
