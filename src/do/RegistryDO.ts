import { DurableObject } from "cloudflare:workers";
import { SQLSchemaMigrations, type SQLSchemaMigration } from "durable-utils/sql-migrations";
import type { RegistryAppRecord } from "../types";

const MIGRATIONS: SQLSchemaMigration[] = [
	{
		idMonotonicInc: 1,
		description: "initial schema",
		sql: `
      CREATE TABLE IF NOT EXISTS apps (
        id              TEXT PRIMARY KEY,
        slug            TEXT NOT NULL,
        description     TEXT NOT NULL,
        visibility      TEXT NOT NULL DEFAULT 'private',
        current_version INTEGER NOT NULL DEFAULT 1,
        last_updated    TEXT NOT NULL,
        created_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_apps_created_at ON apps(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_apps_last_updated ON apps(last_updated DESC);
    `,
	},
];

export class RegistryDO extends DurableObject {
	#migrations: SQLSchemaMigrations;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.#migrations = new SQLSchemaMigrations({ doStorage: ctx.storage, migrations: MIGRATIONS });
	}

	async #ensureSchema() {
		await this.#migrations.runAll();
	}

	async upsertApp(record: RegistryAppRecord): Promise<void> {
		await this.#ensureSchema();
		this.ctx.storage.sql.exec(
			`INSERT OR REPLACE INTO apps (id, slug, description, visibility, current_version, last_updated, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
			record.id,
			record.slug,
			record.description,
			record.visibility,
			record.current_version,
			record.last_updated,
			record.created_at,
		);
	}

	async listApps(): Promise<RegistryAppRecord[]> {
		await this.#ensureSchema();
		return this.ctx.storage.sql
			.exec<RegistryAppRecord>(
				"SELECT id, slug, description, visibility, current_version, last_updated, created_at FROM apps ORDER BY created_at DESC",
			)
			.toArray();
	}
}
