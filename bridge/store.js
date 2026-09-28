/**
 * File store for profiles.
 *
 * The bridge's profiles/ directory is the single source of truth. Proxifier
 * pulls from us over HTTP (File -> Profile Auto Update), so we never write
 * into Proxifier's sandbox container and never need Full Disk Access.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PROFILES_DIR, BACKUPS_DIR } from './config.js';
import { Profile } from './ppx.js';
import { canCreateEmptyProfile } from './platform.js';

export { PROFILES_DIR, BACKUPS_DIR };

const MAX_BACKUPS_PER_PROFILE = 30;
const NAME_RE = /^[^/\\:*?"<>|\x00-\x1f]{1,64}$/;

export function assertProfileName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name) || name === '.' || name === '..') {
    throw new Error(`invalid profile name: ${JSON.stringify(name)}`);
  }
  return name;
}

export function profilePath(name) {
  return path.join(PROFILES_DIR, `${assertProfileName(name)}.ppx`);
}

export function listProfiles() {
  if (!fs.existsSync(PROFILES_DIR)) return [];
  return fs
    .readdirSync(PROFILES_DIR)
    .filter((f) => f.endsWith('.ppx'))
    .map((f) => {
      const full = path.join(PROFILES_DIR, f);
      const st = fs.statSync(full);
      return { name: f.slice(0, -4), bytes: st.size, modified: st.mtime.toISOString() };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function exists(name) {
  return fs.existsSync(profilePath(name));
}

export function readRaw(name) {
  return fs.readFileSync(profilePath(name), 'utf8');
}

export function load(name) {
  return Profile.parse(readRaw(name));
}

/**
 * The profile Proxifier should receive.
 *
 * Proxifier pulls profiles from profiles/ over HTTP, so this is the only
 * content it ever sees. Serving the normalised form means a correction that
 * lives only in the model (list quoting, the DNS auto switch) reaches the
 * client on the next pull, instead of waiting for the next save to persist it.
 */
export function readNormalized(name) {
  return Profile.parse(readRaw(name)).toXml();
}

function snapshot(name, xml, reason) {
  const dir = path.join(BACKUPS_DIR, assertProfileName(name));
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${stamp}__${reason}.ppx`);
  fs.writeFileSync(file, xml, { mode: 0o600 });

  const kept = fs.readdirSync(dir).filter((f) => f.endsWith('.ppx')).sort();
  for (const old of kept.slice(0, Math.max(0, kept.length - MAX_BACKUPS_PER_PROFILE))) {
    fs.unlinkSync(path.join(dir, old));
  }
  return file;
}

/**
 * Write a profile atomically, snapshotting the previous revision first.
 * Returns { backup } so callers can surface a rollback handle.
 */
export function writeRaw(name, xml, { reason = 'save' } = {}) {
  const target = profilePath(name);
  let backup = null;
  if (fs.existsSync(target)) backup = snapshot(name, fs.readFileSync(target, 'utf8'), reason);

  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, xml, { mode: 0o600 });
  fs.renameSync(tmp, target);
  return { backup };
}

export function save(name, profile, opts) {
  return writeRaw(name, profile.toXml(), opts);
}

/**
 * Create a new profile.
 *
 * Defaults to cloning an existing profile rather than fabricating one.
 * A fabricated profile carries guessed <Options>/<Encryption>, and Proxifier
 * rejects a profile it cannot reconcile — so the only safe base is one
 * Proxifier itself produced (or one we round-tripped from it).
 */
export function create(name, { from = null, empty = false, platform = process.platform } = {}) {
  assertProfileName(name);
  if (exists(name)) throw new Error(`profile "${name}" already exists`);

  const source = empty
    ? null
    : (from ?? listProfiles().find((p) => p.name !== name)?.name ?? null);
  if (!source && !canCreateEmptyProfile(platform)) {
    throw new Error('no source profile available — import a profile exported by Proxifier first');
  }
  const profile = source ? Profile.parse(readRaw(source)) : Profile.empty();
  fs.writeFileSync(profilePath(name), profile.toXml(), { mode: 0o600 });
  return profile;
}

export function remove(name) {
  assertProfileName(name);
  const target = profilePath(name);
  if (!fs.existsSync(target)) throw new Error(`profile "${name}" not found`);
  snapshot(name, fs.readFileSync(target, 'utf8'), 'delete');
  fs.unlinkSync(target);
  return true;
}

export function listBackups(name) {
  const dir = path.join(BACKUPS_DIR, assertProfileName(name));
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.ppx'))
    .sort()
    .reverse()
    .map((f) => ({ id: f, bytes: fs.statSync(path.join(dir, f)).size }));
}

export function restoreBackup(name, id) {
  const dir = path.join(BACKUPS_DIR, assertProfileName(name));
  const src = path.join(dir, path.basename(id));
  if (!fs.existsSync(src)) throw new Error(`backup "${id}" not found`);
  return writeRaw(name, fs.readFileSync(src, 'utf8'), { reason: 'restore' });
}
