/**
 * Unit tests for platform-sensitive helpers.
 *
 *   node test/platform.test.mjs
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  appDir,
  canCreateEmptyProfile,
  findProxifierExe,
  silentLoadArgs,
  startupVbsPath,
} from '../bridge/platform.js';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}\n${err.message}`);
    process.exitCode = 1;
  }
}

test('Windows data lives under APPDATA', () => {
  assert.equal(
    appDir({ platform: 'win32', env: { APPDATA: 'C:\\Users\\Test\\AppData\\Roaming' }, homedir: 'C:\\Users\\Test' }),
    path.join('C:\\Users\\Test\\AppData\\Roaming', 'ProxifierBridge'),
  );
});

test('Windows data falls back to the roaming home path', () => {
  assert.equal(
    appDir({ platform: 'win32', env: {}, homedir: 'C:\\Users\\Test' }),
    path.join('C:\\Users\\Test', 'AppData', 'Roaming', 'ProxifierBridge'),
  );
});

test('macOS and XDG data paths stay stable', () => {
  assert.equal(
    appDir({ platform: 'darwin', env: {}, homedir: '/Users/test' }),
    path.join('/Users/test', 'Library', 'Application Support', 'ProxifierBridge'),
  );
  assert.equal(
    appDir({ platform: 'linux', env: { XDG_CONFIG_HOME: '/cfg' }, homedir: '/Users/test' }),
    path.join('/cfg', 'ProxifierBridge'),
  );
});

test('Windows launcher is placed in the Startup folder', () => {
  assert.equal(
    startupVbsPath({ appData: 'C:\\Users\\Test\\AppData\\Roaming' }),
    path.join(
      'C:\\Users\\Test\\AppData\\Roaming',
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
      'Startup',
      'proxifier-bridge.vbs',
    ),
  );
});

test('a configured Proxifier executable wins over standard paths', () => {
  const custom = 'D:\\Tools\\Proxifier.exe';
  assert.equal(
    findProxifierExe({ cfg: { proxifierExe: custom }, env: {}, exists: (p) => p === custom }),
    custom,
  );
});

test('standard Proxifier install paths are checked in order', () => {
  const env = {
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    ProgramFiles: 'C:\\Program Files',
    LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local',
  };
  const x86Exe = path.join(env['ProgramFiles(x86)'], 'Proxifier', 'Proxifier.exe');
  assert.equal(findProxifierExe({ cfg: {}, env, exists: (p) => p === x86Exe }), x86Exe);
  assert.equal(findProxifierExe({ cfg: {}, env, exists: () => false }), null);
});

test('silent-load uses the documented argument order', () => {
  assert.deepEqual(silentLoadArgs('C:\\Profiles\\Work.ppx'), ['C:\\Profiles\\Work.ppx', 'silent-load']);
});

test('only the macOS placeholder profile may be fabricated', () => {
  assert.equal(canCreateEmptyProfile('darwin'), true);
  assert.equal(canCreateEmptyProfile('win32'), false);
});

console.log(`\n${passed} passed, ${process.exitCode ? 1 : 0} failed`);
