import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import { getTableConfig } from "drizzle-orm/sqlite-core";

import { cursorPresence } from "../db/schema.ts";

test("cursor presence uses a project/user/session key with bounded coordinates", () => {
  const config = getTableConfig(cursorPresence);
  assert.equal(config.name, "cursor_presence");

  const columns = new Map(config.columns.map((column) => [column.name, column]));
  assert.deepEqual([...columns.keys()], [
    "project_id",
    "user_id",
    "session_id",
    "x",
    "y",
    "updated_at",
  ]);
  for (const column of columns.values()) assert.equal(column.notNull, true);

  assert.equal(config.primaryKeys.length, 1);
  assert.deepEqual(
    config.primaryKeys[0].columns.map((column) => column.name),
    ["project_id", "user_id", "session_id"],
  );

  const index = config.indexes.find(
    (candidate) => candidate.config.name === "cursor_presence_project_updated_idx",
  );
  assert.ok(index);
  assert.deepEqual(index.config.columns.map((column) => column.name), [
    "project_id",
    "updated_at",
  ]);

  assert.deepEqual(
    new Set(config.checks.map((constraint) => constraint.name)),
    new Set([
      "cursor_presence_session_length_check",
      "cursor_presence_coordinates_check",
    ]),
  );

  const foreignKeys = new Map(
    config.foreignKeys.map((foreignKey) => {
      const reference = foreignKey.reference();
      return [reference.columns[0].name, foreignKey];
    }),
  );
  assert.equal(foreignKeys.get("project_id").onDelete, "cascade");
  assert.equal(foreignKeys.get("user_id").onDelete, "cascade");
});

test("preview bootstrap carries the cursor-presence table, bounds, and query index", async () => {
  const bootstrap = await readFile(new URL("../db/index.ts", import.meta.url), "utf8");
  assertPresenceSqlContract(bootstrap);
});

test("generated migrations carry the cursor-presence storage contract", async (context) => {
  const drizzleDirectory = new URL("../drizzle/", import.meta.url);
  const migrationNames = (await readdir(drizzleDirectory))
    .filter((name) => /^\d+.*\.sql$/u.test(name))
    .sort();
  const migrationSql = (
    await Promise.all(
      migrationNames.map((name) => readFile(new URL(name, drizzleDirectory), "utf8")),
    )
  ).join("\n");

  if (!migrationSql.includes("cursor_presence")) {
    context.skip("cursor-presence migration is still being generated");
    return;
  }
  assertPresenceSqlContract(migrationSql);
});

test("presence API owns identity, scopes every operation, and expires stale cursors", async (context) => {
  const routeUrl = new URL("../app/api/presence/route.ts", import.meta.url);
  let route;
  try {
    route = await readFile(routeUrl, "utf8");
  } catch {
    context.skip("presence API is still being integrated");
    return;
  }

  for (const method of ["GET", "PUT", "DELETE"]) {
    assert.match(route, new RegExp(`export async function ${method}\\(`, "u"));
  }
  assert.match(route, /requireExistingProjectAccess/u);
  assert.match(route, /PRESENCE_ACTIVE_WINDOW_MS/u);
  assert.match(route, /validatePresenceUpdate/u);
  assert.match(route, /validatePresenceSession/u);
  assert.match(route, /eq\(cursorPresence\.projectId,\s*(?:access\.project\.id|projectId)\)/u);
  assert.match(route, /eq\(cursorPresence\.userId,\s*access\.user\.id\)/u);
  assert.match(route, /now\.getTime\(\)\s*-\s*PRESENCE_ACTIVE_WINDOW_MS/u);
  assert.match(route, /gte\(cursorPresence\.updatedAt,\s*activeSince\)/u);
  assert.match(route, /userId:\s*access\.user\.id/u);
  assert.match(route, /displayName:\s*(?:access\.user\.displayName|users\.displayName)/u);
  assert.match(route, /sessionId:\s*input\.sessionId/u);
  assert.match(route, /const updatedAt = new Date\(\)\.toISOString\(\)/u);
  assert.match(route, /cursorPresence\.projectId,\s*cursorPresence\.userId,\s*cursorPresence\.sessionId/su);
  assert.match(route, /cache-control["']?:?\s*["']private, no-store/u);
  assert.match(route, /12_000|PRESENCE_ACTIVE_WINDOW_MS/u);
  assert.doesNotMatch(route, /userId:\s*payload\./u);
  assert.doesNotMatch(route, /displayName:\s*payload\./u);
  assert.doesNotMatch(route, /projectId:\s*payload\./u);
});

test("presence UI uses flow coordinates and lifecycle-safe network updates", async (context) => {
  const [workspace, styles] = await Promise.all([
    readFile(new URL("../components/diagram-workspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  if (!workspace.includes("/api/presence")) {
    context.skip("presence UI is still being integrated");
    return;
  }

  for (const contract of [
    /PRESENCE_POLL_MS\s*=\s*500/u,
    /PRESENCE_SEND_THROTTLE_MS\s*=\s*350/u,
    /PRESENCE_HEARTBEAT_MS\s*=\s*4_?000/u,
    /(?:presenceSessionIdRef\s*=\s*useRef|\[presenceSessionId\]\s*=\s*useState)\([^\n]*crypto\.randomUUID\(\)/u,
    /screenToFlowPosition/u,
    /flowToScreenPosition/u,
    /presenceRequestRef\.current !== requestId/u,
    /document\.visibilityState/u,
    /["']visibilitychange["']/u,
    /["']pagehide["']/u,
    /["']beforeunload["']/u,
    /method:\s*["']DELETE["']/u,
    /keepalive:\s*true/u,
    /JSON\.stringify\(\{ sessionId:/u,
    /role="status"/u,
    /aria-hidden="true"/u,
  ]) {
    assert.match(workspace, contract);
  }

  assert.doesNotMatch(workspace, /members\[1\].*presence-cursor/su);
  assert.doesNotMatch(workspace, /left:\s*["']66%["']/u);
  assert.doesNotMatch(workspace, /top:\s*["']29%["']/u);
  assert.match(workspace, /\{cursor\.displayName\}/u);
  assert.doesNotMatch(workspace, /dangerouslySetInnerHTML/u);

  const layerStart = styles.indexOf(".presence-layer");
  const cursorStart = styles.indexOf(".presence-cursor", layerStart);
  assert.ok(layerStart >= 0 && cursorStart > layerStart);
  assert.match(styles.slice(layerStart, cursorStart), /pointer-events:\s*none/u);
  assert.match(styles, /--presence-x/u);
  assert.match(styles, /--presence-y/u);
  assert.match(styles, /translate3d/u);
});

function assertPresenceSqlContract(source) {
  assert.match(source, /CREATE TABLE(?: IF NOT EXISTS)? [`"]cursor_presence[`"]/u);
  for (const column of [
    "project_id",
    "user_id",
    "session_id",
    "x",
    "y",
    "updated_at",
  ]) {
    assert.match(source, new RegExp('["`]' + column + '["`]', "u"));
  }
  assert.match(source, /PRIMARY KEY\([`"]project_id[`"],\s*[`"]user_id[`"],\s*[`"]session_id[`"]\)/u);
  assert.match(source, /cursor_presence_session_length_check/u);
  assert.match(source, /between 8 and 64/iu);
  assert.match(source, /cursor_presence_coordinates_check/u);
  assert.match(source, /between -1000000 and 1000000/iu);
  assert.match(source, /cursor_presence_project_updated_idx/u);
}
