import assert from "node:assert/strict";
import test from "node:test";

import { parseDBML, serializeDBML } from "../lib/dbml.ts";

const sample = `
// A representative import with inline and standalone references.
Table auth.users as U [headercolor: #6C5CE7] {
  id bigint [pk, increment]
  email varchar(255) [not null, unique, note: 'Login address']
  organization_id uuid [ref: > organizations.id]
  profile jsonb [default: \`{}\`]

  Note: 'People who can sign in'
}

Table organizations {
  id uuid [pk]
  owner_id bigint
  name varchar [not null]
}

Ref organization_owner: organizations.owner_id - auth.users.id [delete: cascade]

TableGroup identity [color: #A78BFA, note: 'Identity boundary'] {
  auth.users
  organizations
}
`;

test("parses tables, field settings, relations, and groups", () => {
  const document = parseDBML(sample);

  assert.equal(document.tables.length, 2);
  assert.equal(document.relations.length, 2);
  assert.equal(document.groups.length, 1);
  assert.equal(document.diagnostics.length, 0);

  const users = document.tables[0];
  assert.equal(users.schema, "auth");
  assert.equal(users.name, "users");
  assert.equal(users.alias, "U");
  assert.equal(users.color, "#6C5CE7");
  assert.equal(users.note, "People who can sign in");
  assert.deepEqual(
    users.fields.map((field) => field.name),
    ["id", "email", "organization_id", "profile"],
  );
  assert.equal(users.fields[0].primaryKey, true);
  assert.equal(users.fields[0].increment, true);
  assert.equal(users.fields[1].notNull, true);
  assert.equal(users.fields[1].unique, true);
  assert.equal(users.fields[1].note, "Login address");
  assert.equal(users.fields[3].default, "`{}`");

  assert.equal(document.relations[0].operator, ">");
  assert.equal(document.relations[0].cardinality, "many-to-one");
  assert.equal(document.relations[0].source, "inline");
  assert.equal(document.relations[1].name, "organization_owner");
  assert.equal(document.relations[1].cardinality, "one-to-one");
  assert.deepEqual(document.relations[1].settings, ["delete: cascade"]);

  assert.equal(document.groups[0].name, "identity");
  assert.equal(document.groups[0].color, "#A78BFA");
  assert.equal(document.groups[0].tableIds[0], users.id);
});

test("ids are deterministic and serialized DBML can be parsed again", () => {
  const first = parseDBML(sample);
  const second = parseDBML(sample);
  assert.deepEqual(
    first.tables.map((table) => [table.id, ...table.fields.map((field) => field.id)]),
    second.tables.map((table) => [table.id, ...table.fields.map((field) => field.id)]),
  );
  assert.deepEqual(
    first.relations.map((relation) => relation.id),
    second.relations.map((relation) => relation.id),
  );

  const exported = serializeDBML(first);
  assert.match(exported, /Table auth\.users as U/);
  assert.match(exported, /Ref: auth\.users\.organization_id > organizations\.id/);
  assert.match(exported, /TableGroup identity/);

  const roundTrip = parseDBML(exported);
  assert.equal(roundTrip.tables.length, first.tables.length);
  assert.equal(roundTrip.relations.length, first.relations.length);
  assert.equal(roundTrip.groups.length, first.groups.length);
  assert.equal(roundTrip.tables[0].fields[1].unique, true);
  assert.equal(roundTrip.diagnostics.length, 0);
});

test("keeps unresolved references exportable while reporting a warning", () => {
  const document = parseDBML(`
Table events {
  id uuid [pk]
  actor_id uuid [ref: > missing_users.id]
}
`);

  assert.equal(document.relations.length, 1);
  assert.equal(document.relations[0].toTable, "missing_users");
  assert.ok(document.diagnostics.some((item) => item.code === "unknown-reference-table"));
  assert.match(serializeDBML(document), /events\.actor_id > missing_users\.id/);
});
