import { sql } from "drizzle-orm";
import {
  check,
  index,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const projectRoles = ["owner", "editor", "viewer"] as const;
export type ProjectRole = (typeof projectRoles)[number];

const isoTimestamp = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    createdAt: text("created_at").notNull().default(isoTimestamp),
    updatedAt: text("updated_at").notNull().default(isoTimestamp),
  },
  (table) => [uniqueIndex("users_email_unique").on(table.email)],
);

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    dbml: text("dbml").notNull(),
    layout: text("layout").notNull().default("{}"),
    version: text("version").notNull().default("1"),
    createdById: text("created_by_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    updatedById: text("updated_by_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: text("created_at").notNull().default(isoTimestamp),
    updatedAt: text("updated_at").notNull().default(isoTimestamp),
  },
  (table) => [index("projects_created_by_idx").on(table.createdById)],
);

export const projectMembers = sqliteTable(
  "project_members",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: projectRoles }).notNull(),
    createdAt: text("created_at").notNull().default(isoTimestamp),
    updatedAt: text("updated_at").notNull().default(isoTimestamp),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.userId] }),
    index("project_members_user_idx").on(table.userId),
    check(
      "project_members_role_check",
      sql`${table.role} in ('owner', 'editor', 'viewer')`,
    ),
  ],
);
