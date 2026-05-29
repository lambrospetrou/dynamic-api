import { DurableObject } from "cloudflare:workers";
import { SQLSchemaMigrations, type SQLSchemaMigration } from "durable-utils/sql-migrations";
import { DEFAULT_CHANNEL, LATEST } from "../lib/ref";
import type { AppChannel, AppCtx, AppRecord, AppToken, AppVersion, Visibility } from "../types";

const MIGRATIONS: SQLSchemaMigration[] = [
    {
        idMonotonicInc: 1,
        description: "initial schema",
        sql: `
      CREATE TABLE IF NOT EXISTS app_meta (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL,
        visibility TEXT NOT NULL DEFAULT 'private',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_versions (
        version INTEGER NOT NULL PRIMARY KEY,
        prompt TEXT NOT NULL,
        code TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_tokens (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        label TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_app_meta_created_at ON app_meta(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_app_versions_created_at ON app_versions(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_app_tokens_hash ON app_tokens(token_hash);
    `,
    },
    {
        idMonotonicInc: 2,
        description: "release channels",
        sql: `
      CREATE TABLE IF NOT EXISTS app_channels (
        name       TEXT PRIMARY KEY,
        version    INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
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
            id,
            slug,
            description,
            now,
        );

        const nextVersion = this.ctx.storage.sql
            .exec("SELECT COALESCE(MAX(version), 0) + 1 AS v FROM app_versions")
            .one().v as number;

        this.ctx.storage.sql.exec(
            "INSERT INTO app_versions (version, prompt, code, created_at) VALUES (?, ?, ?, ?)",
            nextVersion,
            prompt,
            code,
            now,
        );

        const record = await this.getCurrent();
        if (!record) throw new Error(`AppDO: no record found after createVersion for id=${id}`);
        return record;
    }

    // Append a new version to an existing app. The DO owns the read-modify-write:
    // it patches the description, computes the next version number, and inserts —
    // all without an intervening await, so version numbering is race-free. When
    // `expectedVersion` is given it acts as an optimistic-concurrency guard: the
    // caller generated the new code from that base, so a newer version landing in
    // the meantime is reported as a conflict rather than silently superseded.
    async updateVersion(
        description: string,
        code: string,
        prompt: string,
        expectedVersion?: number,
    ): Promise<
        { ok: true; record: AppRecord } | { ok: false; reason: "notfound" | "conflict" }
    > {
        await this.#ensureSchema();
        const max = this.#maxVersion();
        if (max === null) return { ok: false, reason: "notfound" };
        if (expectedVersion !== undefined && max !== expectedVersion) {
            return { ok: false, reason: "conflict" };
        }

        const now = new Date().toISOString();
        const next = max + 1;
        this.ctx.storage.sql.exec("UPDATE app_meta SET description = ?", description);
        this.ctx.storage.sql.exec(
            "INSERT INTO app_versions (version, prompt, code, created_at) VALUES (?, ?, ?, ?)",
            next,
            prompt,
            code,
            now,
        );

        const record = this.#recordAt(next);
        if (!record) throw new Error("AppDO: no record found after updateVersion");
        return { ok: true, record };
    }

    async setVisibility(visibility: Visibility): Promise<AppRecord | null> {
        await this.#ensureSchema();
        this.ctx.storage.sql.exec("UPDATE app_meta SET visibility = ?", visibility);
        return this.getCurrent();
    }

    // Build the AppRecord for a specific version (meta + that version's code).
    #recordAt(version: number): AppRecord | null {
        const rows = this.ctx.storage.sql
            .exec<{
                id: string;
                slug: string;
                description: string;
                visibility: Visibility;
                meta_created_at: string;
                version: number;
                prompt: string;
                code: string;
                version_created_at: string;
            }>(
                `
      SELECT m.id, m.slug, m.description, m.visibility, m.created_at AS meta_created_at,
             v.version, v.prompt, v.code, v.created_at AS version_created_at
      FROM app_meta m, app_versions v
      WHERE v.version = ?
    `,
                version,
            )
            .toArray();

        if (rows.length === 0) return null;
        const row = rows[0];
        return {
            id: row.id,
            slug: row.slug,
            description: row.description,
            visibility: row.visibility,
            created_at: row.meta_created_at,
            current: {
                version: row.version,
                prompt: row.prompt,
                code: row.code,
                created_at: row.version_created_at,
            },
        };
    }

    #maxVersion(): number | null {
        const v = this.ctx.storage.sql.exec("SELECT MAX(version) AS v FROM app_versions").one().v as
            | number
            | null;
        return v ?? null;
    }

    // Map a concrete selector (numeric version, "latest", or a channel name) to
    // a version number. The default channel falls back to latest until it has
    // been explicitly promoted; any other unset channel resolves to null (404).
    #resolveVersionNumber(selector: string): number | null {
        if (/^\d+$/.test(selector)) return Number(selector);
        if (selector === LATEST) return this.#maxVersion();
        const channel = this.#getChannelVersion(selector);
        if (channel !== null) return channel;
        if (selector === DEFAULT_CHANNEL) return this.#maxVersion();
        return null;
    }

    #getChannelVersion(name: string): number | null {
        const rows = this.ctx.storage.sql
            .exec<{ version: number }>("SELECT version FROM app_channels WHERE name = ?", name)
            .toArray();
        return rows[0]?.version ?? null;
    }

    // Resolve a selector to the served AppRecord. Returns null when the selector
    // points at a non-existent version or unset channel.
    async resolve(selector: string): Promise<AppRecord | null> {
        await this.#ensureSchema();
        const version = this.#resolveVersionNumber(selector);
        if (version === null) return null;
        return this.#recordAt(version);
    }

    async getCurrent(): Promise<AppRecord | null> {
        await this.#ensureSchema();
        const version = this.#maxVersion();
        if (version === null) return null;
        return this.#recordAt(version);
    }

    async setChannel(name: string, version: number): Promise<AppChannel | null> {
        await this.#ensureSchema();
        if (this.#recordAt(version) === null) return null; // version must exist
        const now = new Date().toISOString();
        this.ctx.storage.sql.exec(
            `INSERT INTO app_channels (name, version, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at`,
            name,
            version,
            now,
        );
        return { name, version, updated_at: now };
    }

    async listChannels(): Promise<AppChannel[]> {
        await this.#ensureSchema();
        return this.ctx.storage.sql
            .exec<AppChannel>("SELECT name, version, updated_at FROM app_channels ORDER BY name ASC")
            .toArray();
    }

    async getHistory(): Promise<AppVersion[]> {
        await this.#ensureSchema();
        return this.ctx.storage.sql
            .exec<{
                version: number;
                prompt: string;
                code: string;
                created_at: string;
            }>("SELECT version, prompt, code, created_at FROM app_versions ORDER BY version ASC")
            .toArray();
    }

    async getVersion(version: number): Promise<AppVersion | null> {
        await this.#ensureSchema();
        const rows = this.ctx.storage.sql
            .exec<{
                version: number;
                prompt: string;
                code: string;
                created_at: string;
            }>("SELECT version, prompt, code, created_at FROM app_versions WHERE version = ?", version)
            .toArray();
        return rows[0] ?? null;
    }

    async mintToken(tokenHash: string, label: string | null): Promise<AppToken> {
        await this.#ensureSchema();
        const id = crypto.randomUUID().replaceAll("-", "");
        const now = new Date().toISOString();
        this.ctx.storage.sql.exec(
            "INSERT INTO app_tokens (id, token_hash, label, created_at) VALUES (?, ?, ?, ?)",
            id,
            tokenHash,
            label,
            now,
        );
        return { id, label, created_at: now };
    }

    async listTokens(): Promise<AppToken[]> {
        await this.#ensureSchema();
        return this.ctx.storage.sql
            .exec<AppToken>("SELECT id, label, created_at FROM app_tokens ORDER BY created_at DESC")
            .toArray();
    }

    async getTokenHash(tokenId: string): Promise<string | null> {
        await this.#ensureSchema();
        const rows = this.ctx.storage.sql
            .exec<{ token_hash: string }>("SELECT token_hash FROM app_tokens WHERE id = ?", tokenId)
            .toArray();
        if (rows.length === 0) return null;
        return rows[0].token_hash;
    }

    // Returns the token_hash of the deleted token (for cache invalidation), or null if not found.
    async revokeToken(tokenId: string): Promise<string | null> {
        await this.#ensureSchema();
        const rows = this.ctx.storage.sql
            .exec<{ token_hash: string }>("SELECT token_hash FROM app_tokens WHERE id = ?", tokenId)
            .toArray();
        if (rows.length === 0) return null;
        this.ctx.storage.sql.exec("DELETE FROM app_tokens WHERE id = ?", tokenId);
        return rows[0].token_hash;
    }

    async verifyTokenHash(tokenHash: string): Promise<boolean> {
        await this.#ensureSchema();
        const rows = this.ctx.storage.sql
            .exec<{ id: string }>("SELECT id FROM app_tokens WHERE token_hash = ?", tokenHash)
            .toArray();
        return rows.length > 0;
    }
}
