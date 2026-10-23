/**
 * Native "choose an application" dialog, shown by the bridge because a
 * browser page can neither browse into .app bundles nor learn a file's path.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { isWindows } from './platform.js';

const run = promisify(execFile);
const DIALOG_TIMEOUT_MS = 5 * 60 * 1000;

/** Proxifier Applications entries for a picked program, most specific first. */
export function appEntries({ bundleId = null, executable = null, exe = null } = {}) {
  const entries = [];
  for (const value of [bundleId, executable, exe]) {
    const v = String(value ?? '').trim();
    if (v && !entries.some((e) => e.toLowerCase() === v.toLowerCase())) entries.push(v);
  }
  return entries;
}

const MAC_SCRIPT = [
  'tell me to activate',
  'set picked to choose file with prompt "Choose an application for this Proxifier rule" ' +
    'of type {"com.apple.application-bundle"} default location (path to applications folder)',
  'POSIX path of picked',
];

async function pickMac() {
  let appPath;
  try {
    const { stdout } = await run('osascript', MAC_SCRIPT.flatMap((l) => ['-e', l]), { timeout: DIALOG_TIMEOUT_MS });
    appPath = stdout.trim().replace(/\/$/, '');
  } catch (err) {
    if (/-128/.test(String(err.stderr ?? ''))) return { cancelled: true };
    throw new Error(`could not open the application chooser: ${String(err.stderr || err.message).trim()}`);
  }
  const { stdout } = await run('plutil', ['-convert', 'json', '-o', '-', path.join(appPath, 'Contents', 'Info.plist')]);
  const info = JSON.parse(stdout);
  const bundleId = info.CFBundleIdentifier ?? null;
  const executable = info.CFBundleExecutable ?? null;
  return {
    cancelled: false,
    path: appPath,
    name: info.CFBundleDisplayName ?? info.CFBundleName ?? path.basename(appPath, '.app'),
    bundleId,
    executable,
    entries: appEntries({ bundleId, executable }),
  };
}

const WIN_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Title = 'Choose an application for this Proxifier rule'
$d.Filter = 'Programs (*.exe)|*.exe'
$d.InitialDirectory = $env:ProgramFiles
if ($d.ShowDialog($owner) -eq 'OK') { [Console]::Out.Write($d.FileName) }
`;

async function pickWindows() {
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-STA', '-Command', WIN_SCRIPT], {
    timeout: DIALOG_TIMEOUT_MS,
    windowsHide: true,
  });
  const exePath = stdout.trim();
  if (!exePath) return { cancelled: true };
  const exe = path.win32.basename(exePath);
  return {
    cancelled: false,
    path: exePath,
    name: path.win32.basename(exePath, path.win32.extname(exePath)),
    bundleId: null,
    executable: exe,
    entries: appEntries({ exe }),
  };
}

let pending = null;

/** Opens one dialog at a time; a second request joins the open one. */
export function pickApplication() {
  pending ??= (isWindows() ? pickWindows() : pickMac()).finally(() => {
    pending = null;
  });
  return pending;
}
