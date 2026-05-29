// Parsing of the first path segment of `/apps/<segment>/...`.
//
// Grammar:  <ref> := <appId>[ - <slug> ][ @ <selector> ]
//
// The appId is the only authoritative part — everything downstream (DO address,
// KV keys, token map, caches) keys off it. The slug is decorative and ignored
// for routing; the selector picks a version/channel (acted on in Phase 2).
//
// Parsing is unambiguous because the appId never contains '-' or '@' (see
// src/index.ts where it is generated as a hyphen-free token). Therefore the
// FIRST '-' is always the id/slug boundary and the LAST '@' is always the
// ref/selector boundary. We do NOT depend on the appId's length or charset
// beyond that — only that it stays free of '-' and '@'.

export const APP_ID_RE = /^[^-@]+$/;

/**
 * Generate a new app id. MUST stay free of '-' and '@' so parseRef can split
 * the decorative slug and version selector off the ref — keep this co-located
 * with the parser that depends on its shape.
 */
export function generateAppId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}
export const DEFAULT_CHANNEL = "active"; // bare URL resolves here
export const LATEST = "latest"; // reserved virtual channel = MAX(version)

export type ParsedRef = {
  appId: string; // authoritative; everything downstream keys off this
  slug?: string; // decorative; undefined when absent
  selector?: string; // raw value after '@'; undefined when absent
  resolvedSelector: string; // selector ?? DEFAULT_CHANNEL
};

/**
 * Parse the first path segment of `/apps/<segment>/...` into its parts.
 * Returns null when no valid 32-hex appId is present at the front, so a
 * garbage ref fails fast (404) and never spins up an empty Durable Object.
 */
export function parseRef(segment: string): ParsedRef | null {
  if (!segment) return null;

  // 1. Split off the version selector at the LAST '@'.
  let ref = segment;
  let selector: string | undefined;
  const at = segment.lastIndexOf("@");
  if (at !== -1) {
    ref = segment.slice(0, at);
    selector = segment.slice(at + 1) || undefined;
  }

  // 2. appId is everything before the FIRST '-'; the rest is the decorative slug.
  let appId = ref;
  let slug: string | undefined;
  const dash = ref.indexOf("-");
  if (dash !== -1) {
    appId = ref.slice(0, dash);
    slug = ref.slice(dash + 1) || undefined;
  }

  // 3. Only the appId is validated. Slug is cosmetic; selector validity is
  //    decided at resolution time (Phase 2).
  if (!APP_ID_RE.test(appId)) return null;

  return { appId, slug, selector, resolvedSelector: selector ?? DEFAULT_CHANNEL };
}

/**
 * Build the canonical vanity ref for emitting URLs: `<id>-<slug>`,
 * or just `<id>` when there is no distinct slug.
 */
export function formatRef(appId: string, slug?: string): string {
  return slug && slug !== appId ? `${appId}-${slug}` : appId;
}
