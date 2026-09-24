/**
 * Syntax gate for every shipped JS file.
 *
 * The bridge files are exercised directly by the unit and smoke tests, but the
 * extension only runs in Chrome — a SyntaxError in a service worker silently
 * kills the whole extension (popup loses message passing, handlers never
 * bind). This is the cheap gate that catches that class of regression.
 *
 *   node test/syntax.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const files = ['bridge', 'extension'].flatMap((dir) =>
  fs
    .readdirSync(path.join(root, dir))
    .filter((f) => f.endsWith('.js'))
    .sort()
    .map((f) => path.join(dir, f)),
);

let fail = 0;
for (const rel of files) {
  try {
    execFileSync(process.execPath, ['--check', path.join(root, rel)], { stdio: 'pipe' });
    console.log(`PASS  ${rel} parses`);
  } catch (err) {
    fail++;
    console.log(`FAIL  ${rel}\n${String(err.stderr ?? err.message).trim()}`);
  }
}

console.log(`\n${files.length - fail} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
