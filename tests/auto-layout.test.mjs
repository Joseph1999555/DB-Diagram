import assert from "node:assert/strict";
import test from "node:test";

import {
  GROUP_FRAME_PADDING,
  LAYOUT_GRID_SIZE,
  TABLE_NODE_WIDTH,
  computeAutoLayout,
  tableNodeHeight,
} from "../lib/auto-layout.ts";
import { parseDBML } from "../lib/dbml.ts";

function rectangleFor(table, positions) {
  return {
    x: positions[table.id].x,
    y: positions[table.id].y,
    width: TABLE_NODE_WIDTH,
    height: tableNodeHeight(table),
  };
}

function overlaps(left, right) {
  return !(
    left.x + left.width <= right.x ||
    right.x + right.width <= left.x ||
    left.y + left.height <= right.y ||
    right.y + right.height <= left.y
  );
}

function assertValidLayout(document, positions) {
  assert.deepEqual(Object.keys(positions).sort(), document.tables.map((table) => table.id).sort());
  for (const position of Object.values(positions)) {
    assert.ok(Number.isFinite(position.x) && Number.isFinite(position.y));
    assert.ok(position.x >= 0 && position.y >= 0);
    assert.equal(position.x % LAYOUT_GRID_SIZE, 0);
    assert.equal(position.y % LAYOUT_GRID_SIZE, 0);
  }

  const rectangles = document.tables.map((table) => rectangleFor(table, positions));
  for (let left = 0; left < rectangles.length; left += 1) {
    for (let right = left + 1; right < rectangles.length; right += 1) {
      assert.equal(overlaps(rectangles[left], rectangles[right]), false, `tables ${left} and ${right} overlap`);
    }
  }
}

function groupEnvelope(document, group, positions) {
  const members = group.tableIds
    .map((id) => document.tables.find((table) => table.id === id))
    .filter(Boolean)
    .map((table) => rectangleFor(table, positions));
  if (members.length === 0) return null;
  const minX = Math.min(...members.map((rectangle) => rectangle.x)) - GROUP_FRAME_PADDING.left;
  const minY = Math.min(...members.map((rectangle) => rectangle.y)) - GROUP_FRAME_PADDING.top;
  const maxX = Math.max(...members.map((rectangle) => rectangle.x + rectangle.width)) + GROUP_FRAME_PADDING.right;
  const maxY = Math.max(...members.map((rectangle) => rectangle.y + rectangle.height)) + GROUP_FRAME_PADDING.bottom;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

test("smart layout keeps explicit groups together and safely places ungrouped tables", async () => {
  const document = parseDBML(`
Table users {
  id uuid [pk]
}
Table sessions {
  id uuid [pk]
  user_id uuid
}
Table products {
  id uuid [pk]
}
Table orders {
  id uuid [pk]
  user_id uuid
}
Table order_items {
  id uuid [pk]
  order_id uuid
  product_id uuid
}
Table audit_log {
  id uuid [pk]
}
Ref: sessions.user_id > users.id
Ref: orders.user_id > users.id
Ref: order_items.order_id > orders.id
Ref: order_items.product_id > products.id
TableGroup Identity {
  users
  sessions
}
TableGroup Commerce {
  products
  orders
  order_items
}
`);
  const snapshot = JSON.stringify(document);
  const { positions, stats } = await computeAutoLayout(document);

  assertValidLayout(document, positions);
  assert.equal(stats.tables, 6);
  assert.equal(stats.groups, 2);
  assert.equal(JSON.stringify(document), snapshot, "layout must not mutate parsed DBML");

  const envelopes = document.groups.map((group) => groupEnvelope(document, group, positions));
  assert.equal(overlaps(envelopes[0], envelopes[1]), false, "group frames overlap");
  const ungrouped = rectangleFor(document.tables.find((table) => table.name === "audit_log"), positions);
  for (const envelope of envelopes) assert.equal(overlaps(ungrouped, envelope), false);
});

test("smart layout ranks referenced parents before dependents for both DBML directions", async () => {
  for (const reference of ["child.parent_id > parent.id", "parent.id < child.parent_id"]) {
    const document = parseDBML(`
Table parent {
  id int [pk]
}
Table child {
  id int [pk]
  parent_id int
}
Ref: ${reference}
`);
    const { positions } = await computeAutoLayout(document);
    assertValidLayout(document, positions);
    const parent = document.tables.find((table) => table.name === "parent");
    const child = document.tables.find((table) => table.name === "child");
    assert.ok(positions[parent.id].x < positions[child.id].x, reference);
  }
});

test("cycles, self references, and disconnected components are deterministic", async () => {
  const document = parseDBML(`
Table alpha {
  id int [pk]
  gamma_id int
}
Table beta {
  id int [pk]
  alpha_id int
}
Table gamma {
  id int [pk]
  beta_id int
  parent_id int
}
Table delta {
  id int [pk]
}
Table epsilon {
  id int [pk]
  delta_id int
}
Table isolated {
  id int [pk]
}
Ref: beta.alpha_id > alpha.id
Ref: gamma.beta_id > beta.id
Ref: alpha.gamma_id > gamma.id
Ref: gamma.parent_id > gamma.id
Ref: epsilon.delta_id > delta.id
`);
  const first = await computeAutoLayout(document);
  const second = await computeAutoLayout(document);
  assertValidLayout(document, first.positions);
  assert.deepEqual(second, first);
});

test("real table heights prevent collisions and empty documents are safe", async () => {
  const manyFields = Array.from({ length: 24 }, (_, index) => `  field_${index} varchar`).join("\n");
  const document = parseDBML(`
Table orders {
  id int [pk]
${manyFields}
}
Table order_lines {
  id int [pk]
  order_id int
}
Table notes {
  id int [pk]
}
Ref: order_lines.order_id > orders.id
`);
  const result = await computeAutoLayout(document);
  assertValidLayout(document, result.positions);
  assert.ok(tableNodeHeight(document.tables[0]) > 700);

  const empty = await computeAutoLayout(parseDBML(""));
  assert.deepEqual(empty.positions, {});
  assert.equal(empty.stats.tables, 0);
});

