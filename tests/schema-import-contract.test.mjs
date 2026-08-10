import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workspaceUrl = new URL("../components/diagram-workspace.tsx", import.meta.url);

test("schema import exposes an accessible paste, upload, and format-selection source step", async () => {
  const workspace = await readFile(workspaceUrl, "utf8");

  assert.match(workspace, /role="dialog"/u);
  assert.match(workspace, /aria-modal="true"/u);
  assert.match(workspace, /aria-labelledby="import-title"/u);
  assert.match(workspace, /id="import-title"[^>]*>Import schema</u);
  assert.match(workspace, /Schema source/u);
  assert.match(workspace, /aria-label="Schema source"/u);
  assert.match(workspace, /type="file"/u);
  assert.match(workspace, /SCHEMA_IMPORT_ACCEPT/u);
  assert.match(workspace, /onDrop/u);

  for (const label of [
    "Auto detect",
    "DBML",
    "PostgreSQL",
    "MySQL",
    "SQLite",
    "Prisma",
    "Drizzle",
    "JSON Schema",
    "Relix JSON",
  ]) {
    assert.match(workspace, new RegExp(`label: ["']${label}["']`, "u"));
  }

  assert.match(workspace, />Source</u);
  assert.match(workspace, />Preview</u);
  assert.match(workspace, />Parse schema</u);
  assert.match(workspace, />Cancel</u);
  assert.match(workspace, />Reset</u);
});

test("schema import accepts only documented, non-executable schema file types", async () => {
  const workspace = await readFile(workspaceUrl, "utf8");
  const acceptMatch = /SCHEMA_IMPORT_ACCEPT\s*=\s*(["'])(.*?)\1/u.exec(workspace);

  assert.ok(acceptMatch, "the import file input must use one centralized allowlist");
  const accepted = new Set(acceptMatch[2].split(","));
  for (const extension of [
    ".dbml",
    ".sql",
    ".prisma",
    ".ts",
    ".json",
    ".txt",
  ]) {
    assert.ok(accepted.has(extension), `${extension} must be accepted`);
  }
  for (const executable of [
    ".sqlite",
    ".sqlite3",
    ".db",
    ".js",
    ".mjs",
    ".cjs",
    ".exe",
    ".sh",
    ".ps1",
  ]) {
    assert.equal(accepted.has(executable), false, `${executable} must not be accepted`);
  }

  assert.match(workspace, /SCHEMA_IMPORT_MAX_BYTES/u);
  assert.match(workspace, /await import\(["']@\/lib\/schema-import["']\)/u);
  assert.doesNotMatch(
    workspace,
    /import\s*\{[^}]*\bparseSchemaImport\b[^}]*\}\s*from\s*["']@\/lib\/schema-import["']/su,
  );
  assert.doesNotMatch(workspace, /\beval\s*\(/u);
  assert.doesNotMatch(workspace, /new\s+Function\s*\(/u);
  assert.doesNotMatch(workspace, /dangerouslySetInnerHTML/u);
});

test("schema import preview communicates stats, warnings, and selectable tables", async () => {
  const workspace = await readFile(workspaceUrl, "utf8");

  for (const term of ["tables", "fields", "relations", "warnings"]) {
    assert.match(workspace, new RegExp(term, "iu"));
  }
  assert.match(workspace, /Select all tables/u);
  assert.match(workspace, /type="checkbox"/u);
  assert.match(workspace, /schemaImportSelectedTableIds/u);
  assert.match(workspace, /diagnostics/u);
  assert.match(workspace, /role="status"/u);
  assert.match(workspace, /aria-live="polite"/u);
  assert.match(workspace, />Back</u);
});

test("generation offers replace/merge policies and makes the completed import immediately undoable", async () => {
  const workspace = await readFile(workspaceUrl, "utf8");

  for (const label of [
    "Replace current",
    "Merge with current",
    "Update existing",
    "Rename imported",
    "Skip conflicts",
    "Generate diagram",
  ]) {
    assert.match(workspace, new RegExp(label, "u"));
  }

  assert.match(workspace, /filterSchemaDocument/u);
  assert.match(workspace, /mergeSchemaDocuments/u);
  assert.match(workspace, /serializeDBML/u);
  assert.match(workspace, /setHistoryEntries/u);
  assert.match(workspace, /setHistoryIndex/u);
  assert.match(workspace, /Ctrl\+Z/u);
});
