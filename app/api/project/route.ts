import { and, asc, eq, sql } from "drizzle-orm";
import { getChatGPTUser } from "../../chatgpt-auth";
import { ensureProjectStorage, getDb } from "../../../db";
import {
  projectMembers,
  projectRoles,
  projects,
  users,
  type ProjectRole,
} from "../../../db/schema";

export const dynamic = "force-dynamic";

const DEMO_PROJECT_ID = "demo";
const MAX_DBML_LENGTH = 1_000_000;
const MAX_LAYOUT_LENGTH = 250_000;

const DEFAULT_DBML = `// Northstar Commerce — shared demo schema
Table users {
  id uuid [pk]
  email varchar [not null, unique]
  name varchar [not null]
  created_at timestamp [not null]
}

Table workspaces {
  id uuid [pk]
  name varchar [not null]
  owner_id uuid [not null]
}

Table workspace_members {
  workspace_id uuid [not null]
  user_id uuid [not null]
  role varchar [not null]
  joined_at timestamp [not null]
}

Table customers {
  id uuid [pk]
  workspace_id uuid [not null]
  email varchar [not null]
}

Table products {
  id uuid [pk]
  workspace_id uuid [not null]
  sku varchar [not null]
  name varchar [not null]
  price_cents int [not null]
}

Table orders {
  id uuid [pk]
  customer_id uuid [not null]
  status varchar [not null]
  total_cents int [not null]
  created_at timestamp [not null]
}

Table order_items {
  id uuid [pk]
  order_id uuid [not null]
  product_id uuid [not null]
  quantity int [not null]
}

Table payments {
  id uuid [pk]
  order_id uuid [not null]
  provider varchar [not null]
  status varchar [not null]
  amount_cents int [not null]
}

Ref: workspaces.owner_id > users.id
Ref: workspace_members.workspace_id > workspaces.id
Ref: workspace_members.user_id > users.id
Ref: customers.workspace_id > workspaces.id
Ref: products.workspace_id > workspaces.id
Ref: orders.customer_id > customers.id
Ref: order_items.order_id > orders.id
Ref: order_items.product_id > products.id
Ref: payments.order_id > orders.id

TableGroup Identity {
  users
  workspaces
  workspace_members
}

TableGroup Catalog {
  products
}

TableGroup Checkout {
  customers
  orders
  order_items
  payments
}`;

const DEFAULT_LAYOUT = {
  users: { x: 72, y: 84 },
  workspaces: { x: 360, y: 84 },
  workspace_members: { x: 216, y: 348 },
  products: { x: 512, y: 500 },
  customers: { x: 760, y: 84 },
  orders: { x: 760, y: 348 },
  order_items: { x: 1048, y: 348 },
  payments: { x: 760, y: 640 },
};

type RequestIdentity = {
  email: string;
  displayName: string;
};

type UserRow = typeof users.$inferSelect;
type ProjectRow = typeof projects.$inferSelect;

class RouteError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export async function GET(request: Request) {
  try {
    const access = await requireProjectAccess(request);
    const members = await listMembers(access.project.id);

    return Response.json({
      project: serializeProject(access.project),
      members,
      currentUser: serializeCurrentUser(access.user, access.role),
    });
  } catch (error) {
    return routeErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const access = await requireProjectAccess(request);
    requireRole(access.role, ["owner", "editor"]);

    const payload = await readJsonBody(request);
    const update: {
      name?: string;
      dbml?: string;
      layout?: string;
      updatedAt: string;
      updatedById: string;
    } = {
      updatedAt: new Date().toISOString(),
      updatedById: access.user.id,
    };

    if (payload.name !== undefined) {
      if (typeof payload.name !== "string" || !payload.name.trim()) {
        throw new RouteError(400, "name must be a non-empty string", "invalid_name");
      }
      if (payload.name.trim().length > 120) {
        throw new RouteError(400, "name must be 120 characters or fewer", "invalid_name");
      }
      update.name = payload.name.trim();
    }

    if (payload.dbml !== undefined) {
      if (typeof payload.dbml !== "string") {
        throw new RouteError(400, "dbml must be a string", "invalid_dbml");
      }
      if (payload.dbml.length > MAX_DBML_LENGTH) {
        throw new RouteError(413, "dbml is too large", "dbml_too_large");
      }
      update.dbml = payload.dbml;
    }

    if (payload.layout !== undefined) {
      if (
        payload.layout === null ||
        typeof payload.layout !== "object" ||
        Array.isArray(payload.layout)
      ) {
        throw new RouteError(400, "layout must be a JSON object", "invalid_layout");
      }
      const serializedLayout = JSON.stringify(payload.layout);
      if (serializedLayout.length > MAX_LAYOUT_LENGTH) {
        throw new RouteError(413, "layout is too large", "layout_too_large");
      }
      update.layout = serializedLayout;
    }

    if (
      update.name === undefined &&
      update.dbml === undefined &&
      update.layout === undefined
    ) {
      throw new RouteError(
        400,
        "Provide at least one of name, dbml, or layout",
        "empty_update",
      );
    }

    const db = getDb();
    const [project] = await db
      .update(projects)
      .set({
        ...update,
        version: sql`CAST(${projects.version} AS INTEGER) + 1`,
      })
      .where(eq(projects.id, access.project.id))
      .returning();

    return Response.json({ project: serializeProject(project) });
  } catch (error) {
    return routeErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const access = await requireProjectAccess(request);
    requireRole(access.role, ["owner"]);

    const payload = await readJsonBody(request);
    if (typeof payload.email !== "string" || !isEmail(payload.email)) {
      throw new RouteError(400, "A valid email is required", "invalid_email");
    }
    if (
      typeof payload.role !== "string" ||
      !projectRoles.includes(payload.role as ProjectRole)
    ) {
      throw new RouteError(
        400,
        "role must be owner, editor, or viewer",
        "invalid_role",
      );
    }

    const role = payload.role as ProjectRole;
    const invitedUser = await upsertUser({
      email: normalizeEmail(payload.email),
      displayName: displayNameFromEmail(payload.email),
    });

    if (invitedUser.id === access.project.createdById && role !== "owner") {
      throw new RouteError(
        400,
        "The original project owner cannot be demoted",
        "owner_required",
      );
    }

    const now = new Date().toISOString();
    const db = getDb();
    await db
      .insert(projectMembers)
      .values({
        projectId: access.project.id,
        userId: invitedUser.id,
        role,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [projectMembers.projectId, projectMembers.userId],
        set: { role, updatedAt: now },
      });

    const members = await listMembers(access.project.id);
    const member = members.find((item) => item.id === invitedUser.id);
    return Response.json({ member, members }, { status: 201 });
  } catch (error) {
    return routeErrorResponse(error);
  }
}

async function requireProjectAccess(request: Request) {
  await ensureProjectStorage();

  const identity = await getRequestIdentity(request);
  if (!identity) {
    throw new RouteError(401, "Sign in to access this project", "unauthenticated");
  }

  const user = await upsertUser(identity);
  const project = await ensureDemoProject(user);
  const db = getDb();
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

async function getRequestIdentity(
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

async function upsertUser(identity: RequestIdentity): Promise<UserRow> {
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

async function ensureDemoProject(currentUser: UserRow): Promise<ProjectRow> {
  const db = getDb();
  const now = new Date().toISOString();
  await db
    .insert(projects)
    .values({
      id: DEMO_PROJECT_ID,
      name: "Northstar Commerce",
      dbml: DEFAULT_DBML,
      layout: JSON.stringify(DEFAULT_LAYOUT),
      version: "1",
      createdById: currentUser.id,
      updatedById: currentUser.id,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: projects.id });

  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, DEMO_PROJECT_ID))
    .limit(1);

  if (!project) {
    throw new Error("The demo project could not be initialized");
  }

  await db
    .insert(projectMembers)
    .values({
      projectId: project.id,
      userId: project.createdById,
      role: "owner",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({
      target: [projectMembers.projectId, projectMembers.userId],
    });

  return project;
}

async function listMembers(projectId: string) {
  const db = getDb();
  return db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      role: projectMembers.role,
      joinedAt: projectMembers.createdAt,
    })
    .from(projectMembers)
    .innerJoin(users, eq(projectMembers.userId, users.id))
    .where(eq(projectMembers.projectId, projectId))
    .orderBy(asc(users.displayName), asc(users.email));
}

function serializeProject(project: ProjectRow) {
  return {
    id: project.id,
    name: project.name,
    dbml: project.dbml,
    layout: parseLayout(project.layout),
    updatedAt: project.updatedAt,
    version: Number(project.version),
  };
}

function serializeCurrentUser(user: UserRow, role: ProjectRole) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role,
  };
}

function parseLayout(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function requireRole(actual: ProjectRole, allowed: ProjectRole[]) {
  if (!allowed.includes(actual)) {
    throw new RouteError(
      403,
      "Your project role does not allow this action",
      "insufficient_role",
    );
  }
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
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

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function displayNameFromEmail(email: string) {
  const localPart = normalizeEmail(email).split("@")[0] || "Collaborator";
  return localPart
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function isEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function routeErrorResponse(error: unknown) {
  if (error instanceof RouteError) {
    return Response.json(
      { error: error.message, code: error.code },
      { status: error.status },
    );
  }

  console.error("Project API error", error);
  return Response.json(
    { error: "The project service is temporarily unavailable" },
    { status: 500 },
  );
}
