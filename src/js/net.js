/* Net: transport-agnostic messaging for online matches.
   A transport connects everyone in one room (named by a short room code) and offers:
     id                      this player's id in the room
     send(to, msg)           message one player
     broadcast(msg)          message everyone else in the room (a joiner's broadcast reaches the host)
     onMessage(fn(from,msg)) receive
     close()
   Optional voice chat: voiceStart() -> Promise, voiceStop(), voiceSync(ids), voiceMute(bool).
   The game uses a host-authoritative model: the host simulates the fight and broadcasts snapshots;
   joiners only send their controls. Transports:
     peer  - WebRTC peer-to-peer via PeerJS. The free public PeerJS server only introduces players;
             game data and voice then flow directly between their computers. Needs internet.
     local - BroadcastChannel: windows/tabs on the same computer (testing; add ?net=local to the URL)
   Problems are reported to the game as a { t: 'neterr', msg } message. */
const Net = (() => {
  const randId = () => Math.random().toString(36).slice(2, 10);
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no I/O/0/1 to avoid confusion
  const newCode = () => Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  const cleanCode = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  const params = (() => { try { return new URLSearchParams(location.search); } catch (e) { return new URLSearchParams(''); } })();

  function localTransport(code) {
    if (typeof BroadcastChannel === 'undefined') throw new Error('BroadcastChannel not supported');
    const id = randId(), ch = new BroadcastChannel('karatefight-room-' + code);
    let handler = () => {};
    ch.onmessage = e => {
      const m = e.data;
      if (!m || m.from === id || (m.to && m.to !== id)) return;
      try { handler(m.from, m.body); } catch (err) { console.error(err); }
    };
    return {
      id, kind: 'local',
      send(to, body) { ch.postMessage({ from: id, to, body }); },
      broadcast(body) { ch.postMessage({ from: id, body }); },
      onMessage(fn) { handler = fn; },
      close() { try { ch.close(); } catch (e) {} }
    };
  }

  function peerTransport(code, role) {
    if (typeof Peer === 'undefined') throw new Error('PeerJS not loaded');
    const hostPid = 'kfight-' + code;
    const id = role === 'host' ? hostPid : hostPid + '-' + randId();
    const opts = { debug: 0, config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:global.stun.twilio.com:3478' }] } };
    if (params.get('peerhost')) Object.assign(opts, { host: params.get('peerhost'), port: +params.get('peerport') || 9000, path: '/', secure: false });
    const peer = new Peer(id, opts);
    const conns = {};               // peer id -> open DataConnection
    let handler = () => {}, closed = false;
    const deliver = (from, m) => { if (!closed) try { handler(from, m); } catch (err) { console.error(err); } };
    const fail = msg => deliver(role === 'host' ? id : hostPid, { t: 'neterr', msg });

    function wire(conn) {
      conn.on('open', () => { conns[conn.peer] = conn; });
      conn.on('data', d => deliver(conn.peer, d));
      conn.on('close', () => {
        if (conns[conn.peer] !== conn) return;
        delete conns[conn.peer];
        deliver(conn.peer, role === 'host' ? { t: 'bye' } : { t: 'closed' });
      });
      conn.on('error', e => console.warn('conn error', e));
    }
    peer.on('open', () => {
      if (role !== 'host') wire(peer.connect(hostPid, { serialization: 'json', reliable: true }));
    });
    if (role === 'host') peer.on('connection', conn => { if (conn.peer.startsWith(hostPid + '-')) wire(conn); else conn.close(); });
    peer.on('error', e => {
      const t = e && e.type;
      if (t === 'peer-unavailable') fail('No room found with code ' + code);
      else if (t === 'unavailable-id') fail('Room code ' + code + ' is busy, try hosting again');
      else if (t === 'network' || t === 'server-error' || t === 'socket-error' || t === 'socket-closed') fail('Could not reach the online server. Check your internet connection.');
      else if (t === 'browser-incompatible') fail('This browser cannot play online');
      else console.warn('peer error', t, e);
    });
    peer.on('disconnected', () => { if (!closed) try { peer.reconnect(); } catch (e) {} });

    // ---- voice chat: a full mesh of audio calls between players who switched voice on ----
    let mic = null, muted = false;
    const calls = {};               // peer id -> { call, audio }
    function endCall(pid) {
      const c = calls[pid]; if (!c) return;
      delete calls[pid];
      try { c.call.close(); } catch (e) {}
      if (c.audio) { c.audio.srcObject = null; c.audio.remove(); }
    }
    function attach(pid, call) {
      endCall(pid);
      const rec = { call, audio: null };
      calls[pid] = rec;
      call.on('stream', s => {
        if (rec.audio) return;
        const a = document.createElement('audio');
        a.autoplay = true; a.playsInline = true; a.srcObject = s; a.style.display = 'none';
        document.body.appendChild(a); rec.audio = a;
        const p = a.play(); if (p && p.catch) p.catch(() => {});
      });
      call.on('close', () => { if (calls[pid] === rec) endCall(pid); });
      call.on('error', () => { if (calls[pid] === rec) endCall(pid); });
    }
    peer.on('call', call => {
      if (!mic) { call.close(); return; }
      call.answer(mic); attach(call.peer, call);
    });

    return {
      id, kind: 'peer',
      send(to, body) { const c = conns[to]; if (c && c.open) c.send(body); },
      broadcast(body) { for (const k in conns) if (conns[k].open) conns[k].send(body); },
      onMessage(fn) { handler = fn; },
      close() {
        this.voiceStop();
        setTimeout(() => { closed = true; for (const k in conns) try { conns[k].close(); } catch (e) {} try { peer.destroy(); } catch (e) {} }, 150);
      },
      get voiceOn() { return !!mic; },
      get voiceLinks() { return Object.values(calls).filter(c => c.audio).length; },
      voiceStart() {
        if (mic) return Promise.resolve();
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return Promise.reject(new Error('No microphone access here'));
        return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false })
          .then(s => { mic = s; this.voiceMute(muted); });
      },
      voiceStop() {
        Object.keys(calls).forEach(endCall);
        if (mic) mic.getTracks().forEach(t => t.stop());
        mic = null;
      },
      voiceMute(on) { muted = !!on; if (mic) mic.getAudioTracks().forEach(t => { t.enabled = !muted; }); },
      // ids: everyone else who has voice switched on. The lower id places each call, so each pair is called once.
      voiceSync(ids) {
        if (!mic) return;
        Object.keys(calls).forEach(pid => { if (!ids.includes(pid)) endCall(pid); });
        for (const pid of ids) if (!calls[pid] && id < pid) attach(pid, peer.call(pid, mic));
      }
    };
  }

  const transports = { local: localTransport, peer: peerTransport };
  let preferred = params.get('net') === 'local' || typeof Peer === 'undefined' ? 'local' : 'peer';

  return {
    newCode, cleanCode,
    get transportName() { return preferred; },
    use(name) { if (transports[name]) preferred = name; },
    register(name, factory) { transports[name] = factory; },
    connect(code, role) { return transports[preferred](cleanCode(code), role || 'join'); }
  };
})();
