export const PRESENCE_ACTIVE_WINDOW_MS = 12_000;
export const PRESENCE_COORDINATE_LIMIT = 1_000_000;
export const PRESENCE_SESSION_ID_MAX_LENGTH = 64;

const PRESENCE_SESSION_ID_MIN_LENGTH = 8;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{6,62}[A-Za-z0-9]$/;

export type CursorPresence = {
  sessionId: string;
  userId: string;
  displayName: string;
  x: number;
  y: number;
  updatedAt: string;
};

export type PresenceUpdate = {
  sessionId: string;
  x: number;
  y: number;
};

export type PresenceValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string };

export function validatePresenceUpdate(
  payload: Record<string, unknown>,
): PresenceValidationResult<PresenceUpdate> {
  const session = validatePresenceSession(payload);
  if (!session.ok) return session;

  if (!isWorldCoordinate(payload.x) || !isWorldCoordinate(payload.y)) {
    return {
      ok: false,
      code: "invalid_cursor_position",
      message: `Cursor coordinates must be finite numbers between -${PRESENCE_COORDINATE_LIMIT} and ${PRESENCE_COORDINATE_LIMIT}`,
    };
  }

  return {
    ok: true,
    value: { sessionId: session.value.sessionId, x: payload.x, y: payload.y },
  };
}

export function validatePresenceSession(
  payload: Record<string, unknown>,
): PresenceValidationResult<{ sessionId: string }> {
  if (
    typeof payload.sessionId !== "string" ||
    payload.sessionId.length < PRESENCE_SESSION_ID_MIN_LENGTH ||
    payload.sessionId.length > PRESENCE_SESSION_ID_MAX_LENGTH ||
    !SESSION_ID.test(payload.sessionId)
  ) {
    return {
      ok: false,
      code: "invalid_presence_session",
      message: `sessionId must be a UUID-like identifier of at most ${PRESENCE_SESSION_ID_MAX_LENGTH} characters`,
    };
  }

  return { ok: true, value: { sessionId: payload.sessionId } };
}

function isWorldCoordinate(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Math.abs(value) <= PRESENCE_COORDINATE_LIMIT
  );
}
