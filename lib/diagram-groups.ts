import type { DbmlDocument, DbmlGroup } from "@/lib/dbml";
import { GROUP_FRAME_PADDING, TABLE_NODE_WIDTH, tableNodeHeight } from "@/lib/diagram-geometry";

export type DiagramPositions = Record<string, { x: number; y: number }>;

/** Explicit TableGroups win; remaining qualified tables form stable schema groups.
 * These are view-only groups: arranging the canvas never rewrites the schema. */
export function getDiagramGroups(document: DbmlDocument): DbmlGroup[] {
  const tables = new Map(document.tables.map((table) => [table.id, table]));
  const assigned = new Set<string>();
  const groups: DbmlGroup[] = [];
  for (const group of document.groups) {
    const tableIds = group.tableIds.filter((id) => {
      if (!tables.has(id) || assigned.has(id)) return false;
      assigned.add(id);
      return true;
    });
    if (!tableIds.length) continue;
    groups.push({ ...group, tableIds, tableNames: tableIds.map((id) => {
      const table = tables.get(id)!;
      return table.schema ? `${table.schema}.${table.name}` : table.name;
    }) });
  }
  const schemas = new Map<string, string[]>();
  for (const table of document.tables) {
    if (!table.schema || assigned.has(table.id)) continue;
    const members = schemas.get(table.schema) ?? [];
    members.push(table.id);
    schemas.set(table.schema, members);
  }
  const usedIds = new Set(groups.map((group) => group.id));
  for (const [schema, tableIds] of schemas) {
    let id = `schema:${schema}`;
    while (usedIds.has(id)) id = `schema:${id}`;
    usedIds.add(id);
    groups.push({
      id, name: schema, tableIds,
      tableNames: tableIds.map((tableId) => `${schema}.${tables.get(tableId)!.name}`),
      note: `Automatically grouped by the ${schema} schema.`,
    });
  }
  return groups;
}

export function groupBounds(document: DbmlDocument, group: DbmlGroup, positions: DiagramPositions) {
  const ids = new Set(group.tableIds);
  const members = document.tables.filter((table) => ids.has(table.id) && positions[table.id]);
  if (!members.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const table of members) {
    const point = positions[table.id];
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x + TABLE_NODE_WIDTH);
    maxY = Math.max(maxY, point.y + tableNodeHeight(table));
  }
  return {
    x: minX - GROUP_FRAME_PADDING.left,
    y: minY - GROUP_FRAME_PADDING.top,
    width: maxX - minX + GROUP_FRAME_PADDING.left + GROUP_FRAME_PADDING.right,
    height: maxY - minY + GROUP_FRAME_PADDING.top + GROUP_FRAME_PADDING.bottom,
  };
}

/** Immutable rigid translation, preserving each member's relative position. */
export function translateGroup(positions: DiagramPositions, group: DbmlGroup, delta: { x: number; y: number }) {
  const next = { ...positions };
  for (const id of group.tableIds) {
    if (positions[id]) next[id] = { x: positions[id].x + delta.x, y: positions[id].y + delta.y };
  }
  return next;
}
