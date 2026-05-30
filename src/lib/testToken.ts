import type { TestToken } from "../types";

// Stateless HMAC-signed test token — no storage needed.
// Format: test_{expiresAtUnix}_{mac32}
// HMAC input: "${appId}:${expiresAtUnix}", keyed by APP_ID_SECRET.
// Binding the HMAC to both appId and expiry means the token is:
//   - unforgeable without APP_ID_SECRET
//   - scoped to a single app (using it against a different appId fails)
//   - self-expiring (expiresAt is covered by the MAC, so it can't be bumped)

const TOKEN_TTL_SECONDS = 1 * 60 * 60;
const MAC_HEX_LEN = 32; // 128 bits of a SHA-256 MAC — ample for a test credential

const encoder = new TextEncoder();

async function hmacHex(secret: string, message: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
	return Array.from(new Uint8Array(sig))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export async function mintTestToken(appId: string, secret: string): Promise<TestToken> {
	const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
	const mac = await hmacHex(secret, `${appId}:${expiresAt}`);
	return {
		token: `test_${expiresAt}_${mac.slice(0, MAC_HEX_LEN)}`,
		expires_at: new Date(expiresAt * 1000).toISOString(),
	};
}

// Pure verification — no I/O, no storage. Returns true only when the token was
// minted by this service for this specific appId and has not expired.
export async function verifyTestToken(
	appId: string,
	rawToken: string,
	secret: string,
): Promise<boolean> {
	if (!rawToken.startsWith("test_")) return false;
	const parts = rawToken.split("_");
	if (parts.length !== 3) return false;
	const [, expiresAtStr, mac] = parts;
	if (mac.length !== MAC_HEX_LEN) return false;
	const expiresAt = Number(expiresAtStr);
	if (!Number.isInteger(expiresAt) || expiresAt <= 0) return false;
	if (expiresAt < Math.floor(Date.now() / 1000)) return false;
	const expected = await hmacHex(secret, `${appId}:${expiresAt}`);
	let diff = 0;
	for (let i = 0; i < MAC_HEX_LEN; i++) diff |= mac.charCodeAt(i) ^ expected.charCodeAt(i);
	return diff === 0;
}
