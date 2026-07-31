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

const document = parseDBML(`
Table auth.users {
  tenant_id uuid [pk]
  id int [pk, increment]
  email varchar(120) [not null, unique]
  enabled boolean [not null, default: true]
  created_at timestamp [not null, default: \`now()\`]
}

Table profiles {
  id uuid [pk]
  user_id int [not null, unique]
  nickname varchar
}

Table audit_log {
  message text [not null]
}

Ref: profiles.user_id < auth.users.id [delete: cascade]
`);

test("exports PostgreSQL with schemas, composite keys, defaults, and normalized FK direction", () => {
  const output = exportPostgresSql(document);
  assert.match(output, /CREATE SCHEMA IF NOT EXISTS "auth"/);
  assert.match(output, /CREATE TABLE "auth"\."users"/);
  assert.match(output, /PRIMARY KEY \("tenant_id", "id"\)/);
  assert.doesNotMatch(output, /`now\(\)`/);
  assert.match(output, /DEFAULT CURRENT_TIMESTAMP/);
  assert.match(output, /ALTER TABLE "auth"\."users"[\s\S]+FOREIGN KEY \("id"\)[\s\S]+REFERENCES "profiles" \("user_id"\)/);
});

test("exports MySQL types and constraints", () => {
  const output = exportMySql(document);
  assert.match(output, /`tenant_id` CHAR\(36\)/);
  assert.match(output, /`email` VARCHAR\(120\)/);
  assert.match(output, /ENGINE=InnoDB/);
  assert.match(output, /ON DELETE CASCADE/);
});

test("exports SQLite with inline foreign keys and flattened schemas", () => {
  const output = exportSqliteSql(document);
  assert.match(output, /PRAGMA foreign_keys = ON/);
  assert.match(output, /CREATE TABLE "auth__users"/);
  assert.match(output, /FOREIGN KEY \("id"\) REFERENCES "profiles" \("user_id"\)/);
  assert.doesNotMatch(output, /ALTER TABLE/);
});

test("exports Prisma models while safely ignoring tables without a unique identity", () => {
  const output = exportPrismaSchema(document);
  assert.match(output, /datasource db/);
  assert.match(output, /model Users/);
  assert.match(output, /@@id\(\[tenantId, id\]\)/);
  assert.match(output, /@db\.Uuid/);
  assert.match(output, /@default\(now\(\)\)/);
  assert.match(output, /model AuditLog[\s\S]+@@ignore/);
});

test("exports Drizzle TypeScript with physical names and typed references", () => {
  const output = exportDrizzleSchema(document);
  assert.match(output, /from "drizzle-orm\/pg-core"/);
  assert.match(output, /pgSchema\("auth"\)/);
  assert.match(output, /primaryKey\(\{ columns: \[table\.tenantId, table\.id\] \}\)/);
  assert.match(output, /references\(\(\): AnyPgColumn => profiles\.userId/);
  assert.doesNotMatch(output, /`now\(\)`/);
});

test("exports JSON Schema 2020-12 with database annotations", () => {
  const output = JSON.parse(exportJsonSchema(document));
  assert.equal(output.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.ok(output.$defs["auth.users"]);
  assert.deepEqual(output.$defs["auth.users"]["x-primary-key"], ["tenant_id", "id"]);
  assert.equal(output.$defs["auth.users"].properties.tenant_id.format, "uuid");
  assert.equal(output.$defs["auth.users"].properties.created_at["x-db-default"], "now()");
  assert.equal(output["x-relations"][0].childTable, "auth.users");
});

test("marks many-to-many relations instead of emitting a false direct foreign key", () => {
  const many = parseDBML(`
Table authors { id uuid [pk] }
Table books { id uuid [pk] }
Ref: authors.id <> books.id
`);
  assert.match(exportPostgresSql(many), /conceptual many-to-many/);
  assert.doesNotMatch(exportPostgresSql(many), /ADD CONSTRAINT/);
});

test("normalizes all physical DBML relation directions", () => {
  const relations = parseDBML(`
Table parents {
  id uuid [pk]
}
Table greater_child {
  id uuid [pk]
  parent_id uuid
}
Table less_child {
  id uuid [pk]
  parent_id uuid
}
Table dash_child {
  id uuid [pk]
  parent_id uuid
}
Table inline_child {
  id uuid [pk]
  parent_id uuid [ref: - parents.id]
}
Ref: greater_child.parent_id > parents.id
Ref: parents.id < less_child.parent_id
Ref: parents.id - dash_child.parent_id
`);
  const output = exportPostgresSql(relations);
  assert.match(output, /ALTER TABLE "greater_child"[\s\S]+FOREIGN KEY \("parent_id"\)[\s\S]+REFERENCES "parents"/);
  assert.match(output, /ALTER TABLE "less_child"[\s\S]+FOREIGN KEY \("parent_id"\)[\s\S]+REFERENCES "parents"/);
  assert.match(output, /ALTER TABLE "dash_child"[\s\S]+FOREIGN KEY \("parent_id"\)[\s\S]+REFERENCES "parents"/);
  assert.match(output, /ALTER TABLE "inline_child"[\s\S]+FOREIGN KEY \("parent_id"\)[\s\S]+REFERENCES "parents"/);
});

test("preserves integer and decimal defaults without IEEE-754 rounding", () => {
  const precise = parseDBML(`
Table precise_defaults {
  id uuid [pk]
  large_counter bigint [default: 900719925474099312345]
  exact_amount decimal(38, 20) [default: 123456789012345678.12345678901234567890]
}
`);
  const expectedDefaults = [
    "900719925474099312345",
    "123456789012345678.12345678901234567890",
  ];
  const exports = [
    ["PostgreSQL", exportPostgresSql(precise)],
    ["MySQL", exportMySql(precise)],
    ["SQLite", exportSqliteSql(precise)],
    ["Prisma", exportPrismaSchema(precise)],
    ["Drizzle", exportDrizzleSchema(precise)],
    ["JSON Schema", exportJsonSchema(precise)],
  ];

  for (const [format, output] of exports) {
    for (const expected of expectedDefaults) {
      assert.ok(
        output.includes(expected),
        `${format} must preserve the exact default ${expected}`,
      );
    }
  }
});

test("parenthesizes MySQL literal defaults for TEXT, BLOB, and JSON columns", () => {
  const literals = parseDBML(`
Table literal_defaults {
  id int [pk]
  body text [default: 'hello']
  payload blob [default: 'bytes']
  metadata json [default: '{"enabled":true}']
}
`);
  const output = exportMySql(literals);

  assert.match(output, /`body` TEXT DEFAULT \('hello'\)/);
  assert.match(output, /`payload` BLOB DEFAULT \('bytes'\)/);
  assert.match(output, /`metadata` JSON DEFAULT \('\{"enabled":true\}'\)/);
});

test("parenthesizes non-keyword SQLite function-expression defaults", () => {
  const expressions = parseDBML(`
Table generated_values {
  id text [pk, default: \`lower(hex(randomblob(16)))\`]
  created_at datetime [default: \`datetime('now')\`]
}
`);
  const output = exportSqliteSql(expressions);

  assert.match(output, /DEFAULT \(lower\(hex\(randomblob\(16\)\)\)\)/);
  assert.match(output, /DEFAULT \(datetime\('now'\)\)/);
});

test("enforces uniqueness on the physical child of a one-to-one relation", () => {
  const oneToOne = parseDBML(`
Table accounts {
  id uuid [pk]
}
Table account_profiles {
  id uuid [pk]
  account_id uuid [not null]
}
Ref: accounts.id - account_profiles.account_id
`);
  const postgres = exportPostgresSql(oneToOne);
  const mysql = exportMySql(oneToOne);
  const sqlite = exportSqliteSql(oneToOne);
  const drizzle = exportDrizzleSchema(oneToOne);

  assert.match(
    postgres,
    /(?:"account_id"[^\n,]*\bUNIQUE\b|UNIQUE\s*\(\s*"account_id"\s*\))/,
  );
  assert.match(
    mysql,
    /(?:`account_id`[^\n,]*\bUNIQUE\b|UNIQUE(?:\s+KEY\s+`[^`]+`)?\s*\(\s*`account_id`\s*\))/,
  );
  assert.match(
    sqlite,
    /(?:"account_id"[^\n,]*\bUNIQUE\b|UNIQUE\s*\(\s*"account_id"\s*\))/,
  );
  const childLine = drizzle
    .split("\n")
    .find((line) => /^\s*accountId:/.test(line));
  assert.ok(childLine, "Drizzle export must contain the child FK column");
  assert.match(childLine, /\.unique\(\)/);
  assert.match(childLine, /\.references\(/);
});

test("warns and omits a foreign key whose parent field is not uniquely constrained", () => {
  const invalid = parseDBML(`
Table parents {
  id uuid [pk]
  external_code varchar(40) [not null]
}
Table children {
  id uuid [pk]
  parent_code varchar(40)
}
Ref: children.parent_code > parents.external_code
`);
  const outputs = [
    ["PostgreSQL", exportPostgresSql(invalid), /FOREIGN KEY/],
    ["MySQL", exportMySql(invalid), /FOREIGN KEY/],
    ["SQLite", exportSqliteSql(invalid), /FOREIGN KEY/],
    ["Prisma", exportPrismaSchema(invalid), /@relation\(/],
    ["Drizzle", exportDrizzleSchema(invalid), /\.references\(/],
  ];

  for (const [format, output, referencePattern] of outputs) {
    assert.match(
      output,
      /(?:NOTE|WARNING):[^\n]*/i,
      `${format} must warn about the invalid foreign key`,
    );
    assert.match(
      output,
      /not emitted/i,
      `${format} must say the invalid foreign key was not emitted`,
    );
    assert.match(
      output,
      /unique/i,
      `${format} must explain the missing unique parent constraint`,
    );
    assert.doesNotMatch(
      output,
      referencePattern,
      `${format} must not emit the invalid foreign key`,
    );
  }

  const jsonSchema = JSON.parse(exportJsonSchema(invalid));
  assert.deepEqual(jsonSchema["x-relations"], []);
});

test("declares public alongside named schemas in a mixed-schema Prisma export", () => {
  const mixedSchemas = parseDBML(`
Table auth.users {
  id uuid [pk]
}
Table posts {
  id uuid [pk]
  author_id uuid
}
Ref: posts.author_id > auth.users.id
`);
  const output = exportPrismaSchema(mixedSchemas);
  const schemasLine = output.split("\n").find((line) => /^\s*schemas\s*=/.test(line));

  assert.ok(schemasLine, "Prisma datasource must declare its schemas");
  assert.match(schemasLine, /"auth"/);
  assert.match(schemasLine, /"public"/);
  assert.match(output, /model Users \{[\s\S]*?@@schema\("auth"\)[\s\S]*?\}/);
  assert.match(output, /model Posts \{[\s\S]*?@@schema\("public"\)[\s\S]*?\}/);
});

test("renders PostgreSQL arrays with Drizzle's array builder modifier", () => {
  const arrays = parseDBML(`
Table catalog_items {
  id uuid [pk]
  tags text[] [not null]
  related_ids uuid[]
}
`);
  const output = exportDrizzleSchema(arrays);

  assert.match(output, /tags:\s*text\("tags"\)\.array\(\)\.notNull\(\)/);
  assert.match(output, /relatedIds:\s*uuid\("related_ids"\)\.array\(\)/);
});
