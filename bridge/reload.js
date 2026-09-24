/**
 * Ask a running Proxifier to load the bridge's current profile.
 *
 * Windows: Proxifier v4 has an official command line
 *   Proxifier.exe <profile.ppx> silent-load
 * which loads the file into a running instance, or starts one. No UI
 * automation and no Accessibility permission are involved.
 *
 * macOS: there is no CLI (SilentLoad exists as a string in the binary but
 * nothing parses argv), no AppleScript dictionary and no URL scheme, so the
 * only programmable entry point is Profile Auto Update's "Update Now"
 * button, driven through the Accessibility API. Failure is non-fatal by
 * design: the user can click the button, or restart Proxifier.
 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { isWindows, silentLoadArgs } from './platform.js';

const run = promisify(execFile);

function waitForExit(child, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms); // still running = Proxifier was started fresh
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.once('error', (err) => {
      clearTimeout(timer);
      resolve(err.code ?? -1);
    });
  });
}

async function windowsReload({ exe, profilePath, timeoutMs }) {
  if (!profilePath) {
    return { ok: false, result: 'no-profile', hint: 'No active profile is set.' };
  }
  if (!exe) {
    return {
      ok: false,
      result: 'exe-not-found',
      hint: 'Proxifier.exe was not found. Install Proxifier v4, or set "proxifierExe" in config.json.',
    };
  }
  try {
    const child = spawn(exe, silentLoadArgs(profilePath), {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    const code = await waitForExit(child, Math.max(1000, Math.min(timeoutMs ?? 5000, 10000)));
    if (code === null) return { ok: true, result: 'started', exe, profilePath };
    if (code === 0) return { ok: true, result: 'silent-load', exe, profilePath };
    return { ok: false, result: `exit-${code}`, exe, profilePath };
  } catch (err) {
    return { ok: false, result: 'error', message: String(err.message || err).trim() };
  }
}

const APPLESCRIPT = `
tell application "System Events"
  if not (exists process "Proxifier") then return "not-running"
  tell process "Proxifier"
    set frontmost to true
    tell menu bar 1
      tell menu bar item "File"
        tell menu 1
          click menu item "Profile Auto Update..."
        end tell
      end tell
    end tell
    delay 1
    repeat 30 times
      if (exists window "Profile Auto Update") then exit repeat
      delay 0.2
    end repeat
    if not (exists window "Profile Auto Update") then return "no-dialog"
    tell window "Profile Auto Update"
      repeat with e in (every UI element of group 1)
        if (role of e) is "AXButton" and (title of e) is "Update Now" then
          click e
          delay 2
          click button "OK"
          return "clicked"
        end if
      end repeat
      click button "Cancel"
      return "no-button"
    end tell
  end tell
end tell
return "unknown"
`;

async function macReload({ timeoutMs }) {
  try {
    const { stdout } = await run('osascript', ['-e', APPLESCRIPT], { timeout: timeoutMs ?? 15000 });
    const result = stdout.trim();
    return { ok: result === 'clicked', result };
  } catch (err) {
    return {
      ok: false,
      result: 'error',
      message: String(err.stderr || err.message || err).trim(),
      hint:
        'Grant Accessibility permission to the process running the bridge ' +
        '(System Settings -> Privacy & Security -> Accessibility).',
    };
  }
}

/**
 * Platform-appropriate reload.
 * @param {{exe?: string, profilePath?: string, timeoutMs?: number}} opts
 *   `exe` and `profilePath` are the Windows path; macOS ignores them.
 */
export async function triggerReload(opts = {}) {
  return isWindows() ? windowsReload(opts) : macReload(opts);
}

/** True when Proxifier.exe is running (Windows). */
export async function proxifierRunningWindows() {
  try {
    const { stdout } = await run('tasklist', ['/FI', 'IMAGENAME eq Proxifier.exe', '/FO', 'CSV', '/NH']);
    return stdout.includes('Proxifier.exe');
  } catch {
    return false;
  }
}

/** Read-only reload capability probe used by `doctor`. */
export async function probeReload({ exe } = {}) {
  if (isWindows()) {
    const running = await proxifierRunningWindows();
    return exe
      ? { ok: true, mechanism: 'silent-load', exe, running }
      : {
          ok: false,
          mechanism: 'silent-load',
          running,
          message: 'Proxifier.exe not found in the standard install paths.',
          hint: 'Set "proxifierExe" in config.json to the full path of Proxifier.exe.',
        };
  }
  try {
    const { stdout } = await run(
      'osascript',
      ['-e', 'tell application "System Events" to get name of menu bar items of menu bar 1 of process "Proxifier"'],
      { timeout: 8000 },
    );
    return { ok: true, mechanism: 'accessibility', menus: stdout.trim() };
  } catch (err) {
    return { ok: false, mechanism: 'accessibility', message: String(err.stderr || err.message || err).trim() };
  }
}
