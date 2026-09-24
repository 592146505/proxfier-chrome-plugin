# network-plugin — Proxifier Rule Manager

A Chrome extension + local bridge that gives you full CRUD over your Proxifier
profiles and proxification rules from the browser.

```
Chrome Extension (MV3)  ──HTTP + token──►  Bridge (Node, 127.0.0.1:47653)
                                                │  profiles/ is the source of truth
                                                ▼
                     Proxifier  ◄──pulls profile over HTTP──  /t/<token>/
                            (File → Profile Auto Update → Update Now)
```

## Why it is built this way

Proxifier for macOS has **no API, no CLI, and no AppleScript dictionary**, and
it is a **sandboxed app** — its profile lives inside
`~/Library/Containers/com.initex.proxifier.v3.macos/Data/…` behind TCC, so
anything that writes it needs **Full Disk Access**.

So instead of writing into Proxifier's container, the bridge owns the profiles
and Proxifier **pulls them from us** using its own `Profile Auto Update`
feature. Consequences:

- **No Full Disk Access needed** — not for Chrome, not for the bridge.
- **No fighting over the file** — Proxifier never owns the source of truth.
- **Reload is automatable** — the `Update Now` button in Proxifier's
  auto-update dialog, driven over the Accessibility API.

Trade-off: Proxifier's profile folder becomes a read-only cache that Proxifier
refills from the bridge on every update.

## Requirements

- Proxifier 3.x for macOS (verified against 3.15.0), or Proxifier v4 for Windows
- Node.js ≥ 20.11.0
- Google Chrome

## Setup

```bash
npm install
npm run doctor     # prints the profiles dir and the URL Proxifier needs
npm run serve      # keep this running (or: npm run install-agent)
```

`doctor` prints something like:

```
next step
  paste into Proxifier's Profile Auto Update URL:
  http://127.0.0.1:47653/t/<token>/
```

Then, **once**, in Proxifier:

1. `File → Profile Auto Update…`
2. Tick **Update profile on start from a web server**
3. Paste the URL above
4. Choose **Folder with multiple profiles**
5. Click **Update Now**

Load the extension: `chrome://extensions` → Developer mode → *Load unpacked* →
pick `extension/`.

### Windows

On Windows, first export your real profile from Proxifier (`File → Export…`),
then import it before creating anything else:

```powershell
npm install
npm run import -- .\real.ppx --as Work
npm run doctor
npm run serve
```

Data and logs live under `%APPDATA%\ProxifierBridge`. The bridge also looks for
`Proxifier.exe` in the standard Program Files locations; if your copy is
portable, add its full path as `proxifierExe` in
`%APPDATA%\ProxifierBridge\config.json`:

```json
{
  "proxifierExe": "D:\\Tools\\Proxifier\\Proxifier.exe"
}
```

Windows reload uses Proxifier v4's official command line:

```text
Proxifier.exe <profile.ppx> silent-load
```

This loads the profile into a running Proxifier, or starts Proxifier if needed.
Profile Auto Update is still available, but `silent-load` is the primary
automatic path and needs no Accessibility-style permission.

For login startup, Windows uses a small VBS file in the user's Startup folder:

```powershell
npm run install-agent
npm run status
npm run uninstall-agent
```

The VBS launches the bridge hidden through `cmd.exe`, and redirects its output
to the same `bridge.out.log` and `bridge.err.log` files used on macOS.

Then connect it — `npm run link` prints a single URL:

1. Open the extension options: **⚙** in the popup, or *Details → Extension
   options* on `chrome://extensions`.
2. Paste that URL into the **Token** box. The whole URL is accepted; base URL
   and token are parsed out of it, and pasting it into either box works.
3. **Test** checks the values currently in the form. **Save & test** persists
   them and loads your profiles.

> If Test reports *"No token in these settings"*, the pasted value had no
> `/t/<token>/` part. Re-copy the URL exactly as `npm run link` printed it.

After editing any file under `extension/`, press **↻ Reload** for the extension
on `chrome://extensions` — open popups and options pages keep running the old
code until you do.

## Run at login

```bash
npm run install-agent     # writes ~/Library/LaunchAgents/com.proxifier-bridge.plist
npm run status            # loaded? running? which pid?
npm run uninstall-agent   # bootout + delete the plist
```

A LaunchAgent with `RunAtLoad` and `KeepAlive` (15s throttle) starts the bridge
at login and restarts it if it dies. Logs:

```
~/Library/Application Support/ProxifierBridge/bridge.out.log
~/Library/Application Support/ProxifierBridge/bridge.err.log
```

Both grow without bound — `truncate -s 0` them when they get large.

Do not also run `npm run serve`: the port is taken, and launchd will keep
retrying every 15s.

### The one permission to be aware of

Automatic reload clicks Proxifier's **Update Now** through the Accessibility
API. A launchd job is its own TCC subject, so the node binary behind the agent
needs its **own** grant — Terminal's grant does not carry over:

> System Settings → Privacy & Security → Accessibility → add the absolute node
> path printed by `npm run install-agent`.

Without it the bridge still syncs on every write; you just press **Reload ↻**
in the extension, or restart Proxifier (its *Update profile on start* always
pulls). `npm run status` and the Reload button both report this state.

Trade-off worth knowing before you click: granting Accessibility to `node` lets
*any* script run by that interpreter drive your Mac's UI. If that is too broad,
leave the grant off and run the bridge from Terminal instead (Terminal already
holds it), or wrap the agent in a dedicated `.app` bundle so the grant is
scoped to that bundle rather than to node.

## Daily use

- Click the toolbar icon → it shows the current tab's host and the rules of the
  selected profile. **Add rule** prefills targets from the current site.
- To file the current site under an existing rule, click **＋** on that rule:
  the exact host and its wildcard form are appended to its Targets — no typing.
- Toggle a rule with ●/○, edit with ✎, delete with ✕.
- A rule's **Action** can be `Direct`, `Block`, or a proxy/chain. The dropdown
  lists every chain *and* every proxy in the profile, so a profile that has
  proxies but an empty `<ChainList/>` — the normal case — still offers
  `Proxy → SOCKS5 127.0.0.1:7890`. If only Direct and Block appear, the profile
  defines no proxies: add one in Proxifier via `Profile → Proxy Servers…`.
- Rule order matters (Proxifier is first-match-wins) — new rules are inserted
  *before* the trailing `Default` catch-all.
- Right-click any page or link → *Proxifier: add rule for "…"*.

Every write snapshots the previous revision to
`~/Library/Application Support/ProxifierBridge/backups/<profile>/`. Restore from
the options page.

## Reload

On Windows, writes trigger `Proxifier.exe <active-profile.ppx> silent-load`
directly. On macOS, the layers are best-effort in this order:

1. `fs.watch` on `profiles/` → `Update Now` clicked over the Accessibility API
   (needs Accessibility permission for whatever runs the bridge).
2. The **Reload ↻** button in the extension.
3. Proxifier's own *Update profile on start* — restarting it always syncs.

If (1) fails, the bridge logs the reason and nothing breaks. A rejected profile
is a no-op: the running configuration is left alone.

## Seeding the store with your real profile

The bridge **replaces the whole profile** on each pull, so start from a profile
Proxifier authored rather than an empty one:

1. In Proxifier: `File → Export…` to e.g. `~/Documents/real.ppx` (macOS) or
   `C:\Users\<you>\Documents\real.ppx` (Windows).
2. `node bridge/cli.js import <path-to>/real.ppx --as Bridge`
3. Set it active: the extension options do this when you pick a profile
   (`POST /api/active`).
4. `File → Profile Auto Update…` → tick, paste the Proxifier URL, *Folder with
   multiple profiles*, **OK**, then **Update Now**.

The name must match the profile Proxifier has loaded. Proxifier also asks for
`default.ppx` for its built-in profile — the `/t/` surface serves the active
profile for any unrecognised name, so that is handled.

## Layout

```
bridge/
  cli.js        serve | doctor | import | export | link | install-agent
  server.js     two surfaces: /t/<token>/ for Proxifier, /api/ for the extension
  ppx.js        profile model — rules, proxies, chains
  xmldom.js     order-preserving XML DOM (round-trip safe)
  store.js      atomic writes, snapshots, restore
  reload.js     Windows silent-load; macOS Accessibility-driven "Update Now"
  platform.js   platform paths, Proxifier.exe lookup, startup launcher
  config.js     port + token + active profile
extension/
  background.js service worker; owns all bridge traffic
  popup.*       per-tab rule editing
  options.*     connection, profiles, chains, backups, raw XML
```
test/
  connection.test.mjs  unit tests for the options-page URL/token parsing
  smoke.mjs            bridge HTTP API: rule CRUD, auth, fallbacks
  e2e-live.mjs         against a running bridge + Proxifier (adds/removes a rule)
```

## Safety model

- Profiles always validate as XML **before** being written; a bad payload can
  never reach Proxifier.
- Every mutation snapshots first; the last 30 revisions are kept.
- The Proxifier-facing surface is token-scoped (`/t/<token>/`) so a random local
  process cannot enumerate your profiles.
- Mutations patch elements in place, so unknown/unsupported nodes in a profile
  survive untouched.

## Commands

| command | purpose |
|---|---|
| `npm run serve` | run the bridge in the foreground |
| `npm run install-agent` | run it at login (LaunchAgent on macOS, Startup VBS on Windows) |
| `npm run status` | is the login agent installed and running? |
| `npm run uninstall-agent` | remove the login launcher |
| `npm run doctor` | diagnose config, profiles, permissions |
| `npm run import -- file.ppx --as Work` | import an exported profile |
| `node bridge/cli.js export Work --out ./Work.ppx` | export a stored profile |
| `node bridge/cli.js link` | print the Proxifier URL |
| `node test/ppx.test.mjs` | profile model: parsing, round-trip, rule insertion |
| `node test/connection.test.mjs` | options-page URL/token parsing |
| `node test/actions.test.mjs` | rule Action dropdown (proxies vs chains) |
| `node test/smoke.mjs` | bridge API: rule CRUD, auth, name fallback |
| `npm test` | all of the above |
| `npm run test:live` | live check against a running bridge + Proxifier |
