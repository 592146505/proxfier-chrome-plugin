/**
 * Unit tests for the bridge-connection parsing in extension/connection.js.
 *
 *   node test/connection.test.mjs
 */
import { parseToken, resolveConnection, DEFAULT_BRIDGE_URL } from '../extension/connection.js';

const TOKEN = 'c23d6c71cd7810dea721dd4fe472070fb25af4ac05c59523';
const LINK = `http://127.0.0.1:47653/t/${TOKEN}/`;

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

check('empty token field', parseToken(''), { kind: 'empty', token: '', base: null });
check('the full link', parseToken(LINK), { kind: 'link', token: TOKEN, base: 'http://127.0.0.1:47653' });
check('link without trailing slash', parseToken(LINK.slice(0, -1)), {
  kind: 'link',
  token: TOKEN,
  base: 'http://127.0.0.1:47653',
});
check('bare url is not a token', parseToken('http://127.0.0.1:47653'), {
  kind: 'url',
  token: '',
  base: 'http://127.0.0.1:47653',
});
check('bare token', parseToken(TOKEN), { kind: 'token', token: TOKEN, base: null });
check('whitespace tolerated', parseToken(`  ${TOKEN}  `), { kind: 'token', token: TOKEN, base: null });

// --- resolveConnection: the regression that caused "token is not set" ---

check('link pasted into the token box', resolveConnection(LINK, ''), {
  bridgeUrl: 'http://127.0.0.1:47653',
  token: TOKEN,
});
check('link pasted into the url box', resolveConnection('', LINK), {
  bridgeUrl: 'http://127.0.0.1:47653',
  token: TOKEN,
});
check('token box + explicit url box', resolveConnection(TOKEN, 'http://10.0.0.5:9000'), {
  bridgeUrl: 'http://10.0.0.5:9000',
  token: TOKEN,
});
// The link is a self-consistent base+token pair, so its base wins. Otherwise
// pasting a new link while the URL box still holds an old value would stitch
// together a mismatched pair.
check("the link's own base wins over the url box", resolveConnection(LINK, 'http://10.0.0.5:9000'), {
  bridgeUrl: 'http://127.0.0.1:47653',
  token: TOKEN,
});
check('nothing typed falls back to the default url with no token', resolveConnection('', ''), {
  bridgeUrl: DEFAULT_BRIDGE_URL,
  token: '',
});
check('a url alone never yields a token', resolveConnection('', 'http://127.0.0.1:47653').token, '');
check('trailing slashes are trimmed', resolveConnection(TOKEN, 'http://127.0.0.1:47653///'), {
  bridgeUrl: 'http://127.0.0.1:47653',
  token: TOKEN,
});
check('a raw token in the url box is ignored', resolveConnection('', TOKEN).token, '');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
