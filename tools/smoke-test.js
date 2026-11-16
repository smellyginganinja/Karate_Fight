// Smoke test in headless Chromium: CPU-vs-CPU matches finish, and two windows can fight online
// over the local (BroadcastChannel) transport. Usage: serve the repo (python3 -m http.server 8765), then
//   node tools/smoke-test.js [http://localhost:8765/index.html] [screenshot dir]
const { chromium } = require('playwright');
const url = process.argv[2] || 'http://localhost:8765/index.html';
const shots = process.argv[3] || null;
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push('host: ' + e.message));
  await page.goto(url + '?net=local');
  await page.waitForTimeout(800);
  if (shots) await page.screenshot({ path: shots + '/menu.png' });

  // 1. headless CPU vs CPU matches run to the end
  const res = await page.evaluate(() => {
    const out = [];
    for (let n = 0; n < 6; n++) {
      const M = Fight.create({ p1: { name: 'A' }, p2: { name: 'B' } }), a = makeCpu(n / 5), b = makeCpu(0.6);
      const counts = {};
      let steps = 0;
      while (M.phase !== 'matchOver' && steps < 120 * 600) {
        const ev = Fight.step(M, [a(M, 0, 1 / 120), b(M, 1, 1 / 120)], 1 / 120);
        ev.forEach(e => { counts[e.type] = (counts[e.type] || 0) + 1; });
        steps++;
      }
      out.push({ phase: M.phase, secs: Math.round(steps / 120), rounds: M.fighters.map(f => f.rounds), winner: M.winner, counts });
    }
    return out;
  });
  console.log('CPU matches:'); res.forEach(r => console.log(' ', JSON.stringify(r)));

  // 2. 1P vs CPU in the real game loop, with key presses
  await page.evaluate(() => __game.startMatch('cpu'));
  for (let i = 0; i < 30; i++) { await page.keyboard.press(['KeyZ', 'KeyX', 'ArrowRight'][i % 3]); await page.waitForTimeout(120); }
  if (shots) await page.screenshot({ path: shots + '/cpu.png' });
  console.log('1P match phase:', await page.evaluate(() => __game.match.phase + ' t=' + __game.match.timer.toFixed(1)));
  await page.evaluate(() => __game.goMenu());

  // 3. online: host + joiner in two windows
  const page2 = await ctx.newPage();
  page2.on('pageerror', e => errors.push('joiner: ' + e.message));
  await page2.goto(url + '?net=local');
  await page.evaluate(() => __game.onlineHost('Hosty'));
  const code = await page.evaluate(() => __game.net.code);
  await page2.evaluate(c => __game.onlineJoin('Joiner', c), code);
  await page2.waitForTimeout(2500);
  console.log('roster:', await page.evaluate(() => __game.net.roster.map(r => r.name).join(',')), '| joiner status:', await page2.evaluate(() => __game.net.status));
  await page.evaluate(() => __game.hostStart());
  await page.waitForTimeout(2500);   // intro
  // joiner walks left (toward host) and kicks; check the host sees it
  const x0 = await page.evaluate(() => __game.match.fighters[1].x);
  await page2.bringToFront();
  await page2.keyboard.down('ArrowLeft'); await page2.waitForTimeout(700); await page2.keyboard.up('ArrowLeft');
  const x1 = await page.evaluate(() => __game.match.fighters[1].x);
  await page2.keyboard.press('KeyX');
  await page2.waitForTimeout(60);
  const act = await page.evaluate(() => __game.match.fighters[1].act + '/' + __game.match.fighters[1].move);
  await page2.waitForTimeout(400);
  const seen = await page2.evaluate(() => { const f = __game.match.fighters[1]; return { x: Math.round(f.x), phase: __game.match.phase, state: __game.state }; });
  console.log('online: joiner x on host', Math.round(x0), '->', Math.round(x1), '| host saw', act, '| joiner view', JSON.stringify(seen));
  if (shots) { await page.screenshot({ path: shots + '/online-host.png' }); await page2.screenshot({ path: shots + '/online-joiner.png' }); }
  // leaving returns the host to the lobby
  await page2.evaluate(() => __game.leaveOnline());
  await page.waitForTimeout(500);
  console.log('after joiner left, host state:', await page.evaluate(() => __game.state));
  console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
  await browser.close();
  process.exit(errors.length ? 1 : 0);
})();
