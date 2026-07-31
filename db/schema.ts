import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  index,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const projectRoles = ["owner", "editor", "viewer"] as const;
export type ProjectRole = (typeof projectRoles)[number];
export const commentTargetTypes = ["diagram", "table"] as const;
export type CommentTargetType = (typeof commentTargetTypes)[number];
export const commentStatuses = ["open", "resolved"] as const;
export type CommentStatus = (typeof commentStatuses)[number];

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

export const comments = sqliteTable(
  "comments",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    parentId: text("parent_id").references(
      (): AnySQLiteColumn => comments.id,
      { onDelete: "cascade" },
    ),
    targetType: text("target_type", { enum: commentTargetTypes }).notNull(),
    targetId: text("target_id"),
    targetLabel: text("target_label").notNull(),
    body: text("body").notNull(),
    status: text("status", { enum: commentStatuses }).notNull().default("open"),
    authorId: text("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    resolvedById: text("resolved_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    resolvedAt: text("resolved_at"),
    createdAt: text("created_at").notNull().default(isoTimestamp),
    updatedAt: text("updated_at").notNull().default(isoTimestamp),
  },
  (table) => [
    index("comments_project_created_idx").on(
      table.projectId,
      table.createdAt,
      table.id,
    ),
    index("comments_project_target_created_idx").on(
      table.projectId,
      table.targetType,
      table.targetId,
      table.createdAt,
      table.id,
    ),
    index("comments_parent_idx").on(table.parentId),
    check(
      "comments_target_type_check",
      sql`${table.targetType} in ('diagram', 'table')`,
    ),
    check(
      "comments_target_id_check",
      sql`((${table.targetType} = 'diagram' and ${table.targetId} is null) or (${table.targetType} = 'table' and ${table.targetId} is not null))`,
    ),
    check(
      "comments_status_check",
      sql`${table.status} in ('open', 'resolved')`,
    ),
    check(
      "comments_body_length_check",
      sql`length(trim(${table.body})) between 1 and 2000`,
    ),
  ],
);
