/**
 * Pure helpers for turning the current tab's host into Proxifier targets
 * and merging it into an existing rule.
 *
 * DOM/chrome-free so they can be unit-tested — see test/targets.test.mjs.
 */

/**
 * The targets that represent one site: the exact host plus the wildcard of
 * its www-stripped form.
 *   "github.com"     -> ["github.com", "*.github.com"]
 *   "www.github.com" -> ["www.github.com", "*.github.com"]
 */
export function hostVariants(host) {
  const value = String(host ?? '').trim().toLowerCase();
  if (!value) return [];
  return [value, `*.${value.replace(/^www\./, '')}`];
}

/** Proxifier identifies Chrome by its executable name, which differs by OS. */
export function defaultBrowserApp(ua = navigator.userAgent) {
  return /Windows/i.test(String(ua ?? '')) ? 'chrome.exe' : 'Google Chrome';
}

/** Append the host variants to an existing Targets list, deduplicating. */
export function mergeTargets(existing, host) {
  const targets = [...(existing ?? [])];
  const have = new Set(targets);
  let added = 0;
  for (const variant of hostVariants(host)) {
    if (!have.has(variant)) {
      have.add(variant);
      targets.push(variant);
      added += 1;
    }
  }
  return { targets, added };
}

/** Append picked application entries to a "a; b" Applications field, case-insensitively deduplicated. */
export function mergeApplications(field, entries) {
  const apps = String(field ?? '').split(';').map((s) => s.trim()).filter(Boolean);
  for (const entry of entries ?? []) {
    if (!apps.some((a) => a.toLowerCase() === entry.toLowerCase())) apps.push(entry);
  }
  return apps.join('; ');
}
