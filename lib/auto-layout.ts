import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api";
import type { DbmlDocument, DbmlRelation, DbmlTable } from "@/lib/dbml";
import {
  GROUP_FRAME_PADDING,
  LAYOUT_GRID_SIZE,
  TABLE_NODE_WIDTH,
  tableNodeHeight,
} from "@/lib/diagram-geometry";

export {
  GROUP_FRAME_PADDING,
  LAYOUT_GRID_SIZE,
  TABLE_NODE_WIDTH,
  tableNodeHeight,
} from "@/lib/diagram-geometry";
export const LAYOUT_GAPS = {
  node: 48,
  layer: 96,
  component: 108,
} as const;

const CANVAS_MARGIN = 72;

export type AutoLayoutMap = Record<string, { x: number; y: number }>;

export interface AutoLayoutResult {
  positions: AutoLayoutMap;
  stats: {
    tables: number;
    groups: number;
    width: number;
    height: number;
    engine: "elk" | "fallback";
  };
}

interface PositionedTable {
  table: DbmlTable;
  x: number;
  y: number;
}

interface LayoutBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function snap(value: number) {
  return Math.round(value / LAYOUT_GRID_SIZE) * LAYOUT_GRID_SIZE;
}

function directedEndpoints(relation: DbmlRelation) {
  if (relation.operator === ">") {
    return { source: relation.toTableId, target: relation.fromTableId };
  }
  if (relation.operator === "<") {
    return { source: relation.fromTableId, target: relation.toTableId };
  }
  if (relation.operator === "-" && relation.source === "inline") {
    return { source: relation.toTableId, target: relation.fromTableId };
  }
  return { source: relation.fromTableId, target: relation.toTableId };
}

function tableNode(table: DbmlTable): ElkNode {
  return {
    id: table.id,
    width: TABLE_NODE_WIDTH,
    height: tableNodeHeight(table),
  };
}

function buildElkGraph(document: DbmlDocument): ElkNode {
  const tableById = new Map(document.tables.map((table) => [table.id, table]));
  const tableIds = new Set(tableById.keys());
  const assignedTableIds = new Set<string>();
  const groups: ElkNode[] = [];

  for (const group of document.groups) {
    const members = group.tableIds
      .filter((tableId) => tableIds.has(tableId) && !assignedTableIds.has(tableId))
      .map((tableId) => tableById.get(tableId))
      .filter((table): table is DbmlTable => table !== undefined);

    if (members.length === 0) continue;
    members.forEach((table) => assignedTableIds.add(table.id));
    groups.push({
      id: `layout-group-${group.id}`,
      children: members.map(tableNode),
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": "RIGHT",
        "elk.edgeRouting": "ORTHOGONAL",
        "elk.padding": `[top=${GROUP_FRAME_PADDING.top},left=${GROUP_FRAME_PADDING.left},bottom=${GROUP_FRAME_PADDING.bottom},right=${GROUP_FRAME_PADDING.right}]`,
        "elk.spacing.nodeNode": String(LAYOUT_GAPS.node),
        "elk.layered.spacing.nodeNodeBetweenLayers": String(LAYOUT_GAPS.layer),
        "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      },
    });
  }

  const ungrouped = document.tables
    .filter((table) => !assignedTableIds.has(table.id))
    .map(tableNode);
  const edges: ElkExtendedEdge[] = document.relations.flatMap((relation, index) => {
    const { source, target } = directedEndpoints(relation);
    if (!tableIds.has(source) || !tableIds.has(target)) return [];
    return [{ id: `layout-edge-${index}-${relation.id}`, sources: [source], targets: [target] }];
  });

  return {
    id: "smart-layout-root",
    children: [...groups, ...ungrouped],
    edges,
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.padding": "[top=0,left=0,bottom=0,right=0]",
      "elk.spacing.nodeNode": String(LAYOUT_GAPS.node),
      "elk.spacing.edgeNode": "32",
      "elk.spacing.componentComponent": String(LAYOUT_GAPS.component),
      "elk.layered.spacing.nodeNodeBetweenLayers": String(LAYOUT_GAPS.layer),
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.layered.cycleBreaking.strategy": "GREEDY_MODEL_ORDER",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.randomSeed": "1",
      "elk.separateConnectedComponents": "true",
    },
  };
}

function flattenTables(
  node: ElkNode,
  tableById: ReadonlyMap<string, DbmlTable>,
  parentX = 0,
  parentY = 0,
  output: PositionedTable[] = [],
) {
  const x = parentX + (node.x ?? 0);
  const y = parentY + (node.y ?? 0);
  const table = tableById.get(node.id);
  if (table) output.push({ table, x, y });
  for (const child of node.children ?? []) flattenTables(child, tableById, x, y, output);
  return output;
}

function boundsForTables(tables: PositionedTable[]): LayoutBounds {
  if (tables.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return {
    minX: Math.min(...tables.map((item) => item.x)),
    minY: Math.min(...tables.map((item) => item.y)),
    maxX: Math.max(...tables.map((item) => item.x + TABLE_NODE_WIDTH)),
    maxY: Math.max(...tables.map((item) => item.y + tableNodeHeight(item.table))),
  };
}

function normalizePositions(tables: PositionedTable[]) {
  const bounds = boundsForTables(tables);
  const offsetX = CANVAS_MARGIN - bounds.minX;
  const offsetY = CANVAS_MARGIN - bounds.minY;
  const positions: AutoLayoutMap = {};
  for (const item of tables) {
    positions[item.table.id] = {
      x: snap(item.x + offsetX),
      y: snap(item.y + offsetY),
    };
  }
  return positions;
}

function rectanglesOverlap(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number },
) {
  return !(
    left.x + left.width <= right.x ||
    right.x + right.width <= left.x ||
    left.y + left.height <= right.y ||
    right.y + right.height <= left.y
  );
}

function isValidLayout(document: DbmlDocument, positions: AutoLayoutMap) {
  if (Object.keys(positions).length !== document.tables.length) return false;
  const rectangles = document.tables.map((table) => {
    const position = positions[table.id];
    return position && {
      x: position.x,
      y: position.y,
      width: TABLE_NODE_WIDTH,
      height: tableNodeHeight(table),
    };
  });
  if (rectangles.some((rectangle) => (
    !rectangle ||
    !Number.isFinite(rectangle.x) ||
    !Number.isFinite(rectangle.y) ||
    rectangle.x < 0 ||
    rectangle.y < 0
  ))) {
    return false;
  }

  const bucketSize = 512;
  const buckets = new Map<string, number[]>();
  for (let index = 0; index < rectangles.length; index += 1) {
    const rectangle = rectangles[index]!;
    const minColumn = Math.floor(rectangle.x / bucketSize);
    const maxColumn = Math.floor((rectangle.x + rectangle.width - 1) / bucketSize);
    const minRow = Math.floor(rectangle.y / bucketSize);
    const maxRow = Math.floor((rectangle.y + rectangle.height - 1) / bucketSize);
    const candidates = new Set<number>();

    for (let column = minColumn; column <= maxColumn; column += 1) {
      for (let row = minRow; row <= maxRow; row += 1) {
        const key = `${column}:${row}`;
        for (const candidate of buckets.get(key) ?? []) candidates.add(candidate);
      }
    }
    for (const candidate of candidates) {
      if (rectanglesOverlap(rectangle, rectangles[candidate]!)) return false;
    }
    for (let column = minColumn; column <= maxColumn; column += 1) {
      for (let row = minRow; row <= maxRow; row += 1) {
        const key = `${column}:${row}`;
        const entries = buckets.get(key);
        if (entries) entries.push(index);
        else buckets.set(key, [index]);
      }
    }
  }
  return true;
}

function fallbackLayout(document: DbmlDocument): AutoLayoutMap {
  const positionById: AutoLayoutMap = {};
  const tableById = new Map(document.tables.map((table) => [table.id, table]));
  const assigned = new Set<string>();
  const clusters: DbmlTable[][] = [];

  for (const group of document.groups) {
    const members = group.tableIds
      .filter((id) => !assigned.has(id))
      .map((id) => tableById.get(id))
      .filter((table): table is DbmlTable => table !== undefined);
    if (members.length === 0) continue;
    members.forEach((table) => assigned.add(table.id));
    clusters.push(members);
  }
  for (const table of document.tables) {
    if (!assigned.has(table.id)) clusters.push([table]);
  }

  let clusterX = CANVAS_MARGIN;
  for (const cluster of clusters) {
    let y = CANVAS_MARGIN + GROUP_FRAME_PADDING.top;
    for (const table of cluster) {
      positionById[table.id] = { x: snap(clusterX + GROUP_FRAME_PADDING.left), y: snap(y) };
      y += tableNodeHeight(table) + LAYOUT_GAPS.node;
    }
    clusterX += TABLE_NODE_WIDTH + GROUP_FRAME_PADDING.left + GROUP_FRAME_PADDING.right + LAYOUT_GAPS.component;
  }
  return positionById;
}

function statsFor(document: DbmlDocument, positions: AutoLayoutMap, engine: "elk" | "fallback") {
  const positioned = document.tables.map((table) => ({
    table,
    x: positions[table.id]?.x ?? 0,
    y: positions[table.id]?.y ?? 0,
  }));
  const bounds = boundsForTables(positioned);
  const tableIds = new Set(document.tables.map((table) => table.id));
  const assigned = new Set<string>();
  let groupCount = 0;
  for (const group of document.groups) {
    let owned = false;
    for (const tableId of group.tableIds) {
      if (!tableIds.has(tableId) || assigned.has(tableId)) continue;
      assigned.add(tableId);
      owned = true;
    }
    if (owned) groupCount += 1;
  }
  return {
    tables: document.tables.length,
    groups: groupCount,
    width: Math.max(0, Math.round(bounds.maxX - bounds.minX)),
    height: Math.max(0, Math.round(bounds.maxY - bounds.minY)),
    engine,
  } as const;
}

/** Compute a deterministic, group-aware layout without mutating the DBML document. */
export async function computeAutoLayout(document: DbmlDocument): Promise<AutoLayoutResult> {
  if (document.tables.length === 0) {
    return { positions: {}, stats: { tables: 0, groups: 0, width: 0, height: 0, engine: "elk" } };
  }

  try {
    const elk = new ELK();
    const graph = await elk.layout(buildElkGraph(document));
    const tableById = new Map(document.tables.map((table) => [table.id, table]));
    const positions = normalizePositions(flattenTables(graph, tableById));
    if (!isValidLayout(document, positions)) throw new Error("ELK returned an invalid layout");
    return { positions, stats: statsFor(document, positions, "elk") };
  } catch {
    const positions = fallbackLayout(document);
    return { positions, stats: statsFor(document, positions, "fallback") };
  }
}
