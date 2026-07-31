import { and, asc, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { comments, users, type ProjectRole } from "@/db/schema";
import {
  canResolveComment,
  validateCommentInput,
  type CommentStatus,
  type ProjectComment,
} from "@/lib/comments";
import { parseDBML } from "@/lib/dbml";
import {
  RouteError,
  readJsonBody,
  requireExistingProjectAccess,
  routeErrorResponse,
} from "@/lib/server/project-access";

export const dynamic = "force-dynamic";

const COMMENT_ID = /^[A-Za-z0-9_-]{1,160}$/;

const commentSelection = {
  id: comments.id,
  parentId: comments.parentId,
  targetType: comments.targetType,
  targetId: comments.targetId,
  targetLabel: comments.targetLabel,
  body: comments.body,
  status: comments.status,
  authorId: comments.authorId,
  authorDisplayName: users.displayName,
  createdAt: comments.createdAt,
  updatedAt: comments.updatedAt,
  resolvedAt: comments.resolvedAt,
};

type CommentRow = {
  id: string;
  parentId: string | null;
  targetType: "diagram" | "table";
  targetId: string | null;
  targetLabel: string;
  body: string;
  status: CommentStatus;
  authorId: string;
  authorDisplayName: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
};

export async function GET(request: Request) {
  try {
    const access = await requireExistingProjectAccess(request);
    const rows = await getDb()
      .select(commentSelection)
      .from(comments)
      .innerJoin(users, eq(comments.authorId, users.id))
      .where(eq(comments.projectId, access.project.id))
      .orderBy(asc(comments.createdAt), asc(comments.id));
    const tableTargets = tableTargetLabels(access.project.dbml);

    return privateJson({
      comments: rows.map((row) =>
        serializeComment(row, access.role, access.user.id, tableTargets),
      ),
    });
  } catch (error) {
    return commentsErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const access = await requireExistingProjectAccess(request);
    const payload = await readJsonBody(request);
    const parentId = readOptionalParentId(payload.parentId);
    const tableTargets = tableTargetLabels(access.project.dbml);

    if (parentId) {
      const parent = await findRootComment(access.project.id, parentId);
      if (!parent) {
        throw new RouteError(
          404,
          "Comment thread not found",
          "comment_thread_not_found",
        );
      }
      if (parent.status === "resolved") {
        throw new RouteError(
          409,
          "Reopen this thread before replying",
          "comment_thread_resolved",
        );
      }

      const input = validatedInput({
        ...payload,
        targetType: parent.targetType,
        targetId: parent.targetId,
      });
      const now = new Date().toISOString();
      const [created] = await getDb()
        .insert(comments)
        .values({
          id: crypto.randomUUID(),
          projectId: access.project.id,
          parentId: parent.id,
          targetType: parent.targetType,
          targetId: parent.targetId,
          targetLabel: parent.targetLabel,
          body: input.body,
          status: "open",
          authorId: access.user.id,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      return privateJson(
        {
          comment: serializeComment(
            { ...created, authorDisplayName: access.user.displayName },
            access.role,
            access.user.id,
            tableTargets,
          ),
        },
        201,
      );
    }

    const input = validatedInput(payload);
    const targetLabel = resolveTargetLabel(
      input.targetType,
      input.targetId,
      access.project.name,
      tableTargets,
    );
    const now = new Date().toISOString();
    const [created] = await getDb()
      .insert(comments)
      .values({
        id: crypto.randomUUID(),
        projectId: access.project.id,
        targetType: input.targetType,
        targetId: input.targetId,
        targetLabel,
        body: input.body,
        status: "open",
        authorId: access.user.id,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return privateJson(
      {
        comment: serializeComment(
          { ...created, authorDisplayName: access.user.displayName },
          access.role,
          access.user.id,
          tableTargets,
        ),
      },
      201,
    );
  } catch (error) {
    return commentsErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const access = await requireExistingProjectAccess(request);
    const payload = await readJsonBody(request);
    const id = readCommentId(payload.id);
    const status = readCommentStatus(payload.status);
    const existing = await findRootComment(access.project.id, id);

    if (!existing) {
      throw new RouteError(
        404,
        "Comment thread not found",
        "comment_thread_not_found",
      );
    }
    if (
      !canResolveComment(
        access.role,
        access.user.id,
        existing.authorId,
      )
    ) {
      throw new RouteError(
        403,
        "You cannot change this comment thread",
        "insufficient_comment_permission",
      );
    }

    let comment = existing;
    if (existing.status !== status) {
      const now = new Date().toISOString();
      const [updated] = await getDb()
        .update(comments)
        .set({
          status,
          resolvedAt: status === "resolved" ? now : null,
          resolvedById: status === "resolved" ? access.user.id : null,
          updatedAt: now,
        })
        .where(
          and(
            eq(comments.id, existing.id),
            eq(comments.projectId, access.project.id),
            isNull(comments.parentId),
          ),
        )
        .returning();

      if (!updated) {
        throw new RouteError(
          404,
          "Comment thread not found",
          "comment_thread_not_found",
        );
      }
      comment = { ...updated, authorDisplayName: existing.authorDisplayName };
    }

    return privateJson({
      comment: serializeComment(
        comment,
        access.role,
        access.user.id,
        tableTargetLabels(access.project.dbml),
      ),
    });
  } catch (error) {
    return commentsErrorResponse(error);
  }
}

async function findRootComment(projectId: string, id: string) {
  const [comment] = await getDb()
    .select(commentSelection)
    .from(comments)
    .innerJoin(users, eq(comments.authorId, users.id))
    .where(
      and(
        eq(comments.projectId, projectId),
        eq(comments.id, id),
        isNull(comments.parentId),
      ),
    )
    .limit(1);
  return comment;
}

function validatedInput(payload: Record<string, unknown>) {
  const result = validateCommentInput(payload);
  if (!result.ok) {
    throw new RouteError(400, result.message, result.code);
  }
  return result.value;
}

function readOptionalParentId(value: unknown) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !COMMENT_ID.test(value)) {
    throw new RouteError(
      400,
      "parentId must identify a comment thread",
      "invalid_comment_parent",
    );
  }
  return value;
}

function readCommentId(value: unknown) {
  if (typeof value !== "string" || !COMMENT_ID.test(value)) {
    throw new RouteError(
      400,
      "A valid comment id is required",
      "invalid_comment_id",
    );
  }
  return value;
}

function readCommentStatus(value: unknown): CommentStatus {
  if (value !== "open" && value !== "resolved") {
    throw new RouteError(
      400,
      "status must be open or resolved",
      "invalid_comment_status",
    );
  }
  return value;
}

function tableTargetLabels(dbml: string) {
  const document = parseDBML(dbml);
  return new Map(
    document.tables.map((table) => [
      table.id,
      table.schema ? `${table.schema}.${table.name}` : table.name,
    ]),
  );
}

function resolveTargetLabel(
  targetType: "diagram" | "table",
  targetId: string | null,
  projectName: string,
  tableTargets: ReadonlyMap<string, string>,
) {
  if (targetType === "diagram") return projectName;
  const targetLabel = targetId ? tableTargets.get(targetId) : undefined;
  if (!targetLabel) {
    throw new RouteError(
      409,
      "That table no longer exists in the current schema",
      "comment_target_stale",
    );
  }
  return targetLabel;
}

function serializeComment(
  row: CommentRow,
  role: ProjectRole,
  currentUserId: string,
  tableTargets: ReadonlyMap<string, string>,
): ProjectComment {
  return {
    id: row.id,
    parentId: row.parentId,
    targetType: row.targetType,
    targetId: row.targetId,
    targetLabel: row.targetLabel,
    targetExists:
      row.targetType === "diagram" ||
      (row.targetId !== null && tableTargets.has(row.targetId)),
    body: row.body,
    status: row.status,
    author: {
      id: row.authorId,
      displayName: row.authorDisplayName,
    },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    resolvedAt: row.resolvedAt,
    canResolve:
      row.parentId === null &&
      canResolveComment(role, currentUserId, row.authorId),
  };
}

function privateJson(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "private, no-store" },
  });
}

function commentsErrorResponse(error: unknown) {
  const response = routeErrorResponse(error, "Comments");
  response.headers.set("cache-control", "private, no-store");
  return response;
}
