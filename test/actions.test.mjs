/**
 * Unit tests for the rule-Action dropdown logic.
 *
 *   node test/actions.test.mjs
 *
 * The regression these exist for: a profile with proxies but an empty
 * <ChainList/> offered no Proxy entry at all, because the dropdown was built
 * from chains alone.
 */
import {
  actionOptions,
  actionValue,
  parseActionValue,
  proxyLabel,
  chainLabel,
  hasProxyTargets,
} from '../extension/actions.js';

const PROXY = { id: '100', type: 'SOCKS5', address: '127.0.0.1', port: '7890' };
const CHAIN = { id: '1100', name: 'verge-mihomo', type: 'simple', members: ['100'] };

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

const values = (o) => actionOptions(o).map((x) => x.value);

// --- the regression ---
check('one proxy, empty ChainList -> a Proxy option exists', values({ proxies: [PROXY], chains: [] }), [
  'Direct',
  'Block',
  'Proxy:100',
]);
check(
  'label shows type and endpoint',
  actionOptions({ proxies: [PROXY] }).at(-1).label,
  'Proxy → SOCKS5 127.0.0.1:7890',
);

check('chains are offered before bare proxies', values({ proxies: [PROXY], chains: [CHAIN] }), [
  'Direct',
  'Block',
  'Proxy:1100',
  'Proxy:100',
]);
check('nothing to route through -> Direct and Block only', values({}), ['Direct', 'Block']);
check('hasProxyTargets is false with nothing', hasProxyTargets({}), false);
check('hasProxyTargets is true with only a proxy', hasProxyTargets({ proxies: [PROXY] }), true);
check('hasProxyTargets is true with only a chain', hasProxyTargets({ chains: [CHAIN] }), true);

// --- labels survive missing data ---
check('label with type but no endpoint', proxyLabel({ id: '7', type: 'HTTPS' }), 'HTTPS');
check('label with neither', proxyLabel({ id: '7' }), 'proxy 7');
check('chain label', chainLabel(CHAIN), 'verge-mihomo [1100]');
check('unnamed chain label', chainLabel({ id: '5' }), '(unnamed chain) [5]');

// --- action value round-trip ---
check('preselect a proxy action', actionValue({ type: 'Proxy', id: '100' }), 'Proxy:100');
check('preselect multiple proxy ids', actionValue({ type: 'Proxy', id: '1100' }), 'Proxy:1100');
check('preselect Direct', actionValue({ type: 'Direct' }), 'Direct');
check('preselect with no action', actionValue(undefined), 'Direct');
check('parse a proxy value', parseActionValue('Proxy:100'), { type: 'Proxy', id: '100' });
check('parse Direct', parseActionValue('Direct'), { type: 'Direct', id: null });
check('parse Block', parseActionValue('Block'), { type: 'Block', id: null });
check('value survives a round-trip', parseActionValue(actionValue({ type: 'Proxy', id: '1100' })), {
  type: 'Proxy',
  id: '1100',
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
