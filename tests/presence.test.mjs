import assert from "node:assert/strict";
import test from "node:test";

import {
  PRESENCE_ACTIVE_WINDOW_MS,
  PRESENCE_COORDINATE_LIMIT,
  PRESENCE_SESSION_ID_MAX_LENGTH,
  validatePresenceSession,
  validatePresenceUpdate,
} from "../lib/presence.ts";

test("publishes the bounded live-presence contract", () => {
  assert.equal(PRESENCE_ACTIVE_WINDOW_MS, 12_000);
  assert.equal(PRESENCE_COORDINATE_LIMIT, 1_000_000);
  assert.equal(PRESENCE_SESSION_ID_MAX_LENGTH, 64);
});

test("accepts UUID-like sessions at both length boundaries", () => {
  for (const sessionId of [
    "abcdefgh",
    "019fb683-0f1a-7fd0-816e-a456ced2f499",
    `a${"b".repeat(PRESENCE_SESSION_ID_MAX_LENGTH - 1)}`,
  ]) {
    assert.deepEqual(validatePresenceSession({ sessionId }), {
      ok: true,
      value: { sessionId },
    });
  }
});

test("rejects malformed, ambiguous, and oversized session identifiers", () => {
  const invalidSessionIds = [
    undefined,
    null,
    123,
    {},
    [],
    "",
    "abcdefg",
    "-abcdefg",
    "_abcdefg",
    " abcdefgh",
    "abcdefgh ",
    "session/id",
    "session.id",
    "เซสชัน-123",
    `a${"b".repeat(PRESENCE_SESSION_ID_MAX_LENGTH)}`,
  ];

  for (const sessionId of invalidSessionIds) {
    const result = validatePresenceSession({ sessionId });
    assert.equal(result.ok, false, `session ${JSON.stringify(sessionId)} must be rejected`);
    assert.equal(result.code, "invalid_presence_session");
  }
});

test("accepts finite world coordinates including exact positive and negative limits", () => {
  const sessionId = "session_12345678";
  for (const [x, y] of [
    [0, 0],
    [120.25, -88.75],
    [PRESENCE_COORDINATE_LIMIT, -PRESENCE_COORDINATE_LIMIT],
    [-PRESENCE_COORDINATE_LIMIT, PRESENCE_COORDINATE_LIMIT],
  ]) {
    assert.deepEqual(validatePresenceUpdate({ sessionId, x, y }), {
      ok: true,
      value: { sessionId, x, y },
    });
  }
});

test("rejects non-numeric, non-finite, and out-of-bounds cursor coordinates", () => {
  const sessionId = "session_12345678";
  const invalidCoordinates = [
    undefined,
    null,
    "0",
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    PRESENCE_COORDINATE_LIMIT + Number.EPSILON * PRESENCE_COORDINATE_LIMIT,
    PRESENCE_COORDINATE_LIMIT + 1,
    -PRESENCE_COORDINATE_LIMIT - 1,
  ];

  for (const coordinate of invalidCoordinates) {
    for (const payload of [
      { sessionId, x: coordinate, y: 0 },
      { sessionId, x: 0, y: coordinate },
    ]) {
      const result = validatePresenceUpdate(payload);
      assert.equal(result.ok, false, JSON.stringify(payload));
      assert.equal(result.code, "invalid_cursor_position");
    }
  }
});

test("validation returns only client-owned presence fields", () => {
  const payload = {
    sessionId: "session_12345678",
    x: 42,
    y: -19,
    userId: "spoofed-user",
    displayName: "Spoofed User",
    projectId: "another-project",
    updatedAt: "2999-01-01T00:00:00.000Z",
  };

  assert.deepEqual(validatePresenceUpdate(payload), {
    ok: true,
    value: { sessionId: payload.sessionId, x: 42, y: -19 },
  });
});
