/**
 * Unit tests for the profile model in bridge/ppx.js.
 *
 * The fixture mirrors the exact shape Proxifier 3.15.0 writes (verified via
 * File → Export…): the proxy endpoint lives in <Address>/<Port> child elements,
 * and <ChainList/> is empty when the profile has no chains.
 *
 *   node test/ppx.test.mjs
 */
import { Profile, emptyProfileXml } from '../bridge/ppx.js';

const FIXTURE = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<ProxifierProfile version="101" platform="MacOSX" product_id="2" product_minver="200">
    <Options>
        <Resolve>
            <AutoModeDetection enabled="true"/>
            <ViaProxy enabled="false">
                <TryLocalDnsFirst enabled="false"/>
            </ViaProxy>
            <ExclusionList ExcludeSimpleHostnames="false" ExcludeLocalhost="true" ExcludeSelfHostname="true" ExcludeLocalDomain="true">localhost;%ComputerName%;*.local;</ExclusionList>
        </Resolve>
        <Encryption mode="account">
            <Hash>AAECwM5830ccH5njdDAoRS9DLncVG7Ld3lTe7XkOpCqhSm4=</Hash>
        </Encryption>
        <HttpProxiesSupport enabled="false"/>
        <HandleDirectConnections enabled="false"/>
        <ConnectionLoopDetection enabled="true"/>
        <ProcessServices enabled="true"/>
        <ProcessOtherUsers enabled="true"/>
        <BlockUDP443 enabled="false"/>
    </Options>
    <ProxyList>
        <Proxy id="100" type="SOCKS5">
            <Address>127.0.0.1</Address>
            <Port>7890</Port>
            <Options>0</Options>
        </Proxy>
    </ProxyList>
    <ChainList/>
    <RuleList>
        <Rule enabled="true">
            <Name>Localhost</Name>
            <Targets>localhost; 127.0.0.1; ::1</Targets>
            <Action type="Direct"/>
        </Rule>
        <Rule enabled="true">
            <Name>proxys</Name>
            <Targets>*.github.com; *.openai.com</Targets>
            <Action type="Proxy">100</Action>
        </Rule>
        <Rule enabled="false">
            <Name>codex-proxy</Name>
            <Applications>Codex.app; "Codex Helper"</Applications>
            <Action type="Proxy">100</Action>
        </Rule>
        <Rule enabled="true">
            <Name>Default</Name>
            <Action type="Direct"/>
        </Rule>
    </RuleList>
</ProxifierProfile>
`;

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

const p = Profile.parse(FIXTURE);

// --- the regression: endpoint is in child elements, not host/port attributes
check('proxies() reads the endpoint from child elements', p.proxies(), [
  { id: '100', type: 'SOCKS5', address: '127.0.0.1', port: '7890', fields: { Address: '127.0.0.1', Port: '7890', Options: '0' } },
]);
check('chains() is empty for an empty ChainList', p.chains(), []);
check('rules() preserves order', p.rules().map((r) => r.name), [
  'Localhost',
  'proxys',
  'codex-proxy',
  'Default',
]);
check('enabled flag round-trips', p.rules().map((r) => r.enabled), [true, true, false, true]);
check('Proxy action points at the proxy id', p.rules()[1].action, { type: 'Proxy', id: '100' });
// Quoting is a serialisation detail: the model holds unquoted values, so the
// UI shows "Codex Helper" rather than a literal quoted string, and every save
// re-quotes it.
check('quoted Applications entries are parsed unquoted', p.rules()[2].applications, [
  'Codex.app',
  'Codex Helper',
]);
check('Targets split on semicolons', p.rules()[1].targets, ['*.github.com', '*.openai.com']);
check('meta is preserved', p.meta, { version: '101', platform: 'MacOSX', productMinVer: '200' });

// --- mutation keeps the parts we do not model
const out = p.toXml();
check('round-trip is idempotent', Profile.parse(out).toXml(), out);
check('Encryption hash is preserved', out.includes('<Hash>AAECwM5830ccH5njdDAoRS9DLncVG7Ld3lTe7XkOpCqhSm4=</Hash>'), true);
check('ViaProxy still nests TryLocalDnsFirst', /<ViaProxy[^>]*>\s*<TryLocalDnsFirst/.test(out), true);
check('Exclude* stayed attributes of ExclusionList', /<ExclusionList[^>]*ExcludeLocalhost="true"/.test(out), true);
check('the proxy endpoint survives a round-trip', Profile.parse(out).proxies()[0].address, '127.0.0.1');

// --- addRule inserts before the catch-all
p.addRule({ name: 'new-one', targets: ['example.com'], action: { type: 'Proxy', id: '100' } });
check('new rule lands before Default', p.rules().map((r) => r.name), [
  'Localhost',
  'proxys',
  'codex-proxy',
  'new-one',
  'Default',
]);
check('a Proxy rule without an id is rejected', (() => {
  try {
    p.addRule({ name: 'bad', action: { type: 'Proxy' } });
    return 'no error';
  } catch (err) {
    return /requires an id/.test(err.message) ? 'rejected' : err.message;
  }
})(), 'rejected');

// --- the built-in skeleton is valid and parseable
const empty = Profile.empty();
check('emptyProfileXml parses', empty.rules().map((r) => r.name), ['Localhost', 'Default']);
check('emptyProfileXml keeps only Direct actions', empty.rules().every((r) => r.action.type === 'Direct'), true);
check('emptyProfileXml round-trips', Profile.parse(empty.toXml()).toXml(), empty.toXml());
check('skeleton has no invented proxies', empty.proxies(), []);

// --- list quoting: an entry with whitespace MUST be quoted, on every write path
function testQuoting() {
  const q = Profile.parse(FIXTURE);
  q.addRule({
    name: 'chrome',
    applications: ['Google Chrome'],
    targets: ['*.google.com'],
    action: { type: 'Proxy', id: '100' },
  });
  const qx = q.toXml();
  check(
    'an app name with a space is quoted in the file',
    /<Applications>&quot;Google Chrome&quot;<\/Applications>/.test(qx),
    true,
  );
  check(
    'parsing strips the quotes back off',
    q.rules().find((r) => r.name === 'chrome').applications,
    ['Google Chrome'],
  );
  check(
    'quoted entries survive a round-trip',
    Profile.parse(qx).rules().find((r) => r.name === 'chrome').applications,
    ['Google Chrome'],
  );

  const mixed = Profile.parse(FIXTURE);
  mixed.ruleAt(0).apply({ applications: ['curl', 'Codex Helper', 'com.x.y'] });
  check(
    'quotes only the entries that need them',
    mixed.toXml().match(/<Applications>[^<]*<\/Applications>/)[0],
    '<Applications>curl; &quot;Codex Helper&quot;; com.x.y</Applications>',
  );

  const existing = Profile.parse(FIXTURE);
  existing.ruleAt(2).apply({ enabled: true });
  check(
    'an already-quoted entry is not double-quoted',
    existing.toXml().includes('&quot;Codex Helper&quot;') && !existing.toXml().includes('&quot;&quot;'),
    true,
  );

  check(
    'an entry containing a double quote is rejected',
    (() => {
      try {
        Profile.parse(FIXTURE).ruleAt(0).apply({ applications: ['bad"name'] });
        return 'no error';
      } catch (err) {
        return /no escape/.test(err.message) ? 'rejected' : err.message;
      }
    })(),
    'rejected',
  );

  // A load->save round-trip must repair an unquoted entry, because toXml()
  // serialises the DOM as-is and the rule may never be edited again.
  const broken = FIXTURE.replace('<Applications>Codex.app; "Codex Helper"</Applications>', '<Applications>Google Chrome</Applications>');
  const repaired = broken.includes('Google Chrome')
    ? Profile.parse(broken).toXml()
    : Profile.parse(FIXTURE).toXml();
  check(
    'normalize() repairs an unquoted entry on load',
    /<Applications>&quot;Google Chrome&quot;<\/Applications>/.test(repaired),
    true,
  );
  check(
    'normalize() leaves correct entries untouched',
    Profile.parse(FIXTURE).toXml().includes('&quot;Codex Helper&quot;'),
    true,
  );
}

testQuoting();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
