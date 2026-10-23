/**
 * Two HTTP surfaces on one port:
 *
 *  1. Proxifier-facing  (/t/<token>/...)   -- curl-friendly, no custom headers.
 *     Proxifier's "Profile Auto Update" pulls profiles from here, which is
 *     what makes reload work without writing into its sandbox container.
 *
 *  2. Extension-facing  (/api/...)         -- JSON, requires X-Bridge-Token.
 */
import http from 'node:http';
import fs from 'node:fs';
import { URL } from 'node:url';
import * as store from './store.js';
import { Profile } from './ppx.js';
import { triggerReload, probeReload } from './reload.js';
import { findProxifierExe } from './platform.js';
import { baseUrl, PROFILES_DIR, saveConfig } from './config.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-length': Buffer.byteLength(payload), ...headers });
  res.end(payload);
}

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/** Apache-style index; some clients scrape hrefs to learn the file list. */
function indexPage(profiles) {
  const links = profiles
    .map((p) => `<li><a href="${encodeURIComponent(p.name)}.ppx">${p.name}.ppx</a> (${p.bytes} bytes)</li>`)
    .join('\n');
  return `<!doctype html><html><head><title>Index of /</title></head><body>
<h1>Index of /</h1><ul>
${links}
</ul></body></html>`;
}

export function createServer(cfg, { persist = true } = {}) {
  const state = { lastReload: null, startedAt: new Date().toISOString() };
  const saveCfg = () => {
    if (persist) saveConfig(cfg);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, baseUrl(cfg));
    const segments = url.pathname.split('/').filter(Boolean);

    // Access log: this is how you find out whether Proxifier actually pulled.
    console.log(
      `[${new Date().toISOString()}] ${req.method} ${url.pathname} ` +
        `ua=${JSON.stringify(req.headers['user-agent'] ?? '')}`,
    );

    const cors = {};
    const origin = req.headers.origin;
    if (origin && origin.startsWith('chrome-extension://')) {
      cors['access-control-allow-origin'] = origin;
      cors['access-control-allow-headers'] = 'content-type,x-bridge-token';
      cors['access-control-allow-methods'] = 'GET,POST,PUT,PATCH,DELETE,OPTIONS';
    }
    if (req.method === 'OPTIONS') return send(res, 204, '', cors);

    try {
      // ---------- surface 1: Proxifier ----------
      if (segments[0] === 't') {
        if (segments[1] !== cfg.token) return send(res, 404, 'not found', { 'content-type': 'text/plain' });
        const rest = segments.slice(2);

        if (rest.length === 0) {
          return send(res, 200, indexPage(store.listProfiles()), {
            'content-type': 'text/html; charset=utf-8',
          });
        }
        const file = rest[rest.length - 1];
        if (file.endsWith('.ppx')) {
          const name = decodeURIComponent(file.slice(0, -4));
          // Proxifier asks for <base>/<current profile name>.ppx, but the name
          // it uses is not always the one shown in File > Load Profile (it
          // requests `default.ppx` for its built-in profile). Fall back to the
          // profile the extension designated as active, so a name mismatch does
          // not silently stop syncing.
          let serve = name;
          if (!store.exists(serve)) {
            if (cfg.activeProfile && store.exists(cfg.activeProfile)) {
              serve = cfg.activeProfile;
            } else {
              state.lastFetch = { at: new Date().toISOString(), requested: name, served: null, fallback: true };
              return send(res, 404, 'no such profile', { 'content-type': 'text/plain' });
            }
          }
          // Record what Proxifier asked for, so the extension can tell the user
          // when their active profile is unnamed or renamed (Proxifier then
          // requests an internal name and we silently serve the active one).
          state.lastFetch = {
            at: new Date().toISOString(),
            requested: name,
            served: serve,
            fallback: serve !== name,
          };
          // Serve the normalised profile rather than the raw file: this is the
          // only content Proxifier sees, so a correction that exists only in
          // the model has to be applied here to survive its next GUI edit.
          return send(res, 200, store.readNormalized(serve), {
            'content-type': 'application/xml; charset=utf-8',
            'cache-control': 'no-store',
          });
        }
        return send(res, 404, 'not found', { 'content-type': 'text/plain' });
      }

      // ---------- surface 2: extension ----------
      if (segments[0] !== 'api') return send(res, 404, { error: 'not found' }, cors);

      if (segments[1] === 'health' && req.method === 'GET') {
        return send(res, 200, { ok: true, startedAt: state.startedAt, lastReload: state.lastReload }, cors);
      }

      if (req.headers['x-bridge-token'] !== cfg.token) {
        return send(res, 401, { error: 'invalid or missing X-Bridge-Token' }, cors);
      }

      const [, resource, profileName, sub, arg] = segments;

      // ---- resource-level endpoints ----
      if (resource === 'state' && req.method === 'GET') {
        return send(res, 200, {
          profiles: store.listProfiles(),
          active: cfg.activeProfile ?? null,
          updateUrl: `${baseUrl(cfg)}/t/${cfg.token}/`,
          profilesDir: PROFILES_DIR,
          lastFetch: state.lastFetch ?? null,
        }, cors);
      }

      if (resource === 'active' && req.method === 'POST') {
        const body = await readBody(req);
        if (!store.exists(body.name)) {
          return send(res, 404, { error: `profile "${body.name}" not found` }, cors);
        }
        cfg.activeProfile = body.name;
        saveCfg();
        return send(res, 200, { ok: true, active: cfg.activeProfile }, cors);
      }

      if (resource === 'reload' && req.method === 'POST') {
        // Windows needs the profile file (silent-load); macOS ignores both and
        // clicks Update Now over the Accessibility API.
        const result = await triggerReload({
          exe: findProxifierExe({ cfg, exists: fs.existsSync }),
          profilePath: cfg.activeProfile && store.exists(cfg.activeProfile)
            ? store.profilePath(cfg.activeProfile)
            : null,
        });
        state.lastReload = { at: new Date().toISOString(), ...result };
        return send(res, 200, state.lastReload, cors);
      }

      if (resource === 'doctor' && req.method === 'GET') {
        return send(res, 200, { reload: await probeReload({ exe: findProxifierExe({ cfg, exists: fs.existsSync }) }) }, cors);
      }

      if (resource === 'profiles' && !profileName) {
        if (req.method === 'GET') return send(res, 200, { profiles: store.listProfiles() }, cors);
        if (req.method === 'POST') {
          const body = await readBody(req);
          store.create(body.name, { from: body.from ?? null, empty: body.empty === true });
          return send(res, 201, { ok: true, name: body.name }, cors);
        }
      }

      // ---- per-profile endpoints ----
      if (resource !== 'profiles' || !profileName) {
        return send(res, 404, { error: `no route for ${req.method} ${url.pathname}` }, cors);
      }

      if (!sub) {
        if (req.method === 'GET') return send(res, 200, store.load(profileName).toJSON(), cors);
        if (req.method === 'DELETE') {
          store.remove(profileName);
          return send(res, 200, { ok: true }, cors);
        }
        return send(res, 405, { error: `${req.method} not allowed` }, cors);
      }

      if (sub === 'raw') {
        if (req.method === 'GET') {
          return send(res, 200, store.readRaw(profileName), { ...cors, 'content-type': 'application/xml; charset=utf-8' });
        }
        if (req.method === 'PUT') {
          const body = await readBody(req);
          // Validate before persisting so a bad payload can never reach Proxifier.
          const parsed = Profile.parse(body.xml);
          const { backup } = store.save(profileName, parsed, { reason: 'raw-put' });
          return send(res, 200, { ok: true, backup, rules: parsed.rules().length }, cors);
        }
      }

      if (sub === 'rules') {
        const profile = store.load(profileName);
        if (arg === undefined) {
          if (req.method === 'GET') {
            return send(res, 200, { rules: profile.rules().map((r) => r.toJSON()) }, cors);
          }
          if (req.method === 'POST') {
            const body = await readBody(req);
            profile.addRule(body.rule ?? {});
            const { backup } = store.save(profileName, profile, { reason: 'rule-add' });
            return send(res, 201, { ok: true, backup, rules: profile.rules().map((r) => r.toJSON()) }, cors);
          }
        } else {
          const index = Number(arg);
          if (req.method === 'PATCH') {
            const body = await readBody(req);
            profile.ruleAt(index).apply(body.patch ?? {});
            const { backup } = store.save(profileName, profile, { reason: 'rule-update' });
            return send(res, 200, { ok: true, backup, rule: profile.ruleAt(index).toJSON() }, cors);
          }
          if (req.method === 'DELETE') {
            profile.removeRule(index);
            const { backup } = store.save(profileName, profile, { reason: 'rule-delete' });
            return send(res, 200, { ok: true, backup, rules: profile.rules().map((r) => r.toJSON()) }, cors);
          }
          if (req.method === 'PUT') {
            // Bulk replace the whole rule list.
            const body = await readBody(req);
            const list = profile._ruleList();
            for (const el of list.childrenNamed('Rule')) list.removeChild(el);
            for (const rule of body.rules ?? []) profile.addRule(rule);
            const { backup } = store.save(profileName, profile, { reason: 'rules-replace' });
            return send(res, 200, { ok: true, backup, rules: profile.rules().map((r) => r.toJSON()) }, cors);
          }
        }
      }

      if (sub === 'move' && arg !== undefined && req.method === 'POST') {
        const body = await readBody(req);
        const profile = store.load(profileName);
        profile.moveRule(Number(arg), Number(body.to));
        const { backup } = store.save(profileName, profile, { reason: 'rule-move' });
        return send(res, 200, { ok: true, backup, rules: profile.rules().map((r) => r.toJSON()) }, cors);
      }

      if (sub === 'proxies') {
        const profile = store.load(profileName);
        const body = req.method === 'POST' || req.method === 'PATCH' ? await readBody(req) : {};
        let id = arg;
        if (arg === undefined && req.method === 'POST') {
          id = profile.addProxy(body.proxy ?? {});
        } else if (arg !== undefined && req.method === 'PATCH') {
          profile.updateProxy(arg, body.patch ?? {});
        } else if (arg !== undefined && req.method === 'DELETE') {
          profile.removeProxy(arg);
        } else {
          return send(res, 405, { error: `${req.method} not allowed` }, cors);
        }
        const { backup } = store.save(profileName, profile, { reason: `proxy-${req.method.toLowerCase()}` });
        return send(res, req.method === 'POST' ? 201 : 200, { ok: true, backup, id, proxies: profile.proxies() }, cors);
      }

      if (sub === 'backups') {
        if (req.method === 'GET') return send(res, 200, { backups: store.listBackups(profileName) }, cors);
        if (req.method === 'POST') {
          const body = await readBody(req);
          const { backup } = store.restoreBackup(profileName, body.id);
          return send(res, 200, { ok: true, backup }, cors);
        }
      }

      return send(res, 404, { error: `no route for ${req.method} ${url.pathname}` }, cors);
    } catch (err) {
      const status = /not found|no rule at|no such/i.test(err.message) ? 404 : 400;
      return send(res, status, { error: err.message }, cors);
    }
  });

  return {
    server,
    state,
    listen() {
      return new Promise((resolve) => {
        server.listen(cfg.port, '127.0.0.1', () => resolve(server.address()));
      });
    },
  };
}
