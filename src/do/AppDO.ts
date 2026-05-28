import { DurableObject } from "cloudflare:workers";
import { SQLSchemaMigrations, type SQLSchemaMigration } from "durable-utils/sql-migrations";
import type { AppCtx, AppRecord, AppToken, AppVersion } from "../types";

const MIGRATIONS: SQLSchemaMigration[] = [
  {
    idMonotonicInc: 1,
    description: "initial schema",
    sql: `
      CREATE TABLE IF NOT EXISTS app_meta (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_versions (
        version INTEGER NOT NULL PRIMARY KEY,
        prompt TEXT NOT NULL,
        code TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_app_meta_created_at ON app_meta(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_app_versions_created_at ON app_versions(created_at DESC);
    `,
  },
  {
    idMonotonicInc: 2,
    description: "app tokens",
    sql: `
      CREATE TABLE IF NOT EXISTS app_tokens (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        label TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_app_tokens_hash ON app_tokens(token_hash);
    `,
  },
];

export class AppDO extends DurableObject {
  #migrations: SQLSchemaMigrations;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#migrations = new SQLSchemaMigrations({ doStorage: ctx.storage, migrations: MIGRATIONS });
  }

  async #ensureSchema() {
    await this.#migrations.runAll();
  }

  async init(appId: string, workspace: string): Promise<void> {
    const existing = await this.ctx.storage.get<AppCtx>("appCtx");
    if (!existing) {
      await this.ctx.storage.put("appCtx", { appId, workspace });
    }
  }

  async createVersion(
    id: string,
    slug: string,
    description: string,
    code: string,
    prompt: string,
  ): Promise<AppRecord> {
    await this.#ensureSchema();
    const now = new Date().toISOString();

    this.ctx.storage.sql.exec(
      `INSERT INTO app_meta (id, slug, description, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET description = excluded.description`,
      id, slug, description, now,
    );

    const nextVersion = this.ctx.storage.sql.exec(
      "SELECT COALESCE(MAX(version), 0) + 1 AS v FROM app_versions",
    ).one().v as number;

    this.ctx.storage.sql.exec(
      "INSERT INTO app_versions (version, prompt, code, created_at) VALUES (?, ?, ?, ?)",
      nextVersion, prompt, code, now,
    );

    const record = await this.getCurrent();
    if (!record) throw new Error(`AppDO: no record found after createVersion for id=${id}`);
    return record;
  }

  async getCurrent(): Promise<AppRecord | null> {
    await this.#ensureSchema();
    const rows = this.ctx.storage.sql.exec<{
      id: string; slug: string; description: string; meta_created_at: string;
      version: number; prompt: string; code: string; version_created_at: string;
    }>(`
      SELECT m.id, m.slug, m.description, m.created_at AS meta_created_at,
             v.version, v.prompt, v.code, v.created_at AS version_created_at
      FROM app_meta m, app_versions v
      WHERE v.version = (SELECT MAX(version) FROM app_versions)
    `).toArray();

    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      id: row.id,
      slug: row.slug,
      description: row.description,
      created_at: row.meta_created_at,
      current: {
        version: row.version,
        prompt: row.prompt,
        code: row.code,
        created_at: row.version_created_at,
      },
    };
  }

  async getHistory(): Promise<AppVersion[]> {
    await this.#ensureSchema();
    return this.ctx.storage.sql.exec<{
      version: number; prompt: string; code: string; created_at: string;
    }>("SELECT version, prompt, code, created_at FROM app_versions ORDER BY version ASC").toArray();
  }

  async getVersion(version: number): Promise<AppVersion | null> {
    await this.#ensureSchema();
    const rows = this.ctx.storage.sql.exec<{
      version: number; prompt: string; code: string; created_at: string;
    }>("SELECT version, prompt, code, created_at FROM app_versions WHERE version = ?", version).toArray();
    return rows[0] ?? null;
  }

  async mintToken(tokenHash: string, label: string | null): Promise<AppToken> {
    await this.#ensureSchema();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.ctx.storage.sql.exec(
      "INSERT INTO app_tokens (id, token_hash, label, created_at) VALUES (?, ?, ?, ?)",
      id, tokenHash, label, now,
    );
    return { id, label, created_at: now };
  }

  async listTokens(): Promise<AppToken[]> {
    await this.#ensureSchema();
    return this.ctx.storage.sql.exec<AppToken>(
      "SELECT id, label, created_at FROM app_tokens ORDER BY created_at DESC",
    ).toArray();
  }

  // Returns the token_hash of the deleted token (for cache invalidation), or null if not found.
  async revokeToken(tokenId: string): Promise<string | null> {
    await this.#ensureSchema();
    const rows = this.ctx.storage.sql.exec<{ token_hash: string }>(
      "SELECT token_hash FROM app_tokens WHERE id = ?", tokenId,
    ).toArray();
    if (rows.length === 0) return null;
    this.ctx.storage.sql.exec("DELETE FROM app_tokens WHERE id = ?", tokenId);
    return rows[0].token_hash;
  }

  async verifyTokenHash(tokenHash: string): Promise<boolean> {
    await this.#ensureSchema();
    const rows = this.ctx.storage.sql.exec<{ id: string }>(
      "SELECT id FROM app_tokens WHERE token_hash = ?", tokenHash,
    ).toArray();
    return rows.length > 0;
  }
}
