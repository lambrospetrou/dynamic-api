import type { AppRecord } from "../types";
import { BoundedCache } from "./boundedCache";

const appCache = new BoundedCache<{ record: AppRecord; cachedAt: number }>(500);
const CACHE_TTL_MS = 60_000;

export async function getAppRecord(env: Env, appId: string): Promise<AppRecord | null> {
  const cached = appCache.get(appId);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached.record;
  }

  const kvValue = await env.APP_KV.get(`app:${appId}`);
  if (kvValue) {
    const record = JSON.parse(kvValue) as AppRecord;
    appCache.set(appId, { record, cachedAt: Date.now() });
    return record;
  }

  try {
    const stub = env.APP_DO.get(env.APP_DO.idFromName(appId));
    const record = await stub.getCurrent();
    if (!record) return null;
    appCache.set(appId, { record, cachedAt: Date.now() });
    return record;
  } catch {
    return null;
  }
}

export async function writeAppRecord(env: Env, record: AppRecord): Promise<void> {
  await env.APP_KV.put(`app:${record.id}`, JSON.stringify(record));
  const cached = appCache.get(record.id);
  if (!cached || record.current.version >= cached.record.current.version) {
    appCache.set(record.id, { record, cachedAt: Date.now() });
  }
}
