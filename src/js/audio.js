/* Sound: small Web Audio synth for fight sounds, crowd cheers and the chiptune music (no audio
   files). Every entry point is wrapped in try/catch and nothing plays until a key press or click
   has unlocked audio. M mutes everything, N turns the music on and off. */
const Sound = (() => {
  let ac = null, master = null, noise = null, muted = !!store.get('muted', false);
  const safe = fn => (...a) => { try { return fn(...a); } catch (e) {} };
  function init() {
    if (ac) { if (ac.state !== 'running' && !document.hidden) ac.resume().then(safe(applySong)); return; }
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    ac = new AC(); master = ac.createGain(); master.gain.value = muted ? 0 : 0.6; master.connect(ac.destination);
    noise = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
    const d = noise.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  // every kind of first touch, click or key press can unlock audio (Safari is picky about which count)
  const UNLOCK = ['keydown', 'keyup', 'pointerdown', 'mousedown', 'click', 'touchstart', 'touchend'];
  UNLOCK.forEach(e => addEventListener(e, safe(init), { passive: true, capture: true }));

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

  // ---------- crowd ----------
  // A cheer: a filtered-noise roar, a handful of rising "hey!" voices, scattered claps and,
  // for full points and up, a whistle. size: 1 half point, 2 full point, 3 round, 4 match.
  function voice(t, f0, dur, vol) {
    const o = ac.createOscillator(), g = ac.createGain(), out = ac.createGain();
    o.type = 'sawtooth'; o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f0 * 1.3, t + 0.18); o.frequency.exponentialRampToValueAtTime(f0 * 0.9, t + dur);
    [[720, 5], [1150, 6], [2500, 8]].forEach(([fr, q], i) => {           // rough "ay" vowel formants
      const b = ac.createBiquadFilter(); b.type = 'bandpass'; b.frequency.value = fr * (0.95 + Math.random() * 0.1); b.Q.value = q;
      const bg = ac.createGain(); bg.gain.value = [1, 0.7, 0.25][i]; o.connect(b); b.connect(bg); bg.connect(g);
    });
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.06);
    g.gain.setValueAtTime(vol, t + dur * 0.5); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    g.connect(out); out.connect(master); o.start(t); o.stop(t + dur + 0.05);
  }
  function roar(t, freq, q, vol, rise, dur) {
    const s = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
    s.buffer = noise; s.loop = true; s.playbackRate.value = 0.8 + Math.random() * 0.4;
    f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + rise);
    g.gain.setTargetAtTime(0.0001, t + rise + dur * 0.25, dur * 0.3);
    s.connect(f); f.connect(g); g.connect(master); s.start(t); s.stop(t + rise + dur * 1.6);
  }
  function cheer(size) {
    const t = ac.currentTime + 0.03, dur = 0.8 + size * 0.5, vol = 0.12 + size * 0.06;
    roar(t, 700, 0.6, vol, 0.12, dur);
    roar(t, 1800, 1.2, vol * 0.45, 0.15, dur * 0.9);
    for (let i = 0; i < 3 + size * 3; i++) voice(t + Math.random() * 0.25 * size, 150 + Math.random() * 260, 0.35 + Math.random() * 0.5, 0.05 + Math.random() * 0.03);
    for (let i = 0; i < size * 7; i++) hiss(1500 + Math.random() * 1500, 1.5, 0.03, 0.18 + Math.random() * 0.15, 0.08 + Math.random() * dur * 0.8);
    if (size >= 2) {                                                         // two-finger whistle
      const o = ac.createOscillator(), g = ac.createGain(), w = t + 0.15 + Math.random() * 0.2;
      o.type = 'sine'; o.frequency.setValueAtTime(1900, w); o.frequency.exponentialRampToValueAtTime(2700, w + 0.12);
      o.frequency.setValueAtTime(2700, w + 0.3); o.frequency.exponentialRampToValueAtTime(2200, w + 0.5);
      env(g, w, 0.03, 0.05, 0.5); o.connect(g); g.connect(master); o.start(w); o.stop(w + 0.6);
    }
  }
  fx.cheer = cheer;

  // low crowd murmur under the fight music
  let murmur = null;
  function murmurOn(on) {
    if (on && !murmur) {
      const s = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain(), lfo = ac.createOscillator(), lg = ac.createGain();
      s.buffer = noise; s.loop = true; s.playbackRate.value = 0.5;
      f.type = 'bandpass'; f.frequency.value = 450; f.Q.value = 0.8;
      g.gain.setValueAtTime(0.0001, ac.currentTime); g.gain.exponentialRampToValueAtTime(0.03, ac.currentTime + 1.5);
      lfo.frequency.value = 0.23; lg.gain.value = 0.01; lfo.connect(lg); lg.connect(g.gain);
      s.connect(f); f.connect(g); g.connect(master); s.start(); lfo.start();
      murmur = { s, g, lfo };
    } else if (!on && murmur) {
      const m = murmur, t = ac.currentTime; murmur = null;
      m.g.gain.cancelScheduledValues(t); m.g.gain.setValueAtTime(m.g.gain.value, t); m.g.gain.linearRampToValueAtTime(0, t + 0.4);
      m.s.stop(t + 0.5); m.lfo.stop(t + 0.5);
    }
  }

  // ---------- music ----------
  // Original chiptune loops in an A minor pentatonic, arcade style: a pulse-wave lead with a
  // short echo, a triangle bass and noise drums. Notes are written one token per 16th note:
  // a note name starts a note, '-' holds it, '.' is a rest.
  const midi = n => { const m = /^([A-G])([#b]?)(\d)$/.exec(n); return 12 * (+m[3] + 1) + { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0); };
  const hz = m => 440 * Math.pow(2, (m - 69) / 12);
  function parse(str) {                      // -> array indexed by step of [midi, lengthInSteps] or null
    const tok = str.trim().split(/\s+/), out = new Array(tok.length).fill(null);
    let last = -1;
    tok.forEach((k, i) => { if (k === '-') { if (last >= 0) out[last][1]++; } else if (k === '.') last = -1; else { out[i] = [midi(k), 1]; last = i; } });
    return out;
  }
  // bass bar: pattern tokens 0 = root, 1 = root an octave up, 5 = the fifth, '.' rest, '-' hold
  const bassBar = (root, pat) => pat.split(' ').map(k => k === '.' || k === '-' ? k : root.replace(/\d/, d => +d + (k === '1' ? 1 : 0)) + (k === '5' ? '+7' : '')).join(' ');
  function parseBass(bars) {
    return parse(bars.map(([r, p]) => bassBar(r, p)).join(' ').replace(/(\S+)\+7/g, (a, n) => { const m = midi(n) + 7, names = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']; return names[m % 12] + (Math.floor(m / 12) - 1); }));
  }
  const SONGS = {
    // menu: relaxed, 112 bpm, 8 bars
    menu: {
      bpm: 112,
      lead: parse(`
        A4 - - - C5 - D5 - E5 - - - D5 - C5 -   D5 - - - E5 - G5 - E5 - D5 - C5 - - -
        A4 - - - C5 - D5 - E5 - G5 - A5 - - -   G5 - E5 - D5 - E5 - A4 - - - - - . .
        C5 - - - D5 - E5 - G5 - - - E5 - D5 -   E5 - - - D5 - C5 - D5 - - - - - . .
        A5 - G5 - E5 - D5 - E5 - G5 - E5 - D5 -  C5 - D5 - B4 - - - A4 - - - - - . .`),
      bass: parseBass([['A2', '0 - . 1 . 5 . 1 0 - . 1 . 5 . 1'], ['D2', '0 - . 1 . 5 . 1 0 - . 1 . 5 . 1'], ['A2', '0 - . 1 . 5 . 1 0 - . 1 . 5 . 1'], ['E2', '0 - . 1 . 5 . 1 0 - . 1 . 5 . 1'],
                       ['F2', '0 - . 1 . 5 . 1 0 - . 1 . 5 . 1'], ['G2', '0 - . 1 . 5 . 1 0 - . 1 . 5 . 1'], ['F2', '0 - . 1 . 5 . 1 0 - . 1 . 5 . 1'], ['E2', '0 - . 1 . 5 . 1 0 - . 1 0 1 0']]),
      drums: 'k . h . s . h . k . h k s . h .',
      vol: 0.8
    },
    // fight: driving, 150 bpm, 8 bars
    fight: {
      bpm: 150,
      lead: parse(`
        A4 . A4 . C5 . A4 . D5 . C5 . A4 . G4 .   A4 . A4 . C5 . D5 . E5 - - . D5 . C5 .
        A4 . A4 . C5 . A4 . D5 . C5 . A4 . G4 .   E5 . D5 . C5 . D5 . A4 - - - - - . .
        E5 - - . G5 - - . A5 - - . G5 . E5 .   D5 - - . E5 - - . G5 - E5 - D5 . C5 .
        E5 - - . G5 - - . A5 - - . C6 . A5 .   G5 . E5 . D5 . C5 . D5 - - - E5 - - -`),
      bass: parseBass([['A2', '0 0 1 0 0 0 1 0 0 0 1 0 0 0 1 0'], ['A2', '0 0 1 0 0 0 1 0 0 0 1 0 5 5 1 5'], ['A2', '0 0 1 0 0 0 1 0 0 0 1 0 0 0 1 0'], ['E2', '0 0 1 0 0 0 1 0 0 0 1 0 0 1 0 1'],
                       ['C3', '0 0 1 0 0 0 1 0 0 0 1 0 0 0 1 0'], ['D3', '0 0 1 0 0 0 1 0 0 0 1 0 0 0 1 0'], ['F2', '0 0 1 0 0 0 1 0 0 0 1 0 0 0 1 0'], ['E2', '0 0 1 0 0 0 1 0 5 5 1 5 1 0 1 0']]),
      drums: 'k . h . s . h k k . h . s . h h',
      vol: 0.7
    }
  };
  let pulse = null, musicBus = null, echo = null, song = null, songName = null, wantSong = null, step = 0, nextT = 0;
  let musicOn = store.get('music', true) !== false;
  function musicInit() {
    if (musicBus) return;
    const n = 32, re = new Float32Array(n), im = new Float32Array(n);
    for (let i = 1; i < n; i++) re[i] = 2 / (i * Math.PI) * Math.sin(i * Math.PI * 0.25);   // 25% pulse wave
    pulse = ac.createPeriodicWave(re, im);
    musicBus = ac.createGain(); musicBus.gain.value = 0; musicBus.connect(master);
    echo = ac.createDelay(1); const fb = ac.createGain(), wet = ac.createGain();
    fb.gain.value = 0.28; wet.gain.value = 0.3; echo.connect(fb); fb.connect(echo); echo.connect(wet); wet.connect(musicBus);
  }
  function note(type, f, t, len, vol, toEcho) {
    const o = ac.createOscillator(), g = ac.createGain();
    if (type === 'pulse') o.setPeriodicWave(pulse); else o.type = type;
    o.frequency.setValueAtTime(f, t);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.006);
    g.gain.setValueAtTime(vol * 0.75, t + Math.min(0.05, len * 0.3)); g.gain.setValueAtTime(vol * 0.75, t + len * 0.85); g.gain.linearRampToValueAtTime(0, t + len);
    o.connect(g); g.connect(musicBus); if (toEcho) g.connect(echo); o.start(t); o.stop(t + len + 0.02);
  }
  function drum(k, t) {
    if (k === 'k') { const o = ac.createOscillator(), g = ac.createGain(); o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(40, t + 0.12); env(g, t, 0.003, 0.5, 0.13); o.connect(g); g.connect(musicBus); o.start(t); o.stop(t + 0.2); }
    else {
      const s = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain(), d = k === 's' ? 0.12 : 0.03;
      s.buffer = noise; s.playbackRate.value = 1 + Math.random() * 0.2; f.type = k === 's' ? 'bandpass' : 'highpass'; f.frequency.value = k === 's' ? 1800 : 7000; f.Q.value = 0.7;
      env(g, t, 0.002, k === 's' ? 0.35 : 0.12, d); s.connect(f); f.connect(g); g.connect(musicBus); s.start(t, Math.random() * 0.5); s.stop(t + d + 0.03);
    }
  }
  const DRUMS = {};
  function tick() {
    if (!ac || ac.state !== 'running' || !song) return;
    const sp = 60 / song.bpm / 4, len = song.lead.length;
    if (nextT < ac.currentTime) nextT = ac.currentTime + 0.05;
    const dr = DRUMS[songName] || (DRUMS[songName] = song.drums.split(' '));
    while (nextT < ac.currentTime + 0.2) {
      const L = song.lead[step], B = song.bass[step % song.bass.length], D = dr[step % dr.length];
      if (L) note('pulse', hz(L[0]), nextT, L[1] * sp * 0.95, 0.09 * song.vol, true);
      if (B) note('triangle', hz(B[0]), nextT, B[1] * sp * 0.9, 0.22 * song.vol);
      if (D !== '.') drum(D, nextT);
      step = (step + 1) % len; nextT += sp;
    }
  }
  setInterval(safe(tick), 40);
  function applySong() {
    if (!ac) return;
    musicInit();
    murmurOn(wantSong === 'fight');
    const name = musicOn ? wantSong : null;
    if (name === songName) return;
    const t = ac.currentTime;
    musicBus.gain.cancelScheduledValues(t); musicBus.gain.setValueAtTime(musicBus.gain.value, t);
    if (!name) { musicBus.gain.linearRampToValueAtTime(0, t + 0.3); song = null; songName = null; return; }
    // fade out what is playing, then start the new loop from the top
    musicBus.gain.linearRampToValueAtTime(0, t + 0.15); musicBus.gain.linearRampToValueAtTime(1, t + 0.35);
    song = SONGS[name]; songName = name; step = 0; nextT = t + 0.2;
  }
  // pause everything while the tab is hidden (timers are throttled there, which would garble the music)
  document.addEventListener('visibilitychange', safe(() => { if (!ac) return; if (document.hidden) ac.suspend(); else ac.resume(); }));
  UNLOCK.forEach(e => addEventListener(e, safe(applySong), { passive: true, capture: true }));

  return {
    get muted() { return muted; },
    get musicOn() { return musicOn; },
    play: safe((name, arg) => { if (!ac || muted || !fx[name]) return; fx[name](arg); }),
    // play the sounds for a step's fight events; the crowd cheers every point scored and every round won
    events: safe(evs => {
      for (const e of evs) {
        if (e.type === 'hit') { Sound.play('hit', e.points); Sound.play('cheer', e.points >= 2 ? 2 : 1); }
        else if (e.type === 'roundOver') { Sound.play('roundOver'); if (e.by >= 0) Sound.play('cheer', 3); }
        else if (e.type === 'matchOver') Sound.play('cheer', 4);
        else if (e.type !== 'whiff') Sound.play(e.type);
      }
    }),
    // choose the background loop: 'menu', 'fight' or null. Cheap to call every frame.
    music: safe(name => { if (name === wantSong) return; wantSong = name; applySong(); }),
    toggleMute: safe(() => { muted = !muted; store.set('muted', muted); if (master) master.gain.value = muted ? 0 : 0.6; }),
    toggleMusic: safe(() => { musicOn = !musicOn; store.set('music', musicOn); applySong(); })
  };
})();
