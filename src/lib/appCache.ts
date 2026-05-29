import type { AppRecord } from "../types";
import { BoundedCache } from "./boundedCache";
import { LATEST } from "./ref";

const appCache = new BoundedCache<{ record: AppRecord; cachedAt: number }>(500);
// Immutable numeric versions can be cached aggressively; moving targets
// (latest / channels) get a short TTL so promotes and edits propagate.
const MOVING_TTL_MS = 60_000;
const IMMUTABLE_TTL_MS = 60 * 60_000;

const isImmutable = (selector: string) => /^\d+$/.test(selector);

// `selector` is a concrete version selector — a numeric version, "latest", or a
// channel name. Defaults to LATEST so management reads (which always want the
// newest version) keep their previous behavior; the execution plane passes the
// request's resolvedSelector instead.
//
// `fresh` bypasses the memory and KV layers and reads straight from the Durable
// Object (strongly consistent). Use it for the management plane, where a stale
// read — KV GETs sit behind an edge cache of >=60s — could e.g. regenerate a
// new version from an out-of-date base. The fresh result still repopulates the
// caches for subsequent execution-plane reads.
export async function getAppRecord(
	env: Env,
	appId: string,
	selector: string = LATEST,
	{ fresh = false }: { fresh?: boolean } = {},
): Promise<AppRecord | null> {
	const cacheKey = `${appId}@${selector}`;
	const immutable = isImmutable(selector);
	const ttl = immutable ? IMMUTABLE_TTL_MS : MOVING_TTL_MS;
	// KV fast path: the `app:${id}` write-through snapshot is exactly the latest
	// version, and per-version snapshots are immutable. Channels are resolved
	// through the DO (they move and are not written to KV).
	const kvKey =
		selector === LATEST ? `app:${appId}` : immutable ? `app:${appId}@${selector}` : null;

	if (!fresh) {
		const cached = appCache.get(cacheKey);
		if (cached && Date.now() - cached.cachedAt < ttl) {
			return cached.record;
		}
		if (kvKey) {
			const kvValue = await env.APP_KV.get(kvKey);
			if (kvValue) {
				const record = JSON.parse(kvValue) as AppRecord;
				appCache.set(cacheKey, { record, cachedAt: Date.now() });
				return record;
			}
		}
	}

	try {
		const stub = env.APP_DO.get(env.APP_DO.idFromName(appId));
		const record = await stub.resolve(selector);
		if (!record) return null;
		appCache.set(cacheKey, { record, cachedAt: Date.now() });
		// Persist immutable version snapshots to KV for cross-isolate reuse.
		if (immutable && kvKey) {
			await env.APP_KV.put(kvKey, JSON.stringify(record));
		}
		return record;
	} catch {
		return null;
	}
}

// Convenience wrapper for the management plane: always reads the authoritative
// Durable Object state, never a cached snapshot.
export function getAppRecordFresh(
	env: Env,
	appId: string,
	selector: string = LATEST,
): Promise<AppRecord | null> {
	return getAppRecord(env, appId, selector, { fresh: true });
}

export async function writeAppRecord(env: Env, record: AppRecord): Promise<void> {
	await env.APP_KV.put(`app:${record.id}`, JSON.stringify(record));
	const key = `${record.id}@${LATEST}`;
	const cached = appCache.get(key);
	if (!cached || record.current.version >= cached.record.current.version) {
		appCache.set(key, { record, cachedAt: Date.now() });
	}
}
