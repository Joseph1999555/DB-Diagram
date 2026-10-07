import { applyNodeChanges, type Node, type NodeChange } from "@xyflow/react";
import type { DbmlDocument, DbmlGroup } from "@/lib/dbml";
import { groupBounds, translateGroup, type DiagramPositions } from "@/lib/diagram-groups";

/** Keep absolute table coordinates for persistence, translating selected group
 * members once and keeping frames tight after either table or group movement. */
export function applyDiagramNodeChanges<T extends Node>(document: DbmlDocument, changes: NodeChange<T>[], previous: T[]): T[] {
  const positionsFor = (nodes: T[]): DiagramPositions => Object.fromEntries(
    nodes.filter((node) => node.type === "tableCard").map((node) => [node.id, node.position]),
  );
  let positions = positionsFor(previous);
  const movedMembers = new Set<string>();
  const nodeById = new Map(previous.map((node) => [node.id, node]));
  for (const change of changes) {
    if (change.type !== "position" || !change.position) continue;
    const frame = nodeById.get(change.id);
    if (frame?.type !== "groupFrame") continue;
    const group = frame.data.group as DbmlGroup;
    positions = translateGroup(positions, group, { x: change.position.x - frame.position.x, y: change.position.y - frame.position.y });
    group.tableIds.forEach((id) => movedMembers.add(id));
  }
  const filtered = changes.filter((change) => change.type !== "position" || !movedMembers.has(change.id));
  const updated = applyNodeChanges(filtered, previous).map((node) => movedMembers.has(node.id)
    ? { ...node, position: positions[node.id] } : node);
  if (!changes.some((change) => change.type === "position")) return updated;
  const currentPositions = positionsFor(updated);
  return updated.map((node) => {
    if (node.type !== "groupFrame") return node;
    const bounds = groupBounds(document, node.data.group as DbmlGroup, currentPositions);
    return bounds ? { ...node, position: { x: bounds.x, y: bounds.y }, style: { ...node.style, width: bounds.width, height: bounds.height } } : node;
  });
}
