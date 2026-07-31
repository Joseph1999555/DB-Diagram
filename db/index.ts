import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export function getD1() {
  const bindings = env as unknown as { DB?: D1Database };
  if (!bindings.DB) {
    throw new Error(
      "Cloudflare D1 binding `DB` is unavailable. Set the `d1` field in .openai/hosting.json to `DB` or let your control plane inject the real binding values before using the database."
    );
  }

  return bindings.DB;
}

export function getDb() {
  return drizzle(getD1(), { schema });
}

let storageReady: Promise<void> | null = null;

/**
 * Keeps a fresh local preview usable before migrations have been applied.
 * Hosted environments still use the checked-in Drizzle migration as the
 * canonical schema; every statement here is idempotent and mirrors it.
 */
export function ensureProjectStorage() {
  if (storageReady) return storageReady;

  const d1 = getD1();
  storageReady = d1
    .batch([
      d1.prepare(`CREATE TABLE IF NOT EXISTS "users" (
        "id" text PRIMARY KEY NOT NULL,
        "email" text NOT NULL,
        "display_name" text NOT NULL,
        "created_at" text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
        "updated_at" text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
      )`),
      d1.prepare(
        `CREATE UNIQUE INDEX IF NOT EXISTS "users_email_unique" ON "users" ("email")`,
      ),
      d1.prepare(`CREATE TABLE IF NOT EXISTS "projects" (
        "id" text PRIMARY KEY NOT NULL,
        "name" text NOT NULL,
        "dbml" text NOT NULL,
        "layout" text DEFAULT '{}' NOT NULL,
        "version" text DEFAULT '1' NOT NULL,
        "created_by_id" text NOT NULL,
        "updated_by_id" text NOT NULL,
        "created_at" text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
        "updated_at" text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
        FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON UPDATE no action ON DELETE restrict,
        FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON UPDATE no action ON DELETE restrict
      )`),
      d1.prepare(
        `CREATE INDEX IF NOT EXISTS "projects_created_by_idx" ON "projects" ("created_by_id")`,
      ),
      d1.prepare(`CREATE TABLE IF NOT EXISTS "project_members" (
        "project_id" text NOT NULL,
        "user_id" text NOT NULL,
        "role" text NOT NULL,
        "created_at" text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
        "updated_at" text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
        PRIMARY KEY("project_id", "user_id"),
        FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON UPDATE no action ON DELETE cascade,
        FOREIGN KEY ("user_id") REFERENCES "users"("id") ON UPDATE no action ON DELETE cascade,
        CONSTRAINT "project_members_role_check" CHECK("role" in ('owner', 'editor', 'viewer'))
      )`),
      d1.prepare(
        `CREATE INDEX IF NOT EXISTS "project_members_user_idx" ON "project_members" ("user_id")`,
      ),
    ])
    .then(() => undefined)
    .catch((error: unknown) => {
      storageReady = null;
      throw error;
    });

  return storageReady;
}
