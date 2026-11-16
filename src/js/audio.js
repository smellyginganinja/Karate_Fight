/* Sound: small Web Audio synth for fight sounds (no audio files). Every entry point is wrapped
   in try/catch and nothing plays until a key press or click has unlocked audio. M mutes. */
const Sound = (() => {
  let ac = null, master = null, noise = null, muted = !!store.get('muted', false);
  const safe = fn => (...a) => { try { return fn(...a); } catch (e) {} };
  function init() {
    if (ac) { if (ac.state === 'suspended') ac.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    ac = new AC(); master = ac.createGain(); master.gain.value = muted ? 0 : 0.6; master.connect(ac.destination);
    noise = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
    const d = noise.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  ['keydown', 'pointerdown', 'touchstart'].forEach(e => addEventListener(e, safe(init), { passive: true }));

  function env(g, t, a, peak, dec) { g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + a + dec); }
  function tone(type, f0, f1, dur, vol, delay) {
    const t = ac.currentTime + (delay || 0), o = ac.createOscillator(), g = ac.createGain();
    o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    env(g, t, 0.005, vol, dur); o.connect(g); g.connect(master); o.start(t); o.stop(t + dur + 0.05);
  }
  function hiss(freq, q, dur, vol, delay, sweepTo) {
    const t = ac.currentTime + (delay || 0), s = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
    s.buffer = noise; f.type = 'bandpass'; f.Q.value = q; f.frequency.setValueAtTime(freq, t);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    env(g, t, 0.01, vol, dur); s.connect(f); f.connect(g); g.connect(master); s.start(t); s.stop(t + dur + 0.05);
  }
  const fx = {
    swing: () => hiss(900, 1.2, 0.16, 0.35, 0, 2600),
    jump: () => tone('triangle', 220, 440, 0.12, 0.15),
    land: () => tone('sine', 120, 60, 0.08, 0.25),
    hit: p => { tone('sine', 160, 45, 0.22, 0.9); hiss(2400, 0.8, 0.07, 0.6); if (p >= 2) tone('square', 660, 640, 0.35, 0.12, 0.08); },
    block: () => { hiss(3200, 4, 0.05, 0.5); tone('square', 900, 700, 0.04, 0.1); },
    clash: () => { hiss(3000, 3, 0.08, 0.6); tone('square', 1200, 900, 0.06, 0.12); },
    begin: () => { tone('square', 523, 523, 0.12, 0.12); tone('square', 784, 784, 0.22, 0.12, 0.12); },
    roundOver: () => [392, 523, 659, 784].forEach((n, i) => tone('triangle', n, n, 0.25, 0.18, i * 0.12)),
    time: () => tone('square', 330, 330, 0.5, 0.15),
    menuMove: () => tone('square', 660, 660, 0.04, 0.06),
    menuSelect: () => { tone('square', 660, 660, 0.05, 0.08); tone('square', 990, 990, 0.08, 0.08, 0.05); }
  };
  return {
    get muted() { return muted; },
    play: safe((name, arg) => { if (!ac || muted || !fx[name]) return; fx[name](arg); }),
    // play the sounds for a step's fight events
    events: safe(evs => { for (const e of evs) { if (e.type === 'hit') fx.hit && Sound.play('hit', e.points); else if (e.type !== 'whiff' && e.type !== 'matchOver') Sound.play(e.type); } }),
    toggleMute: safe(() => { muted = !muted; store.set('muted', muted); if (master) master.gain.value = muted ? 0 : 0.6; })
  };
})();
