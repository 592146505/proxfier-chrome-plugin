import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const APP_DIR = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'ProxifierBridge',
);

export const PROFILES_DIR = path.join(APP_DIR, 'profiles');
export const BACKUPS_DIR = path.join(APP_DIR, 'backups');
export const CONFIG_FILE = path.join(APP_DIR, 'config.json');

export const DEFAULT_PORT = 47653;

function ensureDirs() {
  for (const dir of [APP_DIR, PROFILES_DIR, BACKUPS_DIR]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

/**
 * Bridge config. Created on first run with a random token so that the
 * localhost API is not world-callable by any other local process/page.
 */
export function loadConfig() {
  ensureDirs();

  let cfg = null;
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch (err) {
      throw new Error(`config.json is corrupt: ${err.message}`);
    }
  }

  if (!cfg) {
    cfg = { port: DEFAULT_PORT, token: crypto.randomBytes(24).toString('hex'), activeProfile: null };
    saveConfig(cfg);
    return cfg;
  }

  let changed = false;
  if (typeof cfg.port !== 'number') {
    cfg.port = DEFAULT_PORT;
    changed = true;
  }
  if (typeof cfg.token !== 'string' || cfg.token.length < 16) {
    cfg.token = crypto.randomBytes(24).toString('hex');
    changed = true;
  }
  if (cfg.activeProfile === undefined) {
    cfg.activeProfile = null;
    changed = true;
  }
  if (changed) saveConfig(cfg);

  return cfg;
}

export function saveConfig(cfg) {
  ensureDirs();
  const tmp = `${CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_FILE);
}

export function baseUrl(cfg) {
  return `http://127.0.0.1:${cfg.port}`;
}
