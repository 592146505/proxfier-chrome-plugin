# The .ppx profile format

**Status: verified** against a profile Proxifier 3.15.0 wrote itself
(`File → Export…` on this machine). Everything below was observed, not inferred.

## Verified shape

```xml
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<ProxifierProfile version="101" platform="MacOSX" product_id="2" product_minver="200">
    <Options>
        <Resolve>
            <AutoModeDetection enabled="true"/>
            <ViaProxy enabled="false">
                <TryLocalDnsFirst enabled="false"/>
            </ViaProxy>
            <ExclusionList ExcludeSimpleHostnames="false" ExcludeLocalhost="true" ExcludeSelfHostname="true" ExcludeLocalDomain="true">localhost;%ComputerName%;*.local;
            </ExclusionList>
        </Resolve>
        <Encryption mode="account">
            <Hash>AAECwM58…</Hash>
        </Encryption>
        <HttpProxiesSupport enabled="false"/>
        <HandleDirectConnections enabled="false"/>
        <ConnectionLoopDetection enabled="true"/>
        <ProcessServices enabled="true"/>
        <ProcessOtherUsers enabled="true"/>
        <BlockUDP443 enabled="false"/>
    </Options>
    <ProxyList>
        <Proxy id="100" type="SOCKS5">
            <Address>127.0.0.1</Address>
            <Port>7890</Port>
            <Options>0</Options>
        </Proxy>
    </ProxyList>
    <ChainList/>
    <RuleList>
        <Rule enabled="true">
            <Name>proxys</Name>
            <Targets>*.github.com; *.openai.com</Targets>
            <Action type="Proxy">100</Action>
        </Rule>
        <Rule enabled="false">
            <Name>Terminal</Name>
            <Applications>curl; git; "Codex Helper"</Applications>
            <Action type="Direct"/>
        </Rule>
        <Rule enabled="true">
            <Name>Default</Name>
            <Action type="Direct"/>
        </Rule>
    </RuleList>
</ProxifierProfile>
```

## The parts that are easy to get wrong

These all caused a real "Update skipped" until they were fixed:

1. **`<ViaProxy>` nests `<TryLocalDnsFirst>`.** They are not siblings.
2. **The `Exclude*` switches are attributes of `<ExclusionList>`**, not child
   elements. The list itself is the element text, and Proxifier writes a
   trailing `;` plus indentation inside it.
3. **`<Encryption mode="…">` takes a string**, one of `disabled`, `basic`,
   `account`, `master` — not a number. `account`/`master` modes carry a
   `<Hash>` child that is derived from the user's credentials and cannot be
   invented.
4. **`<Proxy>` uses `id` and `type` attributes plus `<Address>`, `<Port>`,
   `<Options>` child elements.** There is no `host=`/`port=` attribute.
5. **`<Applications>` entries containing whitespace must be quoted**
   (`"Codex Helper"`), otherwise the whole profile is rejected with
   *"Error in application list"*. `ppx.js` enforces this in both directions:
   `joinList` quotes on write, `splitList` unquotes on read, and `Profile.parse`
   normalises existing entries so a load→save repairs a file that had them
   unquoted. An entry containing a double quote is rejected outright, since the
   format has no escape for one.
6. **Root attributes are `version="101" product_id="2" product_minver="200"`**,
   and the XML declaration includes `standalone="yes"`.
7. **`Default` is a reserved profile name** — Proxifier refuses
   *"This name is reserved, please choose another one."* Its built-in profile
   file is `default.ppx`.

## Rules

- Rule order is significant: **first match wins**. A trailing catch-all
  (`Default`) must stay last, which is why `Profile.addRule()` inserts new rules
  *before* it.
- `Action type` is `Direct`, `Block` or `Proxy`. For `Proxy` the element text is
  the **proxy id** from `<ProxyList>` (chains live in `<ChainList>`, which is
  frequently empty — a single proxy does not need a chain).
- `Rule enabled="false"` disables a rule; an absent attribute means enabled.
- List elements (`Applications`, `Targets`, `Ports`) are `;`-separated.

## Why a real base profile matters

`store.create()` clones an existing profile instead of fabricating one. A
fabricated profile has no real `<Encryption>` hash and no `<ProxyList>`, and
Proxifier will reject it. The only reliable sources are:

- `File → Export…` from Proxifier, or
- a profile the bridge has already round-tripped successfully.

## How the format was determined

Two methods, in order of usefulness:

1. **`File → Export…`** to a readable path. This is ground truth. Note it
   prompts for a password-encryption mode; the profile's proxy passwords are
   stored in whatever form you pick, so prefer `account` (readable only by the
   current user) when there is any authentication configured.
2. **String archaeology in the binary.** `ProxifierProfile`, `Options`,
   `Resolve`, `AutoModeDetection`, `ViaProxy`, `ExclusionList`, `Encryption`,
   `Chain`, `Rule` appear as adjacent cstring literals.

   ⚠️ `strings` defaults to a **minimum length of 4**, so 2–3 character names
   such as `id` are invisible to a naive scan — which is what made the Proxy
   element look like it had no `id` attribute. Use `strings -n 1` before
   concluding a name does not exist.

## The pull channel (verified)

- `File → Profile Auto Update…`: a checkbox, a URL field, a
  *Folder with multiple profiles* / *Single profile file* radio pair, and an
  **Update Now** button.
- Proxifier fetches **`<base URL>/<current profile name>.ppx`** — it appends the
  name to the base URL. No directory index is scraped.
- The user agent is `Proxifier/3.15.0 CFNetwork/…` (CFNetwork, not curl, despite
  the `DoCurlHttps` symbol).
- **A saved, matching profile name is required.** With none defined, Update Now
  makes no network request at all and fails silently.
- Settings only take effect after **OK**. `Update Now` uses the saved config.
- The URL field and the checkbox **ignore the Accessibility `set value`** — they
  need a real `AXPress` / paste, otherwise the app's model stays empty and
  Proxifier reports *"Update URL cannot be empty."*
- A rejected profile is a **no-op**: the running configuration is left alone and
  the log says *"Current profile was not found on the web server. Update
  skipped."* — which is misleading, since the HTTP fetch itself succeeded.
