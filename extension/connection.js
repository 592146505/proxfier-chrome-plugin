/**
 * Pure helpers that turn what the user typed into a bridge connection.
 *
 * Free of DOM/chrome APIs so they can be unit-tested — see
 * test/connection.test.mjs. Mis-parsing these two boxes is what produced the
 * unhelpful "Bridge token is not set" error, because a bare URL was being
 * taken as the token.
 */

export const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:47653';

const LINK_RE = /^(.*?)\/t\/([A-Za-z0-9_-]+)\/?$/;

/**
 * Classify one field.
 * @returns {{kind: 'empty'|'link'|'url'|'token', token: string, base: string|null}}
 *   `link` is the full URL from `cli.js link` (carries both base and token),
 *   `url` is a URL with no token, `token` is a bare token.
 */
export function parseToken(input) {
  const value = (input ?? '').trim();
  if (!value) return { kind: 'empty', token: '', base: null };

  const match = value.match(LINK_RE);
  if (match) return { kind: 'link', token: match[2], base: match[1] || null };

  // A bare URL carries no token — never let it be mistaken for one.
  if (/^https?:\/\//i.test(value)) return { kind: 'url', token: '', base: value };

  return { kind: 'token', token: value, base: null };
}

/**
 * Resolve the connection from the two text boxes.
 *
 * The link is accepted in either box, because `cli.js link` prints a single URL
 * and pasting it one field off is an easy mistake. A bare token is only
 * accepted in the token box, since the other box is the base URL.
 */
export function resolveConnection(tokenField, urlField) {
  const a = parseToken(tokenField);
  const b = parseToken(urlField);

  const link = a.kind === 'link' ? a : b.kind === 'link' ? b : null;
  const base =
    (link && link.base) ||
    (a.kind === 'url' ? a.base : null) ||
    (b.kind === 'url' ? b.base : null) ||
    DEFAULT_BRIDGE_URL;

  const token = link ? link.token : a.kind === 'token' ? a.token : '';

  return { bridgeUrl: String(base).replace(/\/+$/, ''), token };
}
