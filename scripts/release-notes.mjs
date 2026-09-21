#!/usr/bin/env node
/**
 * Render the body of a GitHub Release from the resolver's output and the relay job's outcome.
 *
 * WHY THIS IS A FILE AND NOT `node -e` IN THE WORKFLOW. It was inline, and it shipped a syntax
 * error: a template literal needing a literal backtick, written `\\``, which JavaScript reads as an
 * escaped backslash followed by a backtick that ENDS the template. The release job died after the
 * relay had already published — so npm had 0.2.1 and GitHub had no release for it.
 *
 * The reason it got through is worth more than the fix. I had rendered these notes locally and read
 * the output — but from a RETYPED copy of the same code, not from the workflow file. Two copies,
 * one tested, the other shipped. A script in `scripts/` is the same bytes in both places, and it
 * has a `--self-test` so the rendering is checked rather than eyeballed.
 *
 * Reads three environment variables, exactly as the workflow sets them:
 *   RESOLVED         the JSON from resolve-versions.mjs
 *   RELAY_RESULT     the relay job's `needs.relay.result` — success | failure | cancelled | skipped
 *   RELAY_PUBLISHED  its `published` output — yes | skipped | (empty)
 *
 * Usage:
 *   node scripts/release-notes.mjs              # prints the body
 *   node scripts/release-notes.mjs --self-test
 */

/** How a package's line should read, given what actually happened to it. */
export function stateFor(pkg, { relayResult, relayPublished }) {
  // A package this repository does not release still gets a ROW, because a fork's release should
  // say which relay its extension expects. It must not read "unchanged", which claims this repo
  // looked and found nothing — it never looked.
  if (pkg.excluded) return 'from upstream';
  if (pkg.key !== 'relay') return pkg.release ? '**new**' : 'unchanged';
  if (!pkg.release) return 'unchanged';
  // ANYTHING THAT IS NOT AN OUTRIGHT SUCCESS IS "did not publish". Listing only `failure` would
  // let a cancelled or timed-out job be announced as shipped, and a release naming a version npm
  // does not have is worse than a red build.
  if (relayResult !== 'success') return `⚠️ **did not publish** (${relayResult})`;
  if (relayPublished === 'skipped') return 'already on npm';
  return '**published to npm**';
}

/**
 * Where the notes point a reader at the extension: one zip, or one per build that
 * `extensionVariants` declares (see package-extension.mjs). `builds` is `[{id, name}]` or null.
 */
export function extensionLine(builds) {
  if (!builds || builds.length === 0) {
    return 'The extension is attached below — unzip it and load it unpacked at `chrome://extensions`.';
  }
  const list = builds.map((b) => '**' + b.id + '** (' + b.name + ')').join(', ');
  return (
    'The extension is attached below as ' + builds.length + ' builds: ' + list + '. ' +
    'Unzip the one you need and load it unpacked at `chrome://extensions`.'
  );
}

export function renderNotes(resolved, outcome, builds = null) {
  const lines = ['| Package | Version | This release |', '|---|---|---|'];
  for (const p of resolved.packages) {
    // Backticks around the version are built by CONCATENATION, never a template literal. That is
    // the exact construct that broke this when it lived inline in YAML.
    lines.push('| ' + p.label + ' | `' + p.version + '` | ' + stateFor(p, outcome) + ' |');
  }
  lines.push(
    '',
    '```bash',
    'npm i -g remote-browser-relay',
    '```',
    '',
    extensionLine(builds),
  );
  for (const p of resolved.packages) {
    if (!p.release || p.commits.length === 0) continue;
    lines.push('', '### ' + p.label, '');
    for (const c of p.commits) lines.push('- ' + c);
  }
  return lines.join('\n') + '\n';
}

function selfTest() {
  const cases = [];
  const eq = (name, actual, expected) =>
    cases.push([name, actual === expected, actual, expected]);

  const ext = { key: 'extension', label: 'Chrome extension', release: true, version: '1.0.0', commits: [] };
  const relay = { key: 'relay', label: 'remote-browser-relay', release: true, version: '0.2.1', commits: ['fix: a thing'] };

  eq('a changed extension is new', stateFor(ext, {}), '**new**');
  eq('an unchanged one says so', stateFor({ ...ext, release: false }, {}), 'unchanged');
  eq('a published relay says so',
     stateFor(relay, { relayResult: 'success', relayPublished: 'yes' }), '**published to npm**');
  eq('an already-published one is not claimed as new',
     stateFor(relay, { relayResult: 'success', relayPublished: 'skipped' }), 'already on npm');
  for (const r of ['failure', 'cancelled', 'skipped']) {
    eq(`a ${r} relay job never reads as shipped`,
       stateFor(relay, { relayResult: r, relayPublished: 'yes' }), `⚠️ **did not publish** (${r})`);
  }
  eq('an unchanged relay ignores the job outcome entirely',
     stateFor({ ...relay, release: false }, { relayResult: 'failure' }), 'unchanged');
  // A fork does not release the relay. Its row must not claim this repo checked and found nothing,
  // and — the one that actually bites — must not read as a FAILED publish just because the job it
  // depends on was skipped.
  eq('an excluded package says where it comes from',
     stateFor({ ...relay, release: false, excluded: true }, { relayResult: 'skipped' }), 'from upstream');
  eq('an excluded package is not reported as a failed publish',
     stateFor({ ...relay, excluded: true }, { relayResult: 'failure' }), 'from upstream');
  eq('exclusion applies to any package, not just the relay',
     stateFor({ ...ext, excluded: true, release: false }, {}), 'from upstream');

  const body = renderNotes({ packages: [ext, relay] }, { relayResult: 'success', relayPublished: 'yes' });
  eq('the version is wrapped in backticks', body.includes('| `1.0.0` |'), true);
  eq('a changed package lists its commits', body.includes('- fix: a thing'), true);
  eq('an unchanged one contributes no section', renderNotes(
       { packages: [{ ...ext, release: false }] }, {}).includes('### Chrome extension'), false);
  // The failure that shipped: a backslash reaching the output means the escaping is wrong again.
  eq('no stray backslashes survive into the body', body.includes('\\'), false);

  eq('one build keeps the line releases always had', body.includes(
       'The extension is attached below — unzip it and load it unpacked at `chrome://extensions`.'), true);
  const builds = [{ id: 'dev', name: 'Acme (Dev)' }, { id: 'prod', name: 'Acme' }];
  const multi = renderNotes({ packages: [ext] }, {}, builds);
  eq('several builds are each named, with the id their zip carries',
     multi.includes('attached below as 2 builds: **dev** (Acme (Dev)), **prod** (Acme).'), true);
  eq('and the single-build sentence is gone', multi.includes('unzip it and load'), false);

  let failed = 0;
  for (const [name, ok, actual, expected] of cases) {
    if (!ok) failed++;
    console.log(`  ${ok ? '✓' : '✗'} ${name}`);
    if (!ok) console.log(`      got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  }
  if (failed > 0) {
    console.error(`\n❌ ${failed}/${cases.length} release-notes self-tests failed.`);
    process.exit(1);
  }
  console.log(`\n✅ ${cases.length} release-notes self-tests passed.`);
  process.exit(0);
}

const RUN_DIRECTLY = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (RUN_DIRECTLY && process.argv.includes('--self-test')) {
  selfTest();
} else if (RUN_DIRECTLY) {
  const resolved = JSON.parse(process.env.RESOLVED ?? '{"packages":[]}');
  // The same declaration the packager built from, so the notes cannot name a build that is not
  // attached. Read here rather than passed in: the workflow stays free of inline JS.
  const { readVariants, mergeManifest } = await import('./package-extension.mjs');
  const { readFileSync } = await import('node:fs');
  const variants = readVariants(JSON.parse(readFileSync('package.json', 'utf8')));
  const manifest = JSON.parse(readFileSync('packages/extension/manifest.json', 'utf8'));
  const builds = variants?.map((v) => ({ id: v.id, name: mergeManifest(manifest, v.manifest).name })) ?? null;
  process.stdout.write(
    renderNotes(
      resolved,
      {
        relayResult: process.env.RELAY_RESULT ?? 'skipped',
        relayPublished: process.env.RELAY_PUBLISHED ?? '',
      },
      builds,
    ),
  );
}
