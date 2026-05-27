import { Hono } from "hono";

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => {
  return c.json({ message: "dynamic-api is running" });
});

app.get("/api/items", (c) => {
  return c.json({ items: [] });
});

app.get("/api/items/:id", (c) => {
  const id = c.req.param("id");
  return c.json({ id, name: `Item ${id}` });
});

app.post("/api/items", async (c) => {
  const body = await c.req.json<{ name: string }>();
  return c.json({ id: crypto.randomUUID(), name: body.name }, 201);
});

app.delete("/api/items/:id", (c) => {
  const id = c.req.param("id");
  return c.json({ deleted: id });
});

export default app;
