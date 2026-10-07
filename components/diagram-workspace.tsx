"use client";

import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  useStore,
  type Connection,
  type Node,
  type NodeChange,
  type NodeProps,
  type NodeTypes,
  type EdgeProps,
  type EdgeTypes,
} from "@xyflow/react";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowLeftRight,
  Boxes,
  Braces,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Code2,
  Command,
  Copy,
  Database,
  Download,
  FileCode2,
  FileDown,
  FileJson,
  Focus,
  GitBranch,
  Grid2X2,
  GripVertical,
  Hand,
  History,
  Import,
  KeyRound,
  LockKeyhole,
  LoaderCircle,
  Maximize2,
  MessageSquare,
  MousePointer2,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Redo2,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  Settings2,
  Share2,
  Sparkles,
  Table2,
  Undo2,
  Upload,
  UserPlus,
  WandSparkles,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { ThemeSwitcher } from "@/components/theme-switcher";
import {
  buildCommentThreads,
  COMMENT_BODY_MAX_LENGTH,
  type CommentStatus,
  type CommentThread,
  type ProjectComment,
} from "@/lib/comments";
import {
  parseDBML,
  serializeDBML,
  type DbmlDocument,
  type DbmlGroup,
  type DbmlTable,
} from "@/lib/dbml";
import type {
  SchemaImportFormat,
  SchemaImportResult,
  SchemaMergeStrategy,
} from "@/lib/schema-import";
import type { SchemaExportFormat } from "@/lib/schema-export";
import { getDiagramGroups } from "@/lib/diagram-groups";
import { applyDiagramNodeChanges } from "@/lib/diagram-node-changes";
import { chooseRelationPorts, routeRelation, roundedRoutePath, type TableRectangle } from "@/lib/relation-routing";
import {
  GROUP_FRAME_PADDING,
  LAYOUT_GRID_SIZE,
  TABLE_NODE_WIDTH,
  tableNodeHeight,
} from "@/lib/diagram-geometry";
import {
  memo,
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type DragEvent,
} from "react";

const DEFAULT_DBML = `// Relix sample workspace · PostgreSQL
Table users {
  id uuid [pk]
  email varchar [not null, unique]
  full_name varchar [not null]
  avatar_url varchar
  created_at timestamp [not null, default: \`now()\`]
}

Table workspaces {
  id uuid [pk]
  name varchar [not null]
  slug varchar [not null, unique]
  owner_id uuid [not null]
  created_at timestamp [not null]
}

Table workspace_members {
  workspace_id uuid [not null]
  user_id uuid [not null]
  role varchar [not null, default: 'editor']
  joined_at timestamp [not null]
}

Table customers {
  id uuid [pk]
  workspace_id uuid [not null]
  email varchar [not null]
  full_name varchar
  lifetime_value int [not null, default: 0]
}

Table products {
  id uuid [pk]
  workspace_id uuid [not null]
  sku varchar [not null, unique]
  name varchar [not null]
  price_cents int [not null]
  active boolean [not null, default: true]
}

Table orders {
  id uuid [pk]
  workspace_id uuid [not null]
  customer_id uuid [not null]
  status varchar [not null, default: 'pending']
  total_cents int [not null]
  created_at timestamp [not null]
}

Table order_items {
  id uuid [pk]
  order_id uuid [not null]
  product_id uuid [not null]
  quantity int [not null]
  unit_price_cents int [not null]
}

Table payments {
  id uuid [pk]
  order_id uuid [not null]
  provider varchar [not null]
  status varchar [not null]
  amount_cents int [not null]
  captured_at timestamp
}

Ref: workspaces.owner_id > users.id
Ref: workspace_members.workspace_id > workspaces.id
Ref: workspace_members.user_id > users.id
Ref: customers.workspace_id > workspaces.id
Ref: products.workspace_id > workspaces.id
Ref: orders.workspace_id > workspaces.id
Ref: orders.customer_id > customers.id
Ref: order_items.order_id > orders.id
Ref: order_items.product_id > products.id
Ref: payments.order_id > orders.id

TableGroup Identity [color: #9c83ff] {
  users
  workspaces
  workspace_members
}

TableGroup Catalog [color: #55d99a] {
  products
}

TableGroup Checkout [color: #51d6f5] {
  customers
  orders
  order_items
  payments
}`;

const DEFAULT_DOCUMENT = parseDBML(DEFAULT_DBML);

const GROUP_PALETTE = ["#9c83ff", "#55d99a", "#51d6f5", "#f1c96d", "#ff7387"];
const EDGE_PALETTE = ["#51d6f5", "#9c83ff", "#55d99a", "#f1c96d", "#ff7387"];
const GENERATED_EXPORT_BLOCKED_MESSAGE = "Fix DBML errors before exporting generated schemas.";
const DEFAULT_VIEWPORT = { x: -42, y: 28, zoom: 0.7 };
const SNAP_GRID: [number, number] = [LAYOUT_GRID_SIZE, LAYOUT_GRID_SIZE];
const FLOW_PRO_OPTIONS = { hideAttribution: true } as const;
const EMPTY_ROUTING_RECTANGLES: TableRectangle[] = [];
const MINIMAP_STYLE: CSSProperties = { width: 124, height: 78 };
const PRESENCE_POLL_MS = 500;
const PRESENCE_RETRY_MAX_MS = 5000;
const PRESENCE_SEND_THROTTLE_MS = 350;
const PRESENCE_HEARTBEAT_MS = 4000;
const SCHEMA_IMPORT_MAX_BYTES = 2 * 1024 * 1024;
const SCHEMA_IMPORT_ACCEPT = ".dbml,.sql,.prisma,.ts,.json,.txt,text/plain,application/json,application/sql";

const SCHEMA_IMPORT_FORMATS: ReadonlyArray<{
  value: SchemaImportFormat;
  label: string;
}> = [
  { value: "auto", label: "Auto detect" },
  { value: "dbml", label: "DBML" },
  { value: "postgresql", label: "PostgreSQL" },
  { value: "mysql", label: "MySQL" },
  { value: "sqlite", label: "SQLite" },
  { value: "prisma", label: "Prisma" },
  { value: "drizzle", label: "Drizzle" },
  { value: "json-schema", label: "JSON Schema" },
  { value: "relix", label: "Relix JSON" },
];

type PresenceCursor = {
  sessionId: string;
  userId: string;
  displayName: string;
  x: number;
  y: number;
  updatedAt: string;
};

type PresencePoint = Pick<PresenceCursor, "x" | "y">;
type PresenceStatus = "idle" | "connecting" | "live" | "offline";
type CanvasBounds = { left: number; top: number; width: number; height: number };

type TableNodeData = Record<string, unknown> & {
  table: DbmlTable;
  color: string;
  dimmed: boolean;
  foreignFieldIds: ReadonlySet<string>;
  openCommentCount?: number;
  onOpenComments?: (tableId: string) => void;
};

type GroupNodeData = Record<string, unknown> & {
  group: DbmlGroup;
  color: string;
};

type DiagramNode = Node<TableNodeData, "tableCard"> | Node<GroupNodeData, "groupFrame">;

type LayoutMap = Record<string, { x: number; y: number }>;

type Member = {
  email: string;
  displayName?: string;
  name?: string;
  role: "owner" | "editor" | "viewer" | string;
  color?: string;
};

type CurrentUser = {
  id?: string;
  email: string;
  displayName?: string;
  name?: string;
  role?: string;
};

type ModalName = "import" | "export" | "share" | "command" | null;
type EditorTab = "dbml" | "outline" | "history";
type CanvasMode = "select" | "pan";
type SaveStatus = "saved" | "syncing" | "offline";
type CommentScope = "all" | "diagram" | "table";
type InspectorMode = "details" | "comments";
type SchemaImportStage = "source" | "preview";
type SchemaImportChoice = SchemaImportFormat;

function defaultPosition(name: string, index: number) {
  const known: Record<string, { x: number; y: number }> = {
    users: { x: 120, y: 120 },
    workspaces: { x: 430, y: 105 },
    workspace_members: { x: 430, y: 350 },
    products: { x: 120, y: 590 },
    customers: { x: 800, y: 105 },
    orders: { x: 800, y: 390 },
    payments: { x: 1110, y: 105 },
    order_items: { x: 1110, y: 410 },
  };

  return known[name] ?? { x: 120 + (index % 4) * 310, y: 110 + Math.floor(index / 4) * 290 };
}

function resolveGroupColor(group: DbmlGroup, index: number) {
  return group.color ?? GROUP_PALETTE[index % GROUP_PALETTE.length];
}

function buildNodes(document: DbmlDocument, layout: LayoutMap = {}): DiagramNode[] {
  const groups = getDiagramGroups(document);
  const foreignFields = new Set(
    document.relations.flatMap((relation) => [relation.fromFieldId, relation.toFieldId]),
  );
  const groupByTableId = new Map<string, { group: DbmlGroup; index: number }>();
  groups.forEach((group, index) => {
    group.tableIds.forEach((tableId) => {
      if (!groupByTableId.has(tableId)) groupByTableId.set(tableId, { group, index });
    });
  });

  const tableNodes: Node<TableNodeData, "tableCard">[] = document.tables.map((table, index) => {
    const membership = groupByTableId.get(table.id);
    const color = table.color ?? (membership
      ? resolveGroupColor(membership.group, membership.index)
      : GROUP_PALETTE[index % GROUP_PALETTE.length]);

    return {
      id: table.id,
      type: "tableCard",
      position: layout[table.id] ?? layout[table.name] ?? defaultPosition(table.name, index),
      data: {
        table,
        color,
        dimmed: false,
        foreignFieldIds: new Set(
          table.fields.filter((field) => foreignFields.has(field.id)).map((field) => field.id),
        ),
      },
      zIndex: 3,
    };
  });
  const tableNodeById = new Map(tableNodes.map((node) => [node.id, node]));

  const groupNodes: DiagramNode[] = groups.flatMap((group, index) => {
    const members = group.tableIds
      .filter((tableId) => groupByTableId.get(tableId)?.group.id === group.id)
      .map((tableId) => tableNodeById.get(tableId))
      .filter(
        (node): node is Node<TableNodeData, "tableCard"> => node !== undefined,
    );
    if (members.length === 0) return [];

    const minX = Math.min(...members.map((node) => node.position.x)) - GROUP_FRAME_PADDING.left;
    const minY = Math.min(...members.map((node) => node.position.y)) - GROUP_FRAME_PADDING.top;
    const maxX = Math.max(...members.map((node) => node.position.x + TABLE_NODE_WIDTH)) + GROUP_FRAME_PADDING.right;
    const maxY = Math.max(...members.map((node) => node.position.y + tableNodeHeight(node.data.table))) + GROUP_FRAME_PADDING.bottom;

    return [
      {
        id: `group-frame-${group.id}`,
        type: "groupFrame",
        position: { x: minX, y: minY },
        data: { group, color: resolveGroupColor(group, index) },
        style: { width: maxX - minX, height: maxY - minY },
        draggable: true,
        dragHandle: ".group-label",
        ariaLabel: `${group.name} group. Drag the header to move all ${members.length} tables.`,
        selectable: true,
        connectable: false,
        deletable: false,
        focusable: true,
        zIndex: -2,
      } as Node<GroupNodeData, "groupFrame">,
    ];
  });

  return [...groupNodes, ...tableNodes];
}

function tableNodePropsEqual(previous: NodeProps, next: NodeProps) {
  const previousData = previous.data as TableNodeData;
  const nextData = next.data as TableNodeData;
  return (
    previous.selected === next.selected &&
    previousData.table === nextData.table &&
    previousData.color === nextData.color &&
    previousData.dimmed === nextData.dimmed &&
    previousData.foreignFieldIds === nextData.foreignFieldIds &&
    previousData.openCommentCount === nextData.openCommentCount &&
    previousData.onOpenComments === nextData.onOpenComments
  );
}

const TableNodeCard = memo(function TableNodeCard({ data, selected }: NodeProps) {
  const nodeData = data as TableNodeData;
  const { table, color, dimmed, foreignFieldIds, openCommentCount = 0, onOpenComments } = nodeData;

  return (
    <div
      className={`erd-node${selected ? " selected" : ""}${dimmed ? " is-dimmed" : ""}`}
      style={{ "--table-color": color } as CSSProperties}
      aria-label={`${table.name} table with ${table.fields.length} fields`}
    >
      <div className="table-header">
        <Table2 className="table-icon" size={13} strokeWidth={1.8} aria-hidden="true" />
        <span className="table-name">{table.name}</span>
        <button
          className={`table-comment-trigger nodrag nopan${openCommentCount > 0 ? " has-comments" : ""}`}
          type="button"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onOpenComments?.(table.id);
          }}
          aria-label={openCommentCount > 0
            ? `Open ${openCommentCount} comment ${openCommentCount === 1 ? "thread" : "threads"} for ${table.name}`
            : `Comment on ${table.name}`}
          title={openCommentCount > 0 ? `${openCommentCount} open comment ${openCommentCount === 1 ? "thread" : "threads"}` : "Comment on table"}
        >
          <MessageSquare size={11} aria-hidden="true" />
          {openCommentCount > 0 && <span>{openCommentCount > 99 ? "99+" : openCommentCount}</span>}
        </button>
        <span className="table-count">{table.fields.length}</span>
      </div>
      <div>
        {table.fields.map((field) => (
          <div className="field-row" key={field.id}>
            {(["left", "right"] as const).map((side) => (
              <Handle key={`target-${side}`} className="erd-handle erd-target-handle"
                id={`${field.id}:target:${side}`} type="target"
                position={side === "left" ? Position.Left : Position.Right}
                aria-label={`Connect to ${table.name}.${field.name} on the ${side}`} />
            ))}
            <div className="field-main">
              <span className="field-name">{field.name}</span>
              <span className="field-type">{field.type}</span>
            </div>
            <div className="field-badges">
              {field.primaryKey && <span className="field-badge pk">PK</span>}
              {foreignFieldIds.has(field.id) && !field.primaryKey && (
                <span className="field-badge fk">FK</span>
              )}
              {field.unique && !field.primaryKey && <span className="field-badge">UQ</span>}
            </div>
            {(["left", "right"] as const).map((side) => (
              <Handle key={`source-${side}`} className="erd-handle erd-source-handle"
                id={`${field.id}:source:${side}`} type="source"
                position={side === "left" ? Position.Left : Position.Right}
                aria-label={`Connect from ${table.name}.${field.name} on the ${side}`} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}, tableNodePropsEqual);

const GroupFrameNode = memo(function GroupFrameNode({ data }: NodeProps) {
  const nodeData = data as GroupNodeData;
  return (
    <div
      className="group-frame"
      style={{ "--group-color": nodeData.color } as CSSProperties}
    >
      <div className="group-label" title={`Drag to move all tables in ${nodeData.group.name}`}>
        <GripVertical size={12} aria-hidden="true" />
        <span />
        {nodeData.group.name}
      </div>
    </div>
  );
});

const SmartRelationEdge = memo(function SmartRelationEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, style, data, interactionWidth }: EdgeProps) {
  const rectangles = (data?.rectangles ?? EMPTY_ROUTING_RECTANGLES) as TableRectangle[];
  const lane = (data?.lane ?? 0) as number;
  const path = useMemo(() => roundedRoutePath(routeRelation(
    { x: sourceX, y: sourceY }, { x: targetX, y: targetY },
    sourcePosition === Position.Left ? "left" : "right",
    targetPosition === Position.Left ? "left" : "right", rectangles, lane,
  )), [sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, rectangles, lane]);
  return <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} interactionWidth={interactionWidth ?? 20} />;
});

const EDGE_TYPES: EdgeTypes = { smartRelation: SmartRelationEdge };

function ZoomLevel() {
  const zoom = useStore((state) => Math.round(state.transform[2] * 100));
  return <span className="zoom-level">{zoom}%</span>;
}

function LivePresenceLayer({
  cursors,
  sessionId,
  canvasBounds,
  status,
}: {
  cursors: PresenceCursor[];
  sessionId: string;
  canvasBounds: CanvasBounds | null;
  status: PresenceStatus;
}) {
  const flow = useReactFlow<DiagramNode>();
  const viewportTransform = useStore((state) => state.transform);
  const remoteCursors = useMemo(() => {
    const seenUsers = new Set<string>();
    return cursors.filter((cursor) => {
      if (cursor.sessionId === sessionId || seenUsers.has(cursor.userId)) return false;
      seenUsers.add(cursor.userId);
      return true;
    });
  }, [cursors, sessionId]);
  const positionedCursors = useMemo(() => {
    if (!canvasBounds || !Number.isFinite(viewportTransform[2])) return [];
    return remoteCursors.map((cursor) => {
      const screenPoint = flow.flowToScreenPosition({ x: cursor.x, y: cursor.y });
      return {
        ...cursor,
        screenX: screenPoint.x - canvasBounds.left,
        screenY: screenPoint.y - canvasBounds.top,
      };
    });
  }, [canvasBounds, flow, remoteCursors, viewportTransform]);
  const statusLabel = status === "live"
    ? remoteCursors.length === 0
      ? "No collaborators on the canvas"
      : `${remoteCursors.length} ${remoteCursors.length === 1 ? "collaborator" : "collaborators"} live on the canvas`
    : status === "connecting"
      ? "Connecting live presence"
      : status === "offline"
        ? "Live presence unavailable"
        : "Live presence paused";

  return (
    <>
      <div className={`presence-live-status ${status}`} role="status" aria-live="polite" aria-atomic="true">
        <span className="presence-live-dot" aria-hidden="true" />
        {statusLabel}
      </div>
      <div className="presence-layer" aria-hidden="true">
        {positionedCursors.map((cursor) => (
          <div
            className="presence-cursor"
            key={cursor.sessionId}
            style={{
              "--presence-x": `${cursor.screenX}px`,
              "--presence-y": `${cursor.screenY}px`,
              color: commentAvatarColor(cursor.userId),
            } as CSSProperties}
          >
            <MousePointer2 size={17} fill="currentColor" />
            <span className="presence-label" style={{ background: commentAvatarColor(cursor.userId) }}>
              {cursor.displayName}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

function minimapNodeColor(node: Node) {
  return node.type === "groupFrame"
    ? "transparent"
    : ((node.data as TableNodeData).color ?? "#51d6f5");
}

const NODE_TYPES: NodeTypes = {
  tableCard: TableNodeCard,
  groupFrame: GroupFrameNode,
};

function initials(value: string) {
  const normalized = value.includes("@") ? value.split("@")[0] : value;
  return normalized
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "U";
}

function displayName(member: Member | CurrentUser) {
  return member.displayName ?? member.name ?? member.email.split("@")[0];
}

function isPresenceCursor(value: unknown): value is PresenceCursor {
  if (!value || typeof value !== "object") return false;
  const cursor = value as Partial<PresenceCursor>;
  return typeof cursor.sessionId === "string" &&
    typeof cursor.userId === "string" &&
    typeof cursor.displayName === "string" &&
    typeof cursor.x === "number" && Number.isFinite(cursor.x) &&
    typeof cursor.y === "number" && Number.isFinite(cursor.y) &&
    typeof cursor.updatedAt === "string";
}

function presenceCursorsEqual(
  current: PresenceCursor[],
  next: PresenceCursor[],
) {
  return current.length === next.length && current.every((cursor, index) => {
    const candidate = next[index];
    return candidate !== undefined &&
      cursor.sessionId === candidate.sessionId &&
      cursor.userId === candidate.userId &&
      cursor.displayName === candidate.displayName &&
      cursor.x === candidate.x &&
      cursor.y === candidate.y &&
      cursor.updatedAt === candidate.updatedAt;
  });
}

function commentTargetLabel(comment: ProjectComment, tables: DbmlTable[]) {
  if (comment.targetType === "diagram") return comment.targetLabel || "Diagram";
  const table = tables.find((candidate) => candidate.id === comment.targetId);
  return table?.name ?? comment.targetLabel ?? "Former table";
}

function commentAvatarColor(id: string) {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) hash = (hash * 31 + id.charCodeAt(index)) | 0;
  return GROUP_PALETTE[Math.abs(hash) % GROUP_PALETTE.length];
}

function formatCommentTime(value: string) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "Now";
  const seconds = Math.round((timestamp - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return formatter.format(days, "day");
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(timestamp);
}

function formatCommentDate(value: string) {
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime())
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(timestamp)
    : value;
}

function latestThreadActivity(thread: CommentThread) {
  return thread.replies[thread.replies.length - 1]?.createdAt ?? thread.updatedAt ?? thread.createdAt;
}

function mergeServerComment(comments: ProjectComment[], comment: ProjectComment) {
  const existing = comments.findIndex((candidate) => candidate.id === comment.id);
  if (existing < 0) return [...comments, comment];
  const next = [...comments];
  next[existing] = comment;
  return next;
}

async function commentResponseError(response: Response, fallback: string) {
  try {
    const payload = (await response.json()) as { error?: unknown };
    return typeof payload.error === "string" && payload.error ? payload.error : fallback;
  } catch {
    return fallback;
  }
}

type CommentsPanelProps = {
  threads: CommentThread[];
  tables: DbmlTable[];
  selectedTable: DbmlTable | null;
  scope: CommentScope;
  filter: CommentStatus;
  activeThreadId: string | null;
  rootDraft: string;
  replyDraft: string;
  loading: boolean;
  loaded: boolean;
  error: string | null;
  composerError: string | null;
  pendingAction: string | null;
  onScopeChange: (scope: CommentScope) => void;
  onFilterChange: (filter: CommentStatus) => void;
  onOpenThread: (threadId: string) => void;
  onBack: () => void;
  onRootDraftChange: (value: string) => void;
  onReplyDraftChange: (value: string) => void;
  onSubmitRoot: () => void;
  onSubmitReply: (threadId: string) => void;
  onToggleStatus: (thread: CommentThread) => void;
  onRetry: () => void;
};

function CommentsPanel({
  threads,
  tables,
  selectedTable,
  scope,
  filter,
  activeThreadId,
  rootDraft,
  replyDraft,
  loading,
  loaded,
  error,
  composerError,
  pendingAction,
  onScopeChange,
  onFilterChange,
  onOpenThread,
  onBack,
  onRootDraftChange,
  onReplyDraftChange,
  onSubmitRoot,
  onSubmitReply,
  onToggleStatus,
  onRetry,
}: CommentsPanelProps) {
  const activeThread = threads.find((thread) => thread.id === activeThreadId) ?? null;
  const scopedThreads = useMemo(() => threads.filter((thread) => {
    if (scope === "diagram") return thread.targetType === "diagram";
    if (scope === "table") return Boolean(selectedTable && thread.targetType === "table" && thread.targetId === selectedTable.id);
    return true;
  }), [scope, selectedTable, threads]);
  const openCount = scopedThreads.filter((thread) => thread.status === "open").length;
  const resolvedCount = scopedThreads.length - openCount;
  const visibleThreads = useMemo(
    () => scopedThreads
      .filter((thread) => thread.status === filter)
      .sort((left, right) => latestThreadActivity(right).localeCompare(latestThreadActivity(left))),
    [filter, scopedThreads],
  );
  const composerTarget = scope === "table" && selectedTable ? selectedTable.name : "the diagram";
  const submittingRoot = pendingAction === "root";

  if (activeThread) {
    const targetLabel = commentTargetLabel(activeThread, tables);
    const isOrphaned = activeThread.targetType === "table" && activeThread.targetExists === false;
    const changingStatus = pendingAction === `status:${activeThread.id}`;
    const submittingReply = pendingAction === `reply:${activeThread.id}`;
    const messages = [activeThread, ...activeThread.replies];

    return (
      <div className="comments-panel thread-view" aria-busy={loading || Boolean(pendingAction)}>
        <div className="comment-thread-toolbar">
          <button className="comment-back-btn" type="button" onClick={onBack} aria-label="Back to comment threads">
            <ArrowLeft size={14} aria-hidden="true" />
          </button>
          <div className={`comment-target-label${isOrphaned ? " orphaned" : ""}`}>
            {isOrphaned ? "Former table" : activeThread.targetType === "diagram" ? "Diagram" : "Table"}
            <strong>{targetLabel}</strong>
          </div>
          {activeThread.canResolve ? (
            <button
              className="comment-status-action"
              type="button"
              onClick={() => onToggleStatus(activeThread)}
              disabled={changingStatus}
            >
              {changingStatus ? <LoaderCircle className="spin" size={12} aria-hidden="true" /> : activeThread.status === "open" ? <CheckCircle2 size={12} aria-hidden="true" /> : <RotateCcw size={12} aria-hidden="true" />}
              {activeThread.status === "open" ? "Resolve" : "Reopen"}
            </button>
          ) : (
            <span className={`comment-status-chip ${activeThread.status}`}>
              {activeThread.status === "open" ? "Open" : "Resolved"}
            </span>
          )}
        </div>

        {isOrphaned && <div className="comment-orphan-note">This table no longer exists. The discussion is preserved.</div>}

        <div className="comment-messages" role="feed" aria-label={`Discussion about ${targetLabel}`}>
          {messages.map((message, index) => (
            <article className={`comment-message${index === 0 ? " root" : ""}`} key={message.id}>
              <div className="comment-avatar" style={{ background: commentAvatarColor(message.author.id) }} aria-hidden="true">
                {initials(message.author.displayName)}
              </div>
              <div className="comment-message-content">
                <div className="comment-message-meta">
                  <strong>{message.author.displayName}</strong>
                  <time dateTime={message.createdAt} title={formatCommentDate(message.createdAt)}>{formatCommentTime(message.createdAt)}</time>
                </div>
                <p>{message.body}</p>
              </div>
            </article>
          ))}
        </div>

        {activeThread.status === "resolved" ? (
          <div className="comment-resolved-note" role="status">
            <CheckCircle2 size={14} aria-hidden="true" />
            This thread is resolved.
          </div>
        ) : (
          <form
            className="comment-composer reply-composer"
            onSubmit={(event) => {
              event.preventDefault();
              onSubmitReply(activeThread.id);
            }}
          >
            <label htmlFor="comment-reply">Reply to this thread</label>
            <textarea
              id="comment-reply"
              value={replyDraft}
              onChange={(event) => onReplyDraftChange(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  onSubmitReply(activeThread.id);
                }
              }}
              placeholder="Reply to this thread..."
              maxLength={COMMENT_BODY_MAX_LENGTH}
              aria-describedby={composerError ? "comment-composer-error" : undefined}
            />
            <div className="comment-composer-footer">
              <span>{replyDraft.length}/{COMMENT_BODY_MAX_LENGTH}</span>
              <button className="comment-submit-btn" type="submit" disabled={!replyDraft.trim() || submittingReply}>
                {submittingReply ? <LoaderCircle className="spin" size={12} aria-hidden="true" /> : <Send size={12} aria-hidden="true" />}
                Reply
              </button>
            </div>
          </form>
        )}
        {composerError && <div className="comment-composer-error thread-action-error" id="comment-composer-error" role="alert">{composerError}</div>}
      </div>
    );
  }

  return (
    <div className="comments-panel" aria-busy={loading || Boolean(pendingAction)}>
      <div className="comment-scope-row" role="group" aria-label="Comment scope">
        <button className={scope === "all" ? "active" : ""} type="button" onClick={() => onScopeChange("all")} aria-pressed={scope === "all"}>All</button>
        <button className={scope === "diagram" ? "active" : ""} type="button" onClick={() => onScopeChange("diagram")} aria-pressed={scope === "diagram"}>Diagram</button>
        {selectedTable && (
          <button className={scope === "table" ? "active" : ""} type="button" onClick={() => onScopeChange("table")} aria-pressed={scope === "table"} title={selectedTable.name}>
            <Table2 size={10} aria-hidden="true" />
            {selectedTable.name}
          </button>
        )}
      </div>

      <div className="comment-filter-row" role="tablist" aria-label="Comment status">
        <button className={filter === "open" ? "active" : ""} type="button" role="tab" aria-selected={filter === "open"} onClick={() => onFilterChange("open")}>Open <span>{openCount}</span></button>
        <button className={filter === "resolved" ? "active" : ""} type="button" role="tab" aria-selected={filter === "resolved"} onClick={() => onFilterChange("resolved")}>Resolved <span>{resolvedCount}</span></button>
        <button className="comment-refresh-btn" type="button" onClick={onRetry} disabled={loading} aria-label="Refresh comments" title="Refresh comments">
          <RefreshCw className={loading ? "spin" : ""} size={12} aria-hidden="true" />
        </button>
      </div>

      <div className="comment-thread-scroll">
        {!loaded && loading ? (
          <div className="comment-loading" role="status"><LoaderCircle className="spin" size={16} aria-hidden="true" />Loading comments...</div>
        ) : !loaded && error ? (
          <div className="comment-empty error-state">
            <MessageSquare size={20} aria-hidden="true" />
            <strong>Comments couldn&apos;t load</strong>
            <span>{error}</span>
            <button className="text-btn" type="button" onClick={onRetry}>Try again</button>
          </div>
        ) : visibleThreads.length === 0 ? (
          <div className="comment-empty">
            {filter === "resolved" ? <CheckCircle2 size={20} aria-hidden="true" /> : <MessageSquare size={20} aria-hidden="true" />}
            <strong>{filter === "resolved" ? "No resolved threads yet." : scope === "table" && selectedTable ? `No comments on ${selectedTable.name} yet.` : "No open comments."}</strong>
            {filter === "open" && <span>{scope === "table" ? "Start a focused discussion below." : "The diagram is ready for review."}</span>}
          </div>
        ) : (
          <ol className="comment-thread-list" aria-label={`${filter === "open" ? "Open" : "Resolved"} comment threads`}>
            {visibleThreads.map((thread) => {
              const targetLabel = commentTargetLabel(thread, tables);
              const isOrphaned = thread.targetType === "table" && thread.targetExists === false;
              return (
                <li key={thread.id}>
                  <button className="comment-thread-card" type="button" onClick={() => onOpenThread(thread.id)}>
                    <div className="comment-thread-card-head">
                      <span className={`comment-target-pill${isOrphaned ? " orphaned" : ""}`}>{isOrphaned ? "Former table" : thread.targetType === "diagram" ? "Diagram" : targetLabel}</span>
                      <time dateTime={latestThreadActivity(thread)} title={formatCommentDate(latestThreadActivity(thread))}>{formatCommentTime(latestThreadActivity(thread))}</time>
                    </div>
                    <div className="comment-thread-author">
                      <span className="comment-avatar small" style={{ background: commentAvatarColor(thread.author.id) }} aria-hidden="true">{initials(thread.author.displayName)}</span>
                      <strong>{thread.author.displayName}</strong>
                    </div>
                    <p>{thread.body}</p>
                    <div className="comment-thread-card-foot">
                      <MessageSquare size={11} aria-hidden="true" />
                      {thread.replies.length === 0 ? "No replies" : `${thread.replies.length} ${thread.replies.length === 1 ? "reply" : "replies"}`}
                      {thread.status === "resolved" && <span className="resolved"><CheckCircle2 size={10} aria-hidden="true" />Resolved</span>}
                    </div>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
        {loaded && error && <div className="comment-stale-note" role="status">Couldn&apos;t refresh comments. Showing the last update.</div>}
      </div>

      <form
        className="comment-composer"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmitRoot();
        }}
      >
        <div className="comment-composer-heading">
          <label htmlFor="new-comment">Start a thread</label>
          <span>On {composerTarget}</span>
        </div>
        <textarea
          id="new-comment"
          value={rootDraft}
          onChange={(event) => onRootDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              onSubmitRoot();
            }
          }}
          placeholder={scope === "table" && selectedTable ? `Comment on ${selectedTable.name}...` : "Comment on the diagram..."}
          maxLength={COMMENT_BODY_MAX_LENGTH}
          aria-describedby={composerError ? "comment-composer-error" : undefined}
        />
        <div className="comment-composer-footer">
          <span>{rootDraft.length}/{COMMENT_BODY_MAX_LENGTH} / Ctrl/Cmd + Enter</span>
          <button className="comment-submit-btn" type="submit" disabled={!rootDraft.trim() || submittingRoot}>
            {submittingRoot ? <LoaderCircle className="spin" size={12} aria-hidden="true" /> : <Send size={12} aria-hidden="true" />}
            Comment
          </button>
        </div>
        {composerError && <div className="comment-composer-error" id="comment-composer-error" role="alert">{composerError}</div>}
      </form>
    </div>
  );
}

function downloadBlob(contents: BlobPart, mime: string, filename: string) {
  const url = URL.createObjectURL(new Blob([contents], { type: mime }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function downloadDataUrl(url: string, filename: string) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function safeFileName(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "relix-schema";
}

function layoutFromNodes(nodes: DiagramNode[]): LayoutMap {
  return Object.fromEntries(
    nodes
      .filter((node) => node.type === "tableCard")
      .map((node) => [node.id, { x: Math.round(node.position.x), y: Math.round(node.position.y) }]),
  );
}

function decodeLayout(value: unknown): LayoutMap {
  if (!value) return {};
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== "object") return {};
    const nested = (parsed as { nodes?: unknown }).nodes;
    if (nested && typeof nested === "object") return nested as LayoutMap;
    return parsed as LayoutMap;
  } catch {
    return {};
  }
}

function qualifiedTableName(table: DbmlTable) {
  return table.schema ? `${table.schema}.${table.name}` : table.name;
}

function validImportedLayout(document: DbmlDocument, value: unknown): LayoutMap | null {
  const layout = decodeLayout(value);
  if (document.tables.length === 0 || Object.keys(layout).length === 0) return null;

  const complete = document.tables.every((table) => {
    const position = layout[table.id] ?? layout[qualifiedTableName(table)] ?? layout[table.name];
    return Boolean(position && Number.isFinite(position.x) && Number.isFinite(position.y));
  });

  return complete ? layout : null;
}

function sourceByteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function diagramStats(document: DbmlDocument) {
  return {
    tables: document.tables.length,
    fields: document.tables.reduce((total, table) => total + table.fields.length, 0),
    relations: document.relations.length,
  };
}

function motionDuration(duration: number) {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : duration;
}

function Workspace() {
  const canvasRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const lineNumbersRef = useRef<HTMLPreElement>(null);
  const commentsHeadingRef = useRef<HTMLSpanElement>(null);
  const importSourceRef = useRef<HTMLTextAreaElement>(null);
  const importPreviewHeadingRef = useRef<HTMLHeadingElement>(null);
  const historySkipRef = useRef(false);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flow = useReactFlow<DiagramNode>();

  const [dbml, setDbml] = useState(DEFAULT_DBML);
  const [documentModel, setDocumentModel] = useState(DEFAULT_DOCUMENT);
  const [nodes, setNodes] = useNodesState<DiagramNode>(buildNodes(DEFAULT_DOCUMENT));
  const [projectName, setProjectName] = useState("Northstar Commerce");
  const [selectedTableId, setSelectedTableId] = useState<string | null>(
    DEFAULT_DOCUMENT.tables.find((table) => table.name === "orders")?.id ?? null,
  );
  const [selectedRelationId, setSelectedRelationId] = useState<string | null>(null);
  const [activeGroup, setActiveGroup] = useState("all");
  const [editorOpen, setEditorOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [inspectorMode, setInspectorMode] = useState<InspectorMode>("details");
  const [editorTab, setEditorTab] = useState<EditorTab>("dbml");
  const [canvasMode, setCanvasMode] = useState<CanvasMode>("select");
  const [modal, setModal] = useState<ModalName>(null);
  const [schemaImportStage, setSchemaImportStage] = useState<SchemaImportStage>("source");
  const [schemaImportFormat, setSchemaImportFormat] = useState<SchemaImportChoice>("auto");
  const [schemaImportSource, setSchemaImportSource] = useState("");
  const [schemaImportSourceBytes, setSchemaImportSourceBytes] = useState(0);
  const [schemaImportFileName, setSchemaImportFileName] = useState<string | undefined>();
  const [schemaImportResult, setSchemaImportResult] = useState<SchemaImportResult | null>(null);
  const [schemaImportSelectedTableIds, setSchemaImportSelectedTableIds] = useState<Set<string>>(new Set());
  const [schemaImportMode, setSchemaImportMode] = useState<"replace" | "merge">("replace");
  const [schemaImportMergeStrategy, setSchemaImportMergeStrategy] = useState<SchemaMergeStrategy>("update");
  const [schemaImportError, setSchemaImportError] = useState<string | null>(null);
  const [schemaImportParsing, setSchemaImportParsing] = useState(false);
  const [schemaImportGenerating, setSchemaImportGenerating] = useState(false);
  const [schemaImportDragActive, setSchemaImportDragActive] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const [outlineQuery, setOutlineQuery] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);
  const [parseLine, setParseLine] = useState<number | undefined>();
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");
  const [backendReady, setBackendReady] = useState(false);
  const [layoutRevision, setLayoutRevision] = useState(0);
  const [isSmartLayouting, setIsSmartLayouting] = useState(false);
  const [relationColors, setRelationColors] = useState<Record<string, string>>({});
  const [members, setMembers] = useState<Member[]>([
    { email: "you@relix.dev", displayName: "You", role: "owner", color: "#51d6f5" },
    { email: "maya@northstar.dev", displayName: "Maya", role: "editor", color: "#9c83ff" },
    { email: "alex@northstar.dev", displayName: "Alex", role: "viewer", color: "#55d99a" },
  ]);
  const [currentUser, setCurrentUser] = useState<CurrentUser>({
    email: "you@relix.dev",
    displayName: "You",
    role: "owner",
  });
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("editor");
  const [toast, setToast] = useState<string | null>(null);
  const [comments, setComments] = useState<ProjectComment[]>([]);
  const [commentsLoaded, setCommentsLoaded] = useState(false);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [commentsError, setCommentsError] = useState<string | null>(null);
  const [commentComposerError, setCommentComposerError] = useState<string | null>(null);
  const [commentScope, setCommentScope] = useState<CommentScope>("all");
  const [commentFilter, setCommentFilter] = useState<CommentStatus>("open");
  const [activeCommentThreadId, setActiveCommentThreadId] = useState<string | null>(null);
  const [rootCommentDraft, setRootCommentDraft] = useState("");
  const [replyCommentDraft, setReplyCommentDraft] = useState("");
  const [commentPendingAction, setCommentPendingAction] = useState<string | null>(null);
  const [presenceSessionId] = useState(() => crypto.randomUUID());
  const [presenceCursors, setPresenceCursors] = useState<PresenceCursor[]>([]);
  const [presenceStatus, setPresenceStatus] = useState<PresenceStatus>("idle");
  const [canvasBounds, setCanvasBounds] = useState<CanvasBounds | null>(null);
  const [historyEntries, setHistoryEntries] = useState<string[]>([DEFAULT_DBML]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const historyIndexRef = useRef(historyIndex);
  const nodesRef = useRef(nodes);
  const documentModelRef = useRef(documentModel);
  const layoutRequestRef = useRef(0);
  const schemaImportRequestRef = useRef(0);
  const commentsRequestRef = useRef(0);
  const presenceRequestRef = useRef(0);
  const presenceLastPointRef = useRef<PresencePoint | null>(null);
  const presenceLastSentAtRef = useRef(0);
  const presenceSendTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const presenceAnnouncedRef = useRef(false);
  const presencePutControllersRef = useRef(new Set<AbortController>());

  const stats = useMemo(() => diagramStats(documentModel), [documentModel]);
  const schemaImportStats = useMemo(
    () => schemaImportResult ? diagramStats(schemaImportResult.document) : null,
    [schemaImportResult],
  );
  const schemaImportWarnings = useMemo(
    () => schemaImportResult?.diagnostics.filter((diagnostic) => diagnostic.level === "warning") ?? [],
    [schemaImportResult],
  );
  const schemaImportAllSelected = Boolean(
    schemaImportResult?.document.tables.length &&
    schemaImportSelectedTableIds.size === schemaImportResult.document.tables.length,
  );
  const schemaImportConflictCount = useMemo(() => {
    if (!schemaImportResult) return 0;
    const existingNames = new Set(
      documentModel.tables.map((table) => qualifiedTableName(table).toLocaleLowerCase("en-US")),
    );
    return schemaImportResult.document.tables.filter(
      (table) => schemaImportSelectedTableIds.has(table.id) &&
        existingNames.has(qualifiedTableName(table).toLocaleLowerCase("en-US")),
    ).length;
  }, [documentModel.tables, schemaImportResult, schemaImportSelectedTableIds]);
  const editorLineNumbers = useMemo(
    () => Array.from({ length: Math.max(1, dbml.split("\n").length) }, (_, index) => index + 1).join("\n"),
    [dbml],
  );
  const generatedExportDisabledProps = parseError
    ? {
        disabled: true,
        "aria-describedby": "generated-export-warning",
        title: GENERATED_EXPORT_BLOCKED_MESSAGE,
        style: { cursor: "not-allowed", opacity: 0.45 } as CSSProperties,
      }
    : {};

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 2800);
  }, []);

  const resetSchemaImport = useCallback(() => {
    schemaImportRequestRef.current += 1;
    layoutRequestRef.current += 1;
    setSchemaImportStage("source");
    setSchemaImportFormat("auto");
    setSchemaImportSource("");
    setSchemaImportSourceBytes(0);
    setSchemaImportFileName(undefined);
    setSchemaImportResult(null);
    setSchemaImportSelectedTableIds(new Set());
    setSchemaImportMode("replace");
    setSchemaImportMergeStrategy("update");
    setSchemaImportError(null);
    setSchemaImportParsing(false);
    setSchemaImportGenerating(false);
    setSchemaImportDragActive(false);
    setIsSmartLayouting(false);
  }, []);

  const openSchemaImport = useCallback(() => {
    resetSchemaImport();
    setModal("import");
  }, [resetSchemaImport]);

  const closeSchemaImport = useCallback(() => {
    schemaImportRequestRef.current += 1;
    layoutRequestRef.current += 1;
    setSchemaImportParsing(false);
    setSchemaImportGenerating(false);
    setSchemaImportDragActive(false);
    setIsSmartLayouting(false);
    setModal(null);
  }, []);

  const backToSchemaImportSource = useCallback(() => {
    schemaImportRequestRef.current += 1;
    setSchemaImportResult(null);
    setSchemaImportSelectedTableIds(new Set());
    setSchemaImportError(null);
    setSchemaImportParsing(false);
    setSchemaImportGenerating(false);
    setSchemaImportStage("source");
  }, []);

  const sendPresencePoint = useCallback((point: PresencePoint) => {
    if (!backendReady || document.visibilityState !== "visible") return;
    presenceLastSentAtRef.current = Date.now();
    presenceAnnouncedRef.current = true;
    const controller = new AbortController();
    presencePutControllersRef.current.add(controller);
    void fetch("/api/presence", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: presenceSessionId, x: point.x, y: point.y }),
      signal: controller.signal,
    }).catch(() => undefined).finally(() => {
      presencePutControllersRef.current.delete(controller);
    });
  }, [backendReady, presenceSessionId]);

  const queuePresencePoint = useCallback((point: PresencePoint) => {
    presenceLastPointRef.current = point;
    const elapsed = Date.now() - presenceLastSentAtRef.current;
    const flush = () => {
      presenceSendTimerRef.current = null;
      const latestPoint = presenceLastPointRef.current;
      if (latestPoint) sendPresencePoint(latestPoint);
    };

    if (elapsed >= PRESENCE_SEND_THROTTLE_MS) {
      if (presenceSendTimerRef.current) clearTimeout(presenceSendTimerRef.current);
      flush();
      return;
    }
    if (!presenceSendTimerRef.current) {
      presenceSendTimerRef.current = setTimeout(flush, PRESENCE_SEND_THROTTLE_MS - elapsed);
    }
  }, [sendPresencePoint]);

  const removePresence = useCallback(() => {
    if (presenceSendTimerRef.current) {
      clearTimeout(presenceSendTimerRef.current);
      presenceSendTimerRef.current = null;
    }
    presenceLastPointRef.current = null;
    for (const controller of presencePutControllersRef.current) controller.abort();
    presencePutControllersRef.current.clear();
    if (!presenceAnnouncedRef.current) return;
    presenceAnnouncedRef.current = false;
    void fetch("/api/presence", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: presenceSessionId }),
      keepalive: true,
    }).catch(() => undefined);
  }, [presenceSessionId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let frame = 0;
    const measure = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const rect = canvas.getBoundingClientRect();
        const next = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
        setCanvasBounds((current) => current &&
          current.left === next.left && current.top === next.top &&
          current.width === next.width && current.height === next.height
          ? current
          : next);
      });
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(canvas);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    measure();
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, []);

  useEffect(() => {
    if (!backendReady) return;
    const reactFlowElement = canvasRef.current?.querySelector<HTMLElement>(".react-flow");
    if (!reactFlowElement) return;
    const handlePointerMove = (event: PointerEvent) => {
      if (!event.isPrimary || event.pointerType === "touch") return;
      const point = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
      queuePresencePoint({ x: point.x, y: point.y });
    };
    reactFlowElement.addEventListener("pointermove", handlePointerMove, { passive: true });
    reactFlowElement.addEventListener("pointerleave", removePresence);
    reactFlowElement.addEventListener("pointercancel", removePresence);
    return () => {
      reactFlowElement.removeEventListener("pointermove", handlePointerMove);
      reactFlowElement.removeEventListener("pointerleave", removePresence);
      reactFlowElement.removeEventListener("pointercancel", removePresence);
      removePresence();
    };
  }, [backendReady, flow, queuePresencePoint, removePresence]);

  useEffect(() => {
    if (!backendReady) return;
    const heartbeat = window.setInterval(() => {
      const point = presenceLastPointRef.current;
      if (
        point &&
        document.visibilityState === "visible" &&
        Date.now() - presenceLastSentAtRef.current >= PRESENCE_HEARTBEAT_MS - PRESENCE_SEND_THROTTLE_MS
      ) {
        sendPresencePoint(point);
      }
    }, PRESENCE_HEARTBEAT_MS);
    return () => window.clearInterval(heartbeat);
  }, [backendReady, sendPresencePoint]);

  useEffect(() => {
    if (!backendReady) return;
    let stopped = false;
    let pollTimer = 0;
    let pollController: AbortController | null = null;
    let retryDelay = PRESENCE_POLL_MS;

    const schedulePoll = (delay: number) => {
      window.clearTimeout(pollTimer);
      if (stopped || document.visibilityState !== "visible") return;
      pollTimer = window.setTimeout(() => void poll(), delay);
    };
    const poll = async () => {
      if (stopped || document.visibilityState !== "visible") return;
      const requestId = presenceRequestRef.current + 1;
      presenceRequestRef.current = requestId;
      pollController = new AbortController();
      try {
        const response = await fetch("/api/presence", { cache: "no-store", signal: pollController.signal });
        if (!response.ok) throw new Error("Presence unavailable");
        const payload = (await response.json()) as { cursors?: unknown; serverTime?: unknown };
        if (!Array.isArray(payload.cursors)) throw new Error("Invalid presence response");
        if (stopped || presenceRequestRef.current !== requestId || document.visibilityState !== "visible") return;
        const nextCursors = payload.cursors.filter(isPresenceCursor);
        setPresenceCursors((current) => presenceCursorsEqual(current, nextCursors) ? current : nextCursors);
        setPresenceStatus("live");
        retryDelay = PRESENCE_POLL_MS;
      } catch (error) {
        if (stopped || presenceRequestRef.current !== requestId || (error instanceof DOMException && error.name === "AbortError")) return;
        setPresenceCursors((current) => current.length === 0 ? current : []);
        setPresenceStatus("offline");
        retryDelay = Math.min(PRESENCE_RETRY_MAX_MS, retryDelay * 2);
      } finally {
        pollController = null;
        if (!stopped) schedulePoll(retryDelay);
      }
    };
    const startPolling = () => {
      if (stopped || document.visibilityState !== "visible") return;
      retryDelay = PRESENCE_POLL_MS;
      setPresenceStatus("connecting");
      schedulePoll(0);
    };
    const handleVisibilityChange = () => {
      presenceRequestRef.current += 1;
      pollController?.abort();
      window.clearTimeout(pollTimer);
      if (document.visibilityState === "hidden") {
        removePresence();
        setPresenceCursors((current) => current.length === 0 ? current : []);
        setPresenceStatus("idle");
      } else {
        startPolling();
      }
    };

    const initialStart = window.setTimeout(startPolling, 0);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      stopped = true;
      presenceRequestRef.current += 1;
      window.clearTimeout(initialStart);
      window.clearTimeout(pollTimer);
      pollController?.abort();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [backendReady, removePresence]);

  useEffect(() => {
    const handlePageExit = () => removePresence();
    window.addEventListener("pagehide", handlePageExit);
    window.addEventListener("beforeunload", handlePageExit);
    return () => {
      window.removeEventListener("pagehide", handlePageExit);
      window.removeEventListener("beforeunload", handlePageExit);
      removePresence();
    };
  }, [removePresence]);

  const handleNodesChange = useCallback((changes: NodeChange<DiagramNode>[]) => {
    if (changes.some((change) => change.type === "position" && change.position)) {
      // A user's drag supersedes any asynchronous auto-layout already running.
      layoutRequestRef.current += 1;
      setIsSmartLayouting(false);
    }
    setNodes((previous) => applyDiagramNodeChanges(documentModelRef.current, changes, previous));
    if (
      changes.some(
        (change) =>
          change.type === "position" &&
          change.position !== undefined &&
          change.dragging !== true,
      )
    ) {
      setLayoutRevision((revision) => revision + 1);
    }
  }, [setNodes]);

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  useEffect(() => {
    documentModelRef.current = documentModel;
  }, [documentModel]);

  useEffect(() => {
    historyIndexRef.current = historyIndex;
  }, [historyIndex]);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (modal !== "import") return;
    const frame = window.requestAnimationFrame(() => {
      if (schemaImportStage === "source") importSourceRef.current?.focus();
      else importPreviewHeadingRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [modal, schemaImportStage]);

  useEffect(() => {
    const preloadExports = () => {
      void Promise.allSettled([
        import("@/lib/schema-export"),
        import("html-to-image"),
      ]);
    };
    if ("requestIdleCallback" in window) {
      const idleId = window.requestIdleCallback(preloadExports, { timeout: 3000 });
      return () => window.cancelIdleCallback(idleId);
    }
    const timer = setTimeout(preloadExports, 1600);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadProject() {
      try {
        const response = await fetch("/api/project", { cache: "no-store" });
        if (!response.ok) throw new Error("Project storage is unavailable");
        const payload = (await response.json()) as {
          project?: { name?: string; dbml?: string; layout?: unknown };
          members?: Member[];
          currentUser?: CurrentUser;
        };
        if (cancelled) return;

        if (payload.project?.name) setProjectName(payload.project.name);
        if (payload.project?.dbml) {
          const parsed = parseDBML(payload.project.dbml);
          if (!parsed.diagnostics.some((diagnostic) => diagnostic.level === "error")) {
            setDbml(payload.project.dbml);
            setDocumentModel(parsed);
            setNodes(buildNodes(parsed, decodeLayout(payload.project.layout)));
            setHistoryEntries([payload.project.dbml]);
            setHistoryIndex(0);
          }
        }
        if (payload.members?.length) setMembers(payload.members);
        if (payload.currentUser) setCurrentUser(payload.currentUser);
        setSaveStatus("saved");
      } catch {
        if (!cancelled) setSaveStatus("offline");
      } finally {
        if (!cancelled) setBackendReady(true);
      }
    }
    void loadProject();
    return () => {
      cancelled = true;
    };
  }, [setNodes]);

  useEffect(() => {
    const timer = setTimeout(() => {
      const parsed = parseDBML(dbml);
      const error = parsed.diagnostics.find((diagnostic) => diagnostic.level === "error");
      if (error) {
        setParseError(error.message);
        setParseLine(error.line);
        return;
      }
      if (parsed.tables.length === 0) {
        setParseError("Add at least one Table block to build a diagram.");
        setParseLine(undefined);
        return;
      }

      setParseError(null);
      setParseLine(undefined);
      startTransition(() => {
        setDocumentModel(parsed);
        setNodes((previous) => {
          const positions = layoutFromNodes(previous);
          return buildNodes(parsed, positions);
        });
      });
    }, 280);

    return () => clearTimeout(timer);
  }, [dbml, setNodes]);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (historySkipRef.current) {
        historySkipRef.current = false;
        return;
      }
      setHistoryEntries((previous) => {
        if (previous[historyIndex] === dbml) return previous;
        const next = [...previous.slice(0, historyIndex + 1), dbml].slice(-30);
        historyIndexRef.current = next.length - 1;
        setHistoryIndex(next.length - 1);
        return next;
      });
    }, 850);
    return () => clearTimeout(timer);
  }, [dbml, historyIndex]);

  const saveProject = useCallback(async () => {
    if (!backendReady || parseError) return;
    setSaveStatus("syncing");
    try {
      const response = await fetch("/api/project", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: projectName,
          dbml,
          layout: layoutFromNodes(nodesRef.current),
        }),
      });
      if (!response.ok) throw new Error("Save rejected");
      setSaveStatus("saved");
    } catch {
      setSaveStatus("offline");
    }
  }, [backendReady, dbml, parseError, projectName]);

  useEffect(() => {
    if (!backendReady) return;
    const timer = setTimeout(() => void saveProject(), 1100);
    return () => clearTimeout(timer);
  }, [backendReady, dbml, layoutRevision, projectName, saveProject]);

  const selectedTable = useMemo(
    () => documentModel.tables.find((table) => table.id === selectedTableId) ?? null,
    [documentModel.tables, selectedTableId],
  );
  const selectedRelation = useMemo(
    () => documentModel.relations.find((relation) => relation.id === selectedRelationId) ?? null,
    [documentModel.relations, selectedRelationId],
  );

  const loadComments = useCallback(async (silent = false) => {
    const requestId = commentsRequestRef.current + 1;
    commentsRequestRef.current = requestId;
    if (!silent) setCommentsLoading(true);
    try {
      const response = await fetch("/api/comments", { cache: "no-store" });
      if (!response.ok) throw new Error(await commentResponseError(response, "Comments are temporarily unavailable."));
      const payload = (await response.json()) as { comments?: unknown };
      if (!Array.isArray(payload.comments)) throw new Error("The comments response was incomplete.");
      if (commentsRequestRef.current !== requestId) return;
      setComments(payload.comments as ProjectComment[]);
      setCommentsLoaded(true);
      setCommentsError(null);
    } catch (error) {
      if (commentsRequestRef.current !== requestId) return;
      setCommentsError(error instanceof Error ? error.message : "Comments are temporarily unavailable.");
    } finally {
      if (commentsRequestRef.current === requestId) setCommentsLoading(false);
    }
  }, []);

  const commentThreads = useMemo(() => buildCommentThreads(comments), [comments]);
  const openCommentThreads = useMemo(
    () => commentThreads.filter((thread) => thread.status === "open"),
    [commentThreads],
  );
  const tableOpenCommentCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const thread of openCommentThreads) {
      if (thread.targetType === "table" && thread.targetId) {
        counts.set(thread.targetId, (counts.get(thread.targetId) ?? 0) + 1);
      }
    }
    return counts;
  }, [openCommentThreads]);

  const openComments = useCallback((scope: CommentScope = "all", tableId?: string) => {
    if (tableId) {
      setSelectedTableId(tableId);
      setSelectedRelationId(null);
      setCommentScope("table");
    } else {
      setCommentScope(scope);
    }
    setCommentFilter("open");
    setActiveCommentThreadId(null);
    setCommentComposerError(null);
    setInspectorMode("comments");
    setInspectorOpen(true);
    if (window.matchMedia("(max-width: 780px)").matches) setEditorOpen(false);
  }, []);

  const openTableComments = useCallback((tableId: string) => {
    openComments("table", tableId);
  }, [openComments]);

  const submitRootComment = useCallback(async () => {
    const body = rootCommentDraft.trim();
    if (!body || commentPendingAction) return;
    const useTableTarget = commentScope === "table" && Boolean(selectedTable);
    setCommentPendingAction("root");
    setCommentComposerError(null);
    try {
      const response = await fetch("/api/comments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          body,
          targetType: useTableTarget ? "table" : "diagram",
          targetId: useTableTarget ? selectedTable?.id : null,
        }),
      });
      if (!response.ok) throw new Error(await commentResponseError(response, "Couldn't post your comment. Try again."));
      const payload = (await response.json()) as { comment?: ProjectComment };
      if (!payload.comment) throw new Error("Couldn't post your comment. Try again.");
      setComments((current) => mergeServerComment(current, payload.comment as ProjectComment));
      setRootCommentDraft("");
      setCommentFilter("open");
      setActiveCommentThreadId(payload.comment.id);
      showToast("Comment posted");
    } catch (error) {
      setCommentComposerError(error instanceof Error ? error.message : "Couldn't post your comment. Try again.");
    } finally {
      setCommentPendingAction(null);
    }
  }, [commentPendingAction, commentScope, rootCommentDraft, selectedTable, showToast]);

  const submitReplyComment = useCallback(async (threadId: string) => {
    const body = replyCommentDraft.trim();
    if (!body || commentPendingAction) return;
    setCommentPendingAction(`reply:${threadId}`);
    setCommentComposerError(null);
    try {
      const response = await fetch("/api/comments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body, parentId: threadId }),
      });
      if (!response.ok) throw new Error(await commentResponseError(response, "Couldn't post your reply. Try again."));
      const payload = (await response.json()) as { comment?: ProjectComment };
      if (!payload.comment) throw new Error("Couldn't post your reply. Try again.");
      setComments((current) => mergeServerComment(current, payload.comment as ProjectComment));
      setReplyCommentDraft("");
      showToast("Reply posted");
    } catch (error) {
      setCommentComposerError(error instanceof Error ? error.message : "Couldn't post your reply. Try again.");
    } finally {
      setCommentPendingAction(null);
    }
  }, [commentPendingAction, replyCommentDraft, showToast]);

  const toggleCommentStatus = useCallback(async (thread: CommentThread) => {
    if (commentPendingAction) return;
    const status: CommentStatus = thread.status === "open" ? "resolved" : "open";
    setCommentPendingAction(`status:${thread.id}`);
    setCommentComposerError(null);
    try {
      const response = await fetch("/api/comments", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: thread.id, status }),
      });
      if (!response.ok) throw new Error(await commentResponseError(response, `Couldn't ${status === "resolved" ? "resolve" : "reopen"} this thread.`));
      const payload = (await response.json()) as { comment?: ProjectComment };
      if (!payload.comment) throw new Error(`Couldn't ${status === "resolved" ? "resolve" : "reopen"} this thread.`);
      setComments((current) => mergeServerComment(current, payload.comment as ProjectComment));
      showToast(status === "resolved" ? "Thread resolved" : "Thread reopened");
    } catch (error) {
      setCommentComposerError(error instanceof Error ? error.message : "Couldn't update this thread.");
    } finally {
      setCommentPendingAction(null);
    }
  }, [commentPendingAction, showToast]);

  useEffect(() => {
    if (!backendReady || commentsLoaded) return;
    const timer = window.setTimeout(() => void loadComments(true), 0);
    return () => window.clearTimeout(timer);
  }, [backendReady, commentsLoaded, loadComments]);

  useEffect(() => {
    if (!(inspectorOpen && inspectorMode === "comments")) return;
    const refresh = () => {
      if (document.visibilityState === "visible") void loadComments(true);
    };
    const initialRefresh = window.setTimeout(refresh, 0);
    const timer = window.setInterval(refresh, 15000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearTimeout(initialRefresh);
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [inspectorMode, inspectorOpen, loadComments]);

  useEffect(() => {
    if (!(inspectorOpen && inspectorMode === "comments")) return;
    const frame = window.requestAnimationFrame(() => commentsHeadingRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [inspectorMode, inspectorOpen]);

  const effectiveCommentScope: CommentScope = commentScope === "table" && !selectedTable ? "diagram" : commentScope;

  const connectedTableIds = useMemo(() => {
    const connected = new Set<string>();
    if (selectedRelation) {
      connected.add(selectedRelation.fromTableId);
      connected.add(selectedRelation.toTableId);
    } else if (selectedTableId) {
      connected.add(selectedTableId);
      for (const relation of documentModel.relations) {
        if (relation.fromTableId === selectedTableId || relation.toTableId === selectedTableId) {
          connected.add(relation.fromTableId);
          connected.add(relation.toTableId);
        }
      }
    }
    return connected;
  }, [documentModel.relations, selectedRelation, selectedTableId]);

  const diagramGroups = useMemo(() => getDiagramGroups(documentModel), [documentModel]);
  const activeGroupModel = useMemo(
    () => diagramGroups.find((group) => group.id === activeGroup),
    [activeGroup, diagramGroups],
  );

  const displayNodes = useMemo(() => {
    const hasFocus = Boolean(selectedTable || selectedRelation);
    const activeTableIds = activeGroupModel ? new Set(activeGroupModel.tableIds) : null;
    return nodes.map((node) => {
      if (node.type === "groupFrame") {
        const groupData = node.data as GroupNodeData;
        const hidden = activeGroup !== "all" && groupData.group.id !== activeGroup;
        const draggable = canvasMode === "select";
        return Boolean(node.hidden) === hidden && node.draggable === draggable ? node : { ...node, hidden, draggable };
      }
      const tableData = node.data as TableNodeData;
      const hidden = Boolean(activeTableIds && !activeTableIds.has(node.id));
      const dimmed = hasFocus && !connectedTableIds.has(node.id);
      const openCommentCount = tableOpenCommentCounts.get(node.id) ?? 0;
      const sameHidden = Boolean(node.hidden) === hidden;
      const sameDimmed = tableData.dimmed === dimmed;
      const sameComments = tableData.openCommentCount === openCommentCount && tableData.onOpenComments === openTableComments;
      return sameHidden && sameDimmed && sameComments
        ? node
        : {
            ...node,
            hidden,
            data: { ...tableData, dimmed, openCommentCount, onOpenComments: openTableComments },
          };
    });
  }, [activeGroup, activeGroupModel, canvasMode, connectedTableIds, nodes, openTableComments, selectedRelation, selectedTable, tableOpenCommentCounts]);

  const routingRectangles = useMemo(() => {
    const visible = activeGroupModel ? new Set(activeGroupModel.tableIds) : null;
    return nodes.filter((node) => node.type === "tableCard" && (!visible || visible.has(node.id))).map((node) => ({
      id: node.id, ...node.position, width: TABLE_NODE_WIDTH, height: tableNodeHeight((node.data as TableNodeData).table),
    }));
  }, [nodes, activeGroupModel]);

  const displayEdges = useMemo(() => {
    const hasFocus = Boolean(selectedTable || selectedRelation);
    const visibleIds = activeGroupModel ? new Set(activeGroupModel.tableIds) : null;
    const rectangleById = new Map(routingRectangles.map((rectangle) => [rectangle.id, rectangle]));
    return documentModel.relations.flatMap((relation, index) => {
      const source = rectangleById.get(relation.fromTableId);
      const target = rectangleById.get(relation.toTableId);
      if (!source || !target) return [];
      const ports = chooseRelationPorts(source, target);
      const related = connectedTableIds.has(relation.fromTableId) && connectedTableIds.has(relation.toTableId);
      const highlighted = relation.id === selectedRelationId || (selectedTableId !== null && related);
      const color = relationColors[relation.id] ?? "#51d6f5";
      return [{
        id: relation.id,
        source: relation.fromTableId,
        target: relation.toTableId,
        sourceHandle: `${relation.fromFieldId}:source:${ports.source}`,
        targetHandle: `${relation.toFieldId}:target:${ports.target}`,
        type: "smartRelation",
        data: { rectangles: routingRectangles, lane: (index % 4) * 4 },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: highlighted ? color : "var(--edge-muted)",
          width: 12,
          height: 12,
        },
        className: `${hasFocus && !related ? "dimmed" : ""} ${highlighted ? "highlighted" : ""}`.trim(),
        animated: relation.id === selectedRelationId,
        hidden: visibleIds ? !visibleIds.has(relation.fromTableId) || !visibleIds.has(relation.toTableId) : false,
        style: { "--edge-color": color } as CSSProperties,
        zIndex: highlighted ? 8 : 1,
      }];
    });
  }, [activeGroupModel, connectedTableIds, documentModel.relations, relationColors, routingRectangles, selectedRelation, selectedRelationId, selectedTable, selectedTableId]);

  const tableRelations = useMemo(() => {
    if (!selectedTable) return [];
    return documentModel.relations.filter(
      (relation) => relation.fromTableId === selectedTable.id || relation.toTableId === selectedTable.id,
    );
  }, [documentModel.relations, selectedTable]);

  const focusTable = useCallback(
    (tableId: string) => {
      const node = nodes.find((candidate) => candidate.id === tableId);
      if (!node || node.type !== "tableCard") return;
      setSelectedTableId(tableId);
      setSelectedRelationId(null);
      if (inspectorMode === "comments") {
        setCommentScope("table");
        setActiveCommentThreadId(null);
        setCommentComposerError(null);
      }
      setInspectorOpen(true);
      setModal(null);
      void flow.setCenter(node.position.x + TABLE_NODE_WIDTH / 2, node.position.y + tableNodeHeight((node.data as TableNodeData).table) / 2, {
        zoom: 1,
        duration: motionDuration(420),
      });
    },
    [flow, inspectorMode, nodes],
  );

  const fitDiagram = useCallback(() => {
    void flow.fitView({ padding: 0.14, duration: motionDuration(420), includeHiddenNodes: false });
  }, [flow]);

  const applySmartLayout = useCallback(async () => {
    if (isSmartLayouting || documentModel.tables.length === 0) return;
    const sourceDocument = documentModel;
    const requestId = layoutRequestRef.current + 1;
    layoutRequestRef.current = requestId;
    setIsSmartLayouting(true);
    showToast("Analyzing groups and relationships…");

    try {
      const { computeAutoLayout } = await import("@/lib/auto-layout");
      const result = await computeAutoLayout(sourceDocument);
      if (layoutRequestRef.current !== requestId || documentModelRef.current !== sourceDocument) return;

      setNodes(
        buildNodes(sourceDocument, result.positions).map((node) => (
          node.type === "tableCard"
            ? { ...node, selected: node.id === selectedTableId }
            : node
        )),
      );
      setLayoutRevision((revision) => revision + 1);
      const groupSummary = result.stats.groups > 0 ? ` in ${result.stats.groups} groups` : "";
      showToast(`Smart layout applied · ${result.stats.tables} tables${groupSummary}`);
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(fitDiagram);
      });
    } catch {
      if (layoutRequestRef.current === requestId) {
        showToast("Couldn’t arrange this diagram. Your layout is unchanged.");
      }
    } finally {
      if (layoutRequestRef.current === requestId) setIsSmartLayouting(false);
    }
  }, [documentModel, fitDiagram, isSmartLayouting, selectedTableId, setNodes, showToast]);

  const appendDbml = useCallback((snippet: string) => {
    setDbml((current) => `${current.trimEnd()}\n\n${snippet}\n`);
    setEditorOpen(true);
    setEditorTab("dbml");
    window.setTimeout(() => {
      if (!editorRef.current) return;
      editorRef.current.focus();
      editorRef.current.selectionStart = editorRef.current.value.length;
      editorRef.current.selectionEnd = editorRef.current.value.length;
    }, 50);
  }, []);

  const addTable = useCallback(() => {
    let index = documentModel.tables.length + 1;
    let name = `new_table_${index}`;
    const existing = new Set(documentModel.tables.map((table) => table.name));
    while (existing.has(name)) {
      index += 1;
      name = `new_table_${index}`;
    }
    appendDbml(`Table ${name} {\n  id uuid [pk]\n  created_at timestamp [not null]\n}`);
    showToast(`${name} added to DBML`);
  }, [appendDbml, documentModel.tables, showToast]);

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target || !connection.sourceHandle || !connection.targetHandle) return;
      const sourceTable = documentModel.tables.find((table) => table.id === connection.source);
      const targetTable = documentModel.tables.find((table) => table.id === connection.target);
      const sourceFieldId = connection.sourceHandle.replace(/:(?:source|target)(?::(?:left|right))?$/, "");
      const targetFieldId = connection.targetHandle.replace(/:(?:source|target)(?::(?:left|right))?$/, "");
      const sourceField = sourceTable?.fields.find((field) => field.id === sourceFieldId);
      const targetField = targetTable?.fields.find((field) => field.id === targetFieldId);
      if (!sourceTable || !targetTable || !sourceField || !targetField) return;
      appendDbml(`Ref: ${qualifiedTableName(sourceTable)}.${sourceField.name} > ${qualifiedTableName(targetTable)}.${targetField.name}`);
      showToast("Relationship added");
    },
    [appendDbml, documentModel.tables, showToast],
  );

  const undo = useCallback(() => {
    if (historyIndex <= 0) return;
    const nextIndex = historyIndex - 1;
    historySkipRef.current = true;
    historyIndexRef.current = nextIndex;
    setHistoryIndex(nextIndex);
    setDbml(historyEntries[nextIndex]);
  }, [historyEntries, historyIndex]);

  const redo = useCallback(() => {
    if (historyIndex >= historyEntries.length - 1) return;
    const nextIndex = historyIndex + 1;
    historySkipRef.current = true;
    historyIndexRef.current = nextIndex;
    setHistoryIndex(nextIndex);
    setDbml(historyEntries[nextIndex]);
  }, [historyEntries, historyIndex]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const modifier = event.metaKey || event.ctrlKey;
      const target = event.target as HTMLElement | null;
      const isTyping = target?.tagName === "TEXTAREA" || target?.tagName === "INPUT" || target?.tagName === "SELECT" || target?.isContentEditable === true || Boolean(target?.closest('[role="textbox"]'));

      if (modifier && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandQuery("");
        setModal("command");
        return;
      }
      if (modifier && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveProject();
        showToast("Workspace saved");
        return;
      }
      if (modifier && !isTyping && !modal && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (modifier && !isTyping && !modal && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redo();
        return;
      }
      if (event.key === "Escape") {
        if (modal) {
          if (modal === "import") closeSchemaImport();
          else setModal(null);
          return;
        }
        if (inspectorOpen && inspectorMode === "comments") {
          if (isTyping) {
            target?.blur();
            return;
          }
          if (activeCommentThreadId) {
            setActiveCommentThreadId(null);
            setReplyCommentDraft("");
            setCommentComposerError(null);
            return;
          }
          setInspectorOpen(false);
          return;
        }
        setModal(null);
        setSelectedRelationId(null);
        setSelectedTableId(null);
        return;
      }
      if (!isTyping && event.key.toLowerCase() === "c") {
        event.preventDefault();
        openComments(selectedTableId ? "table" : "all", selectedTableId ?? undefined);
        return;
      }
      if (!isTyping && event.key.toLowerCase() === "l") {
        event.preventDefault();
        void applySmartLayout();
        return;
      }
      if (!isTyping && event.key.toLowerCase() === "f") {
        event.preventDefault();
        fitDiagram();
      }
      if (!isTyping && event.key === "0") {
        event.preventDefault();
        void flow.setViewport({ x: 0, y: 0, zoom: 1 }, { duration: 300 });
      }
      if (!isTyping && event.key === "/") {
        event.preventDefault();
        setModal("command");
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeCommentThreadId, applySmartLayout, closeSchemaImport, fitDiagram, flow, inspectorMode, inspectorOpen, modal, openComments, redo, saveProject, selectedTableId, showToast, undo]);

  const exportDbml = useCallback(() => {
    downloadBlob(dbml, "text/plain;charset=utf-8", `${safeFileName(projectName)}.dbml`);
    setModal(null);
    showToast("DBML exported");
  }, [dbml, projectName, showToast]);

  const exportGeneratedSchema = useCallback(async (
    format: SchemaExportFormat,
    mime: string,
    suffix: string,
    label: string,
  ) => {
    if (parseError) {
      showToast(GENERATED_EXPORT_BLOCKED_MESSAGE);
      return;
    }
    try {
      const { exportSchema } = await import("@/lib/schema-export");
      downloadBlob(
        exportSchema(documentModel, format),
        mime,
        `${safeFileName(projectName)}.${suffix}`,
      );
      setModal(null);
      showToast(`${label} exported`);
    } catch {
      showToast(`${label} export could not finish`);
    }
  }, [documentModel, parseError, projectName, showToast]);

  const exportPostgres = useCallback(() => void exportGeneratedSchema(
    "postgresql", "text/sql;charset=utf-8", "postgres.sql", "PostgreSQL",
  ), [exportGeneratedSchema]);

  const exportMysql = useCallback(() => void exportGeneratedSchema(
    "mysql", "text/sql;charset=utf-8", "mysql.sql", "MySQL",
  ), [exportGeneratedSchema]);

  const exportSqlite = useCallback(() => void exportGeneratedSchema(
    "sqlite", "text/sql;charset=utf-8", "sqlite.sql", "SQLite",
  ), [exportGeneratedSchema]);

  const exportPrisma = useCallback(() => void exportGeneratedSchema(
    "prisma", "text/plain;charset=utf-8", "prisma", "Prisma schema",
  ), [exportGeneratedSchema]);

  const exportDrizzle = useCallback(() => void exportGeneratedSchema(
    "drizzle", "text/typescript;charset=utf-8", "drizzle.ts", "Drizzle schema",
  ), [exportGeneratedSchema]);

  const exportJsonSchemaFile = useCallback(() => void exportGeneratedSchema(
    "json-schema", "application/schema+json;charset=utf-8", "schema.json", "JSON Schema",
  ), [exportGeneratedSchema]);

  const exportRelixSnapshot = useCallback(() => {
    const snapshot = JSON.stringify(
      { version: 1, project: { name: projectName, dbml, layout: layoutFromNodes(nodesRef.current) } },
      null,
      2,
    );
    downloadBlob(snapshot, "application/json", `${safeFileName(projectName)}.relix.json`);
    setModal(null);
    showToast("Relix snapshot exported");
  }, [dbml, projectName, showToast]);

  const exportPng = useCallback(async () => {
    const viewport = canvasRef.current?.querySelector(".react-flow__viewport") as HTMLElement | null;
    if (!viewport) return;
    setModal(null);
    showToast("Rendering diagram…");
    try {
      const imageModule = import("html-to-image");
      await flow.fitView({ padding: 0.08, duration: 250, includeHiddenNodes: false });
      await new Promise((resolve) => window.setTimeout(resolve, 320));
      const { toPng } = await imageModule;
      const dataUrl = await toPng(viewport, {
        cacheBust: true,
        pixelRatio: 2,
        backgroundColor: document.documentElement.dataset.theme === "light" ? "#e9eef4" : "#070a0f",
      });
      downloadDataUrl(dataUrl, `${safeFileName(projectName)}.png`);
      showToast("PNG exported");
    } catch {
      showToast("PNG export could not finish");
    }
  }, [flow, projectName, showToast]);

  const updateSchemaImportSource = useCallback((nextSource: string) => {
    const nextBytes = sourceByteLength(nextSource);
    if (nextBytes > SCHEMA_IMPORT_MAX_BYTES) {
      setSchemaImportError("Schema source is larger than 2 MB. Split it into smaller imports and try again.");
      return;
    }
    setSchemaImportSource(nextSource);
    setSchemaImportSourceBytes(nextBytes);
    setSchemaImportFileName(undefined);
    setSchemaImportResult(null);
    setSchemaImportError(null);
  }, []);

  const readSchemaImportFile = useCallback(async (file: File) => {
    const requestId = schemaImportRequestRef.current + 1;
    schemaImportRequestRef.current = requestId;
    setSchemaImportError(null);
    setSchemaImportParsing(true);

    try {
      if (file.size > SCHEMA_IMPORT_MAX_BYTES) {
        throw new Error("This file is larger than 2 MB. Split it into smaller schema files and try again.");
      }
      if (!/\.(dbml|sql|prisma|ts|json|txt)$/i.test(file.name)) {
        throw new Error("Choose a DBML, SQL, Prisma, TypeScript, JSON, or text schema file.");
      }

      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      const contents = await file.text();
      const contentBytes = sourceByteLength(contents);
      if (contentBytes > SCHEMA_IMPORT_MAX_BYTES) {
        throw new Error("This file is larger than 2 MB. Split it into smaller schema files and try again.");
      }
      if (schemaImportRequestRef.current !== requestId) return;

      setSchemaImportSource(contents);
      setSchemaImportSourceBytes(contentBytes);
      setSchemaImportFileName(file.name);
      setSchemaImportFormat("auto");
      setSchemaImportResult(null);
      setSchemaImportError(null);
    } catch (error) {
      if (schemaImportRequestRef.current === requestId) {
        setSchemaImportError(error instanceof Error ? error.message : "The schema file could not be read.");
      }
    } finally {
      if (schemaImportRequestRef.current === requestId) setSchemaImportParsing(false);
    }
  }, []);

  const parseSchemaImportSource = useCallback(async () => {
    if (!schemaImportSource.trim()) {
      setSchemaImportError("Paste a schema or choose a schema file before parsing.");
      importSourceRef.current?.focus();
      return;
    }
    if (schemaImportSourceBytes > SCHEMA_IMPORT_MAX_BYTES) {
      setSchemaImportError("Schema source is larger than 2 MB. Split it into smaller imports and try again.");
      return;
    }

    const requestId = schemaImportRequestRef.current + 1;
    schemaImportRequestRef.current = requestId;
    setSchemaImportError(null);
    setSchemaImportResult(null);
    setSchemaImportParsing(true);

    try {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      const { parseSchemaImport } = await import("@/lib/schema-import");
      const result = await Promise.resolve(parseSchemaImport(schemaImportSource, {
        format: schemaImportFormat,
        fileName: schemaImportFileName,
      }));
      if (schemaImportRequestRef.current !== requestId) return;

      const error = result.diagnostics.find((diagnostic) => diagnostic.level === "error");
      if (error || result.document.tables.length === 0) {
        throw new Error(error?.message ?? "No tables were found in this schema.");
      }

      setSchemaImportResult(result);
      setSchemaImportSelectedTableIds(new Set(result.document.tables.map((table) => table.id)));
      setSchemaImportMode("replace");
      setSchemaImportMergeStrategy("update");
      setSchemaImportStage("preview");
    } catch (error) {
      if (schemaImportRequestRef.current === requestId) {
        setSchemaImportError(error instanceof Error ? error.message : "This schema could not be parsed.");
      }
    } finally {
      if (schemaImportRequestRef.current === requestId) setSchemaImportParsing(false);
    }
  }, [schemaImportFileName, schemaImportFormat, schemaImportSource, schemaImportSourceBytes]);

  const toggleSchemaImportTable = useCallback((tableId: string) => {
    setSchemaImportSelectedTableIds((current) => {
      const next = new Set(current);
      if (next.has(tableId)) next.delete(tableId);
      else next.add(tableId);
      return next;
    });
    setSchemaImportError(null);
  }, []);

  const toggleAllSchemaImportTables = useCallback(() => {
    if (!schemaImportResult) return;
    setSchemaImportSelectedTableIds(schemaImportAllSelected
      ? new Set()
      : new Set(schemaImportResult.document.tables.map((table) => table.id)));
    setSchemaImportError(null);
  }, [schemaImportAllSelected, schemaImportResult]);

  const generateSchemaImport = useCallback(async () => {
    if (!schemaImportResult || schemaImportSelectedTableIds.size === 0) {
      setSchemaImportError("Select at least one table to generate a diagram.");
      return;
    }

    const requestId = schemaImportRequestRef.current + 1;
    const layoutRequestId = layoutRequestRef.current + 1;
    const currentDocument = documentModelRef.current;
    schemaImportRequestRef.current = requestId;
    layoutRequestRef.current = layoutRequestId;
    setSchemaImportError(null);
    setSchemaImportGenerating(true);

    try {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      const { filterSchemaDocument, mergeSchemaDocuments } = await import("@/lib/schema-import");
      const importedDocument = filterSchemaDocument(
        schemaImportResult.document,
        schemaImportSelectedTableIds,
      );
      const nextDocument = schemaImportMode === "merge"
        ? mergeSchemaDocuments(currentDocument, importedDocument, schemaImportMergeStrategy).document
        : importedDocument;
      const nextDbml = `${serializeDBML(nextDocument, { includeGeneratedHeader: true }).trimEnd()}\n`;
      const restoredLayout = schemaImportMode === "replace" && schemaImportResult.format === "relix"
        ? validImportedLayout(importedDocument, schemaImportResult.layout)
        : null;
      let nextLayout = restoredLayout;
      let arranged = false;

      if (!nextLayout) {
        setIsSmartLayouting(true);
        const { computeAutoLayout } = await import("@/lib/auto-layout");
        nextLayout = (await computeAutoLayout(nextDocument)).positions;
        arranged = true;
      }

      if (
        schemaImportRequestRef.current !== requestId ||
        layoutRequestRef.current !== layoutRequestId
      ) return;
      if (documentModelRef.current !== currentDocument) {
        setSchemaImportError("The project changed while this import was being arranged. Review it and generate again.");
        return;
      }

      setHistoryEntries((previous) => {
        const activeIndex = Math.min(historyIndexRef.current, previous.length - 1);
        if (previous[activeIndex] === nextDbml) return previous;
        const nextHistory = [...previous.slice(0, activeIndex + 1), nextDbml].slice(-30);
        historyIndexRef.current = nextHistory.length - 1;
        setHistoryIndex(nextHistory.length - 1);
        return nextHistory;
      });

      documentModelRef.current = nextDocument;
      setDbml(nextDbml);
      setDocumentModel(nextDocument);
      setNodes(buildNodes(nextDocument, nextLayout));
      setParseError(null);
      setParseLine(undefined);
      setSelectedTableId(nextDocument.tables[0]?.id ?? null);
      setSelectedRelationId(null);
      setActiveGroup("all");
      setEditorOpen(true);
      setEditorTab("dbml");
      if (schemaImportMode === "replace" && schemaImportResult.format === "relix" && schemaImportResult.projectName) {
        setProjectName(schemaImportResult.projectName);
      }
      setLayoutRevision((revision) => revision + 1);
      setModal(null);
      setSchemaImportGenerating(false);
      setIsSmartLayouting(false);
      window.requestAnimationFrame(() => window.requestAnimationFrame(fitDiagram));
      showToast(
        `Generated ${nextDocument.tables.length} tables and ${nextDocument.relations.length} relations${arranged ? " · smart layout" : " · restored layout"}. Press Ctrl+Z to undo.`,
      );
    } catch (error) {
      if (schemaImportRequestRef.current === requestId) {
        setSchemaImportError(error instanceof Error ? error.message : "The diagram could not be generated.");
      }
    } finally {
      if (schemaImportRequestRef.current === requestId) setSchemaImportGenerating(false);
      if (layoutRequestRef.current === layoutRequestId) setIsSmartLayouting(false);
    }
  }, [fitDiagram, schemaImportMergeStrategy, schemaImportMode, schemaImportResult, schemaImportSelectedTableIds, setNodes, showToast]);

  const onImportInput = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) void readSchemaImportFile(file);
    event.target.value = "";
  }, [readSchemaImportFile]);

  const onDropFile = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setSchemaImportDragActive(false);
    const file = event.dataTransfer.files?.[0];
    if (file) void readSchemaImportFile(file);
  }, [readSchemaImportFile]);

  const inviteMember = useCallback(async () => {
    const email = inviteEmail.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      showToast("Enter a valid email address");
      return;
    }
    try {
      const response = await fetch("/api/project", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, role: inviteRole }),
      });
      if (!response.ok) throw new Error("Invite could not be sent");
      const payload = (await response.json()) as { members?: Member[]; member?: Member };
      if (payload.members) setMembers(payload.members);
      else if (payload.member) {
        setMembers((current) => [
          ...current.filter((member) => member.email !== payload.member?.email),
          payload.member as Member,
        ]);
      }
      setInviteEmail("");
      showToast(`${email} added as ${inviteRole}`);
    } catch {
      setMembers((current) => [
        ...current.filter((member) => member.email !== email),
        { email, role: inviteRole, color: GROUP_PALETTE[current.length % GROUP_PALETTE.length] },
      ]);
      setInviteEmail("");
      showToast("Invite added to this session");
    }
  }, [inviteEmail, inviteRole, showToast]);

  const copyShareLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      showToast("Private link copied");
    } catch {
      showToast("Copy the URL from your browser");
    }
  }, [showToast]);

  const commandItems = useMemo(() => {
    const query = commandQuery.trim().toLowerCase();
    const tables = documentModel.tables
      .filter((table) => {
        if (!query) return true;
        return (
          table.name.toLowerCase().includes(query) ||
          table.fields.some((field) => field.name.toLowerCase().includes(query))
        );
      })
      .slice(0, 8);
    return tables;
  }, [commandQuery, documentModel.tables]);

  const commandActionMatches = useMemo(() => {
    const query = commandQuery.trim().toLowerCase();
    const matches = (keywords: string) => !query || keywords.includes(query);
    return {
      add: matches("add create new table entity"),
      comments: matches("comment comments review discuss discussion collaborate feedback"),
      layout: matches("smart auto layout arrange organize group relationship relation diagram"),
      fit: matches("fit center zoom view diagram canvas"),
      export: matches("export download schema dbml prisma mysql sqlite drizzle json"),
    };
  }, [commandQuery]);

  const hasCommandActionMatch = Object.values(commandActionMatches).some(Boolean);

  const outlineTables = useMemo(() => {
    const query = outlineQuery.trim().toLowerCase();
    if (!query) return documentModel.tables;
    return documentModel.tables.filter(
      (table) =>
        table.name.toLowerCase().includes(query) ||
        table.fields.some((field) => field.name.toLowerCase().includes(query)),
    );
  }, [documentModel.tables, outlineQuery]);

  const historyItems = useMemo(
    () => [
      { title: "Schema synchronized", subtitle: `${stats.tables} tables · ${stats.relations} relations`, time: "Now" },
      { title: "orders.status refined", subtitle: displayName(currentUser), time: "8m" },
      { title: "Checkout group created", subtitle: "Maya Chen", time: "24m" },
      { title: "Initial DBML imported", subtitle: displayName(currentUser), time: "1h" },
    ],
    [currentUser, stats.relations, stats.tables],
  );

  const openPanel = (tab: EditorTab) => {
    setEditorTab(tab);
    setEditorOpen(true);
  };

  return (
    <main className="relix-app">
      <header className="topbar">
        <div className="brand" aria-label="Relix home">
          <div className="brand-mark" aria-hidden="true" />
          <span className="brand-word">relix</span>
          <span className="beta-tag">Beta</span>
        </div>

        <div className="project-bar">
          <span className="project-kicker">Workspace</span>
          <span className="project-slash">/</span>
          <input
            className="project-name"
            value={projectName}
            onChange={(event) => setProjectName(event.target.value)}
            aria-label="Project name"
          />
          <span className="engine-pill">
            <Database size={10} aria-hidden="true" />
            PostgreSQL
          </span>
          <span className={`save-state ${saveStatus}`} aria-live="polite">
            <span className="save-dot" />
            <span>{saveStatus === "saved" ? "All changes saved" : saveStatus === "syncing" ? "Syncing" : "Local mode"}</span>
          </span>
        </div>

        <div className="top-actions">
          <button className="icon-btn hide-mobile" onClick={undo} disabled={historyIndex <= 0} aria-label="Undo" title="Undo">
            <Undo2 size={14} />
          </button>
          <button
            className="icon-btn hide-mobile"
            onClick={redo}
            disabled={historyIndex >= historyEntries.length - 1}
            aria-label="Redo"
            title="Redo"
          >
            <Redo2 size={14} />
          </button>
          <div className="divider-vertical" />
          <ThemeSwitcher />
          <div className="avatars" aria-label={`${members.length} collaborators`}>
            {members.slice(0, 3).map((member, index) => (
              <div
                className="avatar"
                key={member.email}
                style={{ background: member.color ?? GROUP_PALETTE[index % GROUP_PALETTE.length] }}
                title={`${displayName(member)} · ${member.role}`}
              >
                {initials(displayName(member))}
              </div>
            ))}
          </div>
          <button className="text-btn hide-mobile comments-top-trigger" onClick={() => openComments("all")} aria-label={`Open comments${openCommentThreads.length > 0 ? `, ${openCommentThreads.length} open` : ""}`} title="Comments (C)">
            <MessageSquare size={13} aria-hidden="true" />
            <span className="action-label">Comments</span>
            {openCommentThreads.length > 0 && <span className="comment-count-badge">{openCommentThreads.length > 99 ? "99+" : openCommentThreads.length}</span>}
          </button>
          <button className="text-btn import-trigger mobile-essential" onClick={openSchemaImport} aria-label="Import schema" title="Import schema">
            <Import size={13} />
            <span className="action-label">Import</span>
          </button>
          <button className="text-btn mobile-essential" onClick={() => setModal("export")}>
            <Download size={13} />
            <span className="action-label">Export</span>
          </button>
          <button className="primary-btn mobile-essential" onClick={() => setModal("share")}>
            <Share2 size={13} />
            <span className="action-label">Share</span>
          </button>
        </div>
      </header>

      <section className="workspace">
        <nav className="activity-rail" aria-label="Workspace tools">
          <button
            className={`rail-btn ${editorOpen && editorTab === "dbml" ? "active" : ""}`}
            onClick={() => (editorOpen && editorTab === "dbml" ? setEditorOpen(false) : openPanel("dbml"))}
            aria-label="DBML editor"
            title="DBML editor"
          >
            <Code2 size={17} />
          </button>
          <button className="rail-btn" onClick={() => setModal("command")} aria-label="Search schema" title="Search schema">
            <Search size={17} />
          </button>
          <button
            className={`rail-btn ${editorOpen && editorTab === "outline" ? "active" : ""}`}
            onClick={() => openPanel("outline")}
            aria-label="Schema outline and groups"
            title="Schema outline and groups"
          >
            <Boxes size={17} />
          </button>
          <button
            className={`rail-btn ${inspectorOpen && inspectorMode === "comments" ? "active" : ""}`}
            onClick={() => (inspectorOpen && inspectorMode === "comments" ? setInspectorOpen(false) : openComments("all"))}
            aria-label={`Comments${openCommentThreads.length > 0 ? `, ${openCommentThreads.length} open threads` : ""}`}
            title="Comments (C)"
          >
            <MessageSquare size={17} aria-hidden="true" />
            {openCommentThreads.length > 0 && <span className="rail-count-badge">{openCommentThreads.length > 9 ? "9+" : openCommentThreads.length}</span>}
          </button>
          <button
            className={`rail-btn ${editorOpen && editorTab === "history" ? "active" : ""}`}
            onClick={() => openPanel("history")}
            aria-label="Version history"
            title="Version history"
          >
            <History size={17} />
          </button>
          <div className="rail-spacer" />
          <button className="rail-btn" onClick={() => showToast("Workspace settings are ready for your team")} aria-label="Settings" title="Settings">
            <Settings2 size={17} />
          </button>
          <div className="avatar" style={{ background: "#51d6f5", margin: "3px 0 0" }} title={displayName(currentUser)}>
            {initials(displayName(currentUser))}
          </div>
        </nav>

        <aside className={`editor-panel ${editorOpen ? "" : "collapsed"}`} aria-label="Schema editor">
          <div className="panel-header">
            {editorTab === "dbml" ? <Braces size={14} /> : editorTab === "history" ? <Clock3 size={14} /> : <Boxes size={14} />}
            <span className="panel-title">
              {editorTab === "dbml" ? "Schema source" : editorTab === "history" ? "Version history" : "Schema outline"}
            </span>
            <span className="panel-meta">{editorTab === "dbml" ? "schema.dbml" : `${stats.tables} tables`}</span>
            <button className="icon-btn compact" onClick={() => setEditorOpen(false)} aria-label="Close editor panel" title="Close panel">
              <PanelLeftClose size={14} />
            </button>
          </div>

          {editorTab !== "history" && (
            <div className="panel-tabs" role="tablist" aria-label="Schema panel views">
              <button className={`panel-tab ${editorTab === "dbml" ? "active" : ""}`} onClick={() => setEditorTab("dbml")} role="tab">
                DBML
              </button>
              <button className={`panel-tab ${editorTab === "outline" ? "active" : ""}`} onClick={() => setEditorTab("outline")} role="tab">
                Outline
              </button>
            </div>
          )}

          {editorTab === "dbml" && (
            <>
              <div className="code-editor-shell">
                <div className="line-numbers" aria-hidden="true">
                  <pre className="line-number-list" ref={lineNumbersRef}>{editorLineNumbers}</pre>
                </div>
                <textarea
                  ref={editorRef}
                  className="dbml-editor"
                  value={dbml}
                  onChange={(event) => setDbml(event.target.value)}
                  onScroll={(event) => {
                    if (lineNumbersRef.current) {
                      lineNumbersRef.current.style.transform = `translateY(-${event.currentTarget.scrollTop}px)`;
                    }
                  }}
                  spellCheck={false}
                  aria-label="DBML source editor"
                />
              </div>
              <div className={`parse-status ${parseError ? "error" : ""}`} aria-live="polite">
                <span className="parse-indicator" />
                {parseError ? (
                  <span>
                    <strong>{parseLine ? `Line ${parseLine}` : "DBML"}</strong> · {parseError}
                  </span>
                ) : (
                  <span>
                    <strong>Valid DBML</strong> · {stats.tables} tables, {stats.relations} refs
                  </span>
                )}
                <span className="shortcut-chip">⌘ S</span>
              </div>
            </>
          )}

          {editorTab === "outline" && (
            <div className="outline-panel">
              <label className="search-box">
                <Search size={12} />
                <input
                  value={outlineQuery}
                  onChange={(event) => setOutlineQuery(event.target.value)}
                  placeholder="Find table or field…"
                  aria-label="Filter schema outline"
                />
              </label>
              {[{ id: "ungrouped", name: "All tables", tableIds: documentModel.tables.map((table) => table.id) } as DbmlGroup, ...diagramGroups].map(
                (group, groupIndex) => {
                  const tables = outlineTables.filter((table) => group.tableIds.includes(table.id));
                  if (tables.length === 0) return null;
                  const color = group.id === "ungrouped" ? "#7f8c9d" : resolveGroupColor(group, Math.max(0, groupIndex - 1));
                  return (
                    <div className="outline-group" key={group.id}>
                      <div className="outline-group-title">
                        <span className="group-color-dot" style={{ "--group-color": color } as CSSProperties} />
                        {group.name}
                      </div>
                      {tables.map((table) => (
                        <button
                          className={`outline-table ${table.id === selectedTableId ? "active" : ""}`}
                          key={`${group.id}-${table.id}`}
                          onClick={() => focusTable(table.id)}
                        >
                          <Table2 size={11} />
                          {table.name}
                          <span className="outline-count">{table.fields.length}</span>
                        </button>
                      ))}
                    </div>
                  );
                },
              )}
            </div>
          )}

          {editorTab === "history" && (
            <div className="side-tool-panel">
              {historyItems.map((item) => (
                <div className="history-item" key={`${item.title}-${item.time}`}>
                  <span className="history-dot" />
                  <div>
                    <div className="history-title">{item.title}</div>
                    <div className="history-subtitle">{item.subtitle}</div>
                  </div>
                  <div className="history-time">{item.time}</div>
                </div>
              ))}
            </div>
          )}
        </aside>

        <section
          className="canvas-shell"
          ref={canvasRef}
          aria-label="Entity relationship diagram canvas"
          aria-busy={isSmartLayouting}
        >
          {!editorOpen && (
            <button className="icon-btn floating-open-panel left" onClick={() => setEditorOpen(true)} aria-label="Open DBML editor" title="Open editor">
              <PanelLeftOpen size={15} />
            </button>
          )}
          {!inspectorOpen && (
            <button className="icon-btn floating-open-panel right" onClick={() => setInspectorOpen(true)} aria-label={inspectorMode === "comments" ? "Open comments" : "Open inspector"} title={inspectorMode === "comments" ? "Open comments" : "Open inspector"}>
              {inspectorMode === "comments" ? <MessageSquare size={15} /> : <PanelRightOpen size={15} />}
            </button>
          )}

          <div className="canvas-topline" aria-label="Diagram views">
            <button className={`view-chip ${activeGroup === "all" ? "active" : ""}`} onClick={() => setActiveGroup("all")}>
              <Grid2X2 size={11} />
              All schema
            </button>
            {diagramGroups.map((group, index) => (
              <button
                className={`view-chip ${activeGroup === group.id ? "active" : ""}`}
                key={group.id}
                onClick={() => {
                  setActiveGroup(group.id);
                  window.setTimeout(() => fitDiagram(), 40);
                }}
              >
                <span className="view-dot" style={{ "--chip-color": resolveGroupColor(group, index) } as CSSProperties} />
                {group.name}
              </button>
            ))}
            <button className="view-chip" onClick={() => openPanel("outline")}>
              <Plus size={11} />
              View
            </button>
          </div>

          <div className="canvas-stat">
            <Sparkles size={10} />
            {stats.tables} tables · {stats.relations} relations · ∞ canvas
          </div>

          <ReactFlow
            nodes={displayNodes}
            edges={displayEdges}
            nodeTypes={NODE_TYPES}
            onNodesChange={handleNodesChange}
            onNodeClick={(_event, node) => {
              if (node.type !== "tableCard") return;
              setSelectedTableId(node.id);
              setSelectedRelationId(null);
              if (inspectorMode === "comments") {
                setCommentScope("table");
                setActiveCommentThreadId(null);
                setCommentComposerError(null);
              }
              setInspectorOpen(true);
            }}
            onEdgeClick={(_event, edge) => {
              setSelectedRelationId(edge.id);
              setSelectedTableId(null);
              if (inspectorMode === "comments") {
                setCommentScope("diagram");
                setActiveCommentThreadId(null);
                setCommentComposerError(null);
              }
              setInspectorOpen(true);
            }}
            onPaneClick={() => {
              setSelectedTableId(null);
              setSelectedRelationId(null);
              if (inspectorMode === "comments") {
                setCommentScope("diagram");
                setActiveCommentThreadId(null);
                setCommentComposerError(null);
              }
            }}
            onConnect={onConnect}
            edgeTypes={EDGE_TYPES}
            defaultViewport={DEFAULT_VIEWPORT}
            minZoom={0.18}
            maxZoom={2.4}
            snapToGrid
            snapGrid={SNAP_GRID}
            panOnDrag={canvasMode === "pan" ? true : [1, 2]}
            selectionOnDrag={canvasMode === "select"}
            nodesDraggable={canvasMode === "select"}
            nodesConnectable={canvasMode === "select"}
            onlyRenderVisibleElements
            fitView={false}
            elevateEdgesOnSelect
            proOptions={FLOW_PRO_OPTIONS}
            aria-label="Interactive entity relationship diagram"
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1} />
            <MiniMap
              pannable
              zoomable
              nodeColor={minimapNodeColor}
              nodeStrokeWidth={2}
              style={MINIMAP_STYLE}
              ariaLabel="Diagram minimap"
            />
          </ReactFlow>

          <LivePresenceLayer
            cursors={presenceCursors}
            sessionId={presenceSessionId}
            canvasBounds={canvasBounds}
            status={presenceStatus}
          />

          <div className="canvas-toolbar" aria-label="Canvas tools">
            <button className={`tool-btn ${canvasMode === "select" ? "active" : ""}`} onClick={() => setCanvasMode("select")} aria-label="Select tool" title="Select (V)">
              <MousePointer2 size={14} />
            </button>
            <button className={`tool-btn ${canvasMode === "pan" ? "active" : ""}`} onClick={() => setCanvasMode("pan")} aria-label="Pan tool" title="Pan (H)">
              <Hand size={14} />
            </button>
            <div className="toolbar-sep" />
            <button className="tool-btn" onClick={addTable} aria-label="Add table" title="Add table">
              <Plus size={15} />
            </button>
            <button className="tool-btn" onClick={() => showToast("Drag a field handle to another field to create a relation")} aria-label="Add relation" title="Add relation">
              <GitBranch size={14} />
            </button>
            <button className="tool-btn toolbar-hide-mobile" onClick={() => openPanel("outline")} aria-label="Manage groups" title="Manage groups">
              <Boxes size={14} />
            </button>
            <button
              className="tool-btn toolbar-hide-mobile"
              onClick={() => void applySmartLayout()}
              aria-label="Apply smart layout"
              title="Smart layout — arrange by groups and relationships (L)"
              disabled={isSmartLayouting || documentModel.tables.length === 0}
            >
              {isSmartLayouting ? <LoaderCircle className="spin" size={14} /> : <WandSparkles size={14} />}
            </button>
            <div className="toolbar-sep" />
            <button className="tool-btn" onClick={() => flow.zoomOut({ duration: 180 })} aria-label="Zoom out" title="Zoom out">
              <ZoomOut size={14} />
            </button>
            <ZoomLevel />
            <button className="tool-btn" onClick={() => flow.zoomIn({ duration: 180 })} aria-label="Zoom in" title="Zoom in">
              <ZoomIn size={14} />
            </button>
            <button className="tool-btn" onClick={fitDiagram} aria-label="Fit diagram" title="Fit diagram (F)">
              <Maximize2 size={14} />
            </button>
            <div className="toolbar-sep toolbar-hide-mobile" />
            <button className="tool-btn toolbar-hide-mobile" onClick={() => setModal("command")} aria-label="Open command palette" title="Command palette">
              <Command size={14} />
            </button>
          </div>
        </section>

        <aside className={`inspector${inspectorMode === "comments" ? " comments-mode" : ""} ${inspectorOpen ? "" : "collapsed"}`} aria-label={inspectorMode === "comments" ? "Comments" : "Selection inspector"}>
          <div className="panel-header">
            {inspectorMode === "comments" ? <MessageSquare size={14} aria-hidden="true" /> : <Focus size={14} aria-hidden="true" />}
            <span className="panel-title" ref={commentsHeadingRef} tabIndex={inspectorMode === "comments" ? -1 : undefined}>{inspectorMode === "comments" ? "Comments" : "Inspector"}</span>
            <span className="panel-meta">{inspectorMode === "comments" ? `${openCommentThreads.length} open` : selectedRelation ? "relation" : selectedTable ? "table" : "canvas"}</span>
            <button className="icon-btn compact" onClick={() => setInspectorOpen(false)} aria-label={inspectorMode === "comments" ? "Close comments" : "Close inspector"} title={inspectorMode === "comments" ? "Close comments" : "Close inspector"}>
              <PanelRightClose size={14} />
            </button>
          </div>

          <div className="inspector-mode-tabs" role="tablist" aria-label="Right panel view">
            <button
              className={inspectorMode === "details" ? "active" : ""}
              type="button"
              role="tab"
              aria-selected={inspectorMode === "details"}
              onClick={() => {
                setInspectorMode("details");
                setInspectorOpen(true);
              }}
            >
              Details
            </button>
            <button
              className={inspectorMode === "comments" ? "active" : ""}
              type="button"
              role="tab"
              aria-selected={inspectorMode === "comments"}
              onClick={() => openComments(selectedTable ? "table" : "all", selectedTable?.id)}
            >
              Comments
              {openCommentThreads.length > 0 && <span>{openCommentThreads.length > 99 ? "99+" : openCommentThreads.length}</span>}
            </button>
          </div>

          {inspectorMode === "comments" ? (
            <CommentsPanel
              threads={commentThreads}
              tables={documentModel.tables}
              selectedTable={selectedTable}
              scope={effectiveCommentScope}
              filter={commentFilter}
              activeThreadId={activeCommentThreadId}
              rootDraft={rootCommentDraft}
              replyDraft={replyCommentDraft}
              loading={commentsLoading}
              loaded={commentsLoaded}
              error={commentsError}
              composerError={commentComposerError}
              pendingAction={commentPendingAction}
              onScopeChange={(scope) => {
                setCommentScope(scope);
                setActiveCommentThreadId(null);
                setCommentComposerError(null);
              }}
              onFilterChange={(filter) => {
                setCommentFilter(filter);
                setActiveCommentThreadId(null);
                setCommentComposerError(null);
              }}
              onOpenThread={(threadId) => {
                setActiveCommentThreadId(threadId);
                setReplyCommentDraft("");
                setCommentComposerError(null);
              }}
              onBack={() => {
                setActiveCommentThreadId(null);
                setReplyCommentDraft("");
                setCommentComposerError(null);
              }}
              onRootDraftChange={(value) => {
                setRootCommentDraft(value);
                setCommentComposerError(null);
              }}
              onReplyDraftChange={(value) => {
                setReplyCommentDraft(value);
                setCommentComposerError(null);
              }}
              onSubmitRoot={() => void submitRootComment()}
              onSubmitReply={(threadId) => void submitReplyComment(threadId)}
              onToggleStatus={(thread) => void toggleCommentStatus(thread)}
              onRetry={() => void loadComments()}
            />
          ) : selectedTable ? (
            <div className="inspector-body">
              <div className="inspector-eyebrow">Table</div>
              <div className="inspector-name">
                <Table2 size={15} style={{ color: "var(--accent)" }} />
                {selectedTable.name}
              </div>
              <p className="inspector-copy">
                {selectedTable.note ?? "Relational entity in the current workspace. Select a connected line to inspect its direction and style."}
              </p>
              <div className="metric-grid">
                <div className="metric">
                  <div className="metric-value">{selectedTable.fields.length}</div>
                  <div className="metric-label">Fields</div>
                </div>
                <div className="metric">
                  <div className="metric-value">{tableRelations.length}</div>
                  <div className="metric-label">Relations</div>
                </div>
              </div>
              <section className="inspector-section">
                <div className="section-label">Relationships</div>
                <div className="relation-list">
                  {tableRelations.map((relation) => {
                    const outbound = relation.fromTableId === selectedTable.id;
                    const otherTable = outbound ? relation.toTable : relation.fromTable;
                    const field = outbound ? relation.fromField : relation.toField;
                    return (
                      <button
                        className="relation-item"
                        key={relation.id}
                        onClick={() => {
                          setSelectedRelationId(relation.id);
                          setSelectedTableId(null);
                        }}
                      >
                        <ArrowLeftRight className="relation-icon" size={12} />
                        <span className="relation-main">{field} → {otherTable}</span>
                        <span className="relation-kind">{outbound ? "out" : "in"}</span>
                      </button>
                    );
                  })}
                </div>
              </section>
              <section className="inspector-section">
                <div className="section-label">Group</div>
                <p className="inspector-copy">
                  {diagramGroups.find((group) => group.tableIds.includes(selectedTable.id))?.name ?? "Ungrouped"}
                </p>
              </section>
              <section className="inspector-section">
                <div className="section-label">Review</div>
                <button className="relation-item" type="button" onClick={() => openComments("table", selectedTable.id)}>
                  <MessageSquare className="relation-icon" size={12} aria-hidden="true" />
                  <span className="relation-main">Comments on {selectedTable.name}</span>
                  <span className="relation-kind">{tableOpenCommentCounts.get(selectedTable.id) ?? 0} open</span>
                </button>
              </section>
            </div>
          ) : selectedRelation ? (
            <div className="inspector-body">
              <div className="inspector-eyebrow">Relationship</div>
              <div className="inspector-name">
                <GitBranch size={15} style={{ color: relationColors[selectedRelation.id] ?? "var(--accent)" }} />
                {selectedRelation.cardinality}
              </div>
              <p className="inspector-copy">This relationship is highlighted across the canvas. Unrelated tables are temporarily dimmed.</p>
              <section className="inspector-section">
                <div className="section-label">From</div>
                <button className="relation-item" onClick={() => focusTable(selectedRelation.fromTableId)}>
                  <Table2 className="relation-icon" size={12} />
                  <span className="relation-main">{selectedRelation.fromTable}.{selectedRelation.fromField}</span>
                  <ChevronRight size={11} />
                </button>
              </section>
              <section className="inspector-section">
                <div className="section-label">To</div>
                <button className="relation-item" onClick={() => focusTable(selectedRelation.toTableId)}>
                  <KeyRound className="relation-icon" size={12} />
                  <span className="relation-main">{selectedRelation.toTable}.{selectedRelation.toField}</span>
                  <ChevronRight size={11} />
                </button>
              </section>
              <section className="inspector-section">
                <div className="section-label">Highlight color</div>
                <div className="color-row">
                  {EDGE_PALETTE.map((color) => (
                    <button
                      className={`color-swatch ${(relationColors[selectedRelation.id] ?? EDGE_PALETTE[0]) === color ? "active" : ""}`}
                      style={{ "--swatch": color } as CSSProperties}
                      key={color}
                      onClick={() => setRelationColors((current) => ({ ...current, [selectedRelation.id]: color }))}
                      aria-label={`Use ${color} for this relation`}
                    />
                  ))}
                </div>
              </section>
            </div>
          ) : (
            <div className="empty-inspector">
              <div>
                <MousePointer2 size={24} style={{ margin: "0 auto 12px", color: "var(--muted-2)" }} />
                <strong>Nothing selected</strong>
                Select a table or relationship to focus its neighborhood and inspect details.
              </div>
            </div>
          )}
        </aside>
      </section>

      {modal === "import" && (
        <div className="modal-backdrop" onMouseDown={closeSchemaImport}>
          <div
            className="modal import-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="import-title"
            aria-describedby="import-description"
            aria-busy={schemaImportParsing || schemaImportGenerating}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-head">
              <div>
                <div className="modal-title" id="import-title">Import schema</div>
                <div className="modal-subtitle" id="import-description">
                  Paste or upload a schema, review what Relix found, then replace or merge without changing the diagram early.
                </div>
              </div>
              <div className="import-stepper" aria-label="Import progress">
                <span className={schemaImportStage === "source" ? "active" : "complete"}>
                  <b>1</b><i>Source</i>
                </span>
                <span className={schemaImportStage === "preview" ? "active" : ""}>
                  <b>2</b><i>Preview</i>
                </span>
              </div>
              <button className="icon-btn compact modal-close" type="button" onClick={closeSchemaImport} aria-label="Close import dialog"><X size={14} /></button>
            </div>
            <div className="modal-body import-modal-body">
              {schemaImportStage === "source" ? (
                <div className="import-source-stage">
                  <div className="import-source-grid">
                    <section className="import-source-editor" aria-labelledby="import-source-heading">
                      <div className="import-section-head">
                        <div>
                          <h2 id="import-source-heading">Schema source</h2>
                          <p id="import-source-help">Paste text from DBML, SQL DDL, Prisma, Drizzle, JSON Schema, or a Relix snapshot.</p>
                        </div>
                        <label className="import-format-field" htmlFor="schema-import-format">
                          <span>Format</span>
                          <select
                            id="schema-import-format"
                            className="form-select"
                            value={schemaImportFormat}
                            onChange={(event) => {
                              setSchemaImportFormat(event.target.value as SchemaImportChoice);
                              setSchemaImportError(null);
                            }}
                            disabled={schemaImportParsing}
                          >
                            {SCHEMA_IMPORT_FORMATS.map((format) => (
                              <option value={format.value} key={format.value}>{format.label}</option>
                            ))}
                          </select>
                        </label>
                      </div>
                      <textarea
                        ref={importSourceRef}
                        className="import-source-textarea"
                        value={schemaImportSource}
                        onChange={(event) => updateSchemaImportSource(event.target.value)}
                        aria-label="Schema source"
                        aria-describedby={`import-source-help${schemaImportError ? " schema-import-error" : ""}`}
                        placeholder={'CREATE TABLE users (\n  id uuid PRIMARY KEY,\n  email varchar(255) NOT NULL UNIQUE\n);'}
                        spellCheck={false}
                        disabled={schemaImportParsing}
                      />
                      <div className="import-source-meta">
                        <span>{schemaImportFileName ? `Loaded ${schemaImportFileName}` : "Paste schema text here"}</span>
                        <span>{Math.ceil(schemaImportSourceBytes / 1024).toLocaleString()} KB / 2,048 KB</span>
                      </div>
                    </section>

                    <aside
                      className={`import-upload-panel ${schemaImportDragActive ? "drag-active" : ""}`}
                      onDragEnter={(event) => {
                        event.preventDefault();
                        setSchemaImportDragActive(true);
                      }}
                      onDragOver={(event) => event.preventDefault()}
                      onDragLeave={(event) => {
                        if (!event.currentTarget.contains(event.relatedTarget as HTMLElement | null)) {
                          setSchemaImportDragActive(false);
                        }
                      }}
                      onDrop={onDropFile}
                    >
                      <label className="drop-zone import-drop-zone" htmlFor="schema-import-file">
                        <input
                          id="schema-import-file"
                          type="file"
                          accept={SCHEMA_IMPORT_ACCEPT}
                          onChange={onImportInput}
                          disabled={schemaImportParsing}
                        />
                        <div>
                          {schemaImportParsing ? (
                            <LoaderCircle className="spin" size={24} aria-hidden="true" />
                          ) : (
                            <Upload size={24} aria-hidden="true" />
                          )}
                          <strong>{schemaImportParsing ? "Reading schema…" : "Drop a schema file"}</strong>
                          <span>or click to choose one</span>
                        </div>
                      </label>
                      <div className="import-file-types">
                        <strong>Accepted files</strong>
                        <span>.dbml · .sql · .prisma · .ts · .json · .txt</span>
                        <small>Text schemas only · maximum 2 MB</small>
                      </div>
                    </aside>
                  </div>

                  <div className="import-safety-note">
                    Relix reads schema definitions only. Imported SQL and TypeScript are never executed.
                  </div>
                </div>
              ) : schemaImportResult && schemaImportStats ? (
                <div className="import-preview-stage">
                  <div className="import-preview-heading-row">
                    <div>
                      <h2 ref={importPreviewHeadingRef} tabIndex={-1}>Ready to generate</h2>
                      <p>Detected <strong>{schemaImportResult.label}</strong>. Choose the tables and how they should enter this project.</p>
                    </div>
                    <span className="import-format-badge">{schemaImportResult.label}</span>
                  </div>

                  <div className="import-stat-grid" aria-label="Schema preview summary">
                    <div><strong>{schemaImportStats.tables}</strong><span>Tables</span></div>
                    <div><strong>{schemaImportStats.fields}</strong><span>Fields</span></div>
                    <div><strong>{schemaImportStats.relations}</strong><span>Relations</span></div>
                    <div className={schemaImportWarnings.length > 0 ? "has-warnings" : ""}>
                      <strong>{schemaImportWarnings.length}</strong><span>Warnings</span>
                    </div>
                  </div>

                  <div className="import-preview-grid">
                    <section className="import-table-picker" aria-labelledby="import-tables-heading">
                      <div className="import-table-picker-head">
                        <label>
                          <input
                            type="checkbox"
                            checked={schemaImportAllSelected}
                            ref={(input) => {
                              if (input) input.indeterminate = schemaImportSelectedTableIds.size > 0 && !schemaImportAllSelected;
                            }}
                            onChange={toggleAllSchemaImportTables}
                            disabled={schemaImportGenerating}
                          />
                          <span id="import-tables-heading">Select all tables</span>
                        </label>
                        <span>{schemaImportSelectedTableIds.size} of {schemaImportStats.tables}</span>
                      </div>
                      <div className="import-table-list">
                        {schemaImportResult.document.tables.map((table) => (
                          <label className="import-table-row" key={table.id}>
                            <input
                              type="checkbox"
                              checked={schemaImportSelectedTableIds.has(table.id)}
                              onChange={() => toggleSchemaImportTable(table.id)}
                              disabled={schemaImportGenerating}
                              aria-label={`Import ${qualifiedTableName(table)}`}
                            />
                            <span className="import-table-name">
                              <strong>{qualifiedTableName(table)}</strong>
                              <small>{table.fields.length} fields</small>
                            </span>
                            <span className="import-table-key-count">
                              {table.fields.filter((field) => field.primaryKey).length} PK
                            </span>
                          </label>
                        ))}
                      </div>
                    </section>

                    <aside className="import-options-panel">
                      <fieldset className="import-option-group">
                        <legend>Generate mode</legend>
                        <label className={schemaImportMode === "replace" ? "active" : ""}>
                          <input
                            type="radio"
                            name="schema-import-mode"
                            value="replace"
                            checked={schemaImportMode === "replace"}
                            onChange={() => setSchemaImportMode("replace")}
                            disabled={schemaImportGenerating}
                          />
                          <span><strong>Replace current</strong><small>Use only the selected imported tables.</small></span>
                        </label>
                        <label className={schemaImportMode === "merge" ? "active" : ""}>
                          <input
                            type="radio"
                            name="schema-import-mode"
                            value="merge"
                            checked={schemaImportMode === "merge"}
                            onChange={() => setSchemaImportMode("merge")}
                            disabled={schemaImportGenerating}
                          />
                          <span><strong>Merge with current</strong><small>Add imported tables to this project.</small></span>
                        </label>
                      </fieldset>

                      {schemaImportMode === "merge" && schemaImportConflictCount > 0 && (
                        <fieldset className="import-option-group conflict-options">
                          <legend>{schemaImportConflictCount} name {schemaImportConflictCount === 1 ? "conflict" : "conflicts"}</legend>
                          {([
                            ["update", "Update existing", "Imported definitions replace matching tables."],
                            ["rename", "Rename imported", "Keep both by creating unique imported names."],
                            ["skip", "Skip conflicts", "Keep existing definitions unchanged."],
                          ] as Array<[SchemaMergeStrategy, string, string]>).map(([value, label, help]) => (
                            <label className={schemaImportMergeStrategy === value ? "active" : ""} key={value}>
                              <input
                                type="radio"
                                name="schema-import-conflicts"
                                value={value}
                                checked={schemaImportMergeStrategy === value}
                                onChange={() => setSchemaImportMergeStrategy(value)}
                                disabled={schemaImportGenerating}
                              />
                              <span><strong>{label}</strong><small>{help}</small></span>
                            </label>
                          ))}
                        </fieldset>
                      )}

                      <section className="import-warning-panel" aria-labelledby="import-warnings-heading">
                        <div>
                          <strong id="import-warnings-heading">Parser warnings</strong>
                          <span>{schemaImportWarnings.length}</span>
                        </div>
                        {schemaImportWarnings.length === 0 ? (
                          <p>No warnings. The selected schema is ready.</p>
                        ) : (
                          <ul>
                            {schemaImportWarnings.slice(0, 6).map((warning, index) => (
                              <li key={`${warning.code}-${warning.line ?? "schema"}-${index}`}>
                                {warning.line ? `Line ${warning.line}: ` : ""}{warning.message}
                              </li>
                            ))}
                            {schemaImportWarnings.length > 6 && (
                              <li>{schemaImportWarnings.length - 6} more warnings</li>
                            )}
                          </ul>
                        )}
                      </section>
                    </aside>
                  </div>
                </div>
              ) : null}

              <div className="import-feedback" aria-live="polite" aria-atomic="true">
                {schemaImportError && (
                  <div className="import-error" id="schema-import-error" role="alert">{schemaImportError}</div>
                )}
                {!schemaImportError && schemaImportParsing && (
                  <div className="import-progress" role="status"><LoaderCircle className="spin" size={13} aria-hidden="true" />Reading and validating schema…</div>
                )}
                {!schemaImportError && schemaImportGenerating && (
                  <div className="import-progress" role="status"><LoaderCircle className="spin" size={13} aria-hidden="true" />Generating tables and smart layout…</div>
                )}
              </div>
            </div>
            <div className="modal-footer">
              <button className="text-btn import-reset-btn" type="button" onClick={resetSchemaImport} disabled={schemaImportParsing || schemaImportGenerating}>Reset</button>
              <div className="import-footer-actions">
                {schemaImportStage === "preview" && (
                  <button className="text-btn" type="button" onClick={backToSchemaImportSource} disabled={schemaImportGenerating}>
                    <ArrowLeft size={13} aria-hidden="true" /><span>Back</span>
                  </button>
                )}
                <button className="text-btn" type="button" onClick={closeSchemaImport}>Cancel</button>
                {schemaImportStage === "source" ? (
                  <button
                    className="primary-btn"
                    type="button"
                    onClick={() => void parseSchemaImportSource()}
                    disabled={schemaImportParsing || !schemaImportSource.trim()}
                  >
                    {schemaImportParsing ? (
                      <><LoaderCircle className="spin" size={13} aria-hidden="true" /><span>Parsing…</span></>
                    ) : (
                      <><Search size={13} aria-hidden="true" /><span>Parse schema</span></>
                    )}
                  </button>
                ) : (
                  <button
                    className="primary-btn"
                    type="button"
                    onClick={() => void generateSchemaImport()}
                    disabled={schemaImportGenerating || schemaImportSelectedTableIds.size === 0}
                  >
                    {schemaImportGenerating ? <LoaderCircle className="spin" size={13} aria-hidden="true" /> : <WandSparkles size={13} aria-hidden="true" />}
                    {schemaImportGenerating ? "Generating…" : "Generate diagram"}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {modal === "export" && (
        <div className="modal-backdrop" onMouseDown={() => setModal(null)}>
          <div className="modal export-modal" role="dialog" aria-modal="true" aria-labelledby="export-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <div>
                <div className="modal-title" id="export-title">Export project</div>
                <div className="modal-subtitle">Take the schema with you as code, a portable snapshot, or a high-resolution visual.</div>
              </div>
              <button className="icon-btn compact modal-close" onClick={() => setModal(null)} aria-label="Close export dialog"><X size={14} /></button>
            </div>
            <div className="modal-body">
              {parseError && (
                <div
                  id="generated-export-warning"
                  className="parse-status error"
                  role="status"
                  aria-live="polite"
                  style={{ marginBottom: 10, border: "1px solid var(--line)", borderRadius: 7 }}
                >
                  <span className="parse-indicator" aria-hidden="true" />
                  <span><strong>Fix DBML first.</strong> Generated schema exports are paused to prevent stale output.</span>
                </div>
              )}
              <div className="format-grid">
                <button className="format-card" onClick={exportDbml} aria-label="Export DBML source">
                  <div className="format-name"><FileCode2 size={16} style={{ color: "var(--accent)" }} />DBML</div>
                  <span>Canonical source with groups and relationships.</span>
                </button>
                <button className="format-card" onClick={exportPostgres} aria-label="Export PostgreSQL schema" {...generatedExportDisabledProps}>
                  <div className="format-name"><Database size={16} style={{ color: "var(--violet)" }} />PostgreSQL</div>
                  <span>CREATE TABLE and foreign-key statements.</span>
                </button>
                <button className="format-card" onClick={exportMysql} aria-label="Export MySQL schema" {...generatedExportDisabledProps}>
                  <div className="format-name"><Database size={16} style={{ color: "var(--warning)" }} />MySQL</div>
                  <span>MySQL-ready tables and foreign-key constraints.</span>
                </button>
                <button className="format-card" onClick={exportSqlite} aria-label="Export SQLite schema" {...generatedExportDisabledProps}>
                  <div className="format-name"><Database size={16} style={{ color: "var(--success)" }} />SQLite</div>
                  <span>Portable SQLite tables and foreign keys.</span>
                </button>
                <button className="format-card" onClick={exportPrisma} aria-label="Export Prisma schema" {...generatedExportDisabledProps}>
                  <div className="format-name"><Braces size={16} style={{ color: "var(--violet)" }} />Prisma</div>
                  <span>Models and relations for Prisma ORM.</span>
                </button>
                <button className="format-card" onClick={exportDrizzle} aria-label="Export Drizzle TypeScript schema" {...generatedExportDisabledProps}>
                  <div className="format-name"><Code2 size={16} style={{ color: "var(--accent)" }} />Drizzle TypeScript</div>
                  <span>Typed PostgreSQL tables for Drizzle ORM.</span>
                </button>
                <button className="format-card" onClick={exportJsonSchemaFile} aria-label="Export JSON Schema" {...generatedExportDisabledProps}>
                  <div className="format-name"><FileJson size={16} style={{ color: "var(--success)" }} />JSON Schema</div>
                  <span>Portable validation schema for every table.</span>
                </button>
                <button className="format-card" onClick={exportRelixSnapshot} aria-label="Export Relix snapshot">
                  <div className="format-name"><FileJson size={16} style={{ color: "var(--success)" }} />Relix snapshot</div>
                  <span>Schema plus canvas positions for a full restore.</span>
                </button>
                <button className="format-card" onClick={() => void exportPng()} aria-label="Export canvas as PNG image">
                  <div className="format-name"><FileDown size={16} style={{ color: "var(--warning)" }} />Canvas PNG</div>
                  <span>High-resolution image of the current focused view.</span>
                </button>
              </div>
            </div>
            <div className="modal-footer">
              <span style={{ marginRight: "auto", alignSelf: "center", color: "var(--muted)", fontSize: 9 }}>{stats.tables} tables · {stats.fields} fields · {stats.relations} relations</span>
              <button className="text-btn" onClick={() => setModal(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {modal === "share" && (
        <div className="modal-backdrop" onMouseDown={() => setModal(null)}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="share-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <div>
                <div className="modal-title" id="share-title">Share “{projectName}”</div>
                <div className="modal-subtitle">Invite teammates with the right level of access. This workspace is private by default.</div>
              </div>
              <button className="icon-btn compact modal-close" onClick={() => setModal(null)} aria-label="Close share dialog"><X size={14} /></button>
            </div>
            <div className="modal-body">
              <label className="field-label" htmlFor="invite-email">Invite by email</label>
              <div className="form-row">
                <input
                  id="invite-email"
                  className="form-input"
                  type="email"
                  value={inviteEmail}
                  onChange={(event) => setInviteEmail(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void inviteMember();
                  }}
                  placeholder="teammate@company.com"
                />
                <select className="form-select" value={inviteRole} onChange={(event) => setInviteRole(event.target.value)} aria-label="Invite role">
                  <option value="editor">Can edit</option>
                  <option value="viewer">Can view &amp; comment</option>
                  <option value="owner">Owner</option>
                </select>
                <button className="primary-btn" onClick={() => void inviteMember()}><UserPlus size={13} />Invite</button>
              </div>

              <div className="member-list">
                {members.map((member, index) => (
                  <div className="member-row" key={member.email}>
                    <div className="avatar" style={{ background: member.color ?? GROUP_PALETTE[index % GROUP_PALETTE.length], margin: 0 }}>
                      {initials(displayName(member))}
                    </div>
                    <div>
                      <div className="member-name">{displayName(member)}{member.email === currentUser.email ? " (you)" : ""}</div>
                      <div className="member-email">{member.email}</div>
                    </div>
                    <span className="role-pill">{member.role}</span>
                  </div>
                ))}
              </div>

              <div className="link-row">
                <LockKeyhole size={13} style={{ color: "var(--success)" }} />
                <span className="link-preview">Private link · only invited collaborators can open</span>
                <button className="text-btn" onClick={() => void copyShareLink()}><Copy size={12} />Copy link</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {modal === "command" && (
        <div className="modal-backdrop" onMouseDown={() => setModal(null)}>
          <div className="command-modal" role="dialog" aria-modal="true" aria-label="Command palette" onMouseDown={(event) => event.stopPropagation()}>
            <div className="command-input-wrap">
              <Search size={15} />
              <input
                className="command-input"
                value={commandQuery}
                onChange={(event) => setCommandQuery(event.target.value)}
                autoFocus
                aria-label="Search commands, tables, and fields"
                placeholder="Find tables, fields, or run a command…"
              />
              <span className="shortcut-chip">ESC</span>
            </div>
            <div className="command-results">
              {commandItems.length > 0 && <div className="command-section">Schema</div>}
              {commandItems.map((table) => (
                <button className="command-item" key={table.id} onClick={() => focusTable(table.id)}>
                  <Table2 className="command-icon" size={13} />
                  <span>{table.name}</span>
                  <span className="command-hint">{table.fields.length} fields</span>
                </button>
              ))}
              {hasCommandActionMatch && (
                <>
                  <div className="command-section">Actions</div>
                  {commandActionMatches.add && (
                    <button className="command-item" onClick={() => { setModal(null); addTable(); }}>
                      <Plus className="command-icon" size={13} /><span>Add a new table</span><span className="command-hint">T</span>
                    </button>
                  )}
                  {commandActionMatches.comments && (
                    <button className="command-item" onClick={() => { setModal(null); openComments(selectedTable ? "table" : "all", selectedTable?.id); }}>
                      <MessageSquare className="command-icon" size={13} /><span>Open comments</span><span className="command-hint">C</span>
                    </button>
                  )}
                  {commandActionMatches.layout && (
                    <button
                      className="command-item"
                      onClick={() => { setModal(null); void applySmartLayout(); }}
                      disabled={isSmartLayouting || documentModel.tables.length === 0}
                    >
                      <WandSparkles className="command-icon" size={13} /><span>Smart layout</span><span className="command-hint">L</span>
                    </button>
                  )}
                  {commandActionMatches.fit && (
                    <button className="command-item" onClick={() => { setModal(null); fitDiagram(); }}>
                      <Maximize2 className="command-icon" size={13} /><span>Fit diagram to view</span><span className="command-hint">F</span>
                    </button>
                  )}
                  {commandActionMatches.export && (
                    <button className="command-item" onClick={() => setModal("export")}>
                      <ArrowDownToLine className="command-icon" size={13} /><span>Export project</span><span className="command-hint">⌘ E</span>
                    </button>
                  )}
                </>
              )}
              {commandQuery && commandItems.length === 0 && !hasCommandActionMatch && (
                <div style={{ padding: 24, color: "var(--muted)", textAlign: "center", fontSize: 10 }}>No command, table, or field matched “{commandQuery}”.</div>
              )}
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="toast" role="status">
          <Check size={14} />
          {toast}
        </div>
      )}
    </main>
  );
}

export function DiagramWorkspace() {
  return (
    <ReactFlowProvider>
      <Workspace />
    </ReactFlowProvider>
  );
}
