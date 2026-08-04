#!/usr/bin/env node
/**
 * Build this repo's image from inside a container, through the phatt-claw socket proxy.
 *
 * phatt-claw cannot open `POST /session`, so BuildKit can neither pull an external
 * `# syntax=` frontend nor resolve a base image it doesn't already have locally.
 * Both are avoidable without touching the proxy or the tracked Dockerfile:
 *
 *   1. pre-pull every `FROM` base via POST /images/create   (allowed)
 *   2. desugar the Dockerfile into the *build context copy* (tracked file untouched)
 *   3. POST /build?version=2                                (real BuildKit, shared layers)
 *
 * Usage: node scripts/agent-build-image.mjs --tag <tag> [--target production]
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, posix } from 'node:path';
import { tmpdir } from 'node:os';

const DOCKER_HOST = process.env.PHATT_CLAW_URL ?? 'http://phatt-claw:2375';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const tag = arg('tag');
const target = arg('target', 'production');
const repoRoot = arg('context', process.cwd());
if (!tag) {
  console.error('usage: agent-build-image.mjs --tag <tag> [--target production]');
  process.exit(2);
}

/** curl through the proxy; returns stdout. */
function claw(args, { input, timeout } = {}) {
  const r = spawnSync('curl', ['-s', '-H', 'Expect:', ...args], {
    input,
    timeout,
    maxBuffer: 1 << 28,
    encoding: 'buffer',
  });
  if (r.status !== 0) throw new Error(`curl failed (${r.status}): ${r.stderr}`);
  return r.stdout.toString('utf8');
}

// ---------------------------------------------------------------- 1. pre-pull

const dockerfile = readFileSync(join(repoRoot, 'Dockerfile'), 'utf8');
const stages = new Set();
const bases = [];
for (const line of dockerfile.split('\n')) {
  const m = line.match(/^\s*FROM\s+(\S+)(?:\s+AS\s+(\S+))?/i);
  if (!m) continue;
  const [, image, alias] = m;
  if (alias) stages.add(alias.toLowerCase());
  if (!stages.has(image.toLowerCase()) && !image.startsWith('$')) bases.push(image);
}

for (const image of [...new Set(bases)]) {
  const [name, tagPart = 'latest'] = image.includes('@')
    ? [image, null]
    : [image.split(':')[0], image.split(':')[1]];
  const q = tagPart ? `fromImage=${encodeURIComponent(name)}&tag=${encodeURIComponent(tagPart)}` : `fromImage=${encodeURIComponent(name)}`;
  process.stderr.write(`pre-pull ${image} ... `);
  const out = claw(['-X', 'POST', `${DOCKER_HOST}/images/create?${q}`], { timeout: 900_000 });
  const failed = out.split('\n').some((l) => l.includes('"errorDetail"'));
  console.error(failed ? 'FAILED' : 'ok');
  if (failed) {
    console.error(out.slice(-500));
    process.exit(1);
  }
}

// ---------------------------------------------------------------- 2. desugar

function expandParents(line) {
  const m = line.match(/^(\s*)COPY\s+--parents\s+(.+)$/i);
  if (!m) return null;
  const [, indent, rest] = m;
  const parts = rest.trim().split(/\s+/);
  const dest = parts.pop();
  const out = [];

  for (const src of parts) {
    const pivot = src.indexOf('/./');
    if (pivot === -1) throw new Error(`COPY --parents source without a './' pivot: ${src}`);
    const base = src.slice(0, pivot);
    const segs = src.slice(pivot + 3).split('/');
    const globIdx = segs.findIndex((s) => s.includes('*'));

    if (globIdx === -1) {
      out.push(`${indent}COPY ${base}/${segs.join('/')} ${posix.join(dest, dirname(segs.join('/')))}/`);
      continue;
    }
    if (segs.slice(globIdx + 1).some((s) => s.includes('*'))) {
      throw new Error(`multi-segment globs are not supported: ${src}`);
    }

    const globDir = join(repoRoot, base, ...segs.slice(0, globIdx));
    const pattern = new RegExp(
      '^' + segs[globIdx].replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
    );
    const remainder = segs.slice(globIdx + 1).join('/');
    const matches = readdirSync(globDir)
      .filter((n) => pattern.test(n))
      .filter((n) => {
        try {
          statSync(join(globDir, n, remainder));
          return true;
        } catch {
          return false;
        }
      })
      .sort();
    if (!matches.length) throw new Error(`COPY --parents glob matched nothing: ${src}`);

    for (const n of matches) {
      out.push(
        `${indent}COPY ${posix.join(base, ...segs.slice(0, globIdx), n, remainder)} ` +
          `${posix.join(dest, ...segs.slice(0, globIdx), n)}/`,
      );
    }
  }
  return out;
}

const desugared = [];
for (const line of dockerfile.split('\n')) {
  if (/^\s*#\s*syntax\s*=/i.test(line)) continue;
  const expanded = expandParents(line);
  if (expanded) desugared.push(...expanded);
  else desugared.push(line);
}

const leftovers = desugared.filter((l) =>
  /^\s*(COPY|RUN|ADD)\s+.*--(parents|link|checksum|mount|network|security)\b/i.test(l),
);
if (leftovers.length) {
  console.error('desugar incomplete — BuildKit-frontend-only flags remain:');
  for (const l of leftovers) console.error('  ' + l.trim());
  console.error('\nAdd a rule for these, or the built-in frontend will reject the build.');
  process.exit(1);
}

// ---------------------------------------------------------------- 3. build

const scratch = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), 'imgbuild-'));
const ctxTar = join(scratch, 'ctx.tar');

// tracked files only: mirrors .dockerignore's intent and keeps the context deterministic
execFileSync('sh', ['-c', `git -C '${repoRoot}' ls-files -z > '${scratch}/files.z'`]);
execFileSync('tar', ['--null', '-cf', ctxTar, '-C', repoRoot, '-T', `${scratch}/files.z`]);
writeFileSync(join(scratch, 'Dockerfile'), desugared.join('\n'));
// appended last so it wins over the tracked Dockerfile
execFileSync('tar', ['-rf', ctxTar, '-C', scratch, 'Dockerfile']);

console.error(`building ${tag} (target=${target}) ...`);
const url =
  `${DOCKER_HOST}/build?version=2&rm=1` +
  `&target=${encodeURIComponent(target)}&t=${encodeURIComponent(tag)}`;
const log = claw(['-X', 'POST', '-H', 'Content-Type: application/x-tar', '--data-binary', `@${ctxTar}`, url], {
  timeout: 3_600_000,
});

const errors = log
  .split('\n')
  .filter((l) => l.includes('"errorDetail"'))
  .map((l) => {
    try {
      return JSON.parse(l).error;
    } catch {
      return l;
    }
  });

if (errors.length) {
  console.error('BUILD FAILED:');
  for (const e of errors) console.error('  ' + e);
  process.exit(1);
}
console.error(`built ${tag}`);
