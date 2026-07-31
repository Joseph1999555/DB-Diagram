import { and, eq } from "drizzle-orm";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { ensureProjectStorage, getDb } from "@/db";
import {
  projectMembers,
  projects,
  users,
  type ProjectRole,
} from "@/db/schema";

export const DEFAULT_PROJECT_ID = "demo";

export type RequestIdentity = {
  email: string;
  displayName: string;
};

export type UserRow = typeof users.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;

export class RouteError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export async function requireExistingProjectAccess(
  request: Request,
  projectId = DEFAULT_PROJECT_ID,
) {
  await ensureProjectStorage();
  const identity = await getRequestIdentity(request);
  if (!identity) {
    throw new RouteError(401, "Sign in to access this project", "unauthenticated");
  }

  const user = await upsertUser(identity);
  const db = getDb();
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) {
    throw new RouteError(404, "Project not found", "project_not_found");
  }

  const [membership] = await db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, project.id),
        eq(projectMembers.userId, user.id),
      ),
    )
    .limit(1);
  if (!membership) {
    throw new RouteError(
      403,
      "You have not been invited to this project",
      "not_a_member",
    );
  }

  return { project, user, role: membership.role };
}

export async function getRequestIdentity(
  request: Request,
): Promise<RequestIdentity | null> {
  const chatGPTUser = await getChatGPTUser();
  if (chatGPTUser) {
    return {
      email: normalizeEmail(chatGPTUser.email),
      displayName: chatGPTUser.displayName.trim() || chatGPTUser.email,
    };
  }

  // Development-only impersonation makes role flows testable without
  // weakening authentication after deployment.
  if (process.env.NODE_ENV !== "production") {
    const email = normalizeEmail(
      request.headers.get("x-dev-user-email") || "owner@local.dev",
    );
    const displayName =
      request.headers.get("x-dev-user-name")?.trim() ||
      displayNameFromEmail(email);
    return { email, displayName };
  }

  return null;
}

export async function upsertUser(identity: RequestIdentity): Promise<UserRow> {
  const db = getDb();
  const email = normalizeEmail(identity.email);
  const now = new Date().toISOString();
  const [user] = await db
    .insert(users)
    .values({
      id: crypto.randomUUID(),
      email,
      displayName: identity.displayName.trim() || displayNameFromEmail(email),
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: users.email,
      set: {
        displayName:
          identity.displayName.trim() || displayNameFromEmail(email),
        updatedAt: now,
      },
    })
    .returning();

  return user;
}

export function requireRole(actual: ProjectRole, allowed: ProjectRole[]) {
  if (!allowed.includes(actual)) {
    throw new RouteError(
      403,
      "Your project role does not allow this action",
      "insufficient_role",
    );
  }
}

export async function readJsonBody(
  request: Request,
): Promise<Record<string, unknown>> {
  try {
    const payload = await request.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("not an object");
    }
    return payload as Record<string, unknown>;
  } catch {
    throw new RouteError(400, "Request body must be a JSON object", "invalid_json");
  }
}

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export function displayNameFromEmail(email: string) {
  const localPart = normalizeEmail(email).split("@")[0] || "Collaborator";
  return localPart
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function isEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export function routeErrorResponse(error: unknown, service = "Project") {
  if (error instanceof RouteError) {
    return Response.json(
      { error: error.message, code: error.code },
      { status: error.status },
    );
  }

  console.error(`${service} API error`, error);
  return Response.json(
    { error: `The ${service.toLowerCase()} service is temporarily unavailable` },
    { status: 500 },
  );
}
