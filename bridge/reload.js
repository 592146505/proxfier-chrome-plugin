/**
 * Ask a running Proxifier to pull the current profile from us.
 *
 * Mechanism: Proxifier's "Profile Auto Update" dialog has an "Update Now"
 * button. We drive it through the Accessibility API, which requires the
 * *calling* process to hold Accessibility permission.
 *
 * This is best-effort by design: if it fails, the user can click the button
 * or restart Proxifier (auto-update also runs on start).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

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

export async function triggerReload({ timeoutMs = 15000 } = {}) {
  try {
    const { stdout } = await run('osascript', ['-e', APPLESCRIPT], { timeout: timeoutMs });
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

/** Read-only probe used by `doctor`. */
export async function probeAccessibility() {
  try {
    const { stdout } = await run(
      'osascript',
      ['-e', 'tell application "System Events" to get name of menu bar items of menu bar 1 of process "Proxifier"'],
      { timeout: 8000 },
    );
    return { ok: true, menus: stdout.trim() };
  } catch (err) {
    return { ok: false, message: String(err.stderr || err.message || err).trim() };
  }
}
