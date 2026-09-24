#!/usr/bin/env node
/**
 * Read-only Proxifier inspection over the Accessibility API.
 *
 * Deliberately read-only: an earlier throwaway script closed windows with
 * cmd+W, which detached the named profile and left Proxifier on an untitled
 * one. Nothing here closes, opens-as-new, or writes.
 *
 *   node tools/proxifier-ax.mjs name     # active profile name
 *   node tools/proxifier-ax.mjs rules    # the Proxification Rules table
 *   node tools/proxifier-ax.mjs profiles # File > Load Profile entries
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const osa = async (script) => {
  const { stdout } = await run('osascript', ['-e', script], { timeout: 20000 });
  return stdout.trim();
};

const running = async () => {
  try {
    await run('pgrep', ['-x', 'Proxifier']);
    return true;
  } catch {
    return false;
  }
};

/** Active profile name, from the window that shows it. */
async function name() {
  const out = await osa(`
tell application "System Events" to tell process "Proxifier"
  set found to ""
  repeat with i from 1 to (count of windows)
    try
      repeat with s in (every static text of window i)
        set v to (value of s) as text
        if v is not "" then set found to found & v & linefeed
      end repeat
    end try
  end repeat
  return found
end tell`);
  return out.split('\n').filter(Boolean);
}

/**
 * Open Proxification Rules and read the table.
 *
 * Opening the menu item is idempotent — Proxifier brings the existing window
 * forward rather than creating a second one — so this does not need to close
 * anything first.
 */
async function rules() {
  await osa(`
tell application "System Events" to tell process "Proxifier"
  set frontmost to true
  tell menu bar 1 to tell menu bar item "Profile" to tell menu 1
    click menu item "Proxification Rules..."
  end tell
end tell`);
  await new Promise((r) => setTimeout(r, 2000));

  const out = await osa(`
tell application "System Events" to tell process "Proxifier"
  set out to ""
  repeat with i from 1 to (count of windows)
    try
      repeat with sa in (every scroll area of window i)
        repeat with t in (every table of sa)
          repeat with r in (every row of t)
            set cells to ""
            repeat with c in (every UI element of r)
              try
                set cells to cells & "|" & ((value of c) as text)
              end try
            end repeat
            set out to out & cells & linefeed
          end repeat
        end repeat
      end repeat
    end try
  end repeat
  return out
end tell`);

  return out
    .split('\n')
    .filter((l) => l.startsWith('|'))
    .map((l) => {
      const [, enabled, ruleName, applications, targets, ports, action] = l.split('|');
      return { enabled: enabled === '1', name: ruleName, applications, targets, ports, action };
    });
}

async function profiles() {
  const out = await osa(
    'tell application "System Events" to tell process "Proxifier" to get name of menu items of menu 1 of menu item "Load Profile" of menu 1 of menu bar item "File" of menu bar 1',
  );
  return out.split(', ').map((s) => s.trim());
}

const cmd = process.argv[2] ?? 'rules';

if (!(await running())) {
  console.error('Proxifier is not running');
  process.exit(1);
}

switch (cmd) {
  case 'name': {
    const texts = await name();
    const active = texts.find((t) => t !== 'Profile' && t !== 'Proxifier');
    console.log(`active profile label: ${JSON.stringify(active ?? texts)}`);
    break;
  }
  case 'rules': {
    const list = await rules();
    console.log(`${list.length} rules`);
    for (const r of list) {
      console.log(`  ${r.enabled ? ' ' : 'x'} ${r.name.padEnd(28)} ${r.action}`);
    }
    break;
  }
  case 'profiles':
    console.log((await profiles()).join('\n'));
    break;
  default:
    console.error(`unknown command "${cmd}" (name | rules | profiles)`);
    process.exit(1);
}
