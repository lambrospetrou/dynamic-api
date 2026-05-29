import type { TestToken } from "../types";

// The test token is a low-privilege, recoverable convenience credential for the
// app owner's manual testing. It is safe to store/return in plaintext only because
// the management plane (/api, /ui) sits behind Cloudflare Access. It rotates every
// 30 minutes via KV expiry: once it lapses, the next owner read mints a fresh one.
const TTL_SECONDS = 30 * 60;

function kvKey(appId: string): string {
  return `testtoken:${appId}`;
}

function generate(): string {
  return crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
}

// Read the current test token, minting (rotating) a new one if none is live.
// Only the (authenticated) management plane should call this — the verify path
// must never mint.
export async function getOrRotateTestToken(env: Env, appId: string): Promise<TestToken> {
  const existing = await env.APP_KV.get(kvKey(appId));
  if (existing !== null) {
    return JSON.parse(existing) as TestToken;
  }
  const record: TestToken = {
    token: generate(),
    expires_at: new Date(Date.now() + TTL_SECONDS * 1000).toISOString(),
  };
  await env.APP_KV.put(kvKey(appId), JSON.stringify(record), { expirationTtl: TTL_SECONDS });
  return record;
}

// Read-only check used by the auth middleware. Returns true only if the supplied
// token matches the app's live test token.
export async function verifyTestToken(env: Env, appId: string, rawToken: string): Promise<boolean> {
  const existing = await env.APP_KV.get(kvKey(appId));
  if (existing === null) return false;
  const record = JSON.parse(existing) as TestToken;
  return record.token === rawToken && Date.parse(record.expires_at) > Date.now();
}
