import assert from "node:assert/strict";
import test from "node:test";
import { parseDBML } from "../lib/dbml.ts";
import { getDiagramGroups, groupBounds } from "../lib/diagram-groups.ts";
import { applyDiagramNodeChanges } from "../lib/diagram-node-changes.ts";
import { chooseRelationPorts, routeRelation, roundedRoutePath } from "../lib/relation-routing.ts";
import { computeAutoLayout } from "../lib/auto-layout.ts";

const source = `
Table auth.users { id int [pk] }
Table auth.sessions { id int [pk] \n user_id int }
Table sales.orders { id int [pk] \n user_id int }
Table audit { id int [pk] }
Ref: auth.sessions.user_id > auth.users.id
Ref: sales.orders.user_id > auth.users.id
`;

test("schema grouping is stable, view-only, and respects explicit membership", () => {
  const document = parseDBML(`${source}\nTableGroup Identity { auth.users }`);
  const before = JSON.stringify(document);
  const groups = getDiagramGroups(document);
  assert.deepEqual(groups.map((group) => group.name), ["Identity", "auth", "sales"]);
  assert.equal(new Set(groups.flatMap((group) => group.tableIds)).size, 3);
  assert.deepEqual(groups, getDiagramGroups(document));
  assert.equal(JSON.stringify(document), before);
  assert.deepEqual(groups[1].tableNames, ["auth.sessions"]);
});

test("automatic schema frames do not overlap other groups or ungrouped tables", async () => {
  const document = parseDBML(source);
  const result = await computeAutoLayout(document);
  assert.equal(result.stats.engine, "elk");
  assert.equal(result.stats.groups, 2);
  const groups = getDiagramGroups(document);
  const frames = groups.map((group) => groupBounds(document, group, result.positions));
  const audit = document.tables.find((table) => table.name === "audit");
  const outside = { ...result.positions[audit.id], width: 248, height: 69 };
  const overlap = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
  assert.equal(overlap(frames[0], frames[1]), false);
  frames.forEach((frame) => assert.equal(overlap(frame, outside), false));
});

function groupedNodes(document) {
  const group = getDiagramGroups(document)[0];
  const tables = document.tables.map((table, index) => ({ id: table.id, type: "tableCard", position: { x: 120 + index * 360, y: 120 }, data: { table } }));
  const bounds = groupBounds(document, group, Object.fromEntries(tables.map((node) => [node.id, node.position])));
  return [{ id: `group-frame-${group.id}`, type: "groupFrame", position: { x: bounds.x, y: bounds.y }, data: { group }, style: { width: bounds.width, height: bounds.height } }, ...tables];
}

test("group drag translates every member exactly once, including mixed selection", () => {
  const document = parseDBML(source);
  const nodes = groupedNodes(document);
  const snapshot = JSON.stringify(nodes);
  const frame = nodes[0];
  const changes = [
    { id: frame.id, type: "position", position: { x: frame.position.x + 72, y: frame.position.y - 24 }, dragging: true },
    { id: nodes[1].id, type: "position", position: { x: nodes[1].position.x + 72, y: 96 }, dragging: true },
  ];
  const moved = applyDiagramNodeChanges(document, changes, nodes);
  for (let index = 1; index < nodes.length; index++) {
    const member = frame.data.group.tableIds.includes(nodes[index].id);
    assert.deepEqual(moved[index].position, member ? { x: nodes[index].position.x + 72, y: nodes[index].position.y - 24 } : nodes[index].position);
  }
  assert.equal(JSON.stringify(nodes), snapshot);
  assert.deepEqual(moved[0].position, changes[0].position);
  // A drag-end event and subsequent selection event must not translate again.
  const ended = applyDiagramNodeChanges(document, [{ ...changes[0], dragging: false }], moved);
  assert.deepEqual(ended.map((node) => node.position), moved.map((node) => node.position));
  const selected = applyDiagramNodeChanges(document, [{ type: "select", id: frame.id, selected: true }], ended);
  assert.deepEqual(selected.map((node) => node.position), ended.map((node) => node.position));
});

test("moving one table refits its group without moving other members", () => {
  const document = parseDBML(source);
  const nodes = groupedNodes(document);
  const moved = applyDiagramNodeChanges(document, [{ id: nodes[2].id, type: "position", position: { x: 840, y: 420 }, dragging: false }], nodes);
  const positions = Object.fromEntries(moved.slice(1).map((node) => [node.id, node.position]));
  const bounds = groupBounds(document, nodes[0].data.group, positions);
  assert.deepEqual(moved[0].position, { x: bounds.x, y: bounds.y });
  assert.equal(moved[0].style.height, bounds.height);
  assert.deepEqual(moved[1].position, nodes[1].position);
});

const rect = (id, x, y, height = 150) => ({ id, x, y, width: 248, height });

test("relationship ports choose facing sides and reverse after tables swap", () => {
  const left = rect("a", 0, 0), right = rect("b", 500, 0);
  assert.deepEqual(chooseRelationPorts(left, right), { source: "right", target: "left" });
  assert.deepEqual(chooseRelationPorts(right, left), { source: "left", target: "right" });
  assert.deepEqual(chooseRelationPorts(left, rect("b", 0, 300)), { source: "right", target: "right" });
  assert.deepEqual(chooseRelationPorts(left, left), { source: "right", target: "right" });
});

function assertOutsideTables(points, rectangles) {
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1], b = points[index];
    assert.ok(a.x === b.x || a.y === b.y, "route must remain orthogonal");
    for (const box of rectangles) {
      const crossing = a.x === b.x
        ? a.x > box.x && a.x < box.x + box.width && Math.max(a.y, b.y) > box.y && Math.min(a.y, b.y) < box.y + box.height
        : a.y > box.y && a.y < box.y + box.height && Math.max(a.x, b.x) > box.x && Math.min(a.x, b.x) < box.x + box.width;
      assert.equal(crossing, false, `route crosses ${box.id}`);
    }
  }
}

test("routing detours around intervening tables, preserving outward endpoints", () => {
  const boxes = [rect("a", 0, 0), rect("blocker", 380, -40, 220), rect("b", 760, 0)];
  const points = routeRelation({ x: 248, y: 70 }, { x: 760, y: 78 }, "right", "left", boxes);
  assertOutsideTables(points, boxes);
  assert.ok(points[1].x > 248);
  assert.ok(points.at(-2).x < 760);
  assert.match(roundedRoutePath(points), /^M .* Q /);
  assert.deepEqual(points, routeRelation({ x: 248, y: 70 }, { x: 760, y: 78 }, "right", "left", boxes));
});

test("backward and vertically stacked relationships stay outside table bodies", () => {
  for (const [boxes, start, end, a, b] of [
    [[rect("a", 760, 0), rect("b", 0, 0)], { x: 760, y: 70 }, { x: 248, y: 78 }, "left", "right"],
    [[rect("a", 0, 0), rect("b", 0, 300)], { x: 248, y: 70 }, { x: 248, y: 378 }, "right", "right"],
  ]) assertOutsideTables(routeRelation(start, end, a, b, boxes), boxes);
});

test("self references create a visible loop instead of collapsing to zero length", () => {
  const boxes = [rect("a", 0, 0)];
  const points = routeRelation({ x: 248, y: 70 }, { x: 248, y: 70 }, "right", "right", boxes);
  assertOutsideTables(points, boxes);
  assert.ok(points.length >= 5);
  assert.ok(new Set(points.map((point) => point.y)).size > 1);
});

test("dense hub diagrams use a compact, collision-free adaptive layout", async () => {
  const document = parseDBML(`Table core { id int [pk] }\n${Array.from({ length: 40 }, (_, index) => `Table item_${index} { id int [pk]\n core_id int [ref: > core.id]\n value text }`).join("\n")}`);
  const result = await computeAutoLayout(document);
  assert.equal(result.stats.engine, "elk");
  assert.ok(result.stats.width / result.stats.height > 0.65, "hub leaves must not form one excessively tall column");
  assert.ok(result.stats.width / result.stats.height < 3.5, "compaction must not create an excessively wide strip");
  const boxes = document.tables.map((table) => ({ ...result.positions[table.id], width: 248, height: 40 + table.fields.length * 29 }));
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
  }
  assert.deepEqual(result.positions, (await computeAutoLayout(document)).positions);
});

test("cross-schema cycles keep distinct same-named tables in their own envelopes", async () => {
  const document = parseDBML(`Table auth.users { id int [pk]\n order_id int }\nTable sales.users { id int [pk]\n auth_id int }\nTable sales.orders { id int [pk]\n user_id int }\nRef: auth.users.order_id > sales.orders.id\nRef: sales.orders.user_id > sales.users.id\nRef: sales.users.auth_id > auth.users.id`);
  const result = await computeAutoLayout(document);
  assert.equal(result.stats.engine, "elk");
  assert.equal(Object.keys(result.positions).length, 3);
  const groups = getDiagramGroups(document);
  const [a, b] = groups.map((group) => groupBounds(document, group, result.positions));
  assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
});
