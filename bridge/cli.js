#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { loadConfig, saveConfig, APP_DIR, PROFILES_DIR, baseUrl, DEFAULT_PORT } from './config.js';
import * as store from './store.js';
import { createServer } from './server.js';
import { triggerReload, probeReload } from './reload.js';
import { Profile } from './ppx.js';
import { findProxifierExe, isWindows, startupVbsPath } from './platform.js';

const AGENT_LABEL = 'com.proxifier-bridge';
const AGENT_PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${AGENT_LABEL}.plist`);
const CLI = path.join(import.meta.dirname, 'cli.js');

function usage() {
  console.log(`proxifier-bridge

  serve [--port N] [--no-watch]   start the HTTP bridge (default command)
  doctor                          check config, profiles, permissions
  import <file.ppx> [--as NAME]   copy an exported profile into the store
  export <name> [--out FILE]      write a stored profile out to a file
  link                            print the URL to paste into Proxifier
  install-agent                   run the bridge automatically at login
  uninstall-agent                 remove the login item
  status                          is the login agent loaded and running?
`);
}

function flag(args, name, fallback = undefined) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
}

async function cmdServe(args) {
  const cfg = loadConfig();
  const port = Number(flag(args, 'port', cfg.port));
  if (port !== cfg.port) {
    cfg.port = port;
    saveConfig(cfg);
  }

  const { server, listen, state } = createServer(cfg);
  const addr = await listen();

  const url = `${baseUrl(cfg)}/t/${cfg.token}/`;
  console.log(`proxifier-bridge listening on ${baseUrl(cfg)}`);
  console.log(`  Proxifier URL : ${url}`);
  console.log(`  profiles dir  : ${PROFILES_DIR}`);
  console.log('');
  console.log('Configure Proxifier once:');
  console.log('  File > Profile Auto Update... > tick the box, paste the URL above,');
  console.log('  choose "Folder with multiple profiles", then click Update Now.');

  if (!args.includes('--no-watch')) {
    let timer = null;
    let running = false;
    let lastFailure = null;
    let failures = 0;

    fs.watch(PROFILES_DIR, { persistent: true }, (_event, file) => {
      if (!file || !String(file).endsWith('.ppx') || String(file).endsWith('.tmp')) return;
      clearTimeout(timer);
      timer = setTimeout(async () => {
        if (running) return;
        running = true;
        const reload = await triggerReload(isWindows() ? {
          exe: findProxifierExe({ cfg, exists: fs.existsSync }),
          profilePath: cfg.activeProfile && store.exists(cfg.activeProfile)
            ? store.profilePath(cfg.activeProfile)
            : null,
        } : undefined);
        state.lastReload = { at: new Date().toISOString(), trigger: 'watch', ...reload };

        if (reload.ok) {
          failures = 0;
          lastFailure = null;
          console.log(`[watch] ${file} changed -> reloaded`);
        } else {
          failures += 1;
          // A launchd-run bridge has no Accessibility grant by default, and
          // every write would otherwise log the same failure. Report it once,
          // then only when the reason actually changes.
          const reason = `${reload.result}:${reload.message ?? ''}`;
          if (reason !== lastFailure) {
            lastFailure = reason;
            console.log(`[watch] ${file} changed -> reload unavailable (${reload.result})`);
            if (reload.hint) console.log(`        ${reload.hint}`);
            console.log('        Identical failures are not logged again.');
          } else if (failures % 100 === 0) {
            console.log(`[watch] still unable to reload (${failures} writes since the last success)`);
          }
        }
        running = false;
      }, 400);
    });
    console.log('\nwatching profiles/ for changes (auto-reload enabled)');
  }

  const shutdown = () => {
    console.log('\nshutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function cmdDoctor() {
  const cfg = loadConfig();
  const line = (k, v) => console.log(`  ${k.padEnd(22)} ${v}`);

  console.log('config');
  line('app dir', APP_DIR);
  line('profiles dir', PROFILES_DIR);
  line('port', cfg.port);
  line('token', `${cfg.token.slice(0, 8)}… (${cfg.token.length} chars)`);

  console.log('\nprofiles');
  const profiles = store.listProfiles();
  if (!profiles.length) console.log('  (none yet — create one from the extension or `import`)');
  for (const p of profiles) line(p.name, `${p.bytes} bytes, ${p.modified}`);

  console.log('\nproxifier');
  if (isWindows()) {
    const exe = findProxifierExe({ cfg, exists: fs.existsSync });
    const probe = await probeReload({ exe });
    line('executable', exe ?? 'NOT FOUND');
    line('running', probe.running ? 'yes' : 'no (silent-load can start it)');
    line('reload', probe.ok ? `ok (${probe.mechanism})` : `FAILED: ${probe.message}`);
    if (!probe.ok) console.log(`  -> ${probe.hint ?? 'install Proxifier v4 for Windows'}`);
  } else {
    let running = false;
    try {
      running = execFileSync('pgrep', ['-x', 'Proxifier'], { encoding: 'utf8' }).trim().length > 0;
    } catch {
      running = false;
    }
    line('running', running ? 'yes' : 'NO — start Proxifier first');
    const probe = await probeReload();
    line('accessibility', probe.ok ? `ok (${probe.menus})` : `FAILED: ${probe.message}`);
    if (!probe.ok) {
      console.log('\n  -> System Settings > Privacy & Security > Accessibility:');
      console.log('     add the app that runs the bridge (Terminal for `serve`, or node).');
    }
  }

  console.log('\nnext step');
  console.log(`  paste into Proxifier's Profile Auto Update URL:\n  ${baseUrl(cfg)}/t/${cfg.token}/`);
  if (isWindows()) {
    console.log('  or click Reload in the extension after setting an active profile.');
  }
}

function cmdImport(args) {
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) throw new Error('usage: import <file.ppx> [--as NAME]');
  const xml = fs.readFileSync(file, 'utf8');
  // Parse (validates AND normalises list quoting) and store what we parsed, not
  // the raw bytes — otherwise an unquoted entry would be imported verbatim and
  // Proxifier would refuse the profile.
  const parsed = Profile.parse(xml);
  const name = flag(args, 'as', path.basename(file).replace(/\.ppx$/i, ''));
  const { backup } = store.writeRaw(name, parsed.toXml(), { reason: 'import' });
  console.log(`imported -> ${path.join(PROFILES_DIR, `${name}.ppx`)}${backup ? ` (replaced, backup: ${backup})` : ''}`);
}

function cmdExport(args) {
  const name = args.find((a) => !a.startsWith('--'));
  if (!name) throw new Error('usage: export <name> [--out FILE]');
  const out = flag(args, 'out', path.join(process.cwd(), `${name}.ppx`));
  fs.writeFileSync(out, store.readRaw(name));
  console.log(`exported -> ${out}`);
}

function cmdLink() {
  const cfg = loadConfig();
  console.log(`${baseUrl(cfg)}/t/${cfg.token}/`);
}

const xmlEsc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function cmdInstallAgent() {
  const cfg = loadConfig();
  if (isWindows()) {
    const vbs = startupVbsPath({ appData: process.env.APPDATA });
    if (!process.env.APPDATA) throw new Error('APPDATA is not set; run this from a normal Windows shell');

    fs.mkdirSync(path.dirname(vbs), { recursive: true });
    const quote = (value) => `"${value}"`;
    const command = [
      quote(process.execPath),
      quote(CLI),
      'serve',
      '>>',
      quote(path.join(APP_DIR, 'bridge.out.log')),
      '2>>',
      quote(path.join(APP_DIR, 'bridge.err.log')),
    ].join(' ');
    const vbsString = (value) => `"${String(value).replace(/"/g, '""')}"`;
    fs.writeFileSync(vbs, [
      'Set shell = CreateObject("WScript.Shell")',
      `command = ${vbsString(command)}`,
      'shell.Run "%ComSpec% /d /c " & command, 0, False',
      '',
    ].join('\r\n'), { mode: 0o700 });

    // Starting once makes installation immediately useful; Startup takes over
    // after the next sign-in.
    execFileSync('wscript.exe', [vbs]);

    console.log(`installed and started ${AGENT_LABEL}`);
    console.log(`launcher : ${vbs}`);
    console.log(`node     : ${process.execPath}`);
    console.log(`logs     : ${path.join(APP_DIR, 'bridge.out.log')}`);
    console.log(`           ${path.join(APP_DIR, 'bridge.err.log')}`);
    console.log(`\nProxifier URL: ${baseUrl(cfg)}/t/${cfg.token}/`);
    console.log('\nCheck it with: npm run status');
    return;
  }

  fs.mkdirSync(path.dirname(AGENT_PLIST), { recursive: true });

  // KeepAlive + RunAtLoad means launchd starts this at login and restarts it if
  // it dies. ThrottleInterval stops a crash-loop (e.g. the port already held by
  // a manual `npm run serve`) from spinning. ProcessType Background keeps
  // launchd from treating it as an interactive job.
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEsc(process.execPath)}</string>
    <string>${xmlEsc(CLI)}</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>ProcessType</key><string>Background</string>
  <key>WorkingDirectory</key><string>${xmlEsc(APP_DIR)}</string>
  <key>StandardOutPath</key><string>${xmlEsc(path.join(APP_DIR, 'bridge.out.log'))}</string>
  <key>StandardErrorPath</key><string>${xmlEsc(path.join(APP_DIR, 'bridge.err.log'))}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
  </dict>
</dict>
</plist>
`;
  fs.writeFileSync(AGENT_PLIST, plist);

  // Validate before handing it to launchd, so a typo cannot leave a half-loaded job.
  try {
    execFileSync('plutil', ['-lint', AGENT_PLIST], { stdio: 'pipe' });
  } catch (err) {
    throw new Error(`generated plist is invalid: ${String(err.stdout ?? err.message).trim()}`);
  }

  // bootout first: re-installing over a loaded job fails with EEXIST.
  try {
    execFileSync('launchctl', ['bootout', `gui/${process.getuid()}`, AGENT_PLIST], { stdio: 'ignore' });
  } catch {
    /* not loaded yet */
  }
  execFileSync('launchctl', ['bootstrap', `gui/${process.getuid()}`, AGENT_PLIST]);

  console.log(`installed and started ${AGENT_LABEL}`);
  console.log(`plist : ${AGENT_PLIST}`);
  console.log(`node  : ${process.execPath}`);
  console.log(`logs  : ${path.join(APP_DIR, 'bridge.out.log')}`);
  console.log(`        ${path.join(APP_DIR, 'bridge.err.log')}`);
  console.log(`\nProxifier URL: ${baseUrl(cfg)}/t/${cfg.token}/`);
  console.log('\nCheck it with: npm run status');

  // The auto-reload click runs through the Accessibility API, and a launchd job
  // is its own TCC subject, so it needs its own grant.
  probeReload().then((ax) => {
    if (ax.ok) return;
    console.log('\nNote: this node binary cannot drive the Accessibility API yet, so');
    console.log('      automatic reload is off. Everything still syncs, you just need');
    console.log('      to click Reload in the extension (or restart Proxifier).');
    console.log('      To enable it: System Settings > Privacy & Security > Accessibility');
    console.log(`      and add: ${process.execPath}`);
  });
}

async function cmdAgentStatus() {
  const currentCfg = loadConfig();
  if (isWindows()) {
    const vbs = startupVbsPath({ appData: process.env.APPDATA });
    console.log(`label      : ${AGENT_LABEL}`);
    console.log(`launcher   : ${vbs}${fs.existsSync(vbs) ? '' : '   (NOT INSTALLED!)'}`);
    console.log(`port       : ${currentCfg.port}`);

    let healthy = false;
    try {
      const res = await fetch(`${baseUrl(currentCfg)}/api/health`);
      healthy = res.ok && (await res.json()).ok === true;
    } catch {
      healthy = false;
    }
    console.log(`state      : ${healthy ? 'running' : 'not running'}`);
    if (!healthy) {
      const errLog = path.join(APP_DIR, 'bridge.err.log');
      console.log(`logs       : ${path.join(APP_DIR, 'bridge.out.log')}`);
      console.log(`             ${errLog}`);
      if (fs.existsSync(errLog)) {
        const tail = fs.readFileSync(errLog, 'utf8').trim().split('\n').slice(-8).join('\n');
        console.log('\nrecent stderr:');
        console.log(tail || '(empty)');
      }
    }
    return;
  }

  const target = `gui/${process.getuid()}/${AGENT_LABEL}`;
  let out = '';
  try {
    out = execFileSync('launchctl', ['print', target], { encoding: 'utf8' });
  } catch (err) {
    out = String(err.stdout ?? '');
  }

  if (!out.trim()) {
    console.log(`${AGENT_LABEL} is not loaded.`);
    console.log('install it with: npm run install-agent');
    return;
  }

  const field = (k) => (out.match(new RegExp(`^\\s*${k} = (.*)$`, 'm')) ?? [, '-'])[1];

  console.log(`label      : ${AGENT_LABEL}`);
  console.log(`plist      : ${AGENT_PLIST}${fs.existsSync(AGENT_PLIST) ? '' : '   (MISSING!)'}`);
  console.log(`state      : ${field('state')}`);
  console.log(`pid        : ${field('pid')}`);
  console.log(`last exit  : ${field('last exit code')}`);
  console.log(`runs       : ${field('runs')}`);

  const cfg = loadConfig();
  console.log(`port       : ${cfg.port}`);

  if (field('state') !== 'running') {
    console.log('\nnot running. Recent stderr:');
    const errLog = path.join(APP_DIR, 'bridge.err.log');
    if (fs.existsSync(errLog)) {
      const tail = fs.readFileSync(errLog, 'utf8').trim().split('\n').slice(-8).join('\n');
      console.log(tail || '(empty)');
    } else {
      console.log('(no log file)');
    }
  }
}

function cmdUninstallAgent() {
  if (isWindows()) {
    const vbs = startupVbsPath({ appData: process.env.APPDATA });
    if (fs.existsSync(vbs)) fs.unlinkSync(vbs);
    console.log(`removed ${AGENT_LABEL}`);
    console.log('Stop a currently running bridge with Ctrl+C, or end node.exe in Task Manager.');
    return;
  }
  try {
    execFileSync('launchctl', ['bootout', `gui/${process.getuid()}`, AGENT_PLIST], { stdio: 'ignore' });
  } catch {
    /* already gone */
  }
  if (fs.existsSync(AGENT_PLIST)) fs.unlinkSync(AGENT_PLIST);
  console.log(`removed ${AGENT_LABEL}`);
}

async function main() {
  const [cmd = 'serve', ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'serve':
      return cmdServe(args);
    case 'doctor':
      return cmdDoctor();
    case 'import':
      return cmdImport(args);
    case 'export':
      return cmdExport(args);
    case 'link':
      return cmdLink();
    case 'install-agent':
      return cmdInstallAgent();
    case 'status':
      return cmdAgentStatus();
    case 'uninstall-agent':
      return cmdUninstallAgent();
    case '-h':
    case '--help':
    case 'help':
      return usage();
    default:
      usage();
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exitCode = 1;
});

export { DEFAULT_PORT };
