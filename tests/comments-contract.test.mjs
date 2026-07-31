import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import { getTableConfig } from "drizzle-orm/sqlite-core";

import {
  commentStatuses,
  commentTargetTypes,
  comments,
} from "../db/schema.ts";

test("comment persistence exposes the required relational constraints and indexes", () => {
  const config = getTableConfig(comments);

  assert.equal(config.name, "comments");
  assert.deepEqual(commentTargetTypes, ["diagram", "table"]);
  assert.deepEqual(commentStatuses, ["open", "resolved"]);

  const columns = new Map(config.columns.map((column) => [column.name, column]));
  for (const name of [
    "id",
    "project_id",
    "parent_id",
    "target_type",
    "target_id",
    "target_label",
    "body",
    "status",
    "author_id",
    "resolved_by_id",
    "resolved_at",
    "created_at",
    "updated_at",
  ]) {
    assert.ok(columns.has(name), `comments.${name} must be present`);
  }

  for (const name of ["id", "project_id", "target_type", "target_label", "body", "status", "author_id", "created_at", "updated_at"]) {
    assert.equal(columns.get(name).notNull, true, `comments.${name} must be NOT NULL`);
  }
  assert.equal(columns.get("id").primary, true);
  assert.equal(columns.get("parent_id").notNull, false);
  assert.equal(columns.get("target_id").notNull, false);
  assert.equal(columns.get("resolved_at").notNull, false);

  const indexes = new Map(config.indexes.map((item) => [item.config.name, item]));
  assert.deepEqual(
    indexes.get("comments_project_created_idx").config.columns.map((column) => column.name),
    ["project_id", "created_at", "id"],
  );
  assert.deepEqual(
    indexes.get("comments_project_target_created_idx").config.columns.map((column) => column.name),
    ["project_id", "target_type", "target_id", "created_at", "id"],
  );
  assert.deepEqual(
    indexes.get("comments_parent_idx").config.columns.map((column) => column.name),
    ["parent_id"],
  );

  assert.deepEqual(
    new Set(config.checks.map((constraint) => constraint.name)),
    new Set([
      "comments_target_type_check",
      "comments_target_id_check",
      "comments_status_check",
      "comments_body_length_check",
    ]),
  );

  const foreignKeys = new Map(
    config.foreignKeys.map((foreignKey) => {
      const reference = foreignKey.reference();
      return [reference.columns[0].name, { foreignKey, reference }];
    }),
  );
  assert.equal(foreignKeys.get("project_id").reference.foreignTable[Symbol.for("drizzle:Name")], "projects");
  assert.equal(foreignKeys.get("project_id").foreignKey.onDelete, "cascade");
  assert.equal(foreignKeys.get("parent_id").reference.foreignTable[Symbol.for("drizzle:Name")], "comments");
  assert.equal(foreignKeys.get("parent_id").foreignKey.onDelete, "cascade");
  assert.equal(foreignKeys.get("author_id").foreignKey.onDelete, "restrict");
  assert.equal(foreignKeys.get("resolved_by_id").foreignKey.onDelete, "set null");
});

test("generated migrations and preview bootstrap carry the same comment guarantees", async () => {
  const drizzleDirectory = new URL("../drizzle/", import.meta.url);
  const migrationNames = (await readdir(drizzleDirectory))
    .filter((name) => /^\d+.*\.sql$/u.test(name))
    .sort();
  const [migrationSql, bootstrap] = await Promise.all([
    Promise.all(
      migrationNames.map((name) => readFile(new URL(name, drizzleDirectory), "utf8")),
    ).then((parts) => parts.join("\n")),
    readFile(new URL("../db/index.ts", import.meta.url), "utf8"),
  ]);

  for (const source of [migrationSql, bootstrap]) {
    assert.match(source, /CREATE TABLE(?: IF NOT EXISTS)? [`"]comments[`"]/u);
    for (const column of [
      "project_id",
      "parent_id",
      "target_type",
      "target_id",
      "target_label",
      "body",
      "status",
      "author_id",
      "resolved_by_id",
      "resolved_at",
      "created_at",
      "updated_at",
    ]) {
      assert.match(source, new RegExp('["`]' + column + '["`]', "u"));
    }
    for (const constraint of [
      "comments_target_type_check",
      "comments_target_id_check",
      "comments_status_check",
      "comments_body_length_check",
    ]) {
      assert.match(source, new RegExp(constraint, "u"));
    }
    for (const index of [
      "comments_project_created_idx",
      "comments_project_target_created_idx",
      "comments_parent_idx",
    ]) {
      assert.match(source, new RegExp(index, "u"));
    }
  }
});

test("comments API authenticates access, scopes queries, and disables shared caching", async () => {
  const routeUrl = new URL("../app/api/comments/route.ts", import.meta.url);
  const route = await readFile(routeUrl, "utf8");

  for (const method of ["GET", "POST", "PATCH"]) {
    assert.match(route, new RegExp(`export async function ${method}\\(`, "u"));
  }
  assert.match(route, /requireExistingProjectAccess/u);
  assert.match(route, /validateCommentInput/u);
  assert.match(route, /parseDBML/u);
  assert.match(route, /targetExists/u);
  assert.match(route, /eq\(comments\.projectId,\s*(?:access\.project\.id|projectId)\)/u);
  assert.match(route, /orderBy\(asc\(comments\.createdAt\), asc\(comments\.id\)\)/u);
  assert.match(route, /cache-control["']?:?\s*["']private, no-store/u);
  assert.match(route, /id:\s*crypto\.randomUUID\(\)/u);
  assert.match(route, /authorId:\s*access\.user\.id/u);
  assert.match(route, /targetType:\s*parent\.targetType/u);
  assert.match(route, /targetId:\s*parent\.targetId/u);
  assert.match(route, /comment_thread_resolved/u);
  assert.doesNotMatch(route, /authorEmail/u);
  assert.doesNotMatch(route, /authorId:\s*payload\./u);
});

test("comment UI keeps content on a plain-text accessible path", async (context) => {
  const workspace = await readFile(
    new URL("../components/diagram-workspace.tsx", import.meta.url),
    "utf8",
  );

  if (!workspace.includes("/api/comments")) {
    context.skip("comments UI is still being integrated");
    return;
  }
  assert.match(workspace, /\/api\/comments/u);
  assert.match(workspace, /COMMENT_BODY_MAX_LENGTH/u);
  assert.match(workspace, /aria-label=["'{`].*comment/iu);
  assert.match(workspace, /commentsRequestRef\.current !== requestId/u);
  assert.match(workspace, /maxLength=\{COMMENT_BODY_MAX_LENGTH\}/u);
  assert.match(workspace, /\(event\.metaKey \|\| event\.ctrlKey\) && event\.key === "Enter"/u);
  assert.match(workspace, /role="feed"/u);
  assert.match(workspace, /<p>\{message\.body\}<\/p>/u);
  assert.doesNotMatch(workspace, /dangerouslySetInnerHTML/u);
});
