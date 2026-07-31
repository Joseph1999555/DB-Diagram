import assert from "node:assert/strict";
import test from "node:test";

import {
  COMMENT_BODY_MAX_LENGTH,
  COMMENT_TARGET_ID_MAX_LENGTH,
  buildCommentThreads,
  canResolveComment,
  normalizeCommentBody,
  validateCommentInput,
} from "../lib/comments.ts";

function comment(overrides = {}) {
  return {
    id: "comment-default",
    parentId: null,
    targetType: "diagram",
    targetId: null,
    targetLabel: "Diagram",
    targetExists: true,
    body: "A useful review note",
    status: "open",
    author: { id: "user-author", displayName: "Ari Reviewer" },
    createdAt: "2026-07-31T09:00:00.000Z",
    updatedAt: "2026-07-31T09:00:00.000Z",
    resolvedAt: null,
    canResolve: true,
    ...overrides,
  };
}

test("normalizes comment edges without damaging meaningful multiline text", () => {
  assert.equal(
    normalizeCommentBody(" \u200B  Check the index\n  before launch. \u2060 "),
    "Check the index\n  before launch.",
  );
  assert.equal(normalizeCommentBody("สวัสดี 👋 مرحبا"), "สวัสดี 👋 مرحبا");
  assert.equal(
    normalizeCommentBody("<img src=x onerror=alert(1)>"),
    "<img src=x onerror=alert(1)>",
    "plain-text rendering, rather than destructive validation, owns HTML safety",
  );
});

test("accepts diagram and table comments with canonical targets", () => {
  assert.deepEqual(
    validateCommentInput({
      body: "  Diagram-wide note  ",
      targetType: "diagram",
    }),
    {
      ok: true,
      value: {
        body: "Diagram-wide note",
        targetType: "diagram",
        targetId: null,
      },
    },
  );

  assert.deepEqual(
    validateCommentInput({
      body: "Review this entity",
      targetType: "table",
      targetId: "table_public-orders_2df92",
    }),
    {
      ok: true,
      value: {
        body: "Review this entity",
        targetType: "table",
        targetId: "table_public-orders_2df92",
      },
    },
  );
});

test("enforces the comment body boundary and rejects unsafe bodies", () => {
  const exactLimit = "x".repeat(COMMENT_BODY_MAX_LENGTH);
  assert.equal(
    validateCommentInput({ body: exactLimit, targetType: "diagram" }).ok,
    true,
  );

  const tooLong = validateCommentInput({
    body: `${exactLimit}x`,
    targetType: "diagram",
  });
  assert.deepEqual(tooLong, {
    ok: false,
    code: "comment_too_long",
    message: `Comments must be ${COMMENT_BODY_MAX_LENGTH} characters or fewer`,
  });

  for (const body of [
    undefined,
    null,
    7,
    {},
    [],
    "",
    " \t\n\u00A0 ",
    "\u200B\u200D\uFEFF",
    "contains\u0000control",
    "contains\u001Fcontrol",
  ]) {
    const result = validateCommentInput({ body, targetType: "diagram" });
    assert.equal(result.ok, false, `body ${JSON.stringify(body)} must be rejected`);
    assert.equal(result.code, "invalid_comment_body");
  }
});

test("rejects mismatched, malformed, and oversized comment targets", () => {
  const invalidPayloads = [
    { body: "Note", targetType: "relation", targetId: "relation-1" },
    { body: "Note", targetType: "diagram", targetId: "table-1" },
    { body: "Note", targetType: "table" },
    { body: "Note", targetType: "table", targetId: null },
    { body: "Note", targetType: "table", targetId: "" },
    { body: "Note", targetType: "table", targetId: "table id with spaces" },
    { body: "Note", targetType: "table", targetId: "table/<script>" },
    {
      body: "Note",
      targetType: "table",
      targetId: "x".repeat(COMMENT_TARGET_ID_MAX_LENGTH + 1),
    },
  ];

  for (const payload of invalidPayloads) {
    const result = validateCommentInput(payload);
    assert.equal(result.ok, false, JSON.stringify(payload));
    assert.equal(result.code, "invalid_comment_target");
  }

  assert.equal(
    validateCommentInput({
      body: "At the target id boundary",
      targetType: "table",
      targetId: "x".repeat(COMMENT_TARGET_ID_MAX_LENGTH),
    }).ok,
    true,
  );
});

test("builds deterministic threads from unordered comments without mutating input", () => {
  const rootLater = comment({
    id: "root-later",
    body: "Later thread",
    createdAt: "2026-07-31T10:00:00.000Z",
  });
  const rootEarlierB = comment({
    id: "root-b",
    body: "Earlier B",
    createdAt: "2026-07-31T08:00:00.000Z",
  });
  const rootEarlierA = comment({
    id: "root-a",
    body: "Earlier A",
    createdAt: "2026-07-31T08:00:00.000Z",
  });
  const replyLater = comment({
    id: "reply-later",
    parentId: "root-a",
    body: "Second reply",
    createdAt: "2026-07-31T08:20:00.000Z",
  });
  const replyEarlier = comment({
    id: "reply-earlier",
    parentId: "root-a",
    body: "First reply",
    createdAt: "2026-07-31T08:10:00.000Z",
  });
  const orphanReply = comment({
    id: "orphan",
    parentId: "missing-root",
    body: "Unavailable parent",
    createdAt: "2026-07-31T07:00:00.000Z",
  });
  const input = [rootLater, replyLater, rootEarlierB, orphanReply, replyEarlier, rootEarlierA];
  const originalOrder = input.map((item) => item.id);

  const threads = buildCommentThreads(input);

  assert.deepEqual(
    threads.map((thread) => thread.id),
    ["root-a", "root-b", "root-later"],
    "roots use created-at ordering with id as a stable tie-breaker",
  );
  assert.deepEqual(
    threads[0].replies.map((reply) => reply.id),
    ["reply-earlier", "reply-later"],
  );
  assert.deepEqual(threads[1].replies, []);
  assert.deepEqual(input.map((item) => item.id), originalOrder);
  assert.equal("replies" in rootEarlierA, false, "source records are not decorated in place");
});

test("applies the documented resolve authorization matrix", () => {
  for (const role of ["owner", "editor"]) {
    assert.equal(canResolveComment(role, "user-other", "user-author"), true);
  }
  assert.equal(canResolveComment("viewer", "user-author", "user-author"), true);
  assert.equal(canResolveComment("viewer", "user-other", "user-author"), false);
  assert.equal(canResolveComment("unknown", "user-other", "user-author"), false);
});
