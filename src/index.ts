import { Hono } from "hono";
import * as v from "valibot";
import { tryWhile } from "durable-utils/retries";
import { getAppRecord, writeAppRecord } from "./lib/appCache";
import { generateCode } from "./lib/codegen";
import { CreateAppSchema, MintTokenSchema, UpdateAppSchema } from "./lib/schemas";
import { hashToken, invalidateTokenCache, verifyAppToken } from "./lib/tokenCache";
import type { RegistryAppRecord } from "./types";

export { AppDO } from "./do/AppDO";
export { RegistryDO } from "./do/RegistryDO";

type HonoEnv = { Bindings: Env };

const app = new Hono<HonoEnv>();

// ---------------------------------------------------------------------------
// Management API
// ---------------------------------------------------------------------------

app.get("/api/apps", async (c) => {
  const registryId = c.env.REGISTRY_DO.idFromName("default");
  const registry = c.env.REGISTRY_DO.get(registryId);
  const apps = await registry.listApps();
  return c.json({ apps });
});

app.post("/api/apps", async (c) => {
  const parsed = v.safeParse(CreateAppSchema, await c.req.json());
  if (!parsed.success) {
    return c.json({ error: v.flatten(parsed.issues) }, 400);
  }
  const input = parsed.output;

  const id = crypto.randomUUID().replaceAll("-", "");
  const slug = input.slug ?? id;
  const now = new Date().toISOString();

  const appStub = c.env.APP_DO.get(c.env.APP_DO.idFromName(id));
  await appStub.init(id, "default");

  const registryId = c.env.REGISTRY_DO.idFromName("default");
  const registry = c.env.REGISTRY_DO.get(registryId);

  const initialRegistryRecord: RegistryAppRecord = {
    id, slug, description: input.description,
    current_version: 0, last_updated: now, created_at: now,
  };
  try {
    await tryWhile(
      () => registry.upsertApp(initialRegistryRecord),
      (_err, nextAttempt) => nextAttempt <= 5,
    );
  } catch {
    return c.json({ error: "Failed to register app, please retry" }, 500);
  }

  let code: string;
  try {
    code = await generateCode(c.env, input.description);
  } catch (err) {
    console.error({
      message: "Code generation failed",
      error: String(err),
      errorProps: err,
      appId: id,
    })
    return c.json({ error: String(err) }, 422);
  }

  const appRecord = await appStub.createVersion(id, slug, input.description, code, input.description);
  await writeAppRecord(c.env, appRecord);

  c.executionCtx.waitUntil(
    registry.upsertApp({
      id, slug, description: input.description,
      current_version: appRecord.current.version,
      last_updated: appRecord.current.created_at,
      created_at: now,
    }),
  );

  return c.json(appRecord, 201);
});

app.get("/api/apps/:id", async (c) => {
  const record = await getAppRecord(c.env, c.req.param("id"));
  if (!record) return c.json({ error: "Not found" }, 404);
  return c.json(record);
});

app.put("/api/apps/:id", async (c) => {
  const parsed = v.safeParse(UpdateAppSchema, await c.req.json());
  if (!parsed.success) {
    return c.json({ error: v.flatten(parsed.issues) }, 400);
  }
  const input = parsed.output;

  const existing = await getAppRecord(c.env, c.req.param("id"));
  if (!existing) return c.json({ error: "Not found" }, 404);

  let code: string;
  try {
    code = await generateCode(c.env, input.description, existing.current.code);
  } catch (err) {
    return c.json({ error: String(err) }, 422);
  }

  const appStub = c.env.APP_DO.get(c.env.APP_DO.idFromName(existing.id));
  const appRecord = await appStub.createVersion(
    existing.id, existing.slug, input.description, code, input.description,
  );
  await writeAppRecord(c.env, appRecord);

  const registryId = c.env.REGISTRY_DO.idFromName("default");
  const registry = c.env.REGISTRY_DO.get(registryId);
  c.executionCtx.waitUntil(
    registry.upsertApp({
      id: existing.id,
      slug: existing.slug,
      description: input.description,
      current_version: appRecord.current.version,
      last_updated: appRecord.current.created_at,
      created_at: existing.created_at,
    }),
  );

  return c.json(appRecord);
});

app.get("/api/apps/:id/history", async (c) => {
  const existing = await getAppRecord(c.env, c.req.param("id"));
  if (!existing) return c.json({ error: "Not found" }, 404);
  const stub = c.env.APP_DO.get(c.env.APP_DO.idFromName(existing.id));
  const history = await stub.getHistory();
  return c.json({ history });
});

app.get("/api/apps/:id/history/:version", async (c) => {
  const existing = await getAppRecord(c.env, c.req.param("id"));
  if (!existing) return c.json({ error: "Not found" }, 404);
  const stub = c.env.APP_DO.get(c.env.APP_DO.idFromName(existing.id));
  const version = await stub.getVersion(Number(c.req.param("version")));
  if (!version) return c.json({ error: "Version not found" }, 404);
  return c.json(version);
});

// ---------------------------------------------------------------------------
// Token management
// ---------------------------------------------------------------------------

app.post("/api/apps/:id/tokens", async (c) => {
  const existing = await getAppRecord(c.env, c.req.param("id"));
  if (!existing) return c.json({ error: "Not found" }, 404);

  const parsed = v.safeParse(MintTokenSchema, await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: v.flatten(parsed.issues) }, 400);

  const rawToken = crypto.randomUUID().replaceAll("-", "");
  const tokenHash = await hashToken(rawToken);
  const stub = c.env.APP_DO.get(c.env.APP_DO.idFromName(existing.id));
  const tokenRecord = await stub.mintToken(tokenHash, parsed.output.label ?? null);

  c.executionCtx.waitUntil(c.env.APP_KV.put(`token:${tokenHash}`, existing.id));

  return c.json({ ...tokenRecord, token: rawToken }, 201);
});

app.get("/api/apps/:id/tokens", async (c) => {
  const existing = await getAppRecord(c.env, c.req.param("id"));
  if (!existing) return c.json({ error: "Not found" }, 404);
  const stub = c.env.APP_DO.get(c.env.APP_DO.idFromName(existing.id));
  const tokens = await stub.listTokens();
  return c.json({ tokens });
});

app.delete("/api/apps/:id/tokens/:tokenId", async (c) => {
  const existing = await getAppRecord(c.env, c.req.param("id"));
  if (!existing) return c.json({ error: "Not found" }, 404);
  const stub = c.env.APP_DO.get(c.env.APP_DO.idFromName(existing.id));
  const deletedHash = await stub.revokeToken(c.req.param("tokenId"));
  if (!deletedHash) return c.json({ error: "Token not found" }, 404);
  c.executionCtx.waitUntil(invalidateTokenCache(c.env, deletedHash));
  return new Response(null, { status: 204 });
});

// ---------------------------------------------------------------------------
// Execution plane
// ---------------------------------------------------------------------------

app.use("/apps/:id/*", async (c, next) => {
  const rawToken =
    c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? c.req.query("token");
  if (!rawToken) return c.json({ error: "Unauthorized" }, 401);
  const valid = await verifyAppToken(c.env, c.req.param("id"), rawToken);
  if (!valid) return c.json({ error: "Unauthorized" }, 401);
  return next();
});

app.all("/apps/:id/*", async (c) => {
  const appId = c.req.param("id");
  const appRecord = await getAppRecord(c.env, appId);
  if (!appRecord) return c.json({ error: "Not found" }, 404);

  const cacheKey = `${appRecord.id}_${appRecord.current.created_at}`;
  const stub = c.env.LOADER.get(cacheKey, () => ({
    compatibilityDate: "2026-05-27",
    compatibilityFlags: ["nodejs_compat"],
    mainModule: "handler.js",
    modules: { "handler.js": appRecord.current.code },
  }));

  const url = new URL(c.req.url);
  const prefix = `/apps/${appId}`;
  url.pathname = url.pathname.slice(prefix.length) || "/";
  const forwardedRequest = new Request(url.toString(), c.req.raw);

  try {
    return await stub.getEntrypoint("DynamicHandler").fetch(forwardedRequest);
  } catch (err) {
    return c.json({ error: String(err) }, 502);
  }
});

export default app;
