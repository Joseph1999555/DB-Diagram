import assert from "node:assert/strict";
import test from "node:test";

import { parseDBML } from "../lib/dbml.ts";
import {
  exportDrizzleSchema,
  exportJsonSchema,
  exportMySql,
  exportPostgresSql,
  exportPrismaSchema,
  exportSqliteSql,
} from "../lib/schema-export.ts";
import {
  detectSchemaFormat,
  filterSchemaDocument,
  mergeSchemaDocuments,
  parseSchemaImport,
} from "../lib/schema-import.ts";

function imported(source, format = "auto", fileName) {
  return parseSchemaImport(source, { format, fileName });
}

function qualifiedName(table) {
  return table.schema ? `${table.schema}.${table.name}` : table.name;
}

function findTable(document, name) {
  const normalized = name.toLocaleLowerCase("en-US");
  return document.tables.find(
    (table) => qualifiedName(table).toLocaleLowerCase("en-US") === normalized ||
      table.name.toLocaleLowerCase("en-US") === normalized,
  );
}

function requireTable(document, name) {
  const table = findTable(document, name);
  assert.ok(table, `expected table ${name}`);
  return table;
}

function requireField(table, name) {
  const field = table.fields.find(
    (candidate) => candidate.name.toLocaleLowerCase("en-US") === name.toLocaleLowerCase("en-US"),
  );
  assert.ok(field, `expected field ${qualifiedName(table)}.${name}`);
  return field;
}

function relationEndpointNames(document, relation) {
  const fromTable = document.tables.find((table) => table.id === relation.fromTableId);
  const toTable = document.tables.find((table) => table.id === relation.toTableId);
  const fromField = fromTable?.fields.find((field) => field.id === relation.fromFieldId);
  const toField = toTable?.fields.find((field) => field.id === relation.toFieldId);
  return [
    `${fromTable ? qualifiedName(fromTable) : relation.fromTable}.${fromField?.name ?? relation.fromField}`,
    `${toTable ? qualifiedName(toTable) : relation.toTable}.${toField?.name ?? relation.toField}`,
  ].map((value) => value.toLocaleLowerCase("en-US"));
}

function hasRelation(document, left, right) {
  const expected = new Set([
    left.toLocaleLowerCase("en-US"),
    right.toLocaleLowerCase("en-US"),
  ]);
  return document.relations.some((relation) => {
    const actual = new Set(relationEndpointNames(document, relation));
    return actual.size === expected.size && [...actual].every((endpoint) => expected.has(endpoint));
  });
}

function assertNoDanglingReferences(document) {
  const tables = new Map(document.tables.map((table) => [table.id, table]));
  for (const relation of document.relations) {
    const fromTable = tables.get(relation.fromTableId);
    const toTable = tables.get(relation.toTableId);
    assert.ok(fromTable, `relation ${relation.id} has a missing from table`);
    assert.ok(toTable, `relation ${relation.id} has a missing to table`);
    assert.ok(fromTable.fields.some((field) => field.id === relation.fromFieldId));
    assert.ok(toTable.fields.some((field) => field.id === relation.toFieldId));
  }
  for (const group of document.groups) {
    assert.ok(group.tableIds.every((tableId) => tables.has(tableId)));
  }
}

function errorDiagnostics(result) {
  return result.diagnostics.filter((diagnostic) => diagnostic.level === "error");
}

test("detects every supported format from content and uses specific extensions as hints", () => {
  const cases = [
    ["Table users { id int [pk] }", "schema.txt", "dbml"],
    ['CREATE TABLE "users" ("id" uuid PRIMARY KEY);', "schema.sql", "postgresql"],
    ["CREATE TABLE `users` (`id` bigint AUTO_INCREMENT PRIMARY KEY) ENGINE=InnoDB;", "schema.sql", "mysql"],
    ['PRAGMA foreign_keys = ON; CREATE TABLE "users" ("id" INTEGER PRIMARY KEY);', "schema.sql", "sqlite"],
    ["model User {\n  id Int @id\n}", "schema.txt", "prisma"],
    ['export const users = pgTable("users", { id: uuid("id").primaryKey() });', "schema.txt", "drizzle"],
    ['{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"id":{"type":"string"}}}', "schema.txt", "json-schema"],
    ['{"version":1,"project":{"name":"Demo","dbml":"Table users { id int [pk] }"}}', "schema.json", "relix"],
  ];

  for (const [source, fileName, expected] of cases) {
    assert.equal(detectSchemaFormat(source, fileName), expected, fileName);
    assert.equal(imported(source, "auto", fileName).format, expected, fileName);
  }

  assert.equal(detectSchemaFormat("model User { id Int @id }", "schema.prisma"), "prisma");
  assert.equal(detectSchemaFormat("Table users { id int [pk] }", "schema.dbml"), "dbml");
  assert.equal(
    detectSchemaFormat('{"project":{"dbml":"Table t { id int }"}}', "backup.relix.json"),
    "relix",
  );
  assert.equal(
    detectSchemaFormat('{"type":"object","properties":{}}', "database.schema.json"),
    "json-schema",
  );
});

test("imports DBML without changing its visual schema semantics", () => {
  const result = imported(`
Table auth.users [headercolor: #6C5CE7] {
  id uuid [pk]
  email varchar(255) [not null, unique, default: 'unknown@example.test']
}
Table profiles {
  id uuid [pk]
  user_id uuid [not null, ref: > auth.users.id]
}
TableGroup Identity { auth.users profiles }
`, "dbml", "identity.dbml");

  assert.equal(result.format, "dbml");
  assert.equal(errorDiagnostics(result).length, 0);
  const users = requireTable(result.document, "auth.users");
  assert.equal(users.color, "#6C5CE7");
  assert.equal(requireField(users, "email").unique, true);
  assert.ok(hasRelation(result.document, "profiles.user_id", "auth.users.id"));
  assert.equal(result.document.groups.length, 1);
});

test("imports PostgreSQL quoted schemas, defaults, unique keys, and composite constraints", () => {
  const result = imported(`
CREATE SCHEMA IF NOT EXISTS "tenant-space";
CREATE TABLE "tenant-space"."Parent Records" (
  "tenant_id" integer NOT NULL,
  "record_id" bigint GENERATED BY DEFAULT AS IDENTITY,
  "external_code" character varying(40) NOT NULL,
  "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "parent_pk" PRIMARY KEY ("tenant_id", "record_id"),
  CONSTRAINT "parent_code_unique" UNIQUE ("external_code")
);
CREATE TABLE "tenant-space"."Child Records" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" integer NOT NULL,
  "parent_record_id" bigint NOT NULL,
  CONSTRAINT "child_parent_fk" FOREIGN KEY ("tenant_id", "parent_record_id")
    REFERENCES "tenant-space"."Parent Records" ("tenant_id", "record_id") ON DELETE CASCADE
);
`, "postgresql", "tenant.postgres.sql");

  assert.equal(errorDiagnostics(result).length, 0);
  const parent = requireTable(result.document, "tenant-space.Parent Records");
  assert.deepEqual(
    parent.fields.filter((field) => field.primaryKey).map((field) => field.name),
    ["tenant_id", "record_id"],
  );
  assert.equal(requireField(parent, "external_code").unique, true);
  assert.match(requireField(parent, "created_at").default, /CURRENT_TIMESTAMP/i);
  assert.equal(requireField(parent, "record_id").increment, true);
  assert.ok(hasRelation(
    result.document,
    "tenant-space.Child Records.tenant_id",
    "tenant-space.Parent Records.tenant_id",
  ));
  assert.ok(hasRelation(
    result.document,
    "tenant-space.Child Records.parent_record_id",
    "tenant-space.Parent Records.record_id",
  ));
  assertNoDanglingReferences(result.document);
});

test("imports MySQL inline and table constraints with physical names intact", () => {
  const result = imported(`
CREATE TABLE \`accounts\` (
  \`id\` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  \`email\` VARCHAR(255) NOT NULL,
  \`status\` ENUM('active', 'disabled') NOT NULL DEFAULT 'active',
  UNIQUE KEY \`accounts_email_unique\` (\`email\`)
) ENGINE=InnoDB;
CREATE TABLE \`sessions\` (
  \`id\` CHAR(36) PRIMARY KEY,
  \`account_id\` BIGINT NOT NULL,
  CONSTRAINT \`sessions_account_fk\` FOREIGN KEY (\`account_id\`) REFERENCES \`accounts\` (\`id\`) ON DELETE CASCADE
) ENGINE=InnoDB;
`, "mysql", "auth.mysql.sql");

  assert.equal(errorDiagnostics(result).length, 0);
  const accounts = requireTable(result.document, "accounts");
  assert.equal(requireField(accounts, "id").primaryKey, true);
  assert.equal(requireField(accounts, "id").increment, true);
  assert.equal(requireField(accounts, "email").unique, true);
  assert.equal(requireField(accounts, "status").default, "'active'");
  assert.ok(hasRelation(result.document, "sessions.account_id", "accounts.id"));
});

test("imports SQLite table-level composite keys, foreign keys, arrays, and defaults", () => {
  const result = imported(`
PRAGMA foreign_keys = ON;
CREATE TABLE "parents" (
  "tenant_id" INTEGER NOT NULL,
  "id" INTEGER NOT NULL,
  "label" TEXT UNIQUE DEFAULT 'new',
  PRIMARY KEY ("tenant_id", "id")
);
CREATE TABLE "children" (
  "tenant_id" INTEGER NOT NULL,
  "parent_id" INTEGER NOT NULL,
  "tags" TEXT DEFAULT '[]',
  FOREIGN KEY ("tenant_id", "parent_id") REFERENCES "parents" ("tenant_id", "id")
);
`, "sqlite", "app.sqlite.sql");

  assert.equal(errorDiagnostics(result).length, 0);
  const parents = requireTable(result.document, "parents");
  assert.deepEqual(
    parents.fields.filter((field) => field.primaryKey).map((field) => field.name),
    ["tenant_id", "id"],
  );
  assert.equal(requireField(parents, "label").unique, true);
  assert.equal(requireField(parents, "label").default, "'new'");
  assert.ok(hasRelation(result.document, "children.tenant_id", "parents.tenant_id"));
  assert.ok(hasRelation(result.document, "children.parent_id", "parents.id"));
});

test("imports Prisma models, mapped names, enums, relations, and reports non-visual indexes", () => {
  const result = imported(`
enum Role {
  MEMBER
  ADMIN
}

model User {
  id      String   @id @default(uuid()) @db.Uuid
  email   String   @unique
  role    Role     @default(MEMBER)
  profile Profile?

  @@index([role], map: "users_role_idx")
  @@map("users")
}

model Profile {
  id     Int    @id @default(autoincrement())
  userId String @unique @map("user_id") @db.Uuid
  user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@map("profiles")
}
`, "prisma", "schema.prisma");

  assert.equal(errorDiagnostics(result).length, 0);
  const users = requireTable(result.document, "users");
  const profiles = requireTable(result.document, "profiles");
  assert.equal(requireField(users, "id").primaryKey, true);
  assert.equal(requireField(users, "email").unique, true);
  assert.equal(requireField(users, "role").type, "Role");
  assert.equal(requireField(profiles, "id").increment, true);
  assert.ok(hasRelation(result.document, "profiles.user_id", "users.id"));
  assert.ok(
    result.diagnostics.some((diagnostic) => /index/i.test(`${diagnostic.code} ${diagnostic.message}`)),
    "Prisma @@index must be acknowledged when the diagram cannot represent it",
  );
});

test("statically imports common Drizzle pg/mysql/sqlite declarations without executing source", () => {
  const marker = "__relixSchemaImportMustNotExecute";
  delete globalThis[marker];
  const sources = [
    ["postgresql", `
globalThis.${marker} = "executed";
export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: varchar("email", { length: 255 }).notNull().unique(),
});
export const posts = pgTable("posts", {
  id: serial("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
});
`],
    ["mysql", `
export const accounts = mysqlTable("accounts", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  email: varchar("email", { length: 255 }).notNull().unique(),
});
`],
    ["sqlite", `
export const notes = sqliteTable("notes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  body: text("body").notNull().default("draft"),
});
`],
  ];

  for (const [dialect, source] of sources) {
    const result = imported(source, "drizzle", `${dialect}.schema.ts`);
    assert.equal(errorDiagnostics(result).length, 0, dialect);
    assert.ok(result.document.tables.length > 0, dialect);
  }
  assert.equal(globalThis[marker], undefined, "Drizzle import must never evaluate TypeScript");

  const postgres = imported(sources[0][1], "drizzle", "pg.schema.ts").document;
  assert.equal(requireField(requireTable(postgres, "users"), "email").unique, true);
  assert.ok(hasRelation(postgres, "posts.user_id", "users.id"));
  const mysql = imported(sources[1][1], "drizzle", "mysql.schema.ts").document;
  assert.equal(requireField(requireTable(mysql, "accounts"), "id").increment, true);
  const sqlite = imported(sources[2][1], "drizzle", "sqlite.schema.ts").document;
  assert.equal(requireField(requireTable(sqlite, "notes"), "id").primaryKey, true);
  assert.equal(requireField(requireTable(sqlite, "notes"), "id").increment, true);
  assert.equal(requireField(requireTable(sqlite, "notes"), "body").notNull, true);
});

test("imports JSON Schema root objects, $defs, legacy definitions, required arrays, and $ref-backed tables", () => {
  const source = JSON.stringify({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Store",
    type: "object",
    properties: {
      users: { type: "array", items: { $ref: "#/$defs/users" } },
      teams: { type: "array", items: { $ref: "#/$defs/teams" } },
      audit: { type: "array", items: { $ref: "#/definitions/audit" } },
    },
    $defs: {
      users: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid", "x-primary-key": true },
          team_id: {
            type: "string",
            format: "uuid",
            "x-foreign-key": [{ table: "teams", field: "id", cardinality: "many-to-one" }],
          },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["id", "team_id"],
        "x-primary-key": ["id"],
      },
      teams: {
        type: "object",
        properties: { id: { type: "string", format: "uuid", "x-primary-key": true } },
        required: ["id"],
      },
    },
    definitions: {
      audit: {
        type: "object",
        properties: { id: { type: "integer" }, payload: { type: "object" } },
        required: ["id"],
      },
    },
    "x-relations": [{
      childTable: "users",
      childField: "team_id",
      parentTable: "teams",
      parentField: "id",
      cardinality: "many-to-one",
    }],
  });
  const result = imported(source, "json-schema", "store.schema.json");

  assert.equal(errorDiagnostics(result).length, 0);
  assert.deepEqual(
    result.document.tables.map((table) => table.name).sort(),
    ["audit", "teams", "users"],
  );
  const users = requireTable(result.document, "users");
  assert.equal(requireField(users, "id").primaryKey, true);
  assert.equal(requireField(users, "team_id").notNull, true);
  assert.match(requireField(users, "tags").type, /\[\]|array/i);
  assert.ok(hasRelation(result.document, "users.team_id", "teams.id"));

  const root = imported(JSON.stringify({
    title: "customer",
    type: "object",
    properties: { id: { type: "integer" }, name: { type: "string" } },
    required: ["id"],
  }), "json-schema").document;
  assert.ok(findTable(root, "customer"));
});

test("restores Relix project name and layout from project and legacy snapshots", () => {
  const schema = "Table users { id uuid [pk] }";
  const parsed = parseDBML(schema);
  const tableId = parsed.tables[0].id;
  const layout = { [tableId]: { x: 120, y: 240 } };
  const projectResult = imported(JSON.stringify({
    version: 1,
    project: { name: "Northstar", dbml: schema, layout },
  }), "relix", "northstar.relix.json");

  assert.equal(projectResult.name, "Northstar");
  assert.deepEqual(projectResult.layout, layout);
  assert.equal(requireTable(projectResult.document, "users").name, "users");

  const legacyResult = imported(JSON.stringify({ dbml: schema, layout }), "relix");
  assert.deepEqual(legacyResult.layout, layout);
  assert.equal(legacyResult.document.tables.length, 1);
});

test("malformed, empty, and partially valid sources fail readably or preserve valid tables", () => {
  for (const [source, format, message] of [
    ["", "dbml", /paste|non-empty/i],
    ["{ definitely not valid JSON", "json-schema", /JSON|table|schema/i],
    ["model Broken {", "prisma", /model|table|schema/i],
    ["export const nope = pgTable(", "drizzle", /table|Drizzle|schema/i],
  ]) {
    assert.throws(
      () => imported(source, format),
      message,
      `${format} must explain unusable input`,
    );
  }

  const partial = imported(`
CREATE TABLE valid_table (id integer PRIMARY KEY);
CREATE TABLE broken_table (
`, "postgresql");
  assert.ok(findTable(partial.document, "valid_table"));
  assert.ok(partial.diagnostics.length > 0);
});

test("imports and ids are deterministic and helpers never mutate caller-owned documents", () => {
  const source = `
Table users {
  id int [pk]
}
Table posts {
  id int [pk]
  user_id int
}
Ref: posts.user_id > users.id
`;
  const first = imported(source, "dbml");
  const second = imported(source, "dbml");
  assert.deepEqual(second, first);

  const before = JSON.stringify(first.document);
  filterSchemaDocument(first.document, [first.document.tables[0].id]);
  assert.equal(JSON.stringify(first.document), before);

  const incoming = parseDBML("Table tags { id int [pk] }");
  const incomingBefore = JSON.stringify(incoming);
  mergeSchemaDocuments(first.document, incoming, "update");
  assert.equal(JSON.stringify(first.document), before);
  assert.equal(JSON.stringify(incoming), incomingBefore);
});

test("table filtering keeps only the selected relational and group closure", () => {
  const document = parseDBML(`
Table users {
  id int [pk]
}
Table posts {
  id int [pk]
  user_id int
}
Table comments {
  id int [pk]
  post_id int
}
Ref: posts.user_id > users.id
Ref: comments.post_id > posts.id
TableGroup Content { users posts comments }
`);
  const users = requireTable(document, "users");
  const posts = requireTable(document, "posts");
  const before = JSON.stringify(document);
  const filtered = filterSchemaDocument(document, [users.id, posts.id]);

  assert.deepEqual(filtered.tables.map((table) => table.name), ["users", "posts"]);
  assert.equal(filtered.relations.length, 1);
  assert.ok(hasRelation(filtered, "posts.user_id", "users.id"));
  assert.deepEqual(filtered.groups[0].tableIds, [users.id, posts.id]);
  assertNoDanglingReferences(filtered);
  assert.equal(JSON.stringify(document), before);
});

test("merge Update replaces conflicts while preserving current and imported relationship integrity", () => {
  const current = parseDBML(`
Table users {
  id int [pk]
  old_name varchar
}
Table orders {
  id int [pk]
  user_id int
}
Ref: orders.user_id > users.id
`);
  const incoming = parseDBML(`
Table users {
  id int [pk]
  email varchar [unique]
}
Table profiles {
  id int [pk]
  user_id int
}
Ref: profiles.user_id > users.id
`);
  const mergeResult = mergeSchemaDocuments(current, incoming, "update");
  const merged = mergeResult.document;

  assert.equal(mergeResult.conflicts.length, 1);
  assert.equal(mergeResult.updatedTableIds.length, 1);
  assert.equal(mergeResult.skippedTableIds.length, 0);
  assert.equal(merged.tables.filter((table) => table.name === "users").length, 1);
  const users = requireTable(merged, "users");
  assert.ok(requireField(users, "email"));
  assert.equal(users.fields.some((field) => field.name === "old_name"), false);
  assert.ok(hasRelation(merged, "orders.user_id", "users.id"));
  assert.ok(hasRelation(merged, "profiles.user_id", "users.id"));
  assertNoDanglingReferences(merged);
});

test("merge Rename keeps both conflicts and rewrites imported relation endpoints deterministically", () => {
  const current = parseDBML(`
Table users {
  id int [pk]
  old_name varchar
}
Table orders {
  id int [pk]
  user_id int
}
Ref: orders.user_id > users.id
`);
  const incoming = parseDBML(`
Table users {
  id int [pk]
  email varchar
}
Table profiles {
  id int [pk]
  user_id int
}
Ref: profiles.user_id > users.id
`);
  const firstResult = mergeSchemaDocuments(current, incoming, "rename");
  const secondResult = mergeSchemaDocuments(current, incoming, "rename");
  const first = firstResult.document;
  const second = secondResult.document;
  assert.deepEqual(second, first);

  assert.equal(firstResult.conflicts.length, 1);
  assert.equal(firstResult.renamedTables.length, 1);
  const original = first.tables.find((table) => table.fields.some((field) => field.name === "old_name"));
  const renamed = first.tables.find((table) => table.fields.some((field) => field.name === "email"));
  assert.ok(original);
  assert.ok(renamed);
  assert.notEqual(original.id, renamed.id);
  assert.notEqual(qualifiedName(original), qualifiedName(renamed));
  const profileRelation = first.relations.find((relation) =>
    relationEndpointNames(first, relation).some((endpoint) => endpoint.endsWith("profiles.user_id")),
  );
  assert.ok(profileRelation);
  assert.ok([profileRelation.fromTableId, profileRelation.toTableId].includes(renamed.id));
  assertNoDanglingReferences(first);
});

test("merge Skip reuses current conflicts and preserves imported relations to them", () => {
  const current = parseDBML(`
Table users {
  id int [pk]
  old_name varchar
}
`);
  const incoming = parseDBML(`
Table users {
  id int [pk]
  email varchar
}
Table profiles {
  id int [pk]
  user_id int
}
Ref: profiles.user_id > users.id
`);
  const mergeResult = mergeSchemaDocuments(current, incoming, "skip");
  const merged = mergeResult.document;

  assert.equal(mergeResult.conflicts.length, 1);
  assert.equal(mergeResult.skippedTableIds.length, 1);
  assert.equal(merged.tables.filter((table) => table.name === "users").length, 1);
  const users = requireTable(merged, "users");
  assert.ok(users.fields.some((field) => field.name === "old_name"));
  assert.equal(users.fields.some((field) => field.name === "email"), false);
  assert.ok(findTable(merged, "profiles"));
  assert.ok(hasRelation(merged, "profiles.user_id", "users.id"));
  assertNoDanglingReferences(merged);
});

test("every generated schema format round-trips back into the same diagram essentials", () => {
  const original = parseDBML(`
Table users {
  id int [pk, increment]
  email varchar(160) [not null, unique]
}
Table posts {
  id int [pk, increment]
  user_id int [not null]
  title varchar(240) [not null, default: 'Untitled']
}
Ref: posts.user_id > users.id [delete: cascade]
`);
  const exporters = [
    ["postgresql", exportPostgresSql],
    ["mysql", exportMySql],
    ["sqlite", exportSqliteSql],
    ["prisma", exportPrismaSchema],
    ["drizzle", exportDrizzleSchema],
    ["json-schema", exportJsonSchema],
  ];

  for (const [format, exporter] of exporters) {
    const result = imported(exporter(original), format, `roundtrip.${format}`);
    assert.equal(errorDiagnostics(result).length, 0, `${format} emitted import errors`);
    assert.equal(result.document.tables.length, 2, `${format} table count`);
    const users = requireTable(result.document, "users");
    const posts = requireTable(result.document, "posts");
    assert.equal(requireField(users, "id").primaryKey, true, `${format} users.id PK`);
    assert.equal(requireField(users, "email").unique, true, `${format} users.email unique`);
    assert.equal(requireField(posts, "title").notNull, true, `${format} posts.title required`);
    assert.ok(hasRelation(result.document, "posts.user_id", "users.id"), `${format} foreign key`);
    assertNoDanglingReferences(result.document);
  }
});
