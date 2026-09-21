#!/usr/bin/env node
/**
 * Package the Chrome extension for a release — one zip, or one per declared VARIANT.
 *
 * WHY VARIANTS. One source tree sometimes has to ship more than one build. The case that asked for
 * this is a fork with a development and a production backend: the same extension, pointed at two
 * endpoints, installed side by side under two names. Two long-lived branches that differ in one
 * file conflict at every merge, and a fork must not edit `release.yml` — it is inherited byte for
 * byte — so the builds are DECLARED in the root package.json, the way `releasePackages` is:
 *
 *   "extensionVariants": [
 *     { "id": "dev",  "manifest": { "name": "Acme Browser (Dev)" },
 *                     "env": { "endpoint": "https://dev.example.com" } },
 *     { "id": "prod", "env": { "endpoint": "https://example.com" } }
 *   ]
 *
 * Absent means exactly what this repository always shipped: ONE zip, `extension-<version>.zip`.
 * Present, each variant becomes `extension-<version>-<id>.zip`, built from a COPY:
 *
 *   - `manifest` is deep-merged into manifest.json — objects merge, anything else replaces. The
 *     version is refused: the release stamps it, and a variant that set its own would ship a
 *     number no tag records.
 *   - `env` becomes `BUILD_ENV` in the copy's `src/build-env.js`. Nothing in this repository reads
 *     it; a fork's own code does, and falls back to its own default in a checkout.
 *
 * AN UNKNOWN KEY, A BAD ID OR A DUPLICATE ONE EXITS 1. Ignoring a typo resolves to "ship the default
 * build under the variant's name" — a zip that looks right and signs people in somewhere else.
 * `--self-test` also validates THIS repository's declaration, so a fork's typo fails `npm test`
 * rather than the release job.
 *
 * The zips have manifest.json at their ROOT, so "unzip, then Load unpacked on the folder" works.
 * `assets.txt` beside them lists `file#label`, one per line, for `gh release create`. The workflow
 * reads it with plain bash rather than inline JS in YAML — which is how the release notes once
 * shipped a syntax error (see release-notes.mjs).
 *
 * Usage:
 *   node scripts/package-extension.mjs --out <dir>   # zips + assets.txt into <dir>
 *   node scripts/package-extension.mjs --self-test   # the logic, against a temp directory, no zip
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT_DIR = path.join(ROOT, 'packages/extension');
const BUILD_ENV_FILE = 'src/build-env.js';

const VARIANT_KEYS = ['id', 'manifest', 'env'];
/** Owned by the release, never by a variant. */
const REFUSED_MANIFEST_KEYS = ['version', 'manifest_version'];
/** It becomes part of a file name and of a release asset's label. */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** Never shipped: dependency trees and Finder litter. */
const NOT_SHIPPED = new Set(['node_modules', '.DS_Store']);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * A parsed package.json → the validated variant list, or null for "one default build".
 * Throws a sentence naming the bad entry; the caller prints it and exits 1.
 */
export function readVariants(pkg) {
  if (!isPlainObject(pkg) || !Object.hasOwn(pkg, 'extensionVariants')) return null;
  const list = pkg.extensionVariants;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(
      'extensionVariants must be a non-empty array. Remove the key to ship one default build.',
    );
  }
  const seen = new Set();
  return list.map((variant, i) => {
    const where = `extensionVariants[${i}]`;
    if (!isPlainObject(variant)) throw new Error(`${where} must be an object.`);
    for (const key of Object.keys(variant)) {
      if (!VARIANT_KEYS.includes(key)) {
        throw new Error(`${where} has an unknown key "${key}". Allowed: ${VARIANT_KEYS.join(', ')}.`);
      }
    }
    if (typeof variant.id !== 'string' || !ID_PATTERN.test(variant.id)) {
      throw new Error(`${where}.id must match ${ID_PATTERN} — it becomes part of a file name.`);
    }
    if (seen.has(variant.id)) throw new Error(`${where}.id "${variant.id}" is used twice.`);
    seen.add(variant.id);
    if (variant.manifest !== undefined) {
      if (!isPlainObject(variant.manifest)) throw new Error(`${where}.manifest must be an object.`);
      for (const key of REFUSED_MANIFEST_KEYS) {
        if (Object.hasOwn(variant.manifest, key)) {
          throw new Error(`${where}.manifest may not set "${key}" — the release stamps it.`);
        }
      }
    }
    if (variant.env !== undefined && !isPlainObject(variant.env)) {
      throw new Error(`${where}.env must be an object.`);
    }
    return { id: variant.id, manifest: variant.manifest ?? {}, env: variant.env ?? {} };
  });
}

/** Objects merge key by key; arrays and scalars replace. Neither argument is modified. */
export function mergeManifest(base, overrides) {
  const out = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    out[key] =
      isPlainObject(value) && isPlainObject(base[key]) ? mergeManifest(base[key], value) : value;
  }
  return out;
}

/** The text of `src/build-env.js` inside one variant's copy. */
export function renderBuildEnv(env, id) {
  return (
    `// Written by scripts/package-extension.mjs for the "${id}" build. Not in the repository.\n` +
    `export const BUILD_ENV = Object.freeze(${JSON.stringify(env, null, 2)});\n`
  );
}

/** What the GitHub Release calls one zip. The default keeps the label it always had. */
export function assetLabel(name, version, id) {
  return id
    ? `${name} — ${id} build, unpacked, v${version}`
    : `Chrome extension (unpacked, v${version})`;
}

/**
 * Copy the extension into `destDir`, then apply one variant to the COPY. Returns the merged
 * manifest. The source tree is never written.
 */
export function stageVariant(srcDir, destDir, variant) {
  if (!fs.existsSync(path.join(srcDir, BUILD_ENV_FILE))) {
    throw new Error(
      `${BUILD_ENV_FILE} is missing from the extension, so the "${variant.id}" build's env would ` +
        'have nowhere to go.',
    );
  }
  fs.cpSync(srcDir, destDir, {
    recursive: true,
    filter: (p) => !NOT_SHIPPED.has(path.basename(p)),
  });
  const manifestPath = path.join(destDir, 'manifest.json');
  const merged = mergeManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')), variant.manifest);
  fs.writeFileSync(manifestPath, JSON.stringify(merged, null, 2) + '\n');
  fs.writeFileSync(path.join(destDir, BUILD_ENV_FILE), renderBuildEnv(variant.env, variant.id));
  return merged;
}

/** From INSIDE the directory, so manifest.json sits at the zip's root. */
function zipDir(dir, zipPath) {
  execFileSync('zip', ['-qr', zipPath, '.', '-x', '*/node_modules/*', '*.DS_Store'], {
    cwd: dir,
    stdio: 'inherit',
  });
}

function packageAll(outDir) {
  const variants = readVariants(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')));
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8'));
  const version = manifest.version;
  fs.mkdirSync(outDir, { recursive: true });

  const assets = [];
  if (!variants) {
    const file = `extension-${version}.zip`;
    zipDir(EXT_DIR, path.join(outDir, file));
    assets.push(`${file}#${assetLabel(manifest.name, version, null)}`);
  } else {
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-variants-'));
    try {
      for (const variant of variants) {
        const dir = path.join(stage, variant.id);
        const merged = stageVariant(EXT_DIR, dir, variant);
        const file = `extension-${version}-${variant.id}.zip`;
        zipDir(dir, path.join(outDir, file));
        assets.push(`${file}#${assetLabel(merged.name, version, variant.id)}`);
      }
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  }
  fs.writeFileSync(path.join(outDir, 'assets.txt'), assets.join('\n') + '\n');
  for (const asset of assets) console.log(`  ${asset.replace('#', '  —  ')}`);
}

// ─── self-test ───────────────────────────────────────────────────────────────────────────────

async function selfTest() {
  const cases = [];
  const check = (name, fn) => {
    try {
      const result = fn();
      cases.push([name, result === true, result]);
    } catch (err) {
      cases.push([name, false, err.message]);
    }
  };
  const refuses = (fn, pattern) => {
    try {
      fn();
      return false;
    } catch (err) {
      return pattern.test(err.message);
    }
  };

  // The declaration.
  check('no key means one default build', () => readVariants({ name: 'x' }) === null);
  check('an empty list is refused rather than read as "none"', () =>
    refuses(() => readVariants({ extensionVariants: [] }), /non-empty array/));
  check('an unknown key is refused by name — the typo that would ship the wrong build', () =>
    refuses(() => readVariants({ extensionVariants: [{ id: 'dev', manfest: {} }] }), /unknown key "manfest"/));
  check('an id that cannot be a file name is refused', () =>
    refuses(() => readVariants({ extensionVariants: [{ id: 'Dev Build' }] }), /\.id must match/));
  check('a duplicate id is refused', () =>
    refuses(() => readVariants({ extensionVariants: [{ id: 'a' }, { id: 'a' }] }), /used twice/));
  check('a variant may not set the version', () =>
    refuses(() => readVariants({ extensionVariants: [{ id: 'a', manifest: { version: '9.9.9' } }] }), /may not set "version"/));
  check('nor the manifest version', () =>
    refuses(() => readVariants({ extensionVariants: [{ id: 'a', manifest: { manifest_version: 2 } }] }), /may not set "manifest_version"/));
  check('env must be an object', () =>
    refuses(() => readVariants({ extensionVariants: [{ id: 'a', env: 'https://x' }] }), /env must be an object/));
  check('omitted parts default to empty', () =>
    JSON.stringify(readVariants({ extensionVariants: [{ id: 'a' }] })) ===
      JSON.stringify([{ id: 'a', manifest: {}, env: {} }]));

  // The merge.
  const base = { name: 'Base', action: { default_popup: 'popup.html', default_title: 'Base' }, permissions: ['a', 'b'] };
  check('objects merge key by key — a new title keeps the popup', () => {
    const m = mergeManifest(base, { action: { default_title: 'Dev' } });
    return m.action.default_popup === 'popup.html' && m.action.default_title === 'Dev';
  });
  check('arrays replace rather than concatenate', () =>
    mergeManifest(base, { permissions: ['c'] }).permissions.join() === 'c');
  check('the base manifest is not modified', () => {
    mergeManifest(base, { name: 'X', action: { default_title: 'Y' } });
    return base.name === 'Base' && base.action.default_title === 'Base';
  });

  // The labels.
  check('a variant label names the build', () =>
    assetLabel('Base (Dev)', '1.2.3', 'dev') === 'Base (Dev) — dev build, unpacked, v1.2.3');
  check('the default label is the one releases always had', () =>
    assetLabel('Base', '1.2.3', null) === 'Chrome extension (unpacked, v1.2.3)');

  // A real copy, end to end, short of the zip.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'package-extension-test-'));
  try {
    const src = path.join(tmp, 'extension');
    fs.mkdirSync(path.join(src, 'src'), { recursive: true });
    fs.mkdirSync(path.join(src, 'node_modules', 'junk'), { recursive: true });
    fs.writeFileSync(path.join(src, 'node_modules', 'junk', 'index.js'), 'x');
    fs.writeFileSync(
      path.join(src, 'manifest.json'),
      JSON.stringify({ manifest_version: 3, name: 'Base', version: '1.2.3', action: { default_popup: 'popup.html' } }),
    );
    fs.copyFileSync(path.join(EXT_DIR, BUILD_ENV_FILE), path.join(src, BUILD_ENV_FILE));
    fs.writeFileSync(path.join(src, 'src', 'other.js'), 'export const other = 1;\n');

    const dest = path.join(tmp, 'dev');
    stageVariant(src, dest, {
      id: 'dev',
      manifest: { name: 'Base (Dev)', action: { default_title: 'Base (Dev)' } },
      env: { endpoint: 'https://dev.example.com', label: 'Dev' },
    });
    const copied = JSON.parse(fs.readFileSync(path.join(dest, 'manifest.json'), 'utf8'));
    check('the copy carries the variant name', () => copied.name === 'Base (Dev)');
    check('and keeps the version the release stamped', () => copied.version === '1.2.3');
    check('and keeps what it did not override', () => copied.action.default_popup === 'popup.html');
    check('the source manifest is untouched', () =>
      JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8')).name === 'Base');
    check('the source build-env.js is untouched', () =>
      fs.readFileSync(path.join(src, BUILD_ENV_FILE), 'utf8') ===
        fs.readFileSync(path.join(EXT_DIR, BUILD_ENV_FILE), 'utf8'));
    check('node_modules is never copied', () => !fs.existsSync(path.join(dest, 'node_modules')));
    check('every other file is copied as it was', () =>
      fs.readFileSync(path.join(dest, 'src', 'other.js'), 'utf8') === 'export const other = 1;\n');

    const staged = await import(pathToFileURL(path.join(dest, BUILD_ENV_FILE)).href);
    check('the copy exports exactly the variant env', () =>
      JSON.stringify(staged.BUILD_ENV) === JSON.stringify({ endpoint: 'https://dev.example.com', label: 'Dev' }));
    check('frozen, like the empty one', () => Object.isFrozen(staged.BUILD_ENV));

    const bare = path.join(tmp, 'bare');
    fs.mkdirSync(bare);
    fs.writeFileSync(path.join(bare, 'manifest.json'), '{}');
    check('an extension without build-env.js is refused, not silently shipped', () =>
      refuses(() => stageVariant(bare, path.join(tmp, 'bare-out'), { id: 'x', manifest: {}, env: {} }), /missing/));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // The committed file, and this repository's own declaration.
  const committed = await import(pathToFileURL(path.join(EXT_DIR, BUILD_ENV_FILE)).href);
  check('the committed build-env.js is empty — a checkout carries no build', () =>
    Object.keys(committed.BUILD_ENV).length === 0 && Object.isFrozen(committed.BUILD_ENV));
  check("this repository's package.json declares its builds validly", () => {
    readVariants(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')));
    return true;
  });

  let failed = 0;
  for (const [name, ok, got] of cases) {
    if (!ok) failed++;
    console.log(`  ${ok ? '✓' : '✗'} ${name}`);
    if (!ok) console.log(`      got ${JSON.stringify(got)}`);
  }
  if (failed > 0) {
    console.error(`\n❌ ${failed}/${cases.length} package-extension self-tests failed.`);
    process.exit(1);
  }
  console.log(`\n✅ ${cases.length} package-extension self-tests passed.`);
}

const RUN_DIRECTLY = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (RUN_DIRECTLY) {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) {
    await selfTest();
  } else {
    const at = args.indexOf('--out');
    const out = at >= 0 ? args[at + 1] : undefined;
    if (!out) {
      console.error('usage: node scripts/package-extension.mjs --out <dir> | --self-test');
      process.exit(2);
    }
    try {
      packageAll(path.resolve(out));
    } catch (err) {
      console.error(`✗ ${err.message}`);
      process.exit(1);
    }
  }
}
