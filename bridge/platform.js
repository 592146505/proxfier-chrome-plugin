/**
 * Cross-platform helpers, kept as pure as possible so the Windows branches can
 * be unit-tested from any OS.
 *
 * macOS keeps its current paths; Windows gets %APPDATA%; everything else gets
 * an XDG directory. Tests inject platform/env/homedir explicitly.
 */
import path from 'node:path';

/** The bridge's per-user data directory. */
export function appDir({ platform = process.platform, env = process.env, homedir = '' } = {}) {
  if (platform === 'win32') {
    const appData = env.APPDATA || (homedir ? path.join(homedir, 'AppData', 'Roaming') : 'AppData');
    return path.join(appData, 'ProxifierBridge');
  }
  if (platform === 'darwin') {
    return path.join(homedir, 'Library', 'Application Support', 'ProxifierBridge');
  }
  return path.join(env.XDG_CONFIG_HOME || (homedir ? path.join(homedir, '.config') : '.config'), 'ProxifierBridge');
}

/** The Startup-folder launcher used instead of a LaunchAgent on Windows. */
export function startupVbsPath({ appData = '' } = {}) {
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'proxifier-bridge.vbs');
}

/** Where Proxifier v4 for Windows installs, newest first. */
export function proxifierExeCandidates({ env = process.env } = {}) {
  const programFilesX86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const programFiles = env.ProgramFiles || 'C:\\Program Files';
  return [
    path.join(programFilesX86, 'Proxifier', 'Proxifier.exe'),
    path.join(programFiles, 'Proxifier', 'Proxifier.exe'),
    ...(env.LOCALAPPDATA ? [path.join(env.LOCALAPPDATA, 'Programs', 'Proxifier', 'Proxifier.exe')] : []),
  ];
}

/**
 * Resolve the Proxifier executable. `cfg.proxifierExe` wins so a non-standard
 * install can be pinned once in config.json.
 */
export function findProxifierExe({ cfg = {}, env = process.env, exists = () => false } = {}) {
  if (typeof cfg.proxifierExe === 'string' && cfg.proxifierExe && exists(cfg.proxifierExe)) {
    return cfg.proxifierExe;
  }
  return proxifierExeCandidates({ env }).find(exists) ?? null;
}

/** argv for a silent profile load. */
export function silentLoadArgs(profilePath) {
  return [profilePath, 'silent-load'];
}

/** Only the built-in placeholder profile targets macOS; Windows needs a real export. */
export function canCreateEmptyProfile(platform = process.platform) {
  return platform === 'darwin';
}

/** Whether Proxifier is the macOS edition we drive over the Accessibility API. */
export function isDarwin(platform = process.platform) {
  return platform === 'darwin';
}

/** Whether Proxifier accepts the official `silent-load` command line. */
export function isWindows(platform = process.platform) {
  return platform === 'win32';
}
