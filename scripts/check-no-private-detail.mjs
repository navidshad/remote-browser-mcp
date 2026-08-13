#!/usr/bin/env node
/**
 * Refuse to ship one operator's infrastructure in a public repo.
 *
 * WHY THIS EXISTS. This repo accumulated, in tracked files anyone could read: a live VM address
 * (`ubuntu@<ip>`), four hostnames that still resolved, a named-tunnel UUID, a private Chrome profile
 * name in the README's own architecture diagram AND in runtime error messages a stranger's agent
 * would hit — plus a sentence stating that one of those hostnames had no access policy in front of
 * it, which is a map rather than a note.
 *
 * None of it was secret in the "leaked a key" sense. That is exactly why it survived: every line was
 * added by somebody documenting something true, and no single one looked like a mistake. Deployment
 * notes accumulate box contents the way a kitchen accumulates jars.
 *
 * A doc rule would not have held — the whole point is that nobody re-reads a runbook asking "is this
 * still mine to publish". So it is a test.
 *
 * ALLOWED is empty on purpose. It once held the `@lumi.ai/relay` rename strings, because installed
 * boxes still read the old config directory — that compatibility path is gone now, and so is the
 * exemption. Anything added back here needs a reason written beside it, because an allow-list is
 * where a real leak hides.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** Substrings that are fine wherever they appear. Exact, so nothing hides behind a loose pattern. */
const ALLOWED = [];

/**
 * WHOSE NAMES THESE ARE is configuration, not code — `privateNames` in package.json, exactly as
 * `releasePackages` decides what a repo publishes.
 *
 * A FORK IS WHY. `kilogent` is a private product name in THIS repo and the product's own name in
 * the fork, where 27 tracked files carry it legitimately. Hard-coding the list here would have
 * forced the fork to diverge on this file permanently — and a guard you must edit to merge is a
 * guard that gets edited carelessly, on the one file where carelessness leaks somebody's
 * infrastructure. A fork drops its own name from the DATA and inherits the checker unchanged.
 *
 * Structural patterns are NOT configurable and stay below: a bare IP and a UUID are somebody's
 * infrastructure in any repo, under any branding.
 *
 * Entries are matched case-insensitively on a word boundary. A trailing `*` means PREFIX — `aso*`
 * catches `aso-dara`, `aso dara`, `aso-agent`, `aso-window` and `ASO_PROFILE_NAME`, which is five
 * separate patterns before, and the reason the old fixed-compound version missed two of them.
 */
const DEFAULT_PRIVATE_NAMES = ['subturtle', 'kilogent', 'lumi', 'aso*', 'ceo-tunnel'];

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const privateNames = Array.isArray(pkg.privateNames) ? pkg.privateNames : DEFAULT_PRIVATE_NAMES;

const escape = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const namePattern = (entry) =>
  entry.endsWith('*')
    ? new RegExp(`\\b${escape(entry.slice(0, -1))}[-_ ]?[a-z0-9]`, 'i')
    : new RegExp(`\\b${escape(entry)}\\b`, 'i');

const FORBIDDEN = [
  ...privateNames.map((n) => [namePattern(n), `a private name (\`${n}\` in package.json privateNames)`]),
  [/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, 'a bare IP address'],
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, 'a UUID (tunnel or account id)'],
];

/** Files whose IPs are examples, not infrastructure. */
const EXEMPT_FILES = [
  /^scripts\/check-no-private-detail\.mjs$/, // this file names the patterns it bans
  /^packages\/relay\/src\/.*\.test\.ts$/, //    loopback fixtures
  /^scripts\/.*-test\.mjs$/, //                 harness fixtures
  /^scripts\/.*-harness\.mjs$/,
];

/** Loopback and documentation ranges are addresses anyone may write down. */
const SAFE_IP = /^(127\.|0\.0\.0\.0|255\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.|1\.2\.3\.4)/;

/** The `privateNames` rows themselves, as they appear in the file, so they can be skipped there. */
const declaredEntries = new Set(privateNames.map((n) => JSON.stringify(n)));

const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
  .filter((f) => !EXEMPT_FILES.some((re) => re.test(f)));

let failures = 0;
for (const file of files) {
  // The WORKING TREE, not `git show HEAD:` — a guard that reads the last commit passes while the
  // offending line is sitting unstaged in front of you, which is precisely when it should fail.
  let body;
  try {
    body = readFileSync(file, 'utf8');
  } catch {
    continue; // deleted in the working tree, still listed by ls-files
  }
  body.split('\n').forEach((line, i) => {
    if (ALLOWED.some((a) => line.includes(a))) return;
    // The declaration names the names, exactly as this script used to. Skip the ARRAY ELEMENTS
    // only — not the whole of package.json, which would let a real hostname hide in a dependency
    // URL or a repository field two lines away.
    if (file === 'package.json' && declaredEntries.has(line.trim().replace(/,$/, ''))) return;
    for (const [pattern, what] of FORBIDDEN) {
      const hit = line.match(pattern);
      if (!hit) continue;
      if (what.includes('IP') && SAFE_IP.test(hit[0])) continue;
      failures++;
      console.log(`  ✗ ${file}:${i + 1} — ${what}: ${JSON.stringify(hit[0])}`);
      console.log(`      ${line.trim().slice(0, 100)}`);
    }
  });
}

if (failures > 0) {
  console.error(
    `\n❌ private detail: ${failures} line(s) name somebody's real infrastructure.\n` +
      `   Replace with a placeholder (<bridge-host>, <vm-user>@<vm-host>).\n` +
      `   If this name is YOURS — you are a fork and it is your product — remove it from\n` +
      `   "privateNames" in package.json rather than editing this file.`,
  );
  process.exit(1);
}
console.log(`✓ private detail: ${files.length} tracked files carry no real host, IP, UUID or profile name.`);
