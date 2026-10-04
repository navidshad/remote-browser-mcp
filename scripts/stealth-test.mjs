// What a PAGE can see of the agent, against the real Executor and the real page-scripts (no Chrome).
//
// A page cannot tell CDP input from a person by the event — it is trusted — so what gives an agent
// away is everything AROUND the event: globals and elements we leave in the page, `Runtime.enable`,
// and input with a shape no hand makes (teleporting pointer, exact-centre clicks, 0 ms presses,
// scroll jumps). Each of those is asserted here, because each was true before and every one of
// them would come back silently: nothing functional breaks when an agent gets easier to spot.
//
// The mock chrome below REPORTS A FRAME, unlike the other harnesses', so `evalFn` takes the
// isolated-world path a real Chrome takes. It cannot prove isolation itself — that needs a real V8
// — only that every evaluation asks for, and uses, our world's context.
import { Window } from 'happy-dom';

let failures = 0;
const ok = (cond, m) => { console.log(`  ${cond ? '✓' : '✗'} ${m}`); if (!cond) failures++; };

const sent = [];
let box = { found: true, x: 0, y: 0, left: 0, top: 0, w: 120, h: 40, vw: 1000, vh: 700 };
let scrolled = 0; // page scroll offset the mock applies to `box` on wheel events
const WORLD_CTX = 77;

globalThis.chrome = {
  runtime: { lastError: undefined },
  tabs: {
    get: async (id) => ({ id, url: 'https://example.com', title: 't' }),
    create: async () => ({ id: 1 }),
    group: async () => 1,
    update: async () => ({}),
    remove: async () => {},
  },
  tabGroups: { update: async () => ({}) },
  debugger: {
    attach: (_t, _v, cb) => cb(),
    detach: (_t, cb) => cb(),
    sendCommand: (_t, method, params, cb) => {
      sent.push({ method, params });
      if (method === 'Page.getFrameTree') return cb({ frameTree: { frame: { id: 'F1' } } });
      if (method === 'Page.createIsolatedWorld') return cb({ executionContextId: WORLD_CTX });
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseWheel') scrolled += params.deltaY;
      if (method === 'Runtime.evaluate') {
        const e = params.expression;
        if (e.includes('document.readyState')) return cb({ result: { value: { ready: 'complete', href: 'https://example.com' } } });
        if (e.includes('innerWidth')) {
          const top = box.top - scrolled;
          return cb({ result: { value: { ...box, top, y: top + box.h / 2, x: box.left + box.w / 2 } } });
        }
        return cb({ result: { value: { found: true } } });
      }
      return cb({});
    },
  },
};

const { Executor } = await import('../packages/extension/src/executor.js');
const ex = new Executor(() => {}, 'T');
const session = ex.getSession('s');
ex.registerTab(session, 1, 'https://example.com');

console.log('cdp footprint:');
await ex.execute('browser_snapshot', {}, 5000, 's');
ok(!sent.some((c) => c.method === 'Runtime.enable'), 'Runtime.enable is never sent');
const evals = sent.filter((c) => c.method === 'Runtime.evaluate');
ok(evals.length > 0 && evals.every((c) => c.params.contextId === WORLD_CTX), 'every evaluation runs in our isolated world');
ok(
  sent.filter((c) => c.method === 'Page.createIsolatedWorld').length >= evals.length,
  'the world is asked for per evaluation — never a cached, possibly stale context id'
);

console.log('pointer:');
const centres = [];
for (let i = 0; i < 6; i++) {
  sent.length = 0;
  box = { ...box, left: 400, top: 300 };
  scrolled = 0;
  const t0 = Date.now();
  await ex.execute('browser_click', { ref: 'e1' }, 5000, 's');
  const elapsed = Date.now() - t0;
  const mouse = sent.filter((c) => c.method === 'Input.dispatchMouseEvent');
  const moves = mouse.filter((c) => c.params.type === 'mouseMoved');
  const press = mouse.find((c) => c.params.type === 'mousePressed');
  const release = mouse.find((c) => c.params.type === 'mouseReleased');
  if (i === 0) {
    ok(moves.length >= 6, `the pointer travels (${moves.length} moves), it does not teleport`);
    ok(press && release && press.params.x === release.params.x, 'press and release land on the same point');
    ok(
      press.params.x > 400 && press.params.x < 520 && press.params.y > 300 && press.params.y < 340,
      'the click lands inside the element'
    );
    const last = moves[moves.length - 1].params;
    ok(last.x === press.params.x && last.y === press.params.y, 'the path ends exactly where it clicks');
    ok(elapsed >= 90, `a click takes human time (${elapsed} ms)`);
  }
  centres.push(`${press.params.x.toFixed(1)},${press.params.y.toFixed(1)}`);
}
ok(new Set(centres).size > 1, 'repeated clicks on one element do not hit the same pixel');

console.log('scrolling:');
sent.length = 0;
box = { ...box, left: 400, top: 2400 };
scrolled = 0;
await ex.execute('browser_click', { ref: 'e1' }, 5000, 's');
const wheels = sent.filter((c) => c.method === 'Input.dispatchMouseEvent' && c.params.type === 'mouseWheel');
ok(wheels.length >= 15, `an element below the fold is reached by wheel ticks (${wheels.length})`);
ok(wheels.every((w) => Math.abs(w.params.deltaY) <= 100), 'each tick is one notch, not one giant jump');
ok(!sent.some((c) => c.method === 'Runtime.evaluate' && c.params.expression.includes('scrollIntoView')), 'no scrollIntoView when the wheel works');

console.log('overlay (happy-dom):');
{
  const { OVERLAY_FN, OVERLAY_HIDE_FN } = await import('../packages/extension/src/page-scripts.js');
  const win = new Window();
  const saved = { window: globalThis.window, document: globalThis.document };
  globalThis.window = win;
  globalThis.document = win.document;
  OVERLAY_FN({ text: 'click: Buy', color: '#123456' });
  const host = win.document.documentElement.lastElementChild;
  ok(host && !host.id && host.getAttributeNames().every((n) => !/rbm/i.test(n)), 'the host carries no id or attribute naming us');
  ok(host && host.shadowRoot === null, "its contents are in a CLOSED shadow root — the badge's words are not the page's to read");
  ok(!win.document.documentElement.outerHTML.includes('click: Buy'), 'the action text is nowhere in the light DOM');
  OVERLAY_HIDE_FN();
  ok(!host.isConnected, 'hiding REMOVES it from the document, it is not left behind');
  OVERLAY_FN({ text: 'again' });
  ok(host.isConnected, 'and it comes back on the next action');
  await win.happyDOM.close();
  globalThis.window = saved.window;
  globalThis.document = saved.document;
}

if (failures) {
  console.error(`\n❌ ${failures} stealth check(s) failed`);
  process.exit(1);
}
console.log('\n✅ stealth footprint passed');
