export const COMMENT_BODY_MAX_LENGTH = 2000;
export const COMMENT_TARGET_ID_MAX_LENGTH = 160;

export type CommentTargetType = "diagram" | "table";
export type CommentStatus = "open" | "resolved";

export type ProjectComment = {
  id: string;
  parentId: string | null;
  targetType: CommentTargetType;
  targetId: string | null;
  targetLabel: string;
  targetExists: boolean;
  body: string;
  status: CommentStatus;
  author: {
    id: string;
    displayName: string;
  };
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  canResolve: boolean;
};

export type CommentThread = ProjectComment & {
  replies: ProjectComment[];
};

export type ValidCommentInput = {
  body: string;
  targetType: CommentTargetType;
  targetId: string | null;
};

export type CommentValidationResult =
  | { ok: true; value: ValidCommentInput }
  | { ok: false; code: string; message: string };

const EDGE_INVISIBLE = /^[\s\u200B-\u200D\u2060\uFEFF]+|[\s\u200B-\u200D\u2060\uFEFF]+$/gu;
const UNSAFE_CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const TARGET_ID = /^[A-Za-z0-9_-]+$/;

export function normalizeCommentBody(value: string) {
  return value.replace(EDGE_INVISIBLE, "");
}

export function validateCommentInput(
  payload: Record<string, unknown>,
): CommentValidationResult {
  if (typeof payload.body !== "string") {
    return { ok: false, code: "invalid_comment_body", message: "Comment text is required" };
  }
  const body = normalizeCommentBody(payload.body);
  if (!body || UNSAFE_CONTROL_CHARACTERS.test(body)) {
    return { ok: false, code: "invalid_comment_body", message: "Comment text is required" };
  }
  if (body.length > COMMENT_BODY_MAX_LENGTH) {
    return {
      ok: false,
      code: "comment_too_long",
      message: `Comments must be ${COMMENT_BODY_MAX_LENGTH} characters or fewer`,
    };
  }

  if (!isCommentTargetType(payload.targetType)) {
    return {
      ok: false,
      code: "invalid_comment_target",
      message: "Comment target must be the diagram or a table",
    };
  }
  const targetType = payload.targetType;
  if (targetType === "diagram") {
    if (payload.targetId !== null && payload.targetId !== undefined) {
      return {
        ok: false,
        code: "invalid_comment_target",
        message: "Diagram comments cannot include a target id",
      };
    }
    return { ok: true, value: { body, targetType, targetId: null } };
  }

  if (
    typeof payload.targetId !== "string" ||
    payload.targetId.length === 0 ||
    payload.targetId.length > COMMENT_TARGET_ID_MAX_LENGTH ||
    !TARGET_ID.test(payload.targetId)
  ) {
    return {
      ok: false,
      code: "invalid_comment_target",
      message: "Table comments require a valid target id",
    };
  }

  return { ok: true, value: { body, targetType, targetId: payload.targetId } };
}

export function buildCommentThreads(comments: ProjectComment[]): CommentThread[] {
  const roots = new Map<string, CommentThread>();
  const sorted = [...comments].sort(compareComments);
  for (const comment of sorted) {
    if (!comment.parentId) roots.set(comment.id, { ...comment, replies: [] });
  }
  for (const comment of sorted) {
    if (!comment.parentId) continue;
    roots.get(comment.parentId)?.replies.push(comment);
  }
  return [...roots.values()];
}

export function canResolveComment(
  role: string,
  currentUserId: string,
  authorId: string,
) {
  return currentUserId === authorId || role === "owner" || role === "editor";
}

export function isCommentTargetType(value: unknown): value is CommentTargetType {
  return value === "diagram" || value === "table";
}

function compareComments(left: ProjectComment, right: ProjectComment) {
  const created = left.createdAt.localeCompare(right.createdAt);
  return created || left.id.localeCompare(right.id);
}
