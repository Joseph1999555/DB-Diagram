import { and, asc, desc, eq, gte, ne } from "drizzle-orm";
import { getDb } from "@/db";
import { cursorPresence, users } from "@/db/schema";
import {
  PRESENCE_ACTIVE_WINDOW_MS,
  validatePresenceSession,
  validatePresenceUpdate,
  type CursorPresence,
} from "@/lib/presence";
import {
  RouteError,
  readJsonBody,
  requireExistingProjectAccess,
  routeErrorResponse,
} from "@/lib/server/project-access";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await requireExistingProjectAccess(request);
    const now = new Date();
    const activeSince = new Date(
      now.getTime() - PRESENCE_ACTIVE_WINDOW_MS,
    ).toISOString();
    const cursors: CursorPresence[] = await getDb()
      .select({
        sessionId: cursorPresence.sessionId,
        userId: cursorPresence.userId,
        displayName: users.displayName,
        x: cursorPresence.x,
        y: cursorPresence.y,
        updatedAt: cursorPresence.updatedAt,
      })
      .from(cursorPresence)
      .innerJoin(users, eq(cursorPresence.userId, users.id))
      .where(
        and(
          eq(cursorPresence.projectId, access.project.id),
          ne(cursorPresence.userId, access.user.id),
          gte(cursorPresence.updatedAt, activeSince),
        ),
      )
      .orderBy(
        desc(cursorPresence.updatedAt),
        asc(cursorPresence.userId),
        asc(cursorPresence.sessionId),
      )
      .limit(64);

    return privateJson({ cursors, serverTime: new Date().toISOString() });
  } catch (error) {
    return presenceErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const access = await requireExistingProjectAccess(request);
    const payload = await readJsonBody(request);
    const validation = validatePresenceUpdate(payload);
    if (!validation.ok) {
      throw new RouteError(400, validation.message, validation.code);
    }

    const input = validation.value;
    const updatedAt = new Date().toISOString();
    await getDb()
      .insert(cursorPresence)
      .values({
        projectId: access.project.id,
        userId: access.user.id,
        sessionId: input.sessionId,
        x: input.x,
        y: input.y,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: [
          cursorPresence.projectId,
          cursorPresence.userId,
          cursorPresence.sessionId,
        ],
        set: { x: input.x, y: input.y, updatedAt },
      });

    return privateEmpty();
  } catch (error) {
    return presenceErrorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const access = await requireExistingProjectAccess(request);
    const querySessionId = new URL(request.url).searchParams.get("sessionId");
    const payload = querySessionId
      ? { sessionId: querySessionId }
      : await readJsonBody(request);
    const validation = validatePresenceSession(payload);
    if (!validation.ok) {
      throw new RouteError(400, validation.message, validation.code);
    }

    await getDb()
      .delete(cursorPresence)
      .where(
        and(
          eq(cursorPresence.projectId, access.project.id),
          eq(cursorPresence.userId, access.user.id),
          eq(cursorPresence.sessionId, validation.value.sessionId),
        ),
      );

    return privateEmpty();
  } catch (error) {
    return presenceErrorResponse(error);
  }
}

function privateJson(body: unknown) {
  return Response.json(body, {
    headers: { "cache-control": "private, no-store" },
  });
}

function privateEmpty() {
  return new Response(null, {
    status: 204,
    headers: { "cache-control": "private, no-store" },
  });
}

function presenceErrorResponse(error: unknown) {
  const response = routeErrorResponse(error, "Presence");
  response.headers.set("cache-control", "private, no-store");
  return response;
}
