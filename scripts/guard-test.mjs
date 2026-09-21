// The navigation guard — `Executor`'s optional `allowUrl` policy, against the REAL Executor.
//
// WHAT IT IS FOR. The blocklist a fork enforces was checked in exactly one place: the `url`
// ARGUMENT of an incoming command. A `browser_click` carries no url, so an agent could navigate to
// an allowed page, click a link, and land on a blocked origin with nothing checking. A comment in
// the fork said "`Executor`'s own post-navigation assertion catches the rest" — there was no such
// assertion, and `grep block executor.js` returned only `blockInput`.
//
// So core gained a NEUTRAL predicate. It does not know what a blocklist is; it asks where the tab
// ended up and reports whatever the transport says.
//
// THE FAKE CHROME IS `mock-harness.mjs`'s, deliberately: `Page.navigate` MOVES the fake tab, which
// is what lets a test simulate the thing the bug is about — a command that leaves the tab somewhere
// nobody named. A stub whose tab never moves would make every assertion here pass while testing
// nothing.

let failures = 0;
const ok = (cond, m) => {
  console.log(`  ${cond ? '✓' : '✗'} ${m}`);
  if (!cond) failures++;
};

const tabs = new Map();
let nextTabId = 100;
function makeTab(url) {
  const id = ++nextTabId;
  const tab = { id, url: url || 'about:blank', title: url || 'about:blank', active: true };
  tabs.set(id, tab);
  return tab;
}

globalThis.chrome = {
  runtime: { lastError: undefined },
  storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
  tabs: {
    get: (id) => (tabs.has(id) ? Promise.resolve({ ...tabs.get(id) }) : Promise.reject(new Error('no tab'))),
    query: () => Promise.resolve([...tabs.values()].map((t) => ({ ...t }))),
    create: ({ url }) => Promise.resolve(makeTab(url)),
    remove: (id) => (tabs.delete(id), Promise.resolve()),
    update: async (id) => tabs.get(id),
    group: async () => 1,
  },
  tabGroups: { update: async () => ({}) },
  debugger: {
    attach: (_t, _v, cb) => cb(),
    detach: (_t, cb) => cb(),
    sendCommand: ({ tabId }, method, params, cb) => {
      const t = tabs.get(tabId);
      if (method === 'Page.navigate') {
        if (t) t.url = t.title = params.url;
        return cb({});
      }
      if (method === 'Runtime.evaluate') {
        const e = params.expression;
        // A CLICK is what moves the tab here — this is the bug, reproduced. `RESOLVE_BOX_FN` is
        // what `click()` evaluates to find the element, so answering it also lands the tab on
        // whatever `clickLandsOn` says, exactly as a real link would.
        if (e.includes('__rbm') && clickLandsOn && t) t.url = t.title = clickLandsOn;
        const value = e.includes('document.readyState')
          ? { ready: 'complete', href: t ? t.url : 'about:blank' }
          : e.includes('found')
            ? { found: true, x: 1, y: 1 }
            : `SNAPSHOT[${t ? t.url : '?'}]`;
        return cb({ result: { value } });
      }
      if (method === 'Page.captureScreenshot') return cb({ data: 'AAAA' });
      return cb({});
    },
    onEvent: { addListener: () => {} },
    onDetach: { addListener: () => {} },
  },
};

let clickLandsOn = null;

const { Executor } = await import('../packages/extension/src/executor.js');

const BLOCKED = 'https://bank.example.com';
const ALLOWED = 'https://example.com';
const deny = (url) => (url.startsWith(BLOCKED) ? 'That address is blocked on this browser.' : true);

/** A session with one tab already sitting on an allowed page. */
async function seed(policy) {
  const ex = new Executor(() => {}, 'T', policy);
  await ex.execute('browser_tab_new', { url: ALLOWED }, 5000, 's1');
  return ex;
}

console.log('navigation guard:');

// ── the bug ────────────────────────────────────────────────────────────────────────────────────
clickLandsOn = `${BLOCKED}/statement`;
{
  const ex = await seed({ allowUrl: deny });
  let err = null;
  try {
    await ex.execute('browser_click', { ref: 'e1', element: 'a link' }, 5000, 's1');
  } catch (e) {
    err = e;
  }
  ok(err !== null, 'a click that lands on a blocked origin is refused');
  ok(err?.code === 'blocked', 'and refuses with code `blocked`, not a generic failure');
  ok(/blocked on this browser/.test(err?.message ?? ''), "and uses the TRANSPORT's wording, not core's");
}

// The same click, with no policy — upstream's path, which must be untouched.
{
  const ex = await seed(undefined);
  const out = await ex.execute('browser_click', { ref: 'e1', element: 'a link' }, 5000, 's1');
  ok(!!out, 'with no policy the identical click succeeds — upstream is unchanged');
}

// ── a click that stays somewhere allowed ───────────────────────────────────────────────────────
clickLandsOn = `${ALLOWED}/other`;
{
  const ex = await seed({ allowUrl: deny });
  const out = await ex.execute('browser_click', { ref: 'e1', element: 'a link' }, 5000, 's1');
  ok(!!out, 'a click that stays on an allowed origin is not disturbed');
}

// ── the cheap door: a URL an argument names ────────────────────────────────────────────────────
clickLandsOn = null;
{
  const ex = await seed({ allowUrl: deny });
  let err = null;
  try {
    await ex.execute('browser_navigate', { url: `${BLOCKED}/login` }, 5000, 's1');
  } catch (e) {
    err = e;
  }
  ok(err?.code === 'blocked', 'a named blocked URL is refused before it is committed');
  ok(tabs.get(nextTabId)?.url === ALLOWED, 'and the tab never moved — nothing was navigated');
}

// ── the one that bricks every session if it is missed ──────────────────────────────────────────
{
  // A blocklist canonicalises through an origin, so it FAILS CLOSED on anything without one — and
  // core opens its own tabs at about:blank. Offering that placeholder to the predicate refuses
  // core's own tab and every session dies at its first command.
  const seen = [];
  const ex = new Executor(() => {}, 'T', {
    allowUrl: (url) => {
      seen.push(url);
      return url.startsWith('http') ? true : false;
    },
  });
  await ex.execute('browser_tab_new', {}, 5000, 's1');
  // The blank tab must then be ACTED on: `browser_tab_new` returns before the post-action check, so
  // a test that stops there never reaches the skip at all and a removed skip survives it. Ask for a
  // snapshot — that is a command, on a tab whose URL is core's own placeholder.
  const out = await ex.execute('browser_snapshot', {}, 5000, 's1');
  ok(!!out, 'a command on a blank tab still works — about:blank is never judged');
  ok(!seen.includes('about:blank'), 'and the predicate is never even shown about:blank');
}

// ── a predicate that cannot answer ─────────────────────────────────────────────────────────────
clickLandsOn = `${ALLOWED}/other`;
{
  // It must answer the SEED (the tab has to exist before there is a click to test), then fail —
  // which is also the realistic shape: a worker evicted mid-session loses the state the predicate
  // reads, so the throw arrives partway through, not at construction.
  let calls = 0;
  const ex = await seed({
    allowUrl: () => {
      calls += 1;
      if (calls > 1) throw new Error('storage gone');
      return true;
    },
  });
  let err = null;
  try {
    await ex.execute('browser_click', { ref: 'e1', element: 'a link' }, 5000, 's1');
  } catch (e) {
    err = e;
  }
  ok(err?.code === 'blocked', 'a predicate that THROWS refuses — it could not answer, so not "yes"');
}

// ── arming ─────────────────────────────────────────────────────────────────────────────────────
{
  // `pushStatus` already fires on attach, so a transport could arm interception from there with no
  // core change — but it is fire-and-forget, and the first navigation would race it. This hook is
  // awaited, and that is the only reason it exists.
  const order = [];
  const ex = new Executor(() => {}, 'T', {
    onAttached: async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push('armed');
    },
  });
  await ex.execute('browser_tab_new', { url: ALLOWED }, 5000, 's1');
  order.push('command');
  ok(order[0] === 'armed', 'onAttached is AWAITED before a command proceeds, never raced');
}

// ── a session with no page ─────────────────────────────────────────────────────────────────────
// A fresh session used to OPEN a tab for any command — and a fresh tab is about:blank, so a
// screenshot or a snapshot in a session that had never navigated came back blank and "succeeded".
// An agent did exactly that for real, and reported a uniformly blank screenshot as done.
clickLandsOn = null;
{
  const ex = new Executor(() => {}, 'T', undefined);
  const before = tabs.size;
  for (const name of ['browser_take_screenshot', 'browser_snapshot', 'browser_click']) {
    let err = null;
    try {
      await ex.execute(name, { ref: 'e1', element: 'a link' }, 5000, 'empty');
    } catch (e) {
      err = e;
    }
    ok(err?.code === 'no_tab', `${name} in a session with no page is refused with \`no_tab\``);
    // The sentence reaches the model verbatim through every transport, and each client names the
    // navigation tool differently — so it must not name a command at all.
    ok(!/browser_/.test(err?.message ?? 'browser_'), `${name}'s refusal names no command a client may not have`);
  }
  ok(tabs.size === before, 'and not one tab was opened doing it — there is no blank page to photograph');

  let unknown = null;
  try {
    await ex.execute('browser_teleport', {}, 5000, 'empty');
  } catch (e) {
    unknown = e;
  }
  ok(unknown?.code === 'unknown_tool', 'an unknown command is still reported as unknown, not as "no page"');
  ok(tabs.size === before, 'and it opens nothing either');

  const nav = await ex.execute('browser_navigate', { url: ALLOWED }, 5000, 'empty');
  ok(!!nav && tabs.size === before + 1, 'a NAVIGATION is what opens the tab — exactly one');
  const shot = await ex.execute('browser_take_screenshot', {}, 5000, 'empty');
  ok(shot?.content?.[0]?.type === 'image', 'after which a screenshot works, on the page it navigated to');
}

console.log(failures === 0 ? '\n✅ navigation guard passed' : `\n❌ ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
