import { Hono } from "hono";
import * as v from "valibot";
import { tryWhile } from "durable-utils/retries";
import { getAppRecord, getAppRecordFresh, writeAppRecord } from "./lib/appCache";
import { generateCode } from "./lib/codegen";
import {
    ChannelNameSchema,
    CreateAppSchema,
    MintTokenSchema,
    SetChannelSchema,
    UpdateAppSchema,
    UpdateVisibilitySchema,
} from "./lib/schemas";
import { generateAppId, parseRef } from "./lib/ref";
import { getOrRotateTestToken, verifyTestToken } from "./lib/testToken";
import {
    hashToken,
    invalidateTokenCache,
    TOKEN_KV_TTL_SECONDS,
    verifyAppToken,
} from "./lib/tokenCache";
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

    const id = generateAppId();
    const slug = input.slug ?? id;
    const now = new Date().toISOString();

    const appStub = c.env.APP_DO.get(c.env.APP_DO.idFromName(id));
    await appStub.init(id, "default");

    const registryId = c.env.REGISTRY_DO.idFromName("default");
    const registry = c.env.REGISTRY_DO.get(registryId);

    const initialRegistryRecord: RegistryAppRecord = {
        id,
        slug,
        description: input.description,
        visibility: input.visibility,
        current_version: 0,
        last_updated: now,
        created_at: now,
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
        });
        return c.json({ error: String(err) }, 422);
    }

    let appRecord = await appStub.createVersion(id, slug, input.description, code, input.description);
    if (input.visibility === "public") {
        appRecord = (await appStub.setVisibility("public")) ?? appRecord;
    }
    await writeAppRecord(c.env, appRecord);

    c.executionCtx.waitUntil(
        registry.upsertApp({
            id,
            slug,
            description: input.description,
            visibility: appRecord.visibility,
            current_version: appRecord.current.version,
            last_updated: appRecord.current.created_at,
            created_at: now,
        }),
    );

    return c.json(appRecord, 201);
});

app.get("/api/apps/:id", async (c) => {
    const record = await getAppRecordFresh(c.env, c.req.param("id"));
    if (!record) return c.json({ error: "Not found" }, 404);
    const test_token = await getOrRotateTestToken(c.env, record.id);
    return c.json({ ...record, test_token });
});

app.patch("/api/apps/:id", async (c) => {
    const parsed = v.safeParse(UpdateVisibilitySchema, await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: v.flatten(parsed.issues) }, 400);

    const existing = await getAppRecordFresh(c.env, c.req.param("id"));
    if (!existing) return c.json({ error: "Not found" }, 404);

    const stub = c.env.APP_DO.get(c.env.APP_DO.idFromName(existing.id));
    const updated = await stub.setVisibility(parsed.output.visibility);
    if (!updated) return c.json({ error: "Not found" }, 404);
    await writeAppRecord(c.env, updated);

    const registry = c.env.REGISTRY_DO.get(c.env.REGISTRY_DO.idFromName("default"));
    c.executionCtx.waitUntil(
        registry.upsertApp({
            id: updated.id,
            slug: updated.slug,
            description: updated.description,
            visibility: updated.visibility,
            current_version: updated.current.version,
            last_updated: updated.current.created_at,
            created_at: updated.created_at,
        }),
    );

    return c.json(updated);
});

app.put("/api/apps/:id", async (c) => {
    const parsed = v.safeParse(UpdateAppSchema, await c.req.json());
    if (!parsed.success) {
        return c.json({ error: v.flatten(parsed.issues) }, 400);
    }
    const input = parsed.output;

    // Authoritative read: the generated code is a patch on top of this exact
    // base, so it must not be a stale cached snapshot.
    const existing = await getAppRecordFresh(c.env, c.req.param("id"));
    if (!existing) return c.json({ error: "Not found" }, 404);

    let code: string;
    try {
        code = await generateCode(c.env, input.description, existing.current.code);
    } catch (err) {
        return c.json({ error: String(err) }, 422);
    }

    // The DO owns the read-modify-write; expectedVersion guards against another
    // update having superseded the base we just generated from.
    const appStub = c.env.APP_DO.get(c.env.APP_DO.idFromName(existing.id));
    const result = await appStub.updateVersion(
        input.description,
        code,
        input.description,
        existing.current.version,
    );
    if (!result.ok) {
        if (result.reason === "conflict") {
            return c.json({ error: "App was updated concurrently, please retry" }, 409);
        }
        return c.json({ error: "Not found" }, 404);
    }
    const appRecord = result.record;
    await writeAppRecord(c.env, appRecord);

    const registryId = c.env.REGISTRY_DO.idFromName("default");
    const registry = c.env.REGISTRY_DO.get(registryId);
    c.executionCtx.waitUntil(
        registry.upsertApp({
            id: existing.id,
            slug: existing.slug,
            description: input.description,
            visibility: appRecord.visibility,
            current_version: appRecord.current.version,
            last_updated: appRecord.current.created_at,
            created_at: existing.created_at,
        }),
    );

    return c.json(appRecord);
});

app.get("/api/apps/:id/history", async (c) => {
    const existing = await getAppRecordFresh(c.env, c.req.param("id"));
    if (!existing) return c.json({ error: "Not found" }, 404);
    const stub = c.env.APP_DO.get(c.env.APP_DO.idFromName(existing.id));
    const history = await stub.getHistory();
    return c.json({ history });
});

app.get("/api/apps/:id/history/:version", async (c) => {
    const existing = await getAppRecordFresh(c.env, c.req.param("id"));
    if (!existing) return c.json({ error: "Not found" }, 404);
    const stub = c.env.APP_DO.get(c.env.APP_DO.idFromName(existing.id));
    const version = await stub.getVersion(Number(c.req.param("version")));
    if (!version) return c.json({ error: "Version not found" }, 404);
    return c.json(version);
});

// ---------------------------------------------------------------------------
// Release channels
// ---------------------------------------------------------------------------

app.get("/api/apps/:id/channels", async (c) => {
    const existing = await getAppRecordFresh(c.env, c.req.param("id"));
    if (!existing) return c.json({ error: "Not found" }, 404);
    const stub = c.env.APP_DO.get(c.env.APP_DO.idFromName(existing.id));
    const channels = await stub.listChannels();
    return c.json({ channels });
});

app.put("/api/apps/:id/channels/:name", async (c) => {
    const name = v.safeParse(ChannelNameSchema, c.req.param("name"));
    if (!name.success) return c.json({ error: v.flatten(name.issues) }, 400);

    const body = v.safeParse(SetChannelSchema, await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: v.flatten(body.issues) }, 400);

    const existing = await getAppRecordFresh(c.env, c.req.param("id"));
    if (!existing) return c.json({ error: "Not found" }, 404);

    const stub = c.env.APP_DO.get(c.env.APP_DO.idFromName(existing.id));
    const channel = await stub.setChannel(name.output, body.output.version);
    if (!channel) return c.json({ error: "Version not found" }, 404);
    return c.json(channel);
});

// ---------------------------------------------------------------------------
// Token management
// ---------------------------------------------------------------------------

app.post("/api/apps/:id/tokens", async (c) => {
    const existing = await getAppRecordFresh(c.env, c.req.param("id"));
    if (!existing) return c.json({ error: "Not found" }, 404);

    const parsed = v.safeParse(MintTokenSchema, await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: v.flatten(parsed.issues) }, 400);

    const rawToken = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
    const tokenHash = await hashToken(rawToken);
    const stub = c.env.APP_DO.get(c.env.APP_DO.idFromName(existing.id));
    const tokenRecord = await stub.mintToken(tokenHash, parsed.output.label ?? null);

    c.executionCtx.waitUntil(
        c.env.APP_KV.put(`token:${tokenHash}`, existing.id, { expirationTtl: TOKEN_KV_TTL_SECONDS }),
    );

    return c.json({ ...tokenRecord, token: rawToken }, 201);
});

app.get("/api/apps/:id/tokens", async (c) => {
    const existing = await getAppRecordFresh(c.env, c.req.param("id"));
    if (!existing) return c.json({ error: "Not found" }, 404);
    const stub = c.env.APP_DO.get(c.env.APP_DO.idFromName(existing.id));
    const tokens = await stub.listTokens();
    const test_token = await getOrRotateTestToken(c.env, existing.id);
    return c.json({ tokens, test_token });
});

app.delete("/api/apps/:id/tokens/:tokenId", async (c) => {
    const existing = await getAppRecordFresh(c.env, c.req.param("id"));
    if (!existing) return c.json({ error: "Not found" }, 404);
    const stub = c.env.APP_DO.get(c.env.APP_DO.idFromName(existing.id));
    const tokenHash = await stub.getTokenHash(c.req.param("tokenId"));
    if (!tokenHash) return c.json({ error: "Token not found" }, 404);
    await invalidateTokenCache(c.env, tokenHash);
    const deletedHash = await stub.revokeToken(c.req.param("tokenId"));
    if (!deletedHash) return c.json({ error: "Token not found" }, 404);
    return new Response(null, { status: 204 });
});

// ---------------------------------------------------------------------------
// Execution plane
// ---------------------------------------------------------------------------

app.use("/apps/:id/*", async (c, next) => {
    const parsed = parseRef(c.req.param("id"));
    if (!parsed) return c.json({ error: "Not found" }, 404);
    const { appId } = parsed;

    const record = await getAppRecord(c.env, appId);
    if (!record) return c.json({ error: "Not found" }, 404);

    // Public apps are callable by anyone, no token required.
    if (record.visibility === "public") return next();

    const rawToken = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? c.req.query("token");
    if (!rawToken) return c.json({ error: "Unauthorized" }, 401);

    // Minted (hashed) tokens are the common path; the recoverable test token is a
    // fallback so the owner can click an app URL without managing a secret.
    const valid = (await verifyAppToken(c.env, appId, rawToken)) || (await verifyTestToken(c.env, appId, rawToken));
    if (!valid) return c.json({ error: "Unauthorized" }, 401);
    return next();
});

app.all("/apps/:id/*", async (c) => {
    const parsed = parseRef(c.req.param("id"));
    if (!parsed) return c.json({ error: "Not found" }, 404);
    const { appId, resolvedSelector } = parsed;

    const appRecord = await getAppRecord(c.env, appId, resolvedSelector);
    if (!appRecord) return c.json({ error: "Not found" }, 404);

    const cacheKey = `${appRecord.id}_v${appRecord.current.version}`;
    const stub = c.env.LOADER.get(cacheKey, () => ({
        compatibilityDate: "2026-05-27",
        compatibilityFlags: ["nodejs_compat"],
        mainModule: "handler.js",
        modules: { "handler.js": appRecord.current.code },
    }));

    const url = new URL(c.req.url);
    // Strip the WHOLE matched segment (id + slug + selector), not just appId,
    // so the app sees only its own path.
    const prefix = `/apps/${c.req.param("id")}`;
    url.pathname = url.pathname.slice(prefix.length) || "/";
    const forwardedRequest = new Request(url.toString(), c.req.raw);

    try {
        return await stub.getEntrypoint("DynamicHandler").fetch(forwardedRequest);
    } catch (err) {
        return c.json({ error: String(err) }, 502);
    }
});

export default app;
