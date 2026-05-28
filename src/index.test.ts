import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import app from "./index";

vi.mock("./lib/codegen", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/codegen")>();
  return { ...actual, generateCode: vi.fn() };
});

import { generateCode } from "./lib/codegen";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DUMMY_CODE = `import { WorkerEntrypoint } from "cloudflare:workers";
export class DynamicHandler extends WorkerEntrypoint {
  async fetch(request) {
    return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
  }
}`;

async function appFetch(path: string, init?: RequestInit) {
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(`http://localhost${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

function jsonFetch(path: string, method: string, body: unknown) {
  return appFetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("POST /api/apps — validation", () => {
  it("returns 400 when description is missing", async () => {
    const res = await jsonFetch("/api/apps", "POST", {});
    expect(res.status).toBe(400);
  });

  it("returns 400 when slug is invalid", async () => {
    const res = await jsonFetch("/api/apps", "POST", { slug: "UPPER_CASE", description: "test" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when description is empty string", async () => {
    const res = await jsonFetch("/api/apps", "POST", { description: "" });
    expect(res.status).toBe(400);
  });
});

describe("PUT /api/apps/:id — validation", () => {
  it("returns 400 when description is missing", async () => {
    const res = await jsonFetch("/api/apps/someid", "PUT", {});
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Not found
// ---------------------------------------------------------------------------

describe("GET /api/apps/:id", () => {
  it("returns 404 for unknown id", async () => {
    const res = await appFetch("/api/apps/doesnotexist");
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// CRUD (codegen mocked)
// ---------------------------------------------------------------------------

describe("app CRUD", () => {
  it("creates an app, retrieves it, and updates it", async () => {
    vi.mocked(generateCode).mockResolvedValue(DUMMY_CODE);

    // POST — create
    const createRes = await jsonFetch("/api/apps", "POST", { slug: "my-app", description: "A test app" });
    expect(createRes.status).toBe(201);
    const created = await createRes.json<any>();
    expect(created.slug).toBe("my-app");
    expect(created.current.version).toBe(1);
    expect(created.current.code).toBe(DUMMY_CODE);

    const id = created.id;

    // GET — retrieve
    const getRes = await appFetch(`/api/apps/${id}`);
    expect(getRes.status).toBe(200);
    const fetched = await getRes.json<any>();
    expect(fetched.id).toBe(id);

    // PUT — update
    const putRes = await jsonFetch(`/api/apps/${id}`, "PUT", { description: "Updated description" });
    expect(putRes.status).toBe(200);
    const updated = await putRes.json<any>();
    expect(updated.current.version).toBe(2);
    expect(updated.description).toBe("Updated description");

    // GET history
    const histRes = await appFetch(`/api/apps/${id}/history`);
    expect(histRes.status).toBe(200);
    const { history } = await histRes.json<any>();
    expect(history).toHaveLength(2);

    // GET /history/:version
    const v1Res = await appFetch(`/api/apps/${id}/history/1`);
    expect(v1Res.status).toBe(200);
    const v1 = await v1Res.json<any>();
    expect(v1.version).toBe(1);

    // GET list
    const listRes = await appFetch("/api/apps");
    expect(listRes.status).toBe(200);
    const { apps } = await listRes.json<any>();
    expect(apps.some((a: any) => a.id === id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cache layer
// ---------------------------------------------------------------------------

describe("appCache", () => {
  it("writeAppRecord upserts into in-memory cache", async () => {
    const { writeAppRecord, getAppRecord } = await import("./lib/appCache");
    const record = {
      id: "cachetest",
      slug: "cache-test",
      description: "desc",
      created_at: new Date().toISOString(),
      current: { version: 1, prompt: "p", code: "c", created_at: new Date().toISOString() },
    };
    await writeAppRecord(env, record);
    const fetched = await getAppRecord(env, "cachetest");
    expect(fetched?.id).toBe("cachetest");
    expect(fetched?.current.version).toBe(1);
  });

  it("does not overwrite cache with an older version", async () => {
    const { writeAppRecord, getAppRecord } = await import("./lib/appCache");
    const newer = {
      id: "versiontest",
      slug: "vt",
      description: "d",
      created_at: new Date().toISOString(),
      current: { version: 5, prompt: "p", code: "c", created_at: new Date().toISOString() },
    };
    await writeAppRecord(env, newer);
    const older = { ...newer, current: { ...newer.current, version: 3 } };
    await writeAppRecord(env, older);
    const fetched = await getAppRecord(env, "versiontest");
    expect(fetched?.current.version).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Code validation (unit)
// ---------------------------------------------------------------------------

describe("validateCode", () => {
  it("accepts valid DynamicHandler code", async () => {
    const { validateCode } = await import("./lib/codegen");
    expect(validateCode(DUMMY_CODE)).toBe(true);
  });

  it("rejects code missing DynamicHandler export", async () => {
    const { validateCode } = await import("./lib/codegen");
    expect(validateCode("export class Foo {}")).toBe(false);
  });

  it("rejects code missing async fetch", async () => {
    const { validateCode } = await import("./lib/codegen");
    expect(validateCode("export class DynamicHandler {}")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Token management
// ---------------------------------------------------------------------------

describe("token management", () => {
  it("mints a token with label, lists it (no value), revokes it", async () => {
    vi.mocked(generateCode).mockResolvedValue(DUMMY_CODE);

    const createRes = await jsonFetch("/api/apps", "POST", { description: "Token test app" });
    expect(createRes.status).toBe(201);
    const { id: appId } = await createRes.json<any>();

    // Mint with label
    const mintRes = await jsonFetch(`/api/apps/${appId}/tokens`, "POST", { label: "ci" });
    expect(mintRes.status).toBe(201);
    const minted = await mintRes.json<any>();
    expect(typeof minted.token).toBe("string");
    expect(minted.token).toHaveLength(32);
    expect(minted.label).toBe("ci");
    expect(minted.token).not.toContain("-");
    const { id: tokenId, token } = minted;

    // List — value must not be present
    const listRes = await appFetch(`/api/apps/${appId}/tokens`);
    expect(listRes.status).toBe(200);
    const { tokens } = await listRes.json<any>();
    expect(tokens).toHaveLength(1);
    expect(tokens[0].id).toBe(tokenId);
    expect(tokens[0].token).toBeUndefined();

    // /apps/:id/* rejects without token
    const noAuthRes = await appFetch(`/apps/${appId}/`);
    expect(noAuthRes.status).toBe(401);

    // /apps/:id/* rejects with wrong token
    const wrongAuthRes = await appFetch(`/apps/${appId}/`, {
      headers: { Authorization: "Bearer wrongtoken" },
    });
    expect(wrongAuthRes.status).toBe(401);

    // /apps/:id/* passes auth with Authorization header (LOADER may 502, that's fine)
    const authHeaderRes = await appFetch(`/apps/${appId}/`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(authHeaderRes.status).not.toBe(401);

    // /apps/:id/* passes auth with ?token= query param
    const authQueryRes = await appFetch(`/apps/${appId}/?token=${token}`);
    expect(authQueryRes.status).not.toBe(401);

    // Revoke
    const revokeRes = await appFetch(`/api/apps/${appId}/tokens/${tokenId}`, {
      method: "DELETE",
    });
    expect(revokeRes.status).toBe(204);

    // Token no longer accepted
    const afterRevokeRes = await appFetch(`/apps/${appId}/`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(afterRevokeRes.status).toBe(401);
  });

  it("mints a token without label", async () => {
    vi.mocked(generateCode).mockResolvedValue(DUMMY_CODE);
    const createRes = await jsonFetch("/api/apps", "POST", { description: "No label app" });
    const { id: appId } = await createRes.json<any>();
    const mintRes = await jsonFetch(`/api/apps/${appId}/tokens`, "POST", {});
    expect(mintRes.status).toBe(201);
    const { label } = await mintRes.json<any>();
    expect(label).toBeNull();
  });

  it("returns 404 when minting for unknown app", async () => {
    const res = await jsonFetch("/api/apps/doesnotexist/tokens", "POST", { label: "x" });
    expect(res.status).toBe(404);
  });

  it("returns 404 when revoking unknown token id", async () => {
    vi.mocked(generateCode).mockResolvedValue(DUMMY_CODE);
    const createRes = await jsonFetch("/api/apps", "POST", { description: "Revoke test" });
    const { id: appId } = await createRes.json<any>();
    const res = await appFetch(`/api/apps/${appId}/tokens/doesnotexist`, { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// URL prefix stripping
// ---------------------------------------------------------------------------

describe("execution plane URL rewriting", () => {
  it("strips /apps/:id prefix correctly", () => {
    const appId = "abc123";
    const cases: [string, string][] = [
      [`/apps/${appId}/todos`, "/todos"],
      [`/apps/${appId}/todos/1`, "/todos/1"],
      [`/apps/${appId}`, "/"],
      [`/apps/${appId}/`, "/"],
    ];
    for (const [input, expected] of cases) {
      const url = new URL(`http://localhost${input}`);
      const prefix = `/apps/${appId}`;
      url.pathname = url.pathname.slice(prefix.length) || "/";
      expect(url.pathname).toBe(expected);
    }
  });
});
