/* CPU opponent. Produces the same kind of input a player would ({ l, r, u, d, pc, kc, jc }),
   so the fight rules treat it exactly like a person. level 0..1 sets reaction time and accuracy. */
function makeCpu(level) {
  const m = { level: clamp(level, 0, 1), next: 0, hold: { l: false, r: false, u: false, d: false }, pc: 0, kc: 0, jc: 0, t: 0 };
  return function cpuInput(M, me, dt) {
    m.t += dt;
    const f = M.fighters[me], o = M.fighters[1 - me];
    const out = () => Object.assign({}, m.hold, { pc: m.pc, kc: m.kc, jc: m.jc });
    if (M.phase !== 'fight' || m.t < m.next) return out();
    const L = m.level, rnd = Math.random;
    m.next = m.t + lerp(0.32, 0.1, L) + rnd() * 0.1;
    const fwdKey = f.facing > 0 ? 'r' : 'l', backKey = f.facing > 0 ? 'l' : 'r';
    m.hold = { l: false, r: false, u: false, d: false };
    const dist = Math.abs(o.x - f.x);
    const busy = f.act === 'attack' || f.act === 'hit' || f.act === 'down' || f.act === 'block' || f.act === 'jump';
    if (busy) {
      if (f.act === 'jump' && dist < 190 && rnd() < 0.5 + L * 0.4) m.kc++;
      return out();
    }
    // defend against an attack that is coming
    if (o.act === 'attack' && o.phase !== 'recover') {
      const mv = Fight.MOVES[o.move];
      if (dist < mv.reach + 30 && rnd() < 0.25 + L * 0.55) {
        if (mv.height === 'low' && rnd() < 0.5) { m.jc++; return out(); }
        m.hold[backKey] = true;
        if (mv.height !== 'high' && mv.height !== 'mid') m.hold.d = true;
        else if (mv.height === 'high' && rnd() < 0.5) m.hold.d = true;   // duck under it
        return out();
      }
    }
    // punish a whiffed move
    const opening = o.act === 'attack' && o.phase === 'recover' || o.act === 'hit';
    const inRange = reach => dist <= reach + 6;
    const choices = [];
    if (inRange(82)) choices.push(['jab', 2], ['lowpunch', 1.5]);
    if (inRange(96) && dist > 60) choices.push(['lunge', 1]);
    if (inRange(106)) choices.push(['frontkick', 2]);
    if (inRange(118)) choices.push(['roundhouse', 1.5 + L]);
    if (inRange(116)) choices.push(['sweep', o.crouch ? 0.5 : 1.2 + L]);
    if (inRange(130) && dist > 90) choices.push(['spinkick', 0.8]);
    const attackChance = opening ? 0.9 : 0.25 + L * 0.35;
    if (choices.length && rnd() < attackChance) {
      let tot = choices.reduce((s, c) => s + c[1], 0), pick = rnd() * tot, mv = choices[0][0];
      for (const c of choices) { pick -= c[1]; if (pick <= 0) { mv = c[0]; break; } }
      if (mv === 'jab') m.pc++;
      else if (mv === 'lowpunch') { m.hold.d = true; m.pc++; }
      else if (mv === 'lunge') { m.hold[fwdKey] = true; m.pc++; }
      else if (mv === 'frontkick') m.kc++;
      else if (mv === 'roundhouse') { m.hold[fwdKey] = true; m.kc++; }
      else if (mv === 'spinkick') { m.hold[backKey] = true; m.kc++; }
      else if (mv === 'sweep') { m.hold.d = true; m.kc++; }
      return out();
    }
    if (dist > 150 && dist < 240 && rnd() < 0.08 + L * 0.1) { m.hold[fwdKey] = true; m.jc++; return out(); }
    if (dist > 125) { if (rnd() < 0.85) m.hold[fwdKey] = true; }
    else if (dist < 80 && rnd() < 0.4) m.hold[backKey] = true;
    else if (rnd() < 0.3) m.hold[rnd() < 0.5 ? fwdKey : backKey] = true;
    return out();
  };
}
