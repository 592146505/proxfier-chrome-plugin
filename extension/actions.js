/**
 * Pure builders for the rule Action dropdown.
 *
 * Proxifier's `<Action type="Proxy">` holds an id that may name EITHER a chain
 * (from `<ChainList>`) OR a bare proxy (from `<ProxyList>`). `<ChainList/>` is
 * empty whenever the profile has no chains, which is common — a single proxy
 * does not need one. Listing only chains therefore leaves the dropdown with no
 * Proxy entry at all.
 *
 * DOM-free so it can be unit-tested: see test/actions.test.mjs.
 */

export const DIRECT = { value: 'Direct', label: 'Direct (bypass proxy)' };
export const BLOCK = { value: 'Block', label: 'Block' };

/** "127.0.0.1:7890", or "" when neither part is known. */
export function proxyEndpoint(proxy) {
  return [proxy.address, proxy.port].filter(Boolean).join(':');
}

/** "SOCKS5 127.0.0.1:7890" */
export function proxyLabel(proxy) {
  const parts = [proxy.type, proxyEndpoint(proxy)].filter(Boolean);
  return parts.length ? parts.join(' ') : `proxy ${proxy.id ?? '?'}`;
}

/** "verge-mihomo [1100]" */
export function chainLabel(chain) {
  return `${chain.name || '(unnamed chain)'} [${chain.id}]`;
}

/**
 * Options for the Action dropdown. Chains come first because they are the
 * explicit construct; bare proxies follow.
 * @returns {{value: string, label: string}[]}
 */
export function actionOptions({ proxies = [], chains = [] } = {}) {
  return [
    DIRECT,
    BLOCK,
    ...chains.map((c) => ({ value: `Proxy:${c.id}`, label: `Proxy chain → ${chainLabel(c)}` })),
    ...proxies.map((p) => ({ value: `Proxy:${p.id}`, label: `Proxy → ${proxyLabel(p)}` })),
  ];
}

/** The dropdown value to preselect for an existing action. */
export function actionValue(action) {
  if (!action) return DIRECT.value;
  return action.type === 'Proxy' ? `Proxy:${action.id}` : action.type;
}

/** Inverse of actionValue: turn a dropdown value back into an action. */
export function parseActionValue(value) {
  if (typeof value === 'string' && value.startsWith('Proxy:')) {
    return { type: 'Proxy', id: value.slice('Proxy:'.length) };
  }
  return { type: value, id: null };
}

/** True when there is nothing to route through, so only Direct/Block are offered. */
export function hasProxyTargets({ proxies = [], chains = [] } = {}) {
  return proxies.length > 0 || chains.length > 0;
}
