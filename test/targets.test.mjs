/**
 * Unit tests for the current-host target helpers in extension/targets.js.
 *
 *   node test/targets.test.mjs
 */
import { hostVariants, mergeTargets } from '../extension/targets.js';

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        expected ${e}\n        actual   ${a}`);
}

check('a plain host gets an exact and a wildcard target', hostVariants('github.com'), [
  'github.com',
  '*.github.com',
]);
check('a www host keeps the exact form but wildcards the bare host', hostVariants('www.github.com'), [
  'www.github.com',
  '*.github.com',
]);
check('an empty host yields no targets', hostVariants(''), []);
check('hostnames are lowercased', hostVariants('GitHub.COM'), ['github.com', '*.github.com']);

check('merge appends to an empty rule', mergeTargets([], 'github.com'), {
  targets: ['github.com', '*.github.com'],
  added: 2,
});
check('merge preserves existing order and appends new entries', mergeTargets(['a.com'], 'github.com'), {
  targets: ['a.com', 'github.com', '*.github.com'],
  added: 2,
});
check('merge does not duplicate entries the rule already has', mergeTargets(['github.com'], 'github.com'), {
  targets: ['github.com', '*.github.com'],
  added: 1,
});
check('merge reports zero when the rule already covers the site', mergeTargets(
  ['github.com', '*.github.com'],
  'github.com',
), { targets: ['github.com', '*.github.com'], added: 0 });
check('a www host counts as covered by the bare wildcard', mergeTargets(['*.github.com'], 'www.github.com'), {
  targets: ['*.github.com', 'www.github.com'],
  added: 1,
});
check('merge tolerates a missing list', mergeTargets(null, 'a.com'), {
  targets: ['a.com', '*.a.com'],
  added: 2,
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
