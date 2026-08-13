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
 * ALLOWED is empty on purpose. Anything added there needs a reason written beside it, because an
 * allow-list is where a real leak hides.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** Substrings that are fine wherever they appear. Exact, so nothing hides behind a loose pattern. */
const ALLOWED = [];

/**
 * Things that belong to whoever runs this, not to whoever reads it.
 *
 * ONLY REAL INFRASTRUCTURE. Product names were in here too — `kilogent`, `lumi` — on the reasoning
 * that seeing one would mean fork code had leaked in. That is a tidiness check wearing a security
 * check's clothes, and it cost the fork its entire test lane: 27 tracked files carry its own name
 * legitimately. It also bought a configuration mechanism whose only purpose was to undo itself.
 * A hostname and an IP are somebody's machines. A brand is a word.
 *
 * Written as patterns rather than one deployment's values, so it keeps working for the next
 * person's hostnames. `aso` matches as a PREFIX: `aso-dara`, `aso dara`, `aso-agent`, `aso-window`
 * and `ASO_PROFILE_NAME` are one rule, and the last two are exactly what a fixed-compound version
 * missed, in tracked files, through the commit whose purpose was removing them.
 */
const FORBIDDEN = [
  [/\bsubturtle\b/i, 'a private product hostname'],
  [/\baso[-_ ]?[a-z0-9]/i, 'a private profile or hostname'],
  [/\bceo-tunnel\b/i, 'a private pm2 process name'],
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
      `   If it is genuinely publishable, add the exact string to ALLOWED and say why.`,
  );
  process.exit(1);
}
console.log(`✓ private detail: ${files.length} tracked files carry no real host, IP, UUID or profile name.`);
