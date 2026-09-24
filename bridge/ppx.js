/**
 * Profile model over the .ppx DOM.
 *
 * Design rule: every mutation touches ONLY the elements it owns and leaves
 * the rest of the tree untouched. Unknown/unsupported nodes survive because
 * we never rebuild a rule from a JS object — we patch in place.
 */
import { Element, parseXml, buildXml } from './xmldom.js';

export const ACTION_TYPES = ['Direct', 'Block', 'Proxy'];

/**
 * Default skeleton used when creating a brand new profile from nothing.
 *
 * VERIFIED against a profile Proxifier 3.15.0 wrote itself: root attributes,
 * the <Options> subtree (note <ViaProxy> nests <TryLocalDnsFirst>, and the
 * Exclude* switches are attributes of <ExclusionList>), and the Encryption
 * mode strings (disabled | basic | account | master).
 *
 * Prefer cloning a profile Proxifier produced over using this skeleton — see
 * store.create() — because a fabricated profile carries no real Encryption
 * hash and no proxies.
 */
export function emptyProfileXml({ version = '101', productId = '2', productMinVer = '200' } = {}) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<ProxifierProfile version="${version}" platform="MacOSX" product_id="${productId}" product_minver="${productMinVer}">
  <Options>
    <Resolve>
      <AutoModeDetection enabled="true"/>
      <ViaProxy enabled="false">
        <TryLocalDnsFirst enabled="false"/>
      </ViaProxy>
      <ExclusionList ExcludeSimpleHostnames="false" ExcludeLocalhost="true" ExcludeSelfHostname="true" ExcludeLocalDomain="true">localhost;%ComputerName%;*.local;</ExclusionList>
    </Resolve>
    <Encryption mode="disabled"/>
    <HttpProxiesSupport enabled="false"/>
    <HandleDirectConnections enabled="false"/>
    <ConnectionLoopDetection enabled="true"/>
    <ProcessServices enabled="true"/>
    <ProcessOtherUsers enabled="true"/>
    <BlockUDP443 enabled="false"/>
  </Options>
  <ProxyList/>
  <ChainList/>
  <RuleList>
    <Rule enabled="true">
      <Name>Localhost</Name>
      <Targets>localhost; 127.0.0.1; ::1; %ComputerName%</Targets>
      <Action type="Direct"/>
    </Rule>
    <Rule enabled="true">
      <Name>Default</Name>
      <Action type="Direct"/>
    </Rule>
  </RuleList>
</ProxifierProfile>
`;
}

/**
 * Proxifier separates list entries with `;` and wraps entries containing
 * whitespace in double quotes — `"Codex Helper"`. An unquoted entry with a
 * space makes it reject the entire profile with "Error in application list",
 * so quoting has to happen on every write path, not just in the import tool.
 */
function splitList(value) {
  if (!value) return [];
  return String(value)
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(unquoteEntry);
}

function unquoteEntry(entry) {
  return entry.length > 1 && entry.startsWith('"') && entry.endsWith('"')
    ? entry.slice(1, -1)
    : entry;
}

/** Quote an entry that needs it, or fail loudly. */
function quoteEntry(entry) {
  if (entry.includes('"')) {
    // The format has no escape for a double quote inside a quoted entry, so
    // writing one would produce a profile Proxifier refuses to load.
    throw new Error(
      `cannot store ${JSON.stringify(entry)}: this format quotes with double quotes and has no escape for them`,
    );
  }
  return /\s/.test(entry) ? `"${entry}"` : entry;
}

function joinList(values) {
  return (values ?? [])
    .map((s) => String(s).trim())
    .filter(Boolean)
    .map(quoteEntry)
    .join('; ');
}

/** Read a list element that may be absent in older/simpler profiles. */
function readList(rule, tag) {
  const el = rule.child(tag);
  return el ? splitList(el.text) : [];
}

function writeList(rule, tag, values) {
  const existing = rule.child(tag);
  const text = joinList(values);
  if (!text) {
    if (existing) rule.removeChild(existing);
    return;
  }
  if (existing) {
    existing.setText(text);
    return;
  }
  // Keep the canonical element order Proxifier writes.
  const order = ['Name', 'Applications', 'Targets', 'Ports', 'Action'];
  const at = order.indexOf(tag);
  const idx = rule.children.findIndex(
    (c) => c instanceof Element && order.indexOf(c.name) > at && order.indexOf(c.name) >= 0,
  );
  const el = new Element(tag);
  el.setText(text);
  if (idx >= 0) rule.children.splice(idx, 0, el);
  else rule.children.push(el);
}

export class Rule {
  constructor(el) {
    this.el = el;
  }

  get name() {
    return this.el.child('Name')?.text ?? '';
  }

  get enabled() {
    return this.el.attr('enabled') !== 'false';
  }

  get applications() {
    return readList(this.el, 'Applications');
  }

  get targets() {
    return readList(this.el, 'Targets');
  }

  get ports() {
    return readList(this.el, 'Ports');
  }

  get action() {
    const a = this.el.child('Action');
    if (!a) return { type: 'Direct', id: null };
    const raw = a.text.trim() || a.attr('chain') || a.attr('proxy') || '';
    return { type: a.attr('type') ?? 'Direct', id: raw || null };
  }

  get not() {
    return this.el.attr('not') === 'true' || this.el.attr('negative') === 'true';
  }

  toJSON() {
    return {
      name: this.name,
      enabled: this.enabled,
      applications: this.applications,
      targets: this.targets,
      ports: this.ports,
      action: this.action,
      not: this.not,
    };
  }

  apply(patch) {
    if (patch.name !== undefined) {
      const el = this.el.child('Name') ?? this.el.setChild(new Element('Name'));
      el.setText(String(patch.name));
    }
    if (patch.enabled !== undefined) this.el.setAttr('enabled', patch.enabled ? 'true' : 'false');
    if (patch.applications !== undefined) writeList(this.el, 'Applications', patch.applications);
    if (patch.targets !== undefined) writeList(this.el, 'Targets', patch.targets);
    if (patch.ports !== undefined) writeList(this.el, 'Ports', patch.ports);
    if (patch.action !== undefined) {
      const type = patch.action.type;
      if (!ACTION_TYPES.includes(type)) {
        throw new Error(`invalid action type "${type}" (expected ${ACTION_TYPES.join('|')})`);
      }
      let a = this.el.child('Action');
      if (!a) a = this.el.setChild(new Element('Action'));
      a.setAttr('type', type);
      if (type === 'Proxy') {
        if (!patch.action.id) throw new Error('action type "Proxy" requires an id (chain id)');
        a.setText(String(patch.action.id));
      } else {
        a.setText('');
      }
    }
    return this;
  }
}

export class Profile {
  constructor(root) {
    this.root = root;
  }

  static parse(xml) {
    return new Profile(parseXml(xml)).normalize();
  }

  static empty(opts) {
    return new Profile(parseXml(emptyProfileXml(opts)));
  }

  /**
   * Rewrite list elements into their canonical quoted form.
   *
   * Quoting used to live only in writeList(), so a profile whose file carried
   * an unquoted entry containing a space — which Proxifier rejects outright —
   * stayed broken until that particular rule happened to be edited. Since
   * toXml() serialises the DOM verbatim, normalising on load is what makes
   * every subsequent save correct.
   */
  normalize() {
    for (const rule of this.rules()) {
      for (const tag of ['Applications', 'Targets', 'Ports']) {
        const el = rule.el.child(tag);
        if (el) writeList(rule.el, tag, splitList(el.text));
      }
    }
    return this;
  }

  get meta() {
    return {
      version: this.root.attr('version') ?? null,
      platform: this.root.attr('platform') ?? null,
      productMinVer: this.root.attr('product_minver') ?? null,
    };
  }

  _ruleList() {
    let list = this.root.child('RuleList');
    if (!list) {
      list = new Element('RuleList');
      this.root.setChild(list);
    }
    return list;
  }

  rules() {
    return this._ruleList().childrenNamed('Rule').map((el) => new Rule(el));
  }

  ruleAt(index) {
    const el = this._ruleList().childrenNamed('Rule')[index];
    if (!el) throw new Error(`no rule at index ${index}`);
    return new Rule(el);
  }

  addRule(rule) {
    const el = new Element('Rule', { enabled: rule.enabled === false ? 'false' : 'true' });
    el.setChild(new Element('Name'));
    const created = new Rule(el).apply({ name: rule.name ?? 'New Rule', ...rule });
    const list = this._ruleList();
    // Proxifier uses first-match-wins, so a manual "Default" catch-all must
    // stay last; new rules are inserted before any trailing catch-all.
    const rules = list.childrenNamed('Rule');
    const catchAll = rules.findIndex((r) => new Rule(r).name.toLowerCase() === 'default');
    if (catchAll >= 0) list.children.splice(list.children.indexOf(rules[catchAll]), 0, el);
    else list.children.push(el);
    return created;
  }

  removeRule(index) {
    const rules = this._ruleList().childrenNamed('Rule');
    if (!rules[index]) throw new Error(`no rule at index ${index}`);
    this._ruleList().removeChild(rules[index]);
    return true;
  }

  moveRule(from, to) {
    const list = this._ruleList();
    const rules = list.childrenNamed('Rule');
    if (!rules[from]) throw new Error(`no rule at index ${from}`);
    const target = Math.max(0, Math.min(rules.length - 1, to));
    if (from === target) return true;

    const nodes = list.children;
    const [node] = nodes.splice(nodes.indexOf(rules[from]), 1);
    const dstNode = nodes.indexOf(rules[target]);
    // After removing the source, the target itself has shifted for downward
    // moves. Insert after it when moving down, before it when moving up, so
    // the moved rule lands on index `target` in both directions.
    nodes.splice(dstNode + (from < target ? 1 : 0), 0, node);
    return true;
  }

  /**
   * Proxies in <ProxyList>.
   *
   * The endpoint lives in CHILD elements (<Address>, <Port>, <Options>), not in
   * host/port attributes — verified against a profile Proxifier wrote itself.
   */
  proxies() {
    return (this.root.child('ProxyList')?.childrenNamed('Proxy') ?? []).map((p) => {
      const fields = {};
      for (const child of p.children) {
        if (child instanceof Element && child.text) fields[child.name] = child.text;
      }
      return {
        id: p.attr('id') ?? null,
        type: p.attr('type') ?? null,
        address: fields.Address ?? null,
        port: fields.Port ?? null,
        // Anything else Proxifier wrote (Options, …), kept verbatim.
        fields,
      };
    });
  }

  chains() {
    return (this.root.child('ChainList')?.childrenNamed('Chain') ?? []).map((c) => ({
      id: c.attr('id'),
      type: c.attr('type'),
      name: c.child('Name')?.text ?? '',
      members: c.childrenNamed('Proxy').map((p) => p.attr('id')),
    }));
  }

  toXml() {
    return buildXml(this.root);
  }

  toJSON() {
    return { meta: this.meta, rules: this.rules().map((r) => r.toJSON()), proxies: this.proxies(), chains: this.chains() };
  }
}
