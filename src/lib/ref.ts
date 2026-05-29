// Parsing of the first path segment of `/apps/<segment>/...`.
//
// Grammar:  <ref> := <appId>[ - <slug> ][ @ <selector> ]
//
// The appId is the only authoritative part — everything downstream (DO address,
// KV keys, token map, caches) keys off it. The slug is decorative and ignored
// for routing; the selector picks a version/channel (acted on in Phase 2).
//
// An appId is 35 base32 chars: a 25-char random part (125-bit) followed by a
// 10-char HMAC tag (50-bit) — see generateAppId / verifyAppId. base32 carries
// exactly 5 bits/char and, because 256 is a multiple of 32, `byte % 32` is
// perfectly unbiased. The ALPHABET should not contain neither '-' nor '@', so the
// FIRST '-' is still the id/slug boundary and the LAST '@' the ref/selector
// boundary.

const ALPHABET = "0123456789abcdefghijklmnopqrstuv"; // 32 chars
const ID_RANDOM_LEN = 25; // 125-bit random part — collision-safe well past billions of apps
const ID_TAG_LEN = 10; // 50-bit HMAC tag — infeasible to forge online without the secret
const ID_LEN = ID_RANDOM_LEN + ID_TAG_LEN;

// Format gate: cheap, allocation-free rejection of anything that isn't shaped
// like one of our ids, BEFORE any KV/DO lookup. This stops malformed-junk
// traffic at the edge; verifyAppId() then rejects well-formed-but-forged ids.
export const APP_ID_RE = new RegExp(`^[0-9a-v]{${ID_LEN}}$`);

const encoder = new TextEncoder();

// Cryptographically random base32 string: one random byte per char, mapped into
// the alphabet. 256 is a multiple of 32, so `byte % 32` is unbiased.
function randomBase32(len: number): string {
	const bytes = crypto.getRandomValues(new Uint8Array(len));
	let out = "";
	for (const b of bytes) out += ALPHABET[b % 32];
	return out;
}

// HMAC-SHA256(randomPart) mapped to ID_TAG_LEN base32 chars. The tag binds the
// id to our secret, so a request for an id we never minted can be rejected with
// pure CPU — no KV read, no Durable Object instantiation. The mapping is
// deterministic (so verify reproduces it) and the output is unpredictable to
// anyone without the secret.
async function hmacTag(secret: string, randomPart: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(randomPart));
	const bytes = new Uint8Array(sig);
	let tag = "";
	for (let i = 0; i < ID_TAG_LEN; i++) tag += ALPHABET[bytes[i] % 32];
	return tag;
}

// Constant-time comparison of two equal-length strings.
function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/**
 * Generate a new, self-verifying app id: a random part plus an HMAC tag keyed by
 * the server secret. MUST stay free of '-' and '@' so parseRef can split the
 * decorative slug and version selector off the ref — keep this co-located with
 * the parser and verifier that depend on its shape.
 */
export async function generateAppId(secret: string): Promise<string> {
	const random = randomBase32(ID_RANDOM_LEN);
	return random + (await hmacTag(secret, random));
}

/**
 * True only for ids this server actually minted. Verifies the HMAC tag, so a
 * forged id is rejected before any KV/DO lookup. Always run this on the
 * execution plane before resolving an app.
 */
export async function verifyAppId(secret: string, appId: string): Promise<boolean> {
	if (!APP_ID_RE.test(appId)) return false;
	const random = appId.slice(0, ID_RANDOM_LEN);
	const tag = appId.slice(ID_RANDOM_LEN);
	return timingSafeEqual(tag, await hmacTag(secret, random));
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
 * Returns null when the leading token isn't a well-formed appId, so garbage
 * fails fast (404) and never reaches KV or a Durable Object. This is a pure
 * format check; authenticity is confirmed separately by verifyAppId.
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

	// 3. Only the appId is validated for shape. Slug is cosmetic; selector
	//    validity is decided at resolution time (Phase 2).
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
