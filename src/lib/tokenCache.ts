import { BoundedCache } from "./boundedCache";

const tokenCache = new BoundedCache<{ appId: string; cachedAt: number }>(1000);
const CACHE_TTL_MS = 60_000;

export async function hashToken(rawToken: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawToken));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function verifyAppToken(env: Env, appId: string, rawToken: string): Promise<boolean> {
  const hash = await hashToken(rawToken);

  const cached = tokenCache.get(hash);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached.appId === appId;
  }

  const kvValue = await env.APP_KV.get(`token:${hash}`);
  if (kvValue !== null) {
    tokenCache.set(hash, { appId: kvValue, cachedAt: Date.now() });
    return kvValue === appId;
  }

  const stub = env.APP_DO.get(env.APP_DO.idFromName(appId));
  const valid = await stub.verifyTokenHash(hash);
  if (valid) {
    tokenCache.set(hash, { appId, cachedAt: Date.now() });
    await env.APP_KV.put(`token:${hash}`, appId);
  }
  return valid;
}

export async function invalidateTokenCache(env: Env, tokenHash: string): Promise<void> {
  tokenCache.delete(tokenHash);
  await env.APP_KV.delete(`token:${tokenHash}`);
}
