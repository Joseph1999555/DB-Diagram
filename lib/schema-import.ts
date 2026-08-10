import {
  makeDbmlId,
  parseDBML,
  serializeDBML,
  type DbmlDiagnostic,
  type DbmlDocument,
  type DbmlField,
  type DbmlGroup,
  type DbmlRelation,
  type DbmlRelationOperator,
  type DbmlTable,
} from "./dbml";

/** Every source users can choose in the schema import dialog. */
export type SchemaImportFormat =
  | "auto"
  | "dbml"
  | "postgresql"
  | "mysql"
  | "sqlite"
  | "prisma"
  | "drizzle"
  | "json-schema"
  | "relix";

export type ConcreteSchemaImportFormat = Exclude<SchemaImportFormat, "auto">;
export type SchemaMergeStrategy = "update" | "rename" | "skip";

export type SchemaImportLayout = Record<string, { x: number; y: number }>;

export interface SchemaImportOptions {
  format?: SchemaImportFormat;
  fileName?: string;
}

export interface SchemaImportResult {
  format: ConcreteSchemaImportFormat;
  label: string;
  document: DbmlDocument;
  /** Normalized DBML suitable for saving in a Relix project. */
  dbml: string;
  diagnostics: DbmlDiagnostic[];
  /** Convenience projection used by compact import previews. */
  warnings: string[];
  projectName?: string;
  /** Backwards-friendly alias for projectName. */
  name?: string;
  layout?: SchemaImportLayout;
}

export interface SchemaMergeConflict {
  qualifiedName: string;
  currentTableId: string;
  incomingTableId: string;
  strategy: SchemaMergeStrategy;
  resolution: "updated" | "renamed" | "skipped";
  renamedTo?: string;
}

export interface SchemaMergeResult {
  document: DbmlDocument;
  conflicts: SchemaMergeConflict[];
  updatedTableIds: string[];
  skippedTableIds: string[];
  renamedTables: Array<{ from: string; to: string; tableId: string }>;
}

interface FieldSpec {
  name: string;
  type?: string;
  primaryKey?: boolean;
  notNull?: boolean;
  unique?: boolean;
  increment?: boolean;
  default?: string;
  note?: string;
  extraSettings?: string[];
}

interface TableSpec {
  name: string;
  schema?: string;
  domain?: string;
  note?: string;
  fields: FieldSpec[];
}

interface RelationSpec {
  name?: string;
  fromTable: string;
  fromField: string;
  toTable: string;
  toField: string;
  operator?: DbmlRelationOperator;
  settings?: string[];
}

interface ParsedSpecs {
  tables: TableSpec[];
  relations: RelationSpec[];
  diagnostics: DbmlDiagnostic[];
}

interface MutableRelationEndpoint {
  tableId: string;
  fieldId: string;
  tableName: string;
  fieldName: string;
}

const MAX_SOURCE_LENGTH = 5_000_000;

const FORMAT_LABELS: Record<ConcreteSchemaImportFormat, string> = {
  dbml: "DBML",
  postgresql: "PostgreSQL",
  mysql: "MySQL",
  sqlite: "SQLite",
  prisma: "Prisma",
  drizzle: "Drizzle",
  "json-schema": "JSON Schema",
  relix: "Relix snapshot",
};

const SQL_FORMATS = new Set<ConcreteSchemaImportFormat>([
  "postgresql",
  "mysql",
  "sqlite",
]);

/**
 * Detect a schema format without executing any part of the source.
 * Content wins over the extension, except for otherwise ambiguous SQL.
 */
export function detectSchemaFormat(
  source: string,
  fileName?: string,
): ConcreteSchemaImportFormat {
  const text = source.trim();
  const lowerName = (fileName ?? "").toLocaleLowerCase("en-US");

  if (looksLikeJson(text)) {
    try {
      const value: unknown = JSON.parse(text);
      if (isRecord(value)) {
        if (readRelixDbml(value) !== undefined) return "relix";
        if (looksLikeJsonSchemaObject(value)) return "json-schema";
      }
    } catch {
      // The parser will provide a more useful error after format selection.
    }
  }

  if (
    /(?:^|\n)\s*(?:Project\s+[^\n{]+\s*)?Table\s+(?:"[^"]+"|`[^`]+`|[\w$.]+)[^{\n]*\{/i.test(
      text,
    ) ||
    /(?:^|\n)\s*(?:Ref(?:\s+[^:]+)?\s*:|TableGroup\s+)/i.test(text)
  ) {
    return "dbml";
  }

  if (
    /(?:^|\n)\s*(?:model|enum|type)\s+[A-Za-z_$][\w$]*\s*\{/m.test(text) &&
    /(?:@@(?:id|map|schema|unique|index)|@(?:id|relation|default|unique|map|db\.))/m.test(text)
  ) {
    return "prisma";
  }

  if (
    /\b(?:pgTable|mysqlTable|sqliteTable|pgSchema|mysqlSchema|sqliteTableCreator)\s*\(/.test(
      text,
    ) ||
    /from\s+["']drizzle-orm\//.test(text)
  ) {
    return "drizzle";
  }

  if (/\bCREATE\s+(?:TEMP(?:ORARY)?\s+)?TABLE\b/i.test(text)) {
    return detectSqlDialect(text, lowerName);
  }

  if (lowerName.endsWith(".dbml")) return "dbml";
  if (lowerName.endsWith(".prisma")) return "prisma";
  if (/\.relix\.json$/.test(lowerName)) return "relix";
  if (/\.(?:ts|tsx|js|mjs|cjs)$/.test(lowerName)) return "drizzle";
  if (lowerName.endsWith(".json")) return "json-schema";
  if (/\.(?:sqlite|sqlite3|db)\.sql$/.test(lowerName)) return "sqlite";
  if (/\.(?:mysql|mariadb)\.sql$/.test(lowerName)) return "mysql";
  if (/\.(?:pgsql|postgres|postgresql)\.sql$/.test(lowerName)) return "postgresql";
  if (lowerName.endsWith(".sql")) return detectSqlDialect(text, lowerName);

  // DBML is the most forgiving plain-text fallback and produces good diagnostics.
  return "dbml";
}

export function parseSchemaImport(
  source: string,
  options: SchemaImportOptions = {},
): SchemaImportResult {
  if (typeof source !== "string" || !source.trim()) {
    throw new Error("Paste a schema or choose a non-empty schema file.");
  }
  if (source.length > MAX_SOURCE_LENGTH) {
    throw new Error("This schema is larger than 5 MB. Split it into smaller imports and merge them.");
  }

  const requested = options.format ?? "auto";
  const format = requested === "auto"
    ? detectSchemaFormat(source, options.fileName)
    : requested;

  if (format === "relix") return parseRelixSnapshot(source);

  let document: DbmlDocument;
  if (format === "dbml") {
    document = parseDBML(source);
  } else if (SQL_FORMATS.has(format)) {
    document = documentFromSpecs(parseSqlSchema(source, format as SqlDialect));
  } else if (format === "prisma") {
    document = documentFromSpecs(parsePrismaSchema(source));
  } else if (format === "drizzle") {
    document = documentFromSpecs(parseDrizzleSchema(source));
  } else {
    document = documentFromSpecs(parseJsonSchemaSource(source, options.fileName));
  }

  assertUsableDocument(document, FORMAT_LABELS[format]);
  return createImportResult(format, document);
}

function createImportResult(
  format: ConcreteSchemaImportFormat,
  document: DbmlDocument,
  metadata: {
    projectName?: string;
    layout?: SchemaImportLayout;
  } = {},
): SchemaImportResult {
  // Once at least one table is usable, syntax failures elsewhere are partial-import
  // warnings rather than blockers. The preview lets the user review those tables
  // and choose whether to generate them.
  const diagnostics = document.diagnostics.map((diagnostic) => ({
    ...diagnostic,
    level: document.tables.length > 0 && diagnostic.level === "error"
      ? "warning" as const
      : diagnostic.level,
  }));
  const projectName = metadata.projectName?.trim() || undefined;
  return {
    format,
    label: FORMAT_LABELS[format],
    document,
    dbml: serializeDBML(document),
    diagnostics,
    warnings: diagnostics
      .filter((diagnostic) => diagnostic.level === "warning")
      .map((diagnostic) => diagnostic.message),
    projectName,
    name: projectName,
    layout: metadata.layout,
  };
}

function assertUsableDocument(document: DbmlDocument, label: string) {
  if (document.tables.length > 0) return;
  const diagnostic = document.diagnostics.find((entry) => entry.level === "error");
  throw new Error(
    diagnostic?.message ?? `No tables were found in this ${label} schema.`,
  );
}

function parseRelixSnapshot(source: string): SchemaImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("This Relix snapshot is not valid JSON.");
  }
  if (!isRecord(parsed)) throw new Error("This Relix snapshot must contain a JSON object.");
  const dbml = readRelixDbml(parsed);
  if (dbml === undefined) {
    throw new Error("This Relix snapshot does not contain a DBML project.");
  }
  const document = parseDBML(dbml);
  assertUsableDocument(document, "Relix snapshot");
  const project = isRecord(parsed.project) ? parsed.project : undefined;
  const rawName = project?.name ?? parsed.name;
  const rawLayout = project?.layout ?? parsed.layout;
  return createImportResult("relix", document, {
    projectName: typeof rawName === "string" ? rawName : undefined,
    layout: decodeLayout(rawLayout),
  });
}

function readRelixDbml(value: Record<string, unknown>): string | undefined {
  if (typeof value.dbml === "string") return value.dbml;
  if (isRecord(value.project) && typeof value.project.dbml === "string") {
    return value.project.dbml;
  }
  return undefined;
}

function decodeLayout(value: unknown): SchemaImportLayout | undefined {
  if (!isRecord(value)) return undefined;
  const layout: SchemaImportLayout = {};
  for (const [key, position] of Object.entries(value)) {
    if (
      isRecord(position) &&
      typeof position.x === "number" &&
      Number.isFinite(position.x) &&
      typeof position.y === "number" &&
      Number.isFinite(position.y)
    ) {
      layout[key] = { x: position.x, y: position.y };
    }
  }
  return Object.keys(layout).length > 0 ? layout : undefined;
}

function detectSqlDialect(source: string, fileName = ""): SqlDialect {
  if (/\bPRAGMA\s+(?:foreign_keys|table_info|journal_mode)\b/i.test(source) ||
      /\bWITHOUT\s+ROWID\b/i.test(source) ||
      /\bINTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/i.test(source) ||
      /sqlite_(?:master|schema)/i.test(source) ||
      /\.(?:sqlite|sqlite3|db)\.sql$/.test(fileName)) {
    return "sqlite";
  }
  if (/`[^`]+`/.test(source) ||
      /\bAUTO_INCREMENT\b/i.test(source) ||
      /\bENGINE\s*=\s*(?:InnoDB|MyISAM)\b/i.test(source) ||
      /\b(?:CHARSET|COLLATE)\s*=/i.test(source) ||
      /\bSET\s+NAMES\b/i.test(source) ||
      /\.(?:mysql|mariadb)\.sql$/.test(fileName)) {
    return "mysql";
  }
  return "postgresql";
}

function looksLikeJson(source: string) {
  return source.startsWith("{") || source.startsWith("[");
}

function looksLikeJsonSchemaObject(value: Record<string, unknown>) {
  return (
    typeof value.$schema === "string" ||
    isRecord(value.$defs) ||
    isRecord(value.definitions) ||
    (value.type === "object" && isRecord(value.properties)) ||
    Array.isArray(value.allOf) ||
    Array.isArray(value.anyOf)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function documentFromSpecs(specs: ParsedSpecs): DbmlDocument {
  const diagnostics = specs.diagnostics.map((entry) => ({ ...entry }));
  const tables: DbmlTable[] = [];
  const domainByTableId = new Map<string, string>();
  const occurrences = new Map<string, number>();

  for (const spec of specs.tables) {
    const name = cleanName(spec.name) || "untitled";
    const schema = cleanName(spec.schema ?? "") || undefined;
    const qualified = schema ? `${schema}.${name}` : name;
    const key = canonical(qualified);
    const occurrence = occurrences.get(key) ?? 0;
    occurrences.set(key, occurrence + 1);
    if (occurrence > 0) {
      diagnostics.push({
        level: "warning",
        code: "duplicate-import-table",
        message: `Found more than one definition for ${qualified}; both were retained.`,
      });
    }

    const tableId = makeDbmlId("table", `${key}#${occurrence}`);
    const fieldOccurrences = new Map<string, number>();
    const fields: DbmlField[] = [];
    for (const rawField of spec.fields) {
      const fieldName = cleanName(rawField.name);
      if (!fieldName) {
        diagnostics.push({
          level: "warning",
          code: "missing-field-name",
          message: `Skipped a field without a name in ${qualified}.`,
        });
        continue;
      }
      const fieldKey = canonical(fieldName);
      const fieldOccurrence = fieldOccurrences.get(fieldKey) ?? 0;
      fieldOccurrences.set(fieldKey, fieldOccurrence + 1);
      if (fieldOccurrence > 0) {
        diagnostics.push({
          level: "warning",
          code: "duplicate-import-field",
          message: `Field ${qualified}.${fieldName} is declared more than once.`,
        });
      }
      fields.push({
        id: makeDbmlId(
          "field",
          `${key}.${fieldKey}#${fieldOccurrence}`,
        ),
        name: fieldName,
        type: rawField.type?.trim() || "varchar",
        primaryKey: Boolean(rawField.primaryKey),
        notNull: Boolean(rawField.notNull || rawField.primaryKey),
        unique: Boolean(rawField.unique),
        increment: Boolean(rawField.increment),
        default: rawField.default,
        note: rawField.note,
        extraSettings: copyOptionalArray(rawField.extraSettings),
      });
    }

    const table: DbmlTable = {
      id: tableId,
      name,
      schema,
      note: spec.note,
      fields,
    };
    tables.push(table);
    const domain = cleanName(spec.domain ?? schema ?? "");
    if (domain) domainByTableId.set(table.id, domain);
  }

  const exactTables = new Map<string, DbmlTable>();
  const baseTables = new Map<string, DbmlTable[]>();
  for (const table of tables) {
    const qualified = qualifiedName(table);
    if (!exactTables.has(canonical(qualified))) {
      exactTables.set(canonical(qualified), table);
    }
    const base = canonical(table.name);
    const list = baseTables.get(base) ?? [];
    list.push(table);
    baseTables.set(base, list);
  }

  const relations: DbmlRelation[] = [];
  const relationOccurrences = new Map<string, number>();
  for (const spec of specs.relations) {
    const fromTable = resolveImportedTable(
      spec.fromTable,
      undefined,
      exactTables,
      baseTables,
    );
    const toTable = resolveImportedTable(
      spec.toTable,
      fromTable?.schema,
      exactTables,
      baseTables,
    );
    const fromField = fromTable?.fields.find(
      (field) => canonical(field.name) === canonical(spec.fromField),
    );
    const toField = toTable?.fields.find(
      (field) => canonical(field.name) === canonical(spec.toField),
    );
    if (!fromTable || !toTable || !fromField || !toField) {
      const missing = !fromTable
        ? `table ${spec.fromTable}`
        : !fromField
          ? `field ${spec.fromTable}.${spec.fromField}`
          : !toTable
            ? `table ${spec.toTable}`
            : `field ${spec.toTable}.${spec.toField}`;
      diagnostics.push({
        level: "warning",
        code: "unresolved-import-relation",
        message: `Skipped a relation because ${missing} could not be resolved.`,
      });
      continue;
    }
    const operator = spec.operator ?? ">";
    const semantic = [
      canonical(qualifiedName(fromTable)),
      canonical(fromField.name),
      operator,
      canonical(qualifiedName(toTable)),
      canonical(toField.name),
      canonical(spec.name ?? ""),
    ].join("|");
    const occurrence = relationOccurrences.get(semantic) ?? 0;
    relationOccurrences.set(semantic, occurrence + 1);
    if (occurrence > 0) {
      diagnostics.push({
        level: "warning",
        code: "duplicate-import-relation",
        message: `Duplicate relation ${qualifiedName(fromTable)}.${fromField.name} to ${qualifiedName(toTable)}.${toField.name} was ignored.`,
      });
      continue;
    }
    relations.push({
      id: makeDbmlId("relation", `${semantic}#0`),
      name: spec.name,
      fromTableId: fromTable.id,
      fromFieldId: fromField.id,
      toTableId: toTable.id,
      toFieldId: toField.id,
      fromTable: qualifiedName(fromTable),
      fromField: fromField.name,
      toTable: qualifiedName(toTable),
      toField: toField.name,
      operator,
      cardinality: cardinalityFor(operator),
      source: "standalone",
      settings: copyOptionalArray(spec.settings),
    });
  }

  const grouped = new Map<string, DbmlTable[]>();
  for (const table of tables) {
    const domain = domainByTableId.get(table.id);
    if (!domain) continue;
    const list = grouped.get(domain) ?? [];
    list.push(table);
    grouped.set(domain, list);
  }
  const groups: DbmlGroup[] = [...grouped.entries()].map(([name, members], index) => ({
    id: makeDbmlId("group", `${canonical(name)}#${index}`),
    name,
    tableIds: members.map((table) => table.id),
    tableNames: members.map(qualifiedName),
  }));

  return { tables, relations, groups, diagnostics };
}

function resolveImportedTable(
  rawName: string,
  preferredSchema: string | undefined,
  exact: Map<string, DbmlTable>,
  byBase: Map<string, DbmlTable[]>,
) {
  const rawDirect = exact.get(canonical(rawName));
  if (rawDirect) return rawDirect;
  const normalized = normalizeQualifiedName(rawName);
  const direct = exact.get(canonical(normalized));
  if (direct) return direct;
  const parts = splitIdentifierPath(normalized);
  const base = parts.at(-1) ?? normalized;
  const candidates = byBase.get(canonical(base)) ?? [];
  if (preferredSchema) {
    const local = candidates.find(
      (table) => canonical(table.schema ?? "") === canonical(preferredSchema),
    );
    if (local) return local;
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

function cardinalityFor(operator: DbmlRelationOperator): DbmlRelation["cardinality"] {
  if (operator === ">") return "many-to-one";
  if (operator === "<") return "one-to-many";
  if (operator === "-") return "one-to-one";
  return "many-to-many";
}

/** Keep selected tables and only groups/relations wholly contained by that selection. */
export function filterSchemaDocument(
  document: DbmlDocument,
  selectedTableIds: Iterable<string>,
): DbmlDocument {
  const selected = new Set(selectedTableIds);
  const tables = document.tables
    .filter((table) => selected.has(table.id))
    .map(cloneTable);
  const retainedIds = new Set(tables.map((table) => table.id));
  const relations = document.relations
    .filter(
      (relation) =>
        retainedIds.has(relation.fromTableId) && retainedIds.has(relation.toTableId),
    )
    .map(cloneRelation);
  const tableById = new Map(tables.map((table) => [table.id, table]));
  const groups = document.groups
    .map((group) => {
      const tableIds = group.tableIds.filter((id) => retainedIds.has(id));
      return {
        ...cloneGroup(group),
        tableIds,
        tableNames: tableIds.map((id) => {
          const table = tableById.get(id);
          return table ? qualifiedName(table) : id;
        }),
      };
    })
    .filter((group) => group.tableIds.length > 0);
  return {
    tables,
    relations,
    groups,
    diagnostics: document.diagnostics.map((entry) => ({ ...entry })),
  };
}

export const filterSchemaDocumentByTableIds = filterSchemaDocument;

function cloneTable(table: DbmlTable): DbmlTable {
  return {
    ...table,
    fields: table.fields.map((field) => ({
      ...field,
      extraSettings: copyOptionalArray(field.extraSettings),
    })),
    extraSettings: copyOptionalArray(table.extraSettings),
  };
}

function cloneRelation(relation: DbmlRelation): DbmlRelation {
  return { ...relation, settings: copyOptionalArray(relation.settings) };
}

function cloneGroup(group: DbmlGroup): DbmlGroup {
  return {
    ...group,
    tableIds: [...group.tableIds],
    tableNames: [...group.tableNames],
    extraSettings: copyOptionalArray(group.extraSettings),
  };
}

type SqlDialect = "postgresql" | "mysql" | "sqlite";

interface SqlTableParse {
  table: TableSpec;
  qualifiedName: string;
  relations: RelationSpec[];
  primaryKeys: string[];
  uniqueColumns: string[];
}

function parseSqlSchema(source: string, dialect: SqlDialect): ParsedSpecs {
  const diagnostics: DbmlDiagnostic[] = [];
  const clean = stripCodeComments(source, "sql");
  const statements = splitTopLevelStatements(clean, ";");
  const parsedTables: SqlTableParse[] = [];
  const relations: RelationSpec[] = [];

  for (const statement of statements) {
    if (!/^\s*CREATE\s+/i.test(statement) || !/\bTABLE\b/i.test(statement)) continue;
    const parsed = parseCreateTable(statement, dialect, diagnostics);
    if (!parsed) continue;
    parsedTables.push(parsed);
    relations.push(...parsed.relations);
  }

  const tableByName = new Map<string, SqlTableParse>();
  for (const parsed of parsedTables) {
    if (!tableByName.has(canonical(parsed.qualifiedName))) {
      tableByName.set(canonical(parsed.qualifiedName), parsed);
    }
    const base = canonical(parsed.table.name);
    if (!tableByName.has(base)) tableByName.set(base, parsed);
  }

  // PostgreSQL/MySQL exporters commonly add foreign keys after CREATE TABLE.
  for (const statement of statements) {
    const prefix = /^\s*ALTER\s+TABLE\s+(?:ONLY\s+)?/i.exec(statement);
    if (!prefix) continue;
    const tableToken = takeIdentifierPath(statement, prefix[0].length, "sql");
    if (!tableToken) {
      diagnostics.push({
        level: "warning",
        code: "invalid-alter-table",
        message: "Skipped an ALTER TABLE statement with an unreadable table name.",
      });
      continue;
    }
    const fromTable = tableToken.parts.join(".");
    const body = statement.slice(tableToken.end);
    const foreign = parseSqlForeignKey(body, fromTable, diagnostics);
    if (foreign.length > 0) {
      relations.push(...foreign);
      continue;
    }

    const table = tableByName.get(canonical(fromTable)) ??
      tableByName.get(canonical(tableToken.parts.at(-1) ?? fromTable));
    if (!table) continue;
    const primary = parseConstraintColumns(body, "PRIMARY KEY");
    if (primary.length > 0) applyFieldFlags(table.table, primary, "primaryKey");
    const unique = parseConstraintColumns(body, "UNIQUE");
    if (unique.length === 1) applyFieldFlags(table.table, unique, "unique");
  }

  if (parsedTables.length === 0) {
    diagnostics.push({
      level: "error",
      code: "no-create-table",
      message: `No CREATE TABLE statements were found in this ${FORMAT_LABELS[dialect]} schema.`,
    });
  }
  return { tables: parsedTables.map((entry) => entry.table), relations, diagnostics };
}

function parseCreateTable(
  statement: string,
  dialect: SqlDialect,
  diagnostics: DbmlDiagnostic[],
): SqlTableParse | null {
  const prefix = /^\s*CREATE\s+(?:(?:GLOBAL|LOCAL)\s+)?(?:(?:TEMP|TEMPORARY|UNLOGGED)\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?/i.exec(
    statement,
  );
  if (!prefix) return null;
  const token = takeIdentifierPath(statement, prefix[0].length, "sql");
  if (!token || token.parts.length === 0) {
    diagnostics.push({
      level: "warning",
      code: "invalid-create-table",
      message: "Skipped a CREATE TABLE statement with an unreadable name.",
    });
    return null;
  }
  const open = findOutsideCharacter(statement, "(", token.end);
  if (open < 0) {
    diagnostics.push({
      level: "warning",
      code: "create-table-as",
      message: `Skipped ${token.parts.join(".")} because CREATE TABLE AS/query imports are not supported.`,
    });
    return null;
  }
  const close = findMatchingPair(statement, open, "(", ")");
  if (close < 0) {
    diagnostics.push({
      level: "error",
      code: "unclosed-create-table",
      message: `The CREATE TABLE definition for ${token.parts.join(".")} is not closed.`,
    });
    return null;
  }

  const name = token.parts.at(-1) ?? "untitled";
  const schema = token.parts.length > 1
    ? token.parts.slice(0, -1).join(".")
    : undefined;
  const qualified = schema ? `${schema}.${name}` : name;
  const table: TableSpec = { name, schema, domain: schema, fields: [] };
  const primaryKeys: string[] = [];
  const uniqueColumns: string[] = [];
  const rawForeignKeys: RelationSpec[] = [];

  for (const item of splitTopLevel(statement.slice(open + 1, close), ",")) {
    const value = item.trim();
    if (!value) continue;
    const withoutName = stripSqlConstraintName(value);
    if (/^PRIMARY\s+KEY\b/i.test(withoutName)) {
      primaryKeys.push(...parseConstraintColumns(withoutName, "PRIMARY KEY"));
      continue;
    }
    if (/^(?:UNIQUE)(?:\s+(?:KEY|INDEX))?\b/i.test(withoutName)) {
      const columns = parseConstraintColumns(withoutName, "UNIQUE");
      if (columns.length === 1) uniqueColumns.push(columns[0]);
      else if (columns.length > 1) {
        diagnostics.push({
          level: "warning",
          code: "composite-unique",
          message: `Composite UNIQUE on ${qualified} is not shown as a field-level badge.`,
        });
      }
      continue;
    }
    if (/^FOREIGN\s+KEY\b/i.test(withoutName)) {
      rawForeignKeys.push(...parseSqlForeignKey(withoutName, qualified, diagnostics));
      continue;
    }
    if (/^(?:KEY|INDEX|FULLTEXT|SPATIAL|CHECK|EXCLUDE)\b/i.test(withoutName)) {
      continue;
    }
    const parsedField = parseSqlColumn(value, qualified, dialect, diagnostics);
    if (parsedField) {
      table.fields.push(parsedField.field);
      if (parsedField.reference) rawForeignKeys.push(parsedField.reference);
    }
  }

  applyFieldFlags(table, primaryKeys, "primaryKey");
  applyFieldFlags(table, uniqueColumns, "unique");
  const relations = rawForeignKeys.map((relation) => {
    const childField = table.fields.find(
      (field) => canonical(field.name) === canonical(relation.fromField),
    );
    return {
      ...relation,
      operator: (childField?.unique ? "-" : ">") as DbmlRelationOperator,
    };
  });
  if (table.fields.length === 0) {
    diagnostics.push({
      level: "warning",
      code: "empty-import-table",
      message: `${qualified} was imported without columns.`,
    });
  }
  return { table, qualifiedName: qualified, relations, primaryKeys, uniqueColumns };
}

function parseSqlColumn(
  source: string,
  tableName: string,
  dialect: SqlDialect,
  diagnostics: DbmlDiagnostic[],
): { field: FieldSpec; reference?: RelationSpec } | null {
  const token = takeIdentifierPath(source, 0, "sql", false);
  if (!token || token.parts.length !== 1) {
    diagnostics.push({
      level: "warning",
      code: "invalid-sql-column",
      message: `Skipped an unreadable column in ${tableName}.`,
    });
    return null;
  }
  const rest = source.slice(token.end).trim();
  const constraintIndex = findFirstSqlConstraint(rest);
  const rawType = (constraintIndex < 0 ? rest : rest.slice(0, constraintIndex)).trim();
  if (!rawType) {
    diagnostics.push({
      level: "warning",
      code: "missing-sql-type",
      message: `Skipped ${tableName}.${token.parts[0]} because it has no readable type.`,
    });
    return null;
  }
  const constraints = constraintIndex < 0 ? "" : rest.slice(constraintIndex);
  const serial = /^(?:smallserial|serial|bigserial)\b/i.test(rawType);
  const identity = /\bGENERATED\s+(?:ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY\b/i.test(
    constraints,
  );
  const autoIncrement = /\b(?:AUTO_INCREMENT|AUTOINCREMENT)\b/i.test(constraints);
  const primaryKey = /\bPRIMARY\s+KEY\b/i.test(constraints);
  const field: FieldSpec = {
    name: token.parts[0],
    type: normalizeSqlType(rawType, dialect),
    primaryKey,
    notNull: primaryKey || /\bNOT\s+NULL\b/i.test(constraints),
    unique: /\bUNIQUE\b/i.test(constraints),
    increment: serial || identity || autoIncrement,
    default: extractSqlDefault(constraints),
  };
  const referenceIndex = indexOfKeywordOutside(constraints, "REFERENCES");
  const references = referenceIndex >= 0
    ? parseSqlReferenceTail(constraints.slice(referenceIndex), tableName, field.name, diagnostics)
    : [];
  if (/\bGENERATED\b/i.test(constraints) && !identity) {
    diagnostics.push({
      level: "warning",
      code: "generated-column",
      message: `Generated expression for ${tableName}.${field.name} was imported as a regular field.`,
    });
  }
  return { field, reference: references[0] };
}

function normalizeSqlType(type: string, dialect: SqlDialect) {
  let result = type.trim().replace(/\s+/g, " ");
  if (dialect === "mysql") {
    result = result.replace(/\s+(?:UNSIGNED|ZEROFILL)\b/gi, "").trim();
  }
  return result || "varchar";
}

function extractSqlDefault(constraints: string): string | undefined {
  const index = indexOfKeywordOutside(constraints, "DEFAULT");
  if (index < 0) return undefined;
  const after = constraints.slice(index + "DEFAULT".length).trimStart();
  if (!after) return undefined;
  const next = findFirstSqlConstraint(after, [
    "NOT NULL",
    "NULL",
    "PRIMARY KEY",
    "UNIQUE",
    "REFERENCES",
    "GENERATED",
    "IDENTITY",
    "AUTO_INCREMENT",
    "AUTOINCREMENT",
    "COLLATE",
    "CHECK",
    "COMMENT",
    "CONSTRAINT",
  ]);
  const value = (next < 0 ? after : after.slice(0, next)).trim();
  return value || undefined;
}

function parseSqlForeignKey(
  source: string,
  fromTable: string,
  diagnostics: DbmlDiagnostic[],
): RelationSpec[] {
  const text = stripSqlConstraintName(source.trim());
  const fk = indexOfKeywordOutside(text, "FOREIGN KEY");
  if (fk < 0) return [];
  const childOpen = findOutsideCharacter(text, "(", fk + "FOREIGN KEY".length);
  if (childOpen < 0) return [];
  const childClose = findMatchingPair(text, childOpen, "(", ")");
  if (childClose < 0) return [];
  const childColumns = parseIdentifierList(text.slice(childOpen + 1, childClose), "sql");
  const referenceIndex = indexOfKeywordOutside(text, "REFERENCES", childClose);
  if (referenceIndex < 0) return [];
  const target = takeIdentifierPath(text, referenceIndex + "REFERENCES".length, "sql");
  if (!target) return [];
  const parentOpen = findOutsideCharacter(text, "(", target.end);
  const parentClose = parentOpen >= 0
    ? findMatchingPair(text, parentOpen, "(", ")")
    : -1;
  if (parentOpen < 0 || parentClose < 0) return [];
  const parentColumns = parseIdentifierList(text.slice(parentOpen + 1, parentClose), "sql");
  if (childColumns.length === 0 || childColumns.length !== parentColumns.length) {
    diagnostics.push({
      level: "warning",
      code: "invalid-foreign-key",
      message: `Skipped a foreign key on ${fromTable} because its columns could not be paired.`,
    });
    return [];
  }
  const settings = sqlRelationSettings(text.slice(parentClose + 1));
  return childColumns.map((column, index) => ({
    fromTable,
    fromField: column,
    toTable: target.parts.join("."),
    toField: parentColumns[index],
    operator: ">",
    settings,
  }));
}

function parseSqlReferenceTail(
  source: string,
  fromTable: string,
  fromField: string,
  diagnostics: DbmlDiagnostic[],
): RelationSpec[] {
  const referenceIndex = indexOfKeywordOutside(source, "REFERENCES");
  if (referenceIndex < 0) return [];
  const target = takeIdentifierPath(source, referenceIndex + "REFERENCES".length, "sql");
  if (!target) return [];
  const open = findOutsideCharacter(source, "(", target.end);
  const close = open >= 0 ? findMatchingPair(source, open, "(", ")") : -1;
  if (open < 0 || close < 0) return [];
  const targetFields = parseIdentifierList(source.slice(open + 1, close), "sql");
  if (targetFields.length !== 1) {
    diagnostics.push({
      level: "warning",
      code: "invalid-inline-foreign-key",
      message: `Skipped an inline reference on ${fromTable}.${fromField}.`,
    });
    return [];
  }
  return [{
    fromTable,
    fromField,
    toTable: target.parts.join("."),
    toField: targetFields[0],
    operator: ">",
    settings: sqlRelationSettings(source.slice(close + 1)),
  }];
}

function sqlRelationSettings(source: string): string[] | undefined {
  const settings: string[] = [];
  for (const action of ["delete", "update"] as const) {
    const match = new RegExp(
      `\\bON\\s+${action.toUpperCase()}\\s+(CASCADE|RESTRICT|NO\\s+ACTION|SET\\s+NULL|SET\\s+DEFAULT)\\b`,
      "i",
    ).exec(source);
    if (match) settings.push(`${action}: ${match[1].toLowerCase().replace(/\s+/g, " ")}`);
  }
  return copyOptionalArray(settings);
}

function parseConstraintColumns(source: string, keyword: string): string[] {
  const index = indexOfKeywordOutside(source, keyword);
  if (index < 0) return [];
  const open = findOutsideCharacter(source, "(", index + keyword.length);
  const close = open >= 0 ? findMatchingPair(source, open, "(", ")") : -1;
  return open >= 0 && close >= 0
    ? parseIdentifierList(source.slice(open + 1, close), "sql")
    : [];
}

function applyFieldFlags(
  table: TableSpec,
  columns: string[],
  flag: "primaryKey" | "unique",
) {
  for (const name of columns) {
    const field = table.fields.find(
      (candidate) => canonical(candidate.name) === canonical(name),
    );
    if (field) {
      field[flag] = true;
      if (flag === "primaryKey") field.notNull = true;
    }
  }
}

function stripSqlConstraintName(source: string) {
  const match = /^CONSTRAINT\s+/i.exec(source);
  if (!match) return source;
  const token = takeIdentifierPath(source, match[0].length, "sql", false);
  return token ? source.slice(token.end).trimStart() : source;
}

const SQL_CONSTRAINT_KEYWORDS = [
  "NOT NULL",
  "NULL",
  "PRIMARY KEY",
  "UNIQUE",
  "DEFAULT",
  "REFERENCES",
  "GENERATED",
  "IDENTITY",
  "AUTO_INCREMENT",
  "AUTOINCREMENT",
  "COLLATE",
  "CHECK",
  "CONSTRAINT",
  "COMMENT",
];

function findFirstSqlConstraint(source: string, keywords = SQL_CONSTRAINT_KEYWORDS) {
  let result = -1;
  for (const keyword of keywords) {
    const index = indexOfKeywordOutside(source, keyword);
    if (index >= 0 && (result < 0 || index < result)) result = index;
  }
  return result;
}

interface NamedCodeBlock {
  kind: string;
  name: string;
  body: string;
  start: number;
}

interface PrismaModelMeta {
  modelName: string;
  tableName: string;
  schema?: string;
  block: NamedCodeBlock;
  table: TableSpec;
  fieldNames: Map<string, string>;
  relationLines: string[];
}

function parsePrismaSchema(source: string): ParsedSpecs {
  const diagnostics: DbmlDiagnostic[] = [];
  const clean = stripCodeComments(source, "code");
  const blocks = collectNamedBlocks(clean, ["model", "enum"]);
  const modelBlocks = blocks.filter((block) => block.kind === "model");
  const enumNames = new Set(
    blocks.filter((block) => block.kind === "enum").map((block) => block.name),
  );
  const modelNames = new Set(modelBlocks.map((block) => block.name));
  const metas: PrismaModelMeta[] = [];

  for (const block of modelBlocks) {
    const logicalLines = splitLogicalLines(block.body);
    const mapDirective = logicalLines.find((line) => /^@@map\s*\(/.test(line.trim()));
    const schemaDirective = logicalLines.find((line) => /^@@schema\s*\(/.test(line.trim()));
    const tableName = mapDirective
      ? readFirstStringArgument(mapDirective) ?? block.name
      : block.name;
    const schema = schemaDirective
      ? readFirstStringArgument(schemaDirective) ?? undefined
      : undefined;
    const table: TableSpec = {
      name: tableName,
      schema,
      domain: schema,
      fields: [],
    };
    const fieldNames = new Map<string, string>();
    const relationLines: string[] = [];

    for (const logicalLine of logicalLines) {
      const line = logicalLine.trim();
      if (!line || line.startsWith("@@")) continue;
      const parsed = parsePrismaFieldLine(line);
      if (!parsed) {
        diagnostics.push({
          level: "warning",
          code: "unrecognized-prisma-field",
          message: `Skipped an unrecognized field in Prisma model ${block.name}: ${compact(line)}`,
        });
        continue;
      }
      const baseType = parsed.type.replace(/[?\[\]]+$/g, "");
      if (modelNames.has(baseType)) {
        relationLines.push(line);
        continue;
      }
      const mappedName = readAttributeString(parsed.attributes, "map") ?? parsed.name;
      fieldNames.set(parsed.name, mappedName);
      const optional = parsed.type.endsWith("?");
      const array = parsed.type.replace(/\?$/, "").endsWith("[]");
      const dbType = prismaDbmlType(baseType, parsed.attributes, enumNames);
      const defaultCall = readAttributeCall(parsed.attributes, "default");
      const increment = Boolean(defaultCall && /^autoincrement\s*\(\s*\)$/i.test(defaultCall));
      table.fields.push({
        name: mappedName,
        type: `${dbType}${array && !dbType.endsWith("[]") ? "[]" : ""}`,
        primaryKey: hasPrismaAttribute(parsed.attributes, "id"),
        notNull: !optional,
        unique: hasPrismaAttribute(parsed.attributes, "unique"),
        increment,
        default: increment ? undefined : prismaDefaultValue(defaultCall),
      });
    }

    for (const line of logicalLines) {
      const trimmed = line.trim();
      const ids = parsePrismaModelFieldList(trimmed, "id");
      if (ids.length > 0) applyFieldFlags(table, ids.map((name) => fieldNames.get(name) ?? name), "primaryKey");
      const unique = parsePrismaModelFieldList(trimmed, "unique");
      if (unique.length === 1) applyFieldFlags(table, unique.map((name) => fieldNames.get(name) ?? name), "unique");
      else if (unique.length > 1) {
        diagnostics.push({
          level: "warning",
          code: "prisma-composite-unique",
          message: `Composite @@unique in ${block.name} is not shown as a field-level badge.`,
        });
      }
      if (/^@@index\s*\(/.test(trimmed)) {
        diagnostics.push({
          level: "warning",
          code: "prisma-index-not-visualized",
          message: `Index in ${block.name} was preserved in the source but is not visualized by the diagram.`,
        });
      }
    }
    metas.push({
      modelName: block.name,
      tableName,
      schema,
      block,
      table,
      fieldNames,
      relationLines,
    });
  }

  const metaByModel = new Map(metas.map((meta) => [meta.modelName, meta]));
  const relations: RelationSpec[] = [];
  for (const meta of metas) {
    for (const line of meta.relationLines) {
      const parsed = parsePrismaFieldLine(line);
      if (!parsed) continue;
      const targetModelName = parsed.type.replace(/[?\[\]]+$/g, "");
      const target = metaByModel.get(targetModelName);
      if (!target) continue;
      const relationCall = readAttributeCall(parsed.attributes, "relation");
      if (relationCall === undefined) continue;
      const fields = readPrismaNamedList(relationCall, "fields");
      const references = readPrismaNamedList(relationCall, "references");
      const relationName = readLeadingString(relationCall);
      if (fields.length > 0 && fields.length === references.length) {
        const settings = prismaRelationSettings(relationCall);
        for (let index = 0; index < fields.length; index += 1) {
          const childFieldName = meta.fieldNames.get(fields[index]) ?? fields[index];
          const parentFieldName = target.fieldNames.get(references[index]) ?? references[index];
          const childField = meta.table.fields.find(
            (field) => canonical(field.name) === canonical(childFieldName),
          );
          relations.push({
            name: relationName,
            fromTable: qualifyParts(meta.schema, meta.tableName),
            fromField: childFieldName,
            toTable: qualifyParts(target.schema, target.tableName),
            toField: parentFieldName,
            operator: childField?.unique ? "-" : ">",
            settings,
          });
        }
      } else if (fields.length !== references.length) {
        diagnostics.push({
          level: "warning",
          code: "invalid-prisma-relation",
          message: `Skipped relation ${meta.modelName}.${parsed.name} because fields and references do not match.`,
        });
      }
    }
  }

  if (metas.length === 0) {
    diagnostics.push({
      level: "error",
      code: "no-prisma-models",
      message: "No Prisma model blocks were found.",
    });
  }
  return { tables: metas.map((meta) => meta.table), relations, diagnostics };
}

function parsePrismaFieldLine(source: string): {
  name: string;
  type: string;
  attributes: string;
} | null {
  const name = /^([A-Za-z_$][\w$]*)\s+/.exec(source);
  if (!name) return null;
  const start = name[0].length;
  let depth = 0;
  let quote: string | null = null;
  let index = start;
  for (; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "(") depth += 1;
    else if (character === ")") depth = Math.max(0, depth - 1);
    else if (/\s/.test(character) && depth === 0) break;
  }
  const type = source.slice(start, index).trim();
  return type
    ? { name: name[1], type, attributes: source.slice(index).trim() }
    : null;
}

function prismaDbmlType(
  type: string,
  attributes: string,
  enumNames: Set<string>,
) {
  const native = /@db\.([A-Za-z][\w]*)(?:\(([^)]*)\))?/.exec(attributes);
  if (native) {
    const mappings: Record<string, string> = {
      BigInt: "bigint",
      Bit: "bit",
      Boolean: "boolean",
      ByteA: "bytea",
      Char: "char",
      Date: "date",
      Decimal: "decimal",
      DoublePrecision: "double precision",
      Inet: "inet",
      Int: "integer",
      Integer: "integer",
      Json: "json",
      JsonB: "jsonb",
      MediumInt: "mediumint",
      Money: "money",
      Real: "real",
      SmallInt: "smallint",
      Text: "text",
      Time: "time",
      Timestamp: "timestamp",
      Timestamptz: "timestamptz",
      TinyInt: "tinyint",
      UnsignedBigInt: "bigint",
      UnsignedInt: "integer",
      Uuid: "uuid",
      VarBinary: "varbinary",
      VarChar: "varchar",
    };
    const base = mappings[native[1]] ?? native[1].toLowerCase();
    return `${base}${native[2]?.trim() ? `(${native[2].trim()})` : ""}`;
  }
  const unsupported = /^Unsupported\s*\(\s*["']([\s\S]+)["']\s*\)$/.exec(type);
  if (unsupported) return unsupported[1];
  const mappings: Record<string, string> = {
    BigInt: "bigint",
    Boolean: "boolean",
    Bytes: "bytea",
    DateTime: "timestamp",
    Decimal: "decimal",
    Float: "double precision",
    Int: "integer",
    Json: "json",
    String: "varchar",
  };
  return mappings[type] ?? (enumNames.has(type) ? type : type.toLowerCase());
}

function prismaDefaultValue(value: string | undefined): string | undefined {
  if (value === undefined || /^null$/i.test(value.trim())) return undefined;
  const trimmed = value.trim();
  const generated = /^dbgenerated\s*\(\s*(["'])([\s\S]*)\1\s*\)$/i.exec(trimmed);
  if (generated) return generated[2];
  if (/^(?:now|uuid|cuid|ulid)\s*\(/i.test(trimmed)) return trimmed;
  return trimmed;
}

function parsePrismaModelFieldList(source: string, directive: "id" | "unique") {
  const match = new RegExp(`^@@${directive}\\s*\\(`).exec(source);
  if (!match) return [];
  const open = source.indexOf("(", match.index);
  const close = findMatchingPair(source, open, "(", ")");
  if (close < 0) return [];
  const body = source.slice(open + 1, close);
  const arrayOpen = findOutsideCharacter(body, "[");
  const arrayClose = arrayOpen >= 0 ? findMatchingPair(body, arrayOpen, "[", "]") : -1;
  return arrayOpen >= 0 && arrayClose >= 0
    ? parseIdentifierList(body.slice(arrayOpen + 1, arrayClose), "code")
    : [];
}

function readPrismaNamedList(source: string, name: string) {
  const index = indexOfNamedArgument(source, name);
  if (index < 0) return [];
  const open = findOutsideCharacter(source, "[", index);
  const close = open >= 0 ? findMatchingPair(source, open, "[", "]") : -1;
  return open >= 0 && close >= 0
    ? parseIdentifierList(source.slice(open + 1, close), "code")
    : [];
}

function indexOfNamedArgument(source: string, name: string) {
  const regex = new RegExp(`\\b${escapeRegExp(name)}\\s*:`, "g");
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source))) {
    if (isTopLevelIndex(source, match.index)) return match.index + match[0].length;
  }
  return -1;
}

function prismaRelationSettings(source: string): string[] | undefined {
  const settings: string[] = [];
  for (const [prisma, dbml] of [["onDelete", "delete"], ["onUpdate", "update"]] as const) {
    const index = indexOfNamedArgument(source, prisma);
    if (index < 0) continue;
    const action = /^\s*([A-Za-z]+)/.exec(source.slice(index))?.[1];
    if (action) {
      settings.push(`${dbml}: ${action.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()}`);
    }
  }
  return copyOptionalArray(settings);
}

function readLeadingString(source: string): string | undefined {
  const match = /^\s*(["'])([\s\S]*?)\1/.exec(source);
  return match?.[2];
}

function hasPrismaAttribute(source: string, name: string) {
  return new RegExp(`(?:^|\\s)@${escapeRegExp(name)}(?:\\s|\\(|$)`).test(source);
}

function readAttributeString(source: string, name: string) {
  const call = readAttributeCall(source, name);
  return call === undefined ? undefined : readLeadingString(call);
}

function readAttributeCall(source: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)@${escapeRegExp(name)}\\s*\\(`).exec(source);
  if (!match) return undefined;
  const open = source.indexOf("(", match.index);
  const close = findMatchingPair(source, open, "(", ")");
  return close >= 0 ? source.slice(open + 1, close).trim() : undefined;
}

function readFirstStringArgument(source: string): string | undefined {
  const open = findOutsideCharacter(source, "(");
  const close = open >= 0 ? findMatchingPair(source, open, "(", ")") : -1;
  return open >= 0 && close >= 0
    ? readLeadingString(source.slice(open + 1, close))
    : undefined;
}

interface DrizzleTableMeta {
  variable: string;
  table: TableSpec;
  fieldNames: Map<string, string>;
  fieldBuilders: Map<string, string>;
  callback: string;
}

function parseDrizzleSchema(source: string): ParsedSpecs {
  const diagnostics: DbmlDiagnostic[] = [];
  const clean = stripCodeComments(source, "code");
  const schemaVariables = new Map<string, string>();
  const schemaRegex = /\b(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:pgSchema|mysqlSchema)\s*\(/g;
  let schemaMatch: RegExpExecArray | null;
  while ((schemaMatch = schemaRegex.exec(clean))) {
    const open = clean.indexOf("(", schemaMatch.index);
    const close = open >= 0 ? findMatchingPair(clean, open, "(", ")") : -1;
    if (close < 0) continue;
    const schema = parseStringLiteral(clean.slice(open + 1, close).trim());
    if (schema !== undefined) schemaVariables.set(schemaMatch[1], schema);
    schemaRegex.lastIndex = close + 1;
  }

  const tables: DrizzleTableMeta[] = [];
  const declaration = /\b(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(pgTable|mysqlTable|sqliteTable|[A-Za-z_$][\w$]*\.table)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = declaration.exec(clean))) {
    const open = clean.indexOf("(", match.index);
    const close = open >= 0 ? findMatchingPair(clean, open, "(", ")") : -1;
    if (open < 0 || close < 0) {
      diagnostics.push({
        level: "warning",
        code: "unclosed-drizzle-table",
        message: `Skipped Drizzle table ${match[1]} because its declaration is not closed.`,
      });
      continue;
    }
    declaration.lastIndex = close + 1;
    const args = splitTopLevel(clean.slice(open + 1, close), ",");
    const tableName = parseStringLiteral(args[0]?.trim() ?? "") ?? match[1];
    const factory = match[2];
    const schemaVariable = factory.endsWith(".table") ? factory.slice(0, -6) : undefined;
    const schema = schemaVariable ? schemaVariables.get(schemaVariable) : undefined;
    const object = unwrapPair(args[1]?.trim() ?? "", "{", "}");
    if (object === undefined) {
      diagnostics.push({
        level: "warning",
        code: "invalid-drizzle-columns",
        message: `Skipped Drizzle table ${match[1]} because its column object could not be read.`,
      });
      continue;
    }
    const fieldNames = new Map<string, string>();
    const fieldBuilders = new Map<string, string>();
    const fields: FieldSpec[] = [];
    for (const property of splitTopLevel(object, ",")) {
      const colon = findOutsideCharacter(property, ":");
      if (colon < 0) continue;
      const variable = normalizeCodeProperty(property.slice(0, colon));
      const builder = property.slice(colon + 1).trim();
      if (!variable || !builder) continue;
      const field = parseDrizzleField(variable, builder, diagnostics, tableName);
      if (!field) continue;
      fields.push(field);
      fieldNames.set(variable, field.name);
      fieldBuilders.set(variable, builder);
    }
    const callback = args.slice(2).join(",");
    const table: TableSpec = { name: tableName, schema, domain: schema, fields };
    const compositePrimary = /\bprimaryKey\s*\(\s*\{[\s\S]*?columns\s*:\s*\[([\s\S]*?)\]/m.exec(
      callback,
    );
    if (compositePrimary) {
      const variables = [...compositePrimary[1].matchAll(/\b(?:table|t)\.([A-Za-z_$][\w$]*)/g)]
        .map((entry) => fieldNames.get(entry[1]) ?? entry[1]);
      applyFieldFlags(table, variables, "primaryKey");
    }
    for (const unique of callback.matchAll(/\b(?:unique|uniqueIndex)\s*\([^)]*\)\s*\.on\s*\(\s*(?:table|t)\.([A-Za-z_$][\w$]*)\s*\)/g)) {
      applyFieldFlags(table, [fieldNames.get(unique[1]) ?? unique[1]], "unique");
    }
    tables.push({ variable: match[1], table, fieldNames, fieldBuilders, callback });
  }

  const byVariable = new Map(tables.map((table) => [table.variable, table]));
  const relations: RelationSpec[] = [];
  for (const meta of tables) {
    for (const [variable, builder] of meta.fieldBuilders) {
      const reference = readDrizzleReference(builder);
      if (!reference) continue;
      const target = byVariable.get(reference.tableVariable);
      if (!target) {
        diagnostics.push({
          level: "warning",
          code: "unknown-drizzle-reference",
          message: `Skipped ${meta.variable}.${variable} reference to unknown table ${reference.tableVariable}.`,
        });
        continue;
      }
      const childName = meta.fieldNames.get(variable) ?? variable;
      const parentName = target.fieldNames.get(reference.fieldVariable) ?? reference.fieldVariable;
      const child = meta.table.fields.find((field) => field.name === childName);
      relations.push({
        fromTable: qualifyParts(meta.table.schema, meta.table.name),
        fromField: childName,
        toTable: qualifyParts(target.table.schema, target.table.name),
        toField: parentName,
        operator: child?.unique ? "-" : ">",
        settings: reference.settings,
      });
    }
  }

  if (tables.length === 0) {
    diagnostics.push({
      level: "error",
      code: "no-drizzle-tables",
      message: "No pgTable, mysqlTable, sqliteTable, or schema.table declarations were found.",
    });
  }
  return { tables: tables.map((entry) => entry.table), relations, diagnostics };
}

function parseDrizzleField(
  variable: string,
  builder: string,
  diagnostics: DbmlDiagnostic[],
  tableName: string,
): FieldSpec | null {
  const base = /^([A-Za-z_$][\w$]*)\s*(?:<[^;]+?>)?\s*\(/.exec(builder);
  if (!base) {
    diagnostics.push({
      level: "warning",
      code: "unknown-drizzle-builder",
      message: `Skipped ${tableName}.${variable} because its Drizzle builder is not supported.`,
    });
    return null;
  }
  const open = builder.indexOf("(", base.index);
  const close = findMatchingPair(builder, open, "(", ")");
  if (close < 0) return null;
  const args = splitTopLevel(builder.slice(open + 1, close), ",");
  const name = parseStringLiteral(args[0]?.trim() ?? "") ?? variable;
  const functionName = base[1];
  let type = drizzleDbmlType(functionName, args, builder);
  if (/\.array\s*\(\s*\)/.test(builder) && !type.endsWith("[]")) type += "[]";
  const increment =
    /^(?:serial|bigserial|smallserial)$/i.test(functionName) ||
    /\.autoincrement\s*\(\s*\)/i.test(builder) ||
    /\.primaryKey\s*\(\s*\{[\s\S]*?autoIncrement\s*:\s*true/i.test(builder);
  const primaryKey = /\.primaryKey\s*\([^)]*\)/.test(builder);
  const defaultNow = /\.defaultNow\s*\(\s*\)/.test(builder);
  const defaultCall = readChainedCall(builder, "default");
  let defaultValue: string | undefined;
  if (defaultNow) defaultValue = "now()";
  else if (defaultCall !== undefined) defaultValue = drizzleDefaultValue(defaultCall);
  return {
    name,
    type,
    primaryKey,
    notNull: /\.notNull\s*\(\s*\)/.test(builder) || primaryKey,
    unique: /\.unique\s*\(\s*[^)]*\)/.test(builder),
    increment,
    default: increment ? undefined : defaultValue,
  };
}

function drizzleDbmlType(functionName: string, args: string[], builder: string) {
  const lower = functionName.toLowerCase();
  const mappings: Record<string, string> = {
    bigint: "bigint",
    bigserial: "bigint",
    blob: "blob",
    boolean: "boolean",
    date: "date",
    datetime: "datetime",
    doubleprecision: "double precision",
    int: "integer",
    integer: "integer",
    json: "json",
    jsonb: "jsonb",
    mediumint: "mediumint",
    real: "real",
    serial: "integer",
    smallint: "smallint",
    smallserial: "smallint",
    text: "text",
    time: "time",
    timestamp: /withTimezone\s*:\s*true/.test(builder) ? "timestamptz" : "timestamp",
    tinyint: "tinyint",
    uuid: "uuid",
  };
  if (lower === "varchar" || lower === "char" || lower === "binary" || lower === "varbinary") {
    const length = /\blength\s*:\s*(\d+)/.exec(args.slice(1).join(","))?.[1];
    return `${lower}${length ? `(${length})` : ""}`;
  }
  if (lower === "numeric" || lower === "decimal") {
    const options = args.slice(1).join(",");
    const precision = /\bprecision\s*:\s*(\d+)/.exec(options)?.[1];
    const scale = /\bscale\s*:\s*(\d+)/.exec(options)?.[1];
    return `${lower}${precision ? `(${precision}${scale ? `, ${scale}` : ""})` : ""}`;
  }
  if (lower === "customtype") {
    return /\bdataType\s*\(\s*\)\s*\{\s*return\s+(["'])(.*?)\1/.exec(builder)?.[2] ?? "custom";
  }
  return mappings[lower] ?? lower;
}

function drizzleDefaultValue(source: string): string | undefined {
  const value = source.trim();
  const sqlRaw = /^sql\.raw\s*\(\s*(["'])([\s\S]*)\1\s*\)$/.exec(value);
  if (sqlRaw) return unescapeStringLiteral(sqlRaw[2], sqlRaw[1]);
  const literal = parseStringLiteral(value);
  if (literal !== undefined) return JSON.stringify(literal);
  if (/^(?:true|false|null|-?\d+(?:\.\d+)?)$/.test(value)) return value;
  if (/^sql`/.test(value)) return value.slice(3, -1).trim() || undefined;
  return value || undefined;
}

function readDrizzleReference(source: string): {
  tableVariable: string;
  fieldVariable: string;
  settings?: string[];
} | null {
  const call = readChainedCall(source, "references");
  if (call === undefined) return null;
  const endpoint = /=>\s*([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)/.exec(call);
  if (!endpoint) return null;
  const settings: string[] = [];
  for (const [property, label] of [["onDelete", "delete"], ["onUpdate", "update"]] as const) {
    const match = new RegExp(`${property}\\s*:\s*(["'])(.*?)\\1`).exec(call);
    if (match) settings.push(`${label}: ${match[2].toLowerCase()}`);
  }
  return {
    tableVariable: endpoint[1],
    fieldVariable: endpoint[2],
    settings: copyOptionalArray(settings),
  };
}

function readChainedCall(source: string, name: string): string | undefined {
  const regex = new RegExp(`\\.${escapeRegExp(name)}\\s*\\(`, "g");
  const match = regex.exec(source);
  if (!match) return undefined;
  const open = source.indexOf("(", match.index);
  const close = findMatchingPair(source, open, "(", ")");
  return close >= 0 ? source.slice(open + 1, close).trim() : undefined;
}

interface JsonTableMeta {
  key: string;
  qualifiedName: string;
  schema: Record<string, unknown>;
  table: TableSpec;
}

function parseJsonSchemaSource(source: string, fileName?: string): ParsedSpecs {
  let rootValue: unknown;
  try {
    rootValue = JSON.parse(source);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid JSON";
    throw new Error(`This JSON Schema is not valid JSON: ${detail}`);
  }
  if (!isRecord(rootValue)) {
    throw new Error("A JSON Schema import must contain a JSON object.");
  }
  const root = rootValue;
  const diagnostics: DbmlDiagnostic[] = [];
  const definitions: Record<string, unknown> = {
    ...(isRecord(root.definitions) ? root.definitions : {}),
    ...(isRecord(root.$defs) ? root.$defs : {}),
  };
  const rawTables = new Map<string, Record<string, unknown>>();

  if (Object.keys(definitions).length > 0) {
    for (const [key, value] of Object.entries(definitions)) {
      if (isRecord(value) && isJsonObjectSchema(value)) rawTables.set(key, value);
    }
  }

  if (rawTables.size === 0 && isRecord(root.properties)) {
    for (const [key, rawProperty] of Object.entries(root.properties)) {
      if (!isRecord(rawProperty)) continue;
      const property = unwrapNullableJsonSchema(rawProperty);
      const item = property.type === "array" && isRecord(property.items)
        ? unwrapNullableJsonSchema(property.items)
        : property;
      if (isJsonObjectSchema(item)) rawTables.set(key, item);
    }
  }

  if (rawTables.size === 0 && isJsonObjectSchema(root)) {
    const baseName = typeof root.title === "string" && root.title.trim()
      ? root.title.trim()
      : fileBaseName(fileName) || "Root";
    rawTables.set(baseName, root);
  }

  const metas: JsonTableMeta[] = [];
  for (const [key, schemaValue] of rawTables) {
    const parts = splitJsonTableKey(key);
    const required = new Set(
      Array.isArray(schemaValue.required)
        ? schemaValue.required.filter((entry): entry is string => typeof entry === "string")
        : [],
    );
    const properties = isRecord(schemaValue.properties) ? schemaValue.properties : {};
    const table: TableSpec = {
      name: parts.name,
      schema: parts.schema,
      domain: parts.schema ?? (rawTables.size > 1 ? "JSON Schema" : undefined),
      note: typeof schemaValue.description === "string" ? schemaValue.description : undefined,
      fields: [],
    };
    for (const [propertyName, rawProperty] of Object.entries(properties)) {
      if (!isRecord(rawProperty)) {
        diagnostics.push({
          level: "warning",
          code: "invalid-json-property",
          message: `Skipped ${key}.${propertyName} because its schema is not an object.`,
        });
        continue;
      }
      const property = unwrapNullableJsonSchema(rawProperty);
      const field = jsonSchemaField(propertyName, property, required.has(propertyName));
      table.fields.push(field);
    }
    const primaryKeys = Array.isArray(schemaValue["x-primary-key"])
      ? schemaValue["x-primary-key"].filter((entry): entry is string => typeof entry === "string")
      : [];
    applyFieldFlags(table, primaryKeys, "primaryKey");
    metas.push({ key, qualifiedName: qualifyParts(parts.schema, parts.name), schema: schemaValue, table });
  }

  const metaByKey = new Map<string, JsonTableMeta>();
  for (const meta of metas) {
    metaByKey.set(meta.key, meta);
    metaByKey.set(meta.qualifiedName, meta);
    metaByKey.set(meta.table.name, meta);
  }
  const relations: RelationSpec[] = [];
  const explicitRelations = Array.isArray(root["x-relations"])
    ? root["x-relations"]
    : [];
  for (const rawRelation of explicitRelations) {
    if (!isRecord(rawRelation)) continue;
    const childTable = stringProperty(rawRelation, "childTable");
    const childField = stringProperty(rawRelation, "childField");
    const parentTable = stringProperty(rawRelation, "parentTable");
    const parentField = stringProperty(rawRelation, "parentField");
    if (!childTable || !childField || !parentTable || !parentField) continue;
    const settings = jsonRelationSettings(rawRelation);
    relations.push({
      name: stringProperty(rawRelation, "name"),
      fromTable: childTable,
      fromField: childField,
      toTable: parentTable,
      toField: parentField,
      operator: rawRelation.cardinality === "one-to-one" ? "-" : ">",
      settings,
    });
  }

  // Relix JSON Schema exports include canonical root x-relations. The field
  // annotation fallback supports schemas produced by other tools.
  if (explicitRelations.length === 0) {
    for (const meta of metas) {
      const properties = isRecord(meta.schema.properties) ? meta.schema.properties : {};
      for (const [fieldName, rawProperty] of Object.entries(properties)) {
        if (!isRecord(rawProperty)) continue;
        const foreignKeys = Array.isArray(rawProperty["x-foreign-key"])
          ? rawProperty["x-foreign-key"]
          : isRecord(rawProperty["x-foreign-key"])
            ? [rawProperty["x-foreign-key"]]
            : [];
        for (const rawForeignKey of foreignKeys) {
          if (!isRecord(rawForeignKey)) continue;
          const targetTable = stringProperty(rawForeignKey, "table");
          const targetField = stringProperty(rawForeignKey, "field");
          if (!targetTable || !targetField) continue;
          relations.push({
            fromTable: meta.qualifiedName,
            fromField: fieldName,
            toTable: targetTable,
            toField: targetField,
            operator: rawForeignKey.cardinality === "one-to-one" ? "-" : ">",
          });
        }
      }
    }
  }

  // Generic JSON Schema references have no database semantics. Show a
  // conceptual edge to a sensible target key without inventing SQL execution.
  if (explicitRelations.length === 0 && relations.length === 0) {
    for (const meta of metas) {
      const properties = isRecord(meta.schema.properties) ? meta.schema.properties : {};
      for (const [fieldName, rawProperty] of Object.entries(properties)) {
        if (!isRecord(rawProperty)) continue;
        const unwrapped = unwrapNullableJsonSchema(rawProperty);
        const array = unwrapped.type === "array" && isRecord(unwrapped.items);
        const targetSchema = array && isRecord(unwrapped.items)
          ? unwrapNullableJsonSchema(unwrapped.items)
          : unwrapped;
        const reference = typeof targetSchema.$ref === "string" ? targetSchema.$ref : undefined;
        if (!reference) continue;
        const key = decodeJsonPointerTail(reference);
        const target = metaByKey.get(key);
        if (!target) continue;
        const targetField = target.table.fields.find((field) => field.primaryKey)?.name ??
          target.table.fields.find((field) => canonical(field.name) === "id")?.name ??
          target.table.fields[0]?.name;
        if (!targetField) continue;
        relations.push({
          fromTable: meta.qualifiedName,
          fromField: fieldName,
          toTable: target.qualifiedName,
          toField: targetField,
          operator: array ? "<>" : ">",
        });
      }
    }
  }

  if (metas.length === 0) {
    diagnostics.push({
      level: "error",
      code: "no-json-schema-objects",
      message: "No object definitions or object properties were found in this JSON Schema.",
    });
  }
  return { tables: metas.map((meta) => meta.table), relations, diagnostics };
}

function jsonSchemaField(
  name: string,
  schema: Record<string, unknown>,
  required: boolean,
): FieldSpec {
  const rawDbType = schema["x-db-type"];
  const type = typeof rawDbType === "string" ? rawDbType : inferJsonDbmlType(schema);
  let defaultValue: string | undefined;
  if (typeof schema["x-db-default"] === "string") {
    defaultValue = schema["x-db-default"];
  } else if (Object.prototype.hasOwnProperty.call(schema, "default")) {
    defaultValue = jsonDefaultValue(schema.default);
  }
  return {
    name,
    type,
    primaryKey: schema["x-primary-key"] === true,
    notNull: required,
    unique: schema["x-unique"] === true,
    increment: schema["x-increment"] === true,
    default: defaultValue,
    note: typeof schema.description === "string" ? schema.description : undefined,
  };
}

function inferJsonDbmlType(schema: Record<string, unknown>): string {
  if (typeof schema.$ref === "string") return decodeJsonPointerTail(schema.$ref) || "json";
  if (schema.type === "array") {
    const item = isRecord(schema.items) ? unwrapNullableJsonSchema(schema.items) : {};
    return `${inferJsonDbmlType(item)}[]`;
  }
  if (schema.type === "integer") return "integer";
  if (schema.type === "number") return "decimal";
  if (schema.type === "boolean") return "boolean";
  if (schema.type === "object" || isRecord(schema.properties)) return "json";
  if (schema.contentEncoding === "base64") return "bytea";
  if (schema.format === "uuid") return "uuid";
  if (schema.format === "date") return "date";
  if (schema.format === "date-time") return "timestamp";
  if (schema.format === "time") return "time";
  if (typeof schema.maxLength === "number" && Number.isFinite(schema.maxLength)) {
    return `varchar(${Math.max(1, Math.trunc(schema.maxLength))})`;
  }
  if (Array.isArray(schema.enum)) return "enum";
  return "varchar";
}

function unwrapNullableJsonSchema(schema: Record<string, unknown>): Record<string, unknown> {
  for (const keyword of ["anyOf", "oneOf"] as const) {
    const alternatives = schema[keyword];
    if (!Array.isArray(alternatives)) continue;
    const useful = alternatives.find(
      (entry) => isRecord(entry) && entry.type !== "null",
    );
    if (isRecord(useful)) return { ...schema, ...useful, [keyword]: undefined };
  }
  return schema;
}

function isJsonObjectSchema(schema: Record<string, unknown>) {
  return schema.type === "object" || isRecord(schema.properties);
}

function splitJsonTableKey(key: string): { name: string; schema?: string } {
  const normalized = key.trim() || "untitled";
  if (/^[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*$/.test(normalized)) {
    const index = normalized.lastIndexOf(".");
    return { schema: normalized.slice(0, index), name: normalized.slice(index + 1) };
  }
  return { name: normalized };
}

function jsonRelationSettings(relation: Record<string, unknown>): string[] | undefined {
  const settings: string[] = [];
  if (typeof relation.onDelete === "string") {
    settings.push(`delete: ${relation.onDelete.toLowerCase()}`);
  }
  if (typeof relation.onUpdate === "string") {
    settings.push(`update: ${relation.onUpdate.toLowerCase()}`);
  }
  return copyOptionalArray(settings);
}

function jsonDefaultValue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function decodeJsonPointerTail(reference: string) {
  const tail = reference.split("/").at(-1) ?? "";
  try {
    return decodeURIComponent(tail).replaceAll("~1", "/").replaceAll("~0", "~");
  } catch {
    return tail.replaceAll("~1", "/").replaceAll("~0", "~");
  }
}

function stringProperty(record: Record<string, unknown>, key: string) {
  return typeof record[key] === "string" ? record[key] as string : undefined;
}

/**
 * Deterministically combine two documents without mutating either input.
 * Conflicts are matched by case-insensitive qualified table name.
 */
export function mergeSchemaDocuments(
  current: DbmlDocument,
  incoming: DbmlDocument,
  strategy: SchemaMergeStrategy,
): SchemaMergeResult {
  const diagnostics = [
    ...current.diagnostics.map((entry) => ({ ...entry })),
    ...incoming.diagnostics.map((entry) => ({ ...entry })),
  ];
  const tables = current.tables.map(cloneTable);
  const currentMap = new Map<string, DbmlTable>();
  current.tables.forEach((table, index) => currentMap.set(table.id, tables[index]));
  const incomingMap = new Map<string, DbmlTable>();
  const keyToTable = new Map(
    tables.map((table) => [canonical(qualifiedName(table)), table]),
  );
  const conflicts: SchemaMergeConflict[] = [];
  const updatedTableIds: string[] = [];
  const skippedTableIds: string[] = [];
  const renamedTables: Array<{ from: string; to: string; tableId: string }> = [];

  for (const sourceTable of incoming.tables) {
    const originalQualified = qualifiedName(sourceTable);
    const key = canonical(originalQualified);
    const existing = keyToTable.get(key);
    if (!existing) {
      const clone = cloneTable(sourceTable);
      tables.push(clone);
      keyToTable.set(key, clone);
      incomingMap.set(sourceTable.id, clone);
      continue;
    }

    if (strategy === "skip") {
      incomingMap.set(sourceTable.id, existing);
      skippedTableIds.push(sourceTable.id);
      conflicts.push({
        qualifiedName: originalQualified,
        currentTableId: existing.id,
        incomingTableId: sourceTable.id,
        strategy,
        resolution: "skipped",
      });
      continue;
    }

    if (strategy === "update") {
      const replacement = cloneTableWithIdentity(sourceTable, existing, existing.name, existing.schema);
      const index = tables.findIndex((table) => table.id === existing.id);
      if (index >= 0) tables[index] = replacement;
      keyToTable.set(key, replacement);
      incomingMap.set(sourceTable.id, replacement);
      for (const [sourceId, mapped] of currentMap) {
        if (mapped.id === existing.id) currentMap.set(sourceId, replacement);
      }
      updatedTableIds.push(replacement.id);
      conflicts.push({
        qualifiedName: originalQualified,
        currentTableId: existing.id,
        incomingTableId: sourceTable.id,
        strategy,
        resolution: "updated",
      });
      continue;
    }

    const renamed = availableImportedName(sourceTable, keyToTable);
    const renamedTable = cloneTableWithIdentity(
      sourceTable,
      undefined,
      renamed.name,
      renamed.schema,
    );
    tables.push(renamedTable);
    keyToTable.set(canonical(qualifiedName(renamedTable)), renamedTable);
    incomingMap.set(sourceTable.id, renamedTable);
    renamedTables.push({
      from: originalQualified,
      to: qualifiedName(renamedTable),
      tableId: renamedTable.id,
    });
    conflicts.push({
      qualifiedName: originalQualified,
      currentTableId: existing.id,
      incomingTableId: sourceTable.id,
      strategy,
      resolution: "renamed",
      renamedTo: qualifiedName(renamedTable),
    });
  }

  const relations: DbmlRelation[] = [];
  const relationKeys = new Set<string>();
  const appendRelations = (
    sourceRelations: DbmlRelation[],
    tableMap: Map<string, DbmlTable>,
    origin: "current" | "incoming",
  ) => {
    for (const relation of sourceRelations) {
      const from = resolveMergedEndpoint(
        relation.fromTableId,
        relation.fromFieldId,
        relation.fromTable,
        relation.fromField,
        tableMap,
        tables,
      );
      const to = resolveMergedEndpoint(
        relation.toTableId,
        relation.toFieldId,
        relation.toTable,
        relation.toField,
        tableMap,
        tables,
      );
      if (!from || !to) {
        diagnostics.push({
          level: "warning",
          code: "merge-relation-dropped",
          message: `A ${origin} relation was dropped because one of its fields no longer exists.`,
        });
        continue;
      }
      const semantic = [
        canonical(from.tableName),
        canonical(from.fieldName),
        relation.operator,
        canonical(to.tableName),
        canonical(to.fieldName),
      ].join("|");
      if (relationKeys.has(semantic)) continue;
      relationKeys.add(semantic);
      relations.push({
        ...cloneRelation(relation),
        id: makeDbmlId("relation", `${semantic}#0`),
        fromTableId: from.tableId,
        fromFieldId: from.fieldId,
        fromTable: from.tableName,
        fromField: from.fieldName,
        toTableId: to.tableId,
        toFieldId: to.fieldId,
        toTable: to.tableName,
        toField: to.fieldName,
        cardinality: cardinalityFor(relation.operator),
      });
    }
  };
  appendRelations(current.relations, currentMap, "current");
  appendRelations(incoming.relations, incomingMap, "incoming");

  const groupMap = new Map<string, DbmlGroup>();
  const appendGroups = (sourceGroups: DbmlGroup[], tableMap: Map<string, DbmlTable>) => {
    for (const sourceGroup of sourceGroups) {
      const key = canonical(sourceGroup.name);
      let group = groupMap.get(key);
      if (!group) {
        group = {
          ...cloneGroup(sourceGroup),
          id: makeDbmlId("group", `${key}#0`),
          tableIds: [],
          tableNames: [],
        };
        groupMap.set(key, group);
      }
      for (const oldTableId of sourceGroup.tableIds) {
        const table = tableMap.get(oldTableId);
        if (!table || group.tableIds.includes(table.id)) continue;
        group.tableIds.push(table.id);
        group.tableNames.push(qualifiedName(table));
      }
    }
  };
  appendGroups(current.groups, currentMap);
  appendGroups(incoming.groups, incomingMap);

  return {
    document: {
      tables,
      relations,
      groups: [...groupMap.values()].filter((group) => group.tableIds.length > 0),
      diagnostics,
    },
    conflicts,
    updatedTableIds,
    skippedTableIds,
    renamedTables,
  };
}

function cloneTableWithIdentity(
  source: DbmlTable,
  previous: DbmlTable | undefined,
  name: string,
  schema: string | undefined,
): DbmlTable {
  const qualified = qualifyParts(schema, name);
  const id = previous?.id ?? makeDbmlId("table", `${canonical(qualified)}#0`);
  const priorFields = new Map(
    (previous?.fields ?? []).map((field) => [canonical(field.name), field]),
  );
  const occurrences = new Map<string, number>();
  return {
    ...source,
    id,
    name,
    schema,
    color: source.color ?? previous?.color,
    fields: source.fields.map((field) => {
      const key = canonical(field.name);
      const occurrence = occurrences.get(key) ?? 0;
      occurrences.set(key, occurrence + 1);
      const previousField = occurrence === 0 ? priorFields.get(key) : undefined;
      return {
        ...field,
        id: previousField?.id ?? makeDbmlId("field", `${canonical(qualified)}.${key}#${occurrence}`),
        extraSettings: copyOptionalArray(field.extraSettings),
      };
    }),
    extraSettings: copyOptionalArray(source.extraSettings),
  };
}

function availableImportedName(
  table: DbmlTable,
  existing: Map<string, DbmlTable>,
) {
  const base = `${table.name}_imported`;
  let candidate = base;
  let suffix = 2;
  while (existing.has(canonical(qualifyParts(table.schema, candidate)))) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  return { name: candidate, schema: table.schema };
}

function resolveMergedEndpoint(
  oldTableId: string,
  oldFieldId: string,
  fallbackTable: string,
  fallbackField: string,
  tableMap: Map<string, DbmlTable>,
  allTables: DbmlTable[],
): MutableRelationEndpoint | null {
  let table = tableMap.get(oldTableId);
  if (!table) {
    table = allTables.find(
      (candidate) => canonical(qualifiedName(candidate)) === canonical(fallbackTable),
    );
  }
  if (!table) return null;
  const field = table.fields.find((candidate) => candidate.id === oldFieldId) ??
    table.fields.find((candidate) => canonical(candidate.name) === canonical(fallbackField));
  if (!field) return null;
  return {
    tableId: table.id,
    fieldId: field.id,
    tableName: qualifiedName(table),
    fieldName: field.name,
  };
}

type ParserMode = "sql" | "code";

function stripCodeComments(source: string, mode: ParserMode) {
  let output = "";
  let quote: string | null = null;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (quote) {
      output += character;
      if (character === "\\" && next !== undefined) {
        output += next;
        index += 1;
      } else if (character === quote) {
        if (mode === "sql" && next === quote && quote !== "`") {
          output += next;
          index += 1;
        } else quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      output += character;
      continue;
    }
    const lineComment =
      (mode === "code" && character === "/" && next === "/") ||
      (mode === "sql" && character === "-" && next === "-") ||
      (mode === "sql" && character === "#");
    if (lineComment) {
      output += character === "#" ? " " : "  ";
      if (character !== "#") index += 1;
      while (index + 1 < source.length && source[index + 1] !== "\n") {
        output += " ";
        index += 1;
      }
      continue;
    }
    if (character === "/" && next === "*") {
      output += "  ";
      index += 1;
      while (index + 1 < source.length && !(source[index + 1] === "*" && source[index + 2] === "/")) {
        index += 1;
        output += source[index] === "\n" || source[index] === "\r" ? source[index] : " ";
      }
      if (index + 2 < source.length) {
        output += "  ";
        index += 2;
      }
      continue;
    }
    output += character;
  }
  return output;
}

function splitTopLevelStatements(source: string, delimiter: string) {
  return splitTopLevel(source, delimiter).map((entry) => entry.trim()).filter(Boolean);
}

function splitTopLevel(source: string, delimiter: string): string[] {
  const result: string[] = [];
  let current = "";
  let quote: string | null = null;
  let parens = 0;
  let braces = 0;
  let brackets = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      current += character;
      if (character === "\\" && source[index + 1] !== undefined) {
        current += source[index + 1];
        index += 1;
      } else if (character === quote) {
        if (source[index + 1] === quote && quote !== "`") {
          current += source[index + 1];
          index += 1;
        } else quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === "`") quote = character;
    else if (character === "(") parens += 1;
    else if (character === ")") parens = Math.max(0, parens - 1);
    else if (character === "{") braces += 1;
    else if (character === "}") braces = Math.max(0, braces - 1);
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets = Math.max(0, brackets - 1);

    if (character === delimiter && parens === 0 && braces === 0 && brackets === 0) {
      result.push(current);
      current = "";
    } else current += character;
  }
  result.push(current);
  return result;
}

function findMatchingPair(
  source: string,
  openIndex: number,
  openCharacter: string,
  closeCharacter: string,
) {
  if (openIndex < 0 || source[openIndex] !== openCharacter) return -1;
  let depth = 0;
  let quote: string | null = null;
  for (let index = openIndex; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) {
        if (source[index + 1] === quote && quote !== "`") index += 1;
        else quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
    } else if (character === openCharacter) {
      depth += 1;
    } else if (character === closeCharacter) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function findOutsideCharacter(source: string, target: string, start = 0) {
  let quote: string | null = null;
  let parens = 0;
  let braces = 0;
  let brackets = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) {
        if (source[index + 1] === quote && quote !== "`") index += 1;
        else quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (
      index >= start &&
      character === target &&
      parens === 0 &&
      braces === 0 &&
      brackets === 0
    ) return index;
    if (character === "(") parens += 1;
    else if (character === ")") parens = Math.max(0, parens - 1);
    else if (character === "{") braces += 1;
    else if (character === "}") braces = Math.max(0, braces - 1);
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets = Math.max(0, brackets - 1);
  }
  return -1;
}

function isTopLevelIndex(source: string, targetIndex: number) {
  let quote: string | null = null;
  let parens = 0;
  let braces = 0;
  let brackets = 0;
  for (let index = 0; index < targetIndex; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) {
        if (source[index + 1] === quote && quote !== "`") index += 1;
        else quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === "`") quote = character;
    else if (character === "(") parens += 1;
    else if (character === ")") parens = Math.max(0, parens - 1);
    else if (character === "{") braces += 1;
    else if (character === "}") braces = Math.max(0, braces - 1);
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets = Math.max(0, brackets - 1);
  }
  return quote === null && parens === 0 && braces === 0 && brackets === 0;
}

function indexOfKeywordOutside(source: string, keyword: string, start = 0) {
  const pattern = keyword
    .trim()
    .split(/\s+/)
    .map(escapeRegExp)
    .join("\\s+");
  const regex = new RegExp(`\\b${pattern}\\b`, "gi");
  regex.lastIndex = Math.max(0, start);
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source))) {
    if (isTopLevelIndex(source, match.index)) return match.index;
  }
  return -1;
}

function takeIdentifierPath(
  source: string,
  start: number,
  mode: ParserMode,
  allowPath = true,
): { parts: string[]; end: number } | null {
  let index = start;
  while (index < source.length && /\s/.test(source[index])) index += 1;
  const parts: string[] = [];
  while (index < source.length) {
    while (index < source.length && /\s/.test(source[index])) index += 1;
    const character = source[index];
    let value = "";
    if (character === '"' || character === "`" || (mode === "sql" && character === "[")) {
      const close = character === "[" ? "]" : character;
      index += 1;
      while (index < source.length) {
        if (source[index] === close) {
          if (source[index + 1] === close && close !== "]") {
            value += close;
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        if (source[index] === "\\" && source[index + 1] !== undefined) {
          value += source[index + 1];
          index += 2;
        } else {
          value += source[index];
          index += 1;
        }
      }
    } else {
      const identifier = /^[A-Za-z_$][A-Za-z0-9_$-]*/.exec(source.slice(index));
      if (!identifier) break;
      value = identifier[0];
      index += identifier[0].length;
    }
    if (!value) break;
    parts.push(value);
    if (!allowPath) break;
    const beforeDot = index;
    while (index < source.length && /\s/.test(source[index])) index += 1;
    if (source[index] !== ".") {
      index = beforeDot;
      break;
    }
    index += 1;
  }
  return parts.length > 0 ? { parts, end: index } : null;
}

function parseIdentifierList(source: string, mode: ParserMode) {
  const result: string[] = [];
  for (const entry of splitTopLevel(source, ",")) {
    const token = takeIdentifierPath(entry.trim(), 0, mode);
    const name = token?.parts.at(-1);
    if (name) result.push(name);
  }
  return result;
}

function collectNamedBlocks(source: string, kinds: string[]): NamedCodeBlock[] {
  const pattern = new RegExp(
    `\\b(${kinds.map(escapeRegExp).join("|")})\\s+([A-Za-z_$][\\w$]*)\\s*\\{`,
    "g",
  );
  const blocks: NamedCodeBlock[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    const open = source.indexOf("{", match.index);
    const close = findMatchingPair(source, open, "{", "}");
    if (close < 0) break;
    blocks.push({
      kind: match[1],
      name: match[2],
      body: source.slice(open + 1, close),
      start: match.index,
    });
    pattern.lastIndex = close + 1;
  }
  return blocks;
}

function splitLogicalLines(source: string): string[] {
  const result: string[] = [];
  let current = "";
  let quote: string | null = null;
  let depth = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      current += character;
      if (character === "\\" && source[index + 1] !== undefined) {
        current += source[index + 1];
        index += 1;
      } else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if (character === "(" || character === "[" || character === "{") depth += 1;
    else if (character === ")" || character === "]" || character === "}") depth = Math.max(0, depth - 1);
    if ((character === "\n" || character === "\r") && depth === 0) {
      if (current.trim()) result.push(current.trim());
      current = "";
    } else current += character;
  }
  if (current.trim()) result.push(current.trim());
  return result;
}

function parseStringLiteral(source: string): string | undefined {
  const value = source.trim();
  const quote = value[0];
  if ((quote !== '"' && quote !== "'" && quote !== "`") || value.at(-1) !== quote) {
    return undefined;
  }
  return unescapeStringLiteral(value.slice(1, -1), quote);
}

function unescapeStringLiteral(source: string, quote: string) {
  return source.replace(/\\([\\'"`bfnrt])/g, (_match, escaped: string) => {
    const controls: Record<string, string> = {
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
    };
    return controls[escaped] ?? (escaped === quote || escaped === "\\" ? escaped : escaped);
  });
}

function normalizeCodeProperty(source: string) {
  const value = source.trim();
  return parseStringLiteral(value) ?? /^[A-Za-z_$][\w$]*$/.test(value) ? (parseStringLiteral(value) ?? value) : "";
}

function unwrapPair(source: string, open: string, close: string) {
  const value = source.trim();
  if (!value.startsWith(open)) return undefined;
  const end = findMatchingPair(value, 0, open, close);
  return end === value.length - 1 ? value.slice(1, -1) : undefined;
}

function splitIdentifierPath(source: string) {
  const token = takeIdentifierPath(source.trim(), 0, "sql");
  return token?.parts ?? source.split(".").map(cleanName).filter(Boolean);
}

function normalizeQualifiedName(source: string) {
  return splitIdentifierPath(source).join(".");
}

function cleanName(source: string) {
  const value = source.trim();
  if (value.length >= 2) {
    const first = value[0];
    const last = value.at(-1);
    if ((first === '"' && last === '"') || (first === "`" && last === "`") || (first === "[" && last === "]")) {
      return value.slice(1, -1).replaceAll(`${last}${last}`, last ?? "");
    }
  }
  return value;
}

function qualifyParts(schema: string | undefined, name: string) {
  return schema ? `${schema}.${name}` : name;
}

function qualifiedName(table: DbmlTable) {
  return qualifyParts(table.schema, table.name);
}

function canonical(value: string) {
  return value.trim().toLocaleLowerCase("en-US");
}

function copyOptionalArray<T>(items: readonly T[] | undefined): T[] | undefined {
  return items && items.length > 0 ? [...items] : undefined;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compact(value: string) {
  const result = value.replace(/\s+/g, " ").trim();
  return result.length > 100 ? `${result.slice(0, 97)}...` : result;
}

function fileBaseName(fileName?: string) {
  if (!fileName) return "";
  const name = fileName.replaceAll("\\", "/").split("/").at(-1) ?? "";
  return name.replace(/(?:\.schema)?\.(?:json|txt)$/i, "").trim();
}
