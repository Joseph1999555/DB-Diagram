import type { DbmlTable } from "@/lib/dbml";

export const TABLE_NODE_WIDTH = 248;
export const LAYOUT_GRID_SIZE = 12;
export const GROUP_FRAME_PADDING = {
  top: 50,
  right: 38,
  bottom: 38,
  left: 38,
} as const;

export function tableNodeHeight(table: DbmlTable) {
  return 40 + Math.max(1, table.fields.length) * 29;
}
