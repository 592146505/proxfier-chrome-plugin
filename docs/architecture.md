# Architecture

## The problem

Proxifier 3.x for macOS is a **sandboxed** app. Its profile lives at:

```
~/Library/Containers/com.initex.proxifier.v3.macos/Data/Library/Application Support/Proxifier/Profiles/default.ppx
```

Reading or writing that path from another process requires
**Full Disk Access** (TCC). Verified on this machine: `ls` on that directory
returns `Operation not permitted` without it.

There is also **no programmatic surface**:

| mechanism | available? |
|---|---|
| HTTP / IPC API | no |
| CLI flags | no (`SilentLoad` exists as a string but nothing parses argv) |
| AppleScript dictionary (`.sdef`) | no |
| URL scheme | no (`CFBundleURLTypes` absent) |
| Distributed notifications | no |

So "manage Proxifier rules" can only mean one of:

1. Write the profile file and force a reload — requires Full Disk Access, and
   races Proxifier's own in-memory copy (it overwrites you on next save).
2. **Have Proxifier pull the profile from us.**

## The mechanism we use

`File → Profile Auto Update…` exposes:

```
[x] Update profile on start from a web server
    URL: [________________]        Example: http://www.example.net/path/
    URL points to:  (•) Folder with multiple profiles   ( ) Single profile file
    [ ] Keep current usernames and passwords
    [ Update Now ]                          Update Settings
```

The implementation uses libcurl (`DoCurlHttps`), so **plain `http://127.0.0.1`
works**. It also exposes `URLByAppendingPathComponent:` — it resolves individual
profile files under the base URL.

That gives us a pull-based channel: the bridge serves the profiles, Proxifier
fetches them. The bridge therefore never needs Full Disk Access, and
"reload" becomes "click Update Now" — drivable over the Accessibility API.

### Consequences worth knowing

- Proxifier's own `Profiles/` folder stops being authoritative. It is a cache
  that Proxifier refills on every update. Any rule you edit *inside Proxifier's
  GUI* is lost on the next pull. The extension (and the raw-XML editor in
  options) is the place to edit.
- Because the bridge owns the files, backups and validation are ours to
  provide — see `store.js`.

## Components

### `bridge/xmldom.js`

An order-preserving XML DOM over `fast-xml-parser` (`preserveOrder: true`).

Rationale: we do not yet model every element Proxifier writes. Anything
unmodelled must survive a load/save cycle. Rebuilding the document from a JS
object would silently drop unknown nodes; patching a DOM does not.

Two details that matter:

- Whitespace-only text nodes are dropped on parse, because `buildXml`
  re-indents. Keeping them makes output grow on every round-trip.
- Round-tripping is idempotent — asserted by the smoke test shape.

### `bridge/ppx.js`

The profile model: `rules()`, `addRule()`, `ruleAt(i).apply(patch)`,
`removeRule(i)`, `moveRule(from, to)`, `proxies()`, `chains()`.

Key behaviours:

- `addRule` inserts **before a trailing `Default` rule**, because Proxifier
  evaluates rules in order and first match wins. A new rule placed after the
  catch-all would never fire.
- `apply()` writes only the elements it owns (`Name`, `Applications`,
  `Targets`, `Ports`, `Action`) and leaves everything else alone.
- Action types are validated (`Direct` | `Block` | `Proxy`); `Proxy` requires a
  chain id.

### `bridge/store.js`

`profiles/` is the source of truth, `backups/` holds the last 30 revisions per
profile. Writes are `writeFile` + `rename` (atomic), and every mutation
snapshots the previous revision first.

### `bridge/server.js`

One port, two surfaces:

- `/t/<token>/` — Proxifier-facing. No custom headers (curl only), so the token
  is in the path. `/` returns an Apache-style index; `/<name>.ppx` returns the
  profile.
- `/api/…` — extension-facing JSON, requires `X-Bridge-Token`.

CORS is reflected only for `chrome-extension://` origins.

### `bridge/reload.js`

Drives `File → Profile Auto Update… → Update Now → OK` through System Events.
Requires **Accessibility** permission for the process running the bridge.
Failure is non-fatal by design — auto-update also runs when Proxifier starts.

### `extension/`

MV3. The service worker is the only component that talks to the bridge, so the
token is read in exactly one place. The popup edits the selected profile; the
options page handles connection, profiles, chains, backups, and raw XML.

## Answers that are no longer open

All three original open questions are resolved — see `docs/ppx-format.md`:

1. **No index is scraped.** Proxifier fetches `<base>/<current profile name>.ppx`
   directly. The Apache-style index at `/t/<token>/` is harmless but unused.
2. **The root attributes matter.** Proxifier 3.15.0 writes
   `version="101" product_id="2" product_minver="200"`; a profile built with
   different values is rejected.
3. **Lists are `;`-separated strings**, and entries containing whitespace must be
   quoted (`"Codex Helper"`) or the profile is rejected with
   *"Error in application list"*.

Two further things were discovered the hard way:

- **A saved, matching profile name is required.** With no named profile,
  `Update Now` performs no HTTP request at all and fails silently. `Default`
  and its lowercase `default` are reserved.
- **A rejected profile is a no-op**, so iterating on an unknown format is safe:
  the running configuration is left untouched and the log reports
  *"Current profile was not found on the web server. Update skipped."*

The name Proxifier requests is not always the one shown in
`File → Load Profile` — it asks for `default.ppx` for its built-in profile. The
`/t/` surface therefore falls back to the profile designated via
`POST /api/active` when the requested name is not in the store.

## Damage control

This bridge **replaces the whole profile** on every pull. Before that is safe
for a given user, their real profile has to be seeded into the store from a
Proxifier-authored file (`File → Export…`, then
`node bridge/cli.js import …`). `store.create()` now clones an existing profile
rather than fabricating one for exactly this reason.

## The unnamed active profile

Proxifier requests `<active profile name>.ppx`. If its active profile has **no
name** — the window title reads `Untitled` — it falls back to an internal name
and requests `default.ppx` instead. Two consequences:

- Syncing still works, because the `/t/` surface falls back to the profile set
  by `POST /api/active`.
- But an unnamed profile is not obviously persisted across a restart, and the
  name shown in Proxifier no longer matches what the bridge calls the profile.

Recover with `File → Load Profile → <name>` (pins the name back onto the stored
profile) or `File → Save Profile As… → <name>` (names the *current* in-memory
content), then reload from the extension.

Detect it from `/api/state → lastFetch`: `{ requested, served, fallback }`. When
`fallback` is true, the active profile is unnamed or renamed. The options page
surfaces this as a banner.

`tools/proxifier-ax.mjs` is intentionally **read-only**. An earlier throwaway
script closed windows with `cmd+W`, which is what detached the profile name in
the first place.
