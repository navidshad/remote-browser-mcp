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
// A mock <select>: arrow keys move it, as a closed native one does off a Mac.
let sel = { index: 0, target: 3 };
// A mock document for full-page captures: 2400 px tall, 700 px viewport.
let doc = { y: 0, vh: 700, vw: 1000, h: 2400 };

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
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseWheel') {
        scrolled += params.deltaY;
        doc.y = Math.min(Math.max(doc.y + params.deltaY, 0), doc.h - doc.vh);
      }
      if (method === 'Input.dispatchKeyEvent' && params.type === 'rawKeyDown') {
        if (params.key === 'ArrowDown') sel.index++;
        if (params.key === 'ArrowUp') sel.index--;
      }
      if (method === 'Page.captureScreenshot') return cb({ data: `FRAME@${doc.y}` });
      if (method === 'Runtime.evaluate') {
        const e = params.expression;
        if (e.includes('"matchOnly":true')) {
          return cb({ result: { value: { found: true, matched: true, index: sel.target, current: sel.index, label: 'Green', value: 'g' } } });
        }
        if (e.includes('el.options') && e.includes('dispatchEvent')) {
          sel.scripted = true;
          return cb({ result: { value: { found: true, matched: true, label: 'Green', value: 'g' } } });
        }
        if (e.includes('scrollingElement')) return cb({ result: { value: { ...doc } } });
        if (e.includes('selectedIndex') && !e.includes('options')) return cb({ result: { value: { found: true, index: sel.index } } });
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

console.log('keyboard:');
{
  const { IS_MAC } = await import('../packages/extension/src/human.js');
  sent.length = 0;
  box = { ...box, left: 100, top: 100 };
  scrolled = 0;
  const t0 = Date.now();
  await ex.execute('browser_type', { ref: 'e2', text: 'Hi a!' }, 30000, 's');
  const elapsed = Date.now() - t0;
  const keys = sent.filter((c) => c.method === 'Input.dispatchKeyEvent').map((c) => c.params);
  ok(!sent.some((c) => c.method === 'Input.insertText'), 'short text is typed, never inserted at once');
  const typed = keys.filter((k) => k.type === 'keyDown').map((k) => k.text).join('');
  ok(typed === 'Hi a!', `every character is its own keystroke ("${typed}")`);
  const H = keys.find((k) => k.type === 'keyDown' && k.text === 'H');
  ok(H && H.code === 'KeyH' && H.windowsVirtualKeyCode === 72 && H.modifiers === 8, 'a capital carries KeyH, keyCode 72 and Shift');
  const bang = keys.find((k) => k.type === 'keyDown' && k.text === '!');
  ok(bang && bang.code === 'Digit1' && bang.modifiers === 8, '"!" is Shift+Digit1, as on a keyboard');
  const shiftDowns = keys.filter((k) => k.key === 'Shift' && k.type === 'rawKeyDown').length;
  const shiftUps = keys.filter((k) => k.key === 'Shift' && k.type === 'keyUp').length;
  ok(shiftDowns >= 2 && shiftDowns === shiftUps, `Shift is pressed and released around capitals (${shiftDowns}×)`);
  const selectAll = keys.find((k) => k.type === 'rawKeyDown' && k.key === 'a');
  ok(
    selectAll && selectAll.modifiers === (IS_MAC ? 4 : 2),
    `existing text is selected with ${IS_MAC ? '⌘A' : 'Ctrl+A'}, not from script`
  );
  ok(elapsed >= 5 * 45, `typing takes human time (${elapsed} ms for 5 characters)`);

  sent.length = 0;
  await ex.execute('browser_type', { ref: 'e2', text: 'x'.repeat(400) }, 4000, 's');
  const ins = sent.filter((c) => c.method === 'Input.insertText');
  const struck = sent.filter((c) => c.method === 'Input.dispatchKeyEvent' && c.params.type === 'keyDown').length;
  ok(
    struck > 0 && ins.length === 1 && struck + ins[0].params.text.length === 400,
    `long text is typed until the budget, then the rest inserted (${struck} keys + ${ins[0]?.params.text.length})`
  );

  sent.length = 0;
  await ex.execute('browser_press_key', { key: 'Shift+Tab' }, 5000, 's');
  const combo = sent.filter((c) => c.method === 'Input.dispatchKeyEvent').map((c) => `${c.params.type}:${c.params.key}:${c.params.modifiers}`);
  ok(
    combo.join(' ') === 'rawKeyDown:Shift:8 rawKeyDown:Tab:8 keyUp:Tab:8 keyUp:Shift:0',
    `a shortcut is modifiers down, key, modifiers up (${combo.join(' ')})`
  );
  sent.length = 0;
  await ex.execute('browser_press_key', { key: 'a' }, 5000, 's');
  const a = sent.find((c) => c.method === 'Input.dispatchKeyEvent').params;
  ok(a.code === 'KeyA' && a.windowsVirtualKeyCode === 65, 'a bare letter is KeyA / 65, not code "a"');
}

console.log('native select:');
{
  const { IS_MAC } = await import('../packages/extension/src/human.js');
  sent.length = 0;
  sel = { index: 0, target: 3 };
  await ex.execute('browser_select_option', { ref: 'e3', value: 'Green' }, 30000, 's');
  const scripted = !!sel.scripted;
  if (IS_MAC) {
    const arrows = sent.filter((c) => c.method === 'Input.dispatchKeyEvent' && /^Arrow/.test(c.params.key)).length;
    ok(arrows === 0, 'on a Mac, arrow keys are never pressed (they open the OS list)');
    ok(scripted, 'and when type-ahead cannot land, the scripted path still chooses');
  } else {
    ok(sel.index === 3, 'arrow keys walk a closed <select> to the option');
    ok(!scripted, 'and the scripted path is not used when the keyboard landed');
  }
}

console.log('pacing:');
{
  sent.length = 0;
  box = { ...box, left: 100, top: 100 };
  scrolled = 0;
  await ex.execute('browser_click', { ref: 'e1' }, 5000, 's');
  const t0 = Date.now();
  await ex.execute('browser_click', { ref: 'e1' }, 5000, 's');
  ok(Date.now() - t0 >= 250, `back-to-back actions are spaced like a person's (${Date.now() - t0} ms)`);
  const navs = [];
  const real = chrome.debugger.sendCommand;
  chrome.debugger.sendCommand = (t, m, p, cb) => {
    if (m === 'Page.navigate') navs.push({ at: Date.now(), p });
    return real(t, m, p, cb);
  };
  await ex.execute('browser_navigate', { url: 'https://example.com/a' }, 30000, 's');
  await ex.execute('browser_navigate', { url: 'https://example.com/b' }, 30000, 's');
  chrome.debugger.sendCommand = real;
  ok(navs.length === 2 && navs[1].at - navs[0].at >= 1150, `navigations are rate-limited (${navs[1].at - navs[0].at} ms apart)`);
  ok(navs[0].p.transitionType === 'typed', 'a navigation arrives the way a typed URL does');
}

console.log('full-page screenshot:');
{
  sent.length = 0;
  doc = { y: 500, vh: 700, vw: 1000, h: 2400 };
  ex.stitch = async (frames) => frames.map((f) => f.data).join('|');
  const res = await ex.execute('browser_take_screenshot', { fullPage: true }, 30000, 's');
  delete ex.stitch;
  ok(!sent.some((c) => c.params && c.params.captureBeyondViewport), 'the viewport is never resized to the document');
  const parts = res.content[0].data.split('|');
  ok(parts.length >= 3 && parts[0] === 'FRAME@0', `the page is captured screen by screen from the top (${parts.join(', ')})`);
  ok(parts[parts.length - 1] === `FRAME@${doc.h - doc.vh}`, 'down to the bottom');
  ok(doc.y === 500, `and the page is wheeled back to where it was (y=${doc.y})`);
}

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
