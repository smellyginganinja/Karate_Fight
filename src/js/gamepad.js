/* Gamepads: polls up to two connected pads once per frame.
   pads[0] is player 1's and pads[1] player 2's in 2-player mode. Any pad can also drive the menus.
   Mapping (standard layout): left stick or d-pad to move (up jumps, down crouches),
   X/Square punch, B/Circle or Y/Triangle kick, A/Cross jump, Start pause, Back/Select menu. */
const GamepadInput = (() => {
  const blank = () => ({ active: false, l: false, r: false, u: false, d: false, pc: 0, kc: 0, jc: 0 });
  const pads = [blank(), blank()];
  const st = [{ prev: [], up: false, dir: 0 }, { prev: [], up: false, dir: 0 }];
  const DZ = 0.4;

  function list() {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return [];
    const all = Array.from(navigator.getGamepads() || []).filter(Boolean);
    return all.filter(p => p.mapping === 'standard').concat(all.filter(p => p.mapping !== 'standard')).slice(0, 2);
  }

  function pollPad(pad, c, s) {
    const btn = i => !!(pad.buttons[i] && pad.buttons[i].pressed);
    const edge = i => btn(i) && !s.prev[i];
    const ax = pad.axes[0] || 0, ay = pad.axes[1] || 0;
    c.l = btn(14) || ax < -DZ; c.r = btn(15) || ax > DZ;
    c.u = btn(12) || ay < -0.6; c.d = btn(13) || ay > 0.6;
    if (pad.buttons.some(b => b && b.pressed) || Math.abs(ax) > DZ || Math.abs(ay) > DZ) c.active = true;
    if (edge(2)) c.pc++;
    if (edge(1) || edge(3)) c.kc++;
    if (edge(0) || (c.u && !s.up)) c.jc++;
    s.up = c.u;
    // menus
    const dir = c.l ? -1 : c.r ? 1 : 0;
    if (dir && dir !== s.dir) pressed[dir < 0 ? 'ArrowLeft' : 'ArrowRight'] = true;
    s.dir = dir;
    if (edge(12) || (ay < -0.6 && !s.prevUpMenu)) pressed.ArrowUp = true;
    if (edge(13) || (ay > 0.6 && !s.prevDownMenu)) pressed.ArrowDown = true;
    s.prevUpMenu = ay < -0.6; s.prevDownMenu = ay > 0.6;
    if (edge(0)) pressed.Enter = true;
    if (edge(9)) pressed.KeyP = true;
    if (edge(8)) pressed.Escape = true;
    s.prev = pad.buttons.map(b => !!(b && b.pressed));
  }

  return {
    pads,
    poll() {
      try {
        const l = list();
        for (let k = 0; k < 2; k++) {
          if (l[k]) pollPad(l[k], pads[k], st[k]);
          else { Object.assign(pads[k], { active: false, l: false, r: false, u: false, d: false }); st[k].prev = []; }
        }
      } catch (e) { pads.forEach(c => { c.active = false; }); }
    }
  };
})();
