/**
 * Minimal order-preserving XML DOM on top of fast-xml-parser.
 *
 * Why a DOM and not direct object mapping: a .ppx profile holds rules,
 * proxies, chains and option blobs that we do NOT fully understand yet.
 * Anything we cannot model must round-trip byte-for-byte instead of being
 * silently dropped. Order preservation is therefore mandatory.
 */
import { XMLParser, XMLBuilder } from 'fast-xml-parser';

const ATTR_PREFIX = '@_';

export class Element {
  constructor(name, attrs = {}, children = []) {
    this.name = name;
    this.attrs = attrs;
    this.children = children; // Element | Text | Comment
  }

  /** First direct child element by tag name. */
  child(name) {
    return this.children.find((c) => c instanceof Element && c.name === name) ?? null;
  }

  /** All direct child elements by tag name. */
  childrenNamed(name) {
    return this.children.filter((c) => c instanceof Element && c.name === name);
  }

  /** Text content, concatenated over direct text children. */
  get text() {
    return this.children
      .filter((c) => c instanceof Text)
      .map((c) => c.value)
      .join('');
  }

  setText(value) {
    this.children = this.children.filter((c) => !(c instanceof Text));
    this.children.push(new Text(String(value)));
  }

  /** Insert child, replacing an existing one with the same name. */
  setChild(element) {
    const idx = this.children.findIndex(
      (c) => c instanceof Element && c.name === element.name,
    );
    if (idx >= 0) this.children[idx] = element;
    else this.children.push(element);
    return element;
  }

  removeChild(element) {
    const idx = this.children.indexOf(element);
    if (idx >= 0) this.children.splice(idx, 1);
  }

  attr(name) {
    return this.attrs[name];
  }

  setAttr(name, value) {
    this.attrs[name] = String(value);
  }

  /** Depth-first search over all descendants. */
  *walk() {
    for (const c of this.children) {
      if (c instanceof Element) {
        yield c;
        yield* c.walk();
      }
    }
  }

  find(name) {
    for (const el of this.walk()) if (el.name === name) return el;
    return null;
  }

  findAll(name) {
    return [...this.walk()].filter((el) => el.name === name);
  }
}

export class Text {
  constructor(value) {
    this.value = value;
  }
}

export class Comment {
  constructor(value) {
    this.value = value;
  }
}

function fromOrdered(nodes, out) {
  for (const node of nodes) {
    const marker = node[':@'];
    if ('#text' in node) {
      const value = String(node['#text']);
      // Drop whitespace-only text: buildXml re-indents, so keeping the
      // original indentation would double up on every round-trip.
      if (value.trim() === '') continue;
      out.push(new Text(value));
      continue;
    }
    if ('#comment' in node) {
      out.push(new Comment(String(node['#comment'])));
      continue;
    }
    const name = Object.keys(node).find((k) => k !== ':@');
    if (name === undefined) continue;
    // Processing instructions (<?xml ... ?>) are re-emitted by buildXml.
    if (name.startsWith('?')) continue;

    const attrs = {};
    if (marker) {
      for (const [k, v] of Object.entries(marker)) {
        if (k.startsWith(ATTR_PREFIX)) attrs[k.slice(ATTR_PREFIX.length)] = String(v);
      }
    }
    const el = new Element(name, attrs);
    fromOrdered(node[name] ?? [], el.children);
    out.push(el);
  }
}

function toOrdered(nodes) {
  const out = [];
  let pendingText = '';

  // fast-xml-parser wants text as its own entry; merge adjacent text to keep
  // default escaping decisions stable.
  const flush = () => {
    if (pendingText !== '') {
      out.push({ '#text': pendingText });
      pendingText = '';
    }
  };

  for (const node of nodes) {
    if (node instanceof Text) {
      pendingText += node.value;
      continue;
    }
    flush();
    if (node instanceof Comment) {
      out.push({ '#comment': [{ '#text': node.value }] });
      continue;
    }
    const entry = { [node.name]: toOrdered(node.children) };
    const attrKeys = Object.keys(node.attrs);
    if (attrKeys.length) {
      entry[':@'] = Object.fromEntries(
        attrKeys.map((k) => [`${ATTR_PREFIX}${k}`, node.attrs[k]]),
      );
    }
    out.push(entry);
  }
  flush();
  return out;
}

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: ATTR_PREFIX,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  commentPropName: '#comment',
});

const builder = new XMLBuilder({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: ATTR_PREFIX,
  format: true,
  indentBy: '  ',
  suppressEmptyNode: true,
  commentPropName: '#comment',
});

/** Parse .ppx XML text into an Element tree. */
export function parseXml(xml) {
  const ordered = parser.parse(xml);
  const roots = [];
  fromOrdered(ordered, roots);
  const el = roots.find((r) => r instanceof Element);
  if (!el) throw new Error('no root element found');
  return el;
}

/** Serialise an Element tree back to XML text. */
export function buildXml(root, { declaration = true, standalone = true } = {}) {
  const body = builder.build(toOrdered([root]));
  const head = declaration
    ? `<?xml version="1.0" encoding="UTF-8"${standalone ? ' standalone="yes"' : ''}?>\n`
    : '';
  return `${head}${body}\n`;
}

export { ATTR_PREFIX };
