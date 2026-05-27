import { describe, expect, it } from "vitest";
import app from "./index";

describe("dynamic-api", () => {
  it("GET / returns a running message", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ message: "dynamic-api is running" });
  });

  it("GET /api/items returns an empty list", async () => {
    const res = await app.request("/api/items");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ items: [] });
  });

  it("GET /api/items/:id returns the item", async () => {
    const res = await app.request("/api/items/42");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ id: "42", name: "Item 42" });
  });

  it("POST /api/items creates an item", async () => {
    const res = await app.request("/api/items", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Widget" }),
    });
    expect(res.status).toBe(201);
    const json = await res.json<{ id: string; name: string }>();
    expect(json.name).toBe("Widget");
    expect(typeof json.id).toBe("string");
  });

  it("DELETE /api/items/:id deletes the item", async () => {
    const res = await app.request("/api/items/7", { method: "DELETE" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ deleted: "7" });
  });
});
