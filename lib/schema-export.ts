import type {
  DbmlDocument,
  DbmlField,
  DbmlRelation,
  DbmlTable,
} from "./dbml";

export type SchemaExportFormat =
  | "postgresql"
  | "mysql"
  | "sqlite"
  | "prisma"
  | "drizzle"
  | "json-schema";

type ParsedType = {
  raw: string;
  base: string;
  args: string[];
  array: boolean;
};

type ParsedDefault =
  | { kind: "string"; value: string }
  | { kind: "number"; value: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "null"; value: null }
  | { kind: "json"; value: unknown }
  | { kind: "expression"; value: string };

type PhysicalForeignKey = {
  relation: DbmlRelation;
  childTable: DbmlTable;
  childField: DbmlField;
  parentTable: DbmlTable;
  parentField: DbmlField;
  oneToOne: boolean;
  onDelete?: string;
  onUpdate?: string;
};

const INTEGER_TYPES = new Set([
  "int",
  "integer",
  "int2",
  "int4",
  "int8",
  "smallint",
  "bigint",
  "serial",
  "smallserial",
  "bigserial",
]);

const STRING_TYPES = new Set([
  "varchar",
  "character varying",
  "char",
  "character",
  "text",
  "citext",
  "string",
]);

function parseType(value: string): ParsedType {
  let raw = value.trim();
  if (
    raw.length >= 2 &&
    ((raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'")))
  ) {
    raw = raw.slice(1, -1);
  }
  const array = /\[\]\s*$/.test(raw);
  if (array) raw = raw.replace(/\[\]\s*$/, "").trim();
  const match = raw.match(/^(.+?)(?:\((.*)\))?$/);
  const base = (match?.[1] ?? raw).trim().toLowerCase();
  const args = (match?.[2] ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return { raw, base, args, array };
}

function parseDefault(value: string | undefined): ParsedDefault | undefined {
  if (value === undefined) return undefined;
  let raw = value.trim();
  if (raw.startsWith("`") && raw.endsWith("`") && raw.length >= 2) {
    raw = raw.slice(1, -1).trim();
  }
  if (
    raw.length >= 2 &&
    ((raw.startsWith("'") && raw.endsWith("'")) ||
      (raw.startsWith('"') && raw.endsWith('"')))
  ) {
    return {
      kind: "string",
      value: raw.slice(1, -1).replace(/''/g, "'").replace(/\\"/g, '"'),
    };
  }
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(raw)) {
    return { kind: "number", value: raw };
  }
  if (/^(true|false)$/i.test(raw)) {
    return { kind: "boolean", value: raw.toLowerCase() === "true" };
  }
  if (/^null$/i.test(raw)) return { kind: "null", value: null };
  if (/^[{[]/.test(raw)) {
    try {
      return { kind: "json", value: JSON.parse(raw) };
    } catch {
      // Keep database expressions and non-JSON object syntax as expressions.
    }
  }
  return { kind: "expression", value: raw };
}

function qualifiedName(table: DbmlTable) {
  return table.schema ? `${table.schema}.${table.name}` : table.name;
}

function quoteDouble(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteBacktick(value: string) {
  return `\`${value.replaceAll("`", "``")}\``;
}

function qualifiedSqlName(table: DbmlTable, quote: (value: string) => string) {
  return table.schema
    ? `${quote(table.schema)}.${quote(table.name)}`
    : quote(table.name);
}

function sqlString(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

function stableHash(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function safeConstraintName(value: string, maxLength = 63) {
  const normalized = value.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "constraint";
  if (normalized.length <= maxLength) return normalized;
  const suffix = `_${stableHash(normalized).slice(0, 8)}`;
  return `${normalized.slice(0, maxLength - suffix.length)}${suffix}`;
}

function relationAction(settings: string[] | undefined, name: "delete" | "update") {
  const entry = settings?.find((setting) =>
    new RegExp(`^${name}\\s*:`, "i").test(setting.trim()),
  );
  if (!entry) return undefined;
  const raw = entry.slice(entry.indexOf(":") + 1).trim().toLowerCase();
  const actions: Record<string, string> = {
    cascade: "CASCADE",
    restrict: "RESTRICT",
    "no action": "NO ACTION",
    "set null": "SET NULL",
    "set default": "SET DEFAULT",
  };
  return actions[raw];
}

function relationIsInactive(relation: DbmlRelation) {
  return relation.settings?.some((setting) => /^inactive(?:\s*:|$)/i.test(setting.trim())) ?? false;
}

function fieldIsIndividuallyUnique(table: DbmlTable, field: DbmlField) {
  return (
    field.unique ||
    (field.primaryKey &&
      table.fields.filter((candidate) => candidate.primaryKey).length === 1)
  );
}

function resolvePhysicalForeignKey(
  relation: DbmlRelation,
  document: DbmlDocument,
): PhysicalForeignKey | null {
  if (relation.operator === "<>" || relationIsInactive(relation)) return null;
  const fromTable = document.tables.find((table) => table.id === relation.fromTableId);
  const toTable = document.tables.find((table) => table.id === relation.toTableId);
  const fromField = fromTable?.fields.find((field) => field.id === relation.fromFieldId);
  const toField = toTable?.fields.find((field) => field.id === relation.toFieldId);
  if (!fromTable || !toTable || !fromField || !toField) return null;

  const fromIsChild =
    relation.operator === ">" ||
    (relation.operator === "-" && relation.source === "inline");
  const childTable = fromIsChild ? fromTable : toTable;
  const childField = fromIsChild ? fromField : toField;
  const parentTable = fromIsChild ? toTable : fromTable;
  const parentField = fromIsChild ? toField : fromField;

  return {
    relation,
    childTable,
    childField,
    parentTable,
    parentField,
    oneToOne:
      relation.operator === "-" ||
      fieldIsIndividuallyUnique(childTable, childField),
    onDelete: relationAction(relation.settings, "delete"),
    onUpdate: relationAction(relation.settings, "update"),
  };
}

function physicalForeignKeys(document: DbmlDocument) {
  return document.relations
    .map((relation) => resolvePhysicalForeignKey(relation, document))
    .filter(
      (relation): relation is PhysicalForeignKey =>
        relation !== null &&
        fieldIsIndividuallyUnique(relation.parentTable, relation.parentField),
    );
}

function oneToOneFieldIds(document: DbmlDocument) {
  return new Set(
    physicalForeignKeys(document)
      .filter((relation) => relation.oneToOne)
      .map((relation) => relation.childField.id),
  );
}

function needsStandaloneUnique(
  table: DbmlTable,
  field: DbmlField,
  forcedUnique: boolean,
) {
  return (
    (field.unique || forcedUnique) &&
    !(field.primaryKey && table.fields.filter((candidate) => candidate.primaryKey).length === 1)
  );
}

function relationWarnings(document: DbmlDocument, prefix: "--" | "//") {
  const warnings: string[] = [];
  for (const relation of document.relations) {
    if (relation.operator === "<>") {
      warnings.push(
        `${prefix} NOTE: ${relation.fromTable}.${relation.fromField} <> ${relation.toTable}.${relation.toField} is conceptual many-to-many; add an explicit junction table before migration.`,
      );
      continue;
    }
    const foreignKey = resolvePhysicalForeignKey(relation, document);
    if (!foreignKey && !relationIsInactive(relation)) {
      warnings.push(
        `${prefix} NOTE: unresolved relation ${relation.fromTable}.${relation.fromField} ${relation.operator} ${relation.toTable}.${relation.toField} was not emitted.`,
      );
      continue;
    }
    if (
      foreignKey &&
      !fieldIsIndividuallyUnique(foreignKey.parentTable, foreignKey.parentField)
    ) {
      warnings.push(
        `${prefix} NOTE: relation ${relation.fromTable}.${relation.fromField} ${relation.operator} ${relation.toTable}.${relation.toField} was not emitted because the referenced field is not individually primary or unique.`,
      );
    }
  }
  return warnings;
}

function renderSqlDefault(
  value: string | undefined,
  dialect: "postgresql" | "mysql" | "sqlite",
) {
  const parsed = parseDefault(value);
  if (!parsed) return undefined;
  if (parsed.kind === "string") return sqlString(parsed.value);
  if (parsed.kind === "number") return parsed.value;
  if (parsed.kind === "boolean") {
    return dialect === "sqlite" ? (parsed.value ? "1" : "0") : parsed.value ? "TRUE" : "FALSE";
  }
  if (parsed.kind === "null") return "NULL";
  if (parsed.kind === "json") return sqlString(JSON.stringify(parsed.value));
  if (/^(now\(\)|current_timestamp(?:\(\))?)$/i.test(parsed.value)) {
    return "CURRENT_TIMESTAMP";
  }
  return dialect === "mysql" || dialect === "sqlite"
    ? `(${parsed.value})`
    : parsed.value;
}

function mysqlDefault(field: DbmlField, value: string) {
  const generatedType = mysqlType(field);
  const requiresExpression = /^(?:(?:TINY|MEDIUM|LONG)?TEXT|(?:TINY|MEDIUM|LONG)?BLOB|JSON)$/i.test(
    generatedType,
  );
  if (!requiresExpression || (value.startsWith("(") && value.endsWith(")"))) {
    return value;
  }
  return `(${value})`;
}

function postgresType(field: DbmlField) {
  const type = parseType(field.type);
  let result: string;
  if (field.increment && INTEGER_TYPES.has(type.base)) {
    result = type.base.includes("big") || type.base === "int8" ? "BIGSERIAL" : "SERIAL";
  } else if (["uuid"].includes(type.base)) result = "UUID";
  else if (["varchar", "character varying"].includes(type.base)) result = `VARCHAR${type.args[0] ? `(${type.args[0]})` : ""}`;
  else if (["char", "character"].includes(type.base)) result = `CHAR${type.args[0] ? `(${type.args[0]})` : ""}`;
  else if (["int", "integer", "int4"].includes(type.base)) result = "INTEGER";
  else if (["smallint", "int2"].includes(type.base)) result = "SMALLINT";
  else if (["bigint", "int8"].includes(type.base)) result = "BIGINT";
  else if (["decimal", "numeric"].includes(type.base)) result = `NUMERIC${type.args.length ? `(${type.args.join(", ")})` : ""}`;
  else if (["bool", "boolean"].includes(type.base)) result = "BOOLEAN";
  else if (["datetime", "timestamp"].includes(type.base)) result = "TIMESTAMP";
  else if (["timestamptz", "timestamp with time zone"].includes(type.base)) result = "TIMESTAMPTZ";
  else if (type.base === "json") result = "JSON";
  else if (type.base === "jsonb") result = "JSONB";
  else if (["blob", "binary", "varbinary", "bytea"].includes(type.base)) result = "BYTEA";
  else result = type.raw.toUpperCase();
  return type.array ? `${result}[]` : result;
}

function mysqlType(field: DbmlField) {
  const type = parseType(field.type);
  if (type.array) return "JSON";
  if (type.base === "uuid") return "CHAR(36)";
  if (["varchar", "character varying", "string"].includes(type.base)) return `VARCHAR(${type.args[0] ?? "255"})`;
  if (["char", "character"].includes(type.base)) return `CHAR(${type.args[0] ?? "1"})`;
  if (["text", "citext"].includes(type.base)) return "TEXT";
  if (["int", "integer", "int4", "serial"].includes(type.base)) return "INT";
  if (["smallint", "int2", "smallserial"].includes(type.base)) return "SMALLINT";
  if (["bigint", "int8", "bigserial"].includes(type.base)) return "BIGINT";
  if (["decimal", "numeric"].includes(type.base)) return `DECIMAL${type.args.length ? `(${type.args.join(", ")})` : ""}`;
  if (["real", "float", "float4"].includes(type.base)) return "FLOAT";
  if (["double", "double precision", "float8"].includes(type.base)) return "DOUBLE";
  if (["bool", "boolean"].includes(type.base)) return "BOOLEAN";
  if (["datetime", "timestamp", "timestamptz", "timestamp with time zone"].includes(type.base)) return "TIMESTAMP";
  if (type.base === "date") return "DATE";
  if (type.base === "time") return "TIME";
  if (["json", "jsonb"].includes(type.base)) return "JSON";
  if (["blob", "binary", "varbinary", "bytea"].includes(type.base)) return "BLOB";
  return type.raw.toUpperCase();
}

function sqliteType(field: DbmlField) {
  const type = parseType(field.type);
  if (INTEGER_TYPES.has(type.base) || ["bool", "boolean"].includes(type.base)) return "INTEGER";
  if (["decimal", "numeric", "money"].includes(type.base)) return "NUMERIC";
  if (["real", "float", "float4", "double", "double precision", "float8"].includes(type.base)) return "REAL";
  if (["blob", "binary", "varbinary", "bytea"].includes(type.base)) return "BLOB";
  return "TEXT";
}

function sqlForeignKeyClause(
  foreignKey: PhysicalForeignKey,
  quote: (value: string) => string,
  tableName: (table: DbmlTable) => string,
) {
  const actions = [
    foreignKey.onDelete ? `ON DELETE ${foreignKey.onDelete}` : "",
    foreignKey.onUpdate ? `ON UPDATE ${foreignKey.onUpdate}` : "",
  ].filter(Boolean);
  return `FOREIGN KEY (${quote(foreignKey.childField.name)}) REFERENCES ${tableName(foreignKey.parentTable)} (${quote(foreignKey.parentField.name)})${actions.length ? ` ${actions.join(" ")}` : ""}`;
}

export function exportPostgresSql(document: DbmlDocument) {
  const blocks: string[] = [
    "-- Generated by Relix",
    "-- PostgreSQL schema",
  ];
  const warnings = relationWarnings(document, "--");
  if (warnings.length) blocks.push(warnings.join("\n"));
  const schemas = [
    ...new Set(
      document.tables
        .map((table) => table.schema)
        .filter((schema): schema is string => Boolean(schema)),
    ),
  ];
  if (schemas.length) {
    blocks.push(schemas.map((schema) => `CREATE SCHEMA IF NOT EXISTS ${quoteDouble(schema)};`).join("\n"));
  }
  const oneToOneFields = oneToOneFieldIds(document);

  for (const table of document.tables) {
    const primaryKeys = table.fields.filter((field) => field.primaryKey);
    const columns = table.fields.map((field) => {
      const pieces = [quoteDouble(field.name), postgresType(field)];
      if (primaryKeys.length === 1 && field.primaryKey) pieces.push("PRIMARY KEY");
      if (field.notNull || field.primaryKey) pieces.push("NOT NULL");
      if (needsStandaloneUnique(table, field, oneToOneFields.has(field.id))) {
        pieces.push("UNIQUE");
      }
      const defaultValue = renderSqlDefault(field.default, "postgresql");
      if (defaultValue !== undefined && !field.increment) pieces.push(`DEFAULT ${defaultValue}`);
      return `  ${pieces.join(" ")}`;
    });
    if (primaryKeys.length > 1) {
      columns.push(`  PRIMARY KEY (${primaryKeys.map((field) => quoteDouble(field.name)).join(", ")})`);
    }
    blocks.push(`CREATE TABLE ${qualifiedSqlName(table, quoteDouble)} (\n${columns.join(",\n")}\n);`);
  }

  for (const foreignKey of physicalForeignKeys(document)) {
    const name = safeConstraintName(
      `fk_${foreignKey.childTable.schema ?? "public"}_${foreignKey.childTable.name}_${foreignKey.childField.name}_${stableHash(foreignKey.relation.id).slice(0, 5)}`,
    );
    blocks.push(
      `ALTER TABLE ${qualifiedSqlName(foreignKey.childTable, quoteDouble)}\n  ADD CONSTRAINT ${quoteDouble(name)} ${sqlForeignKeyClause(foreignKey, quoteDouble, (table) => qualifiedSqlName(table, quoteDouble))};`,
    );
  }
  return `${blocks.join("\n\n")}\n`;
}

export function exportMySql(document: DbmlDocument) {
  const blocks: string[] = [
    "-- Generated by Relix",
    "-- MySQL 8+ schema",
    "SET NAMES utf8mb4;",
  ];
  const warnings = relationWarnings(document, "--");
  if (warnings.length) blocks.push(warnings.join("\n"));
  const oneToOneFields = oneToOneFieldIds(document);

  for (const table of document.tables) {
    const primaryKeys = table.fields.filter((field) => field.primaryKey);
    let incrementUsed = false;
    let incrementField: DbmlField | undefined;
    const columns = table.fields.map((field) => {
      const pieces = [quoteBacktick(field.name), mysqlType(field)];
      if (field.notNull || field.primaryKey) pieces.push("NOT NULL");
      const parsedType = parseType(field.type);
      if (field.increment && INTEGER_TYPES.has(parsedType.base) && !incrementUsed) {
        pieces.push("AUTO_INCREMENT");
        incrementUsed = true;
        incrementField = field;
      }
      if (needsStandaloneUnique(table, field, oneToOneFields.has(field.id))) {
        pieces.push("UNIQUE");
      }
      const defaultValue = renderSqlDefault(field.default, "mysql");
      if (defaultValue !== undefined && !field.increment) {
        pieces.push(`DEFAULT ${mysqlDefault(field, defaultValue)}`);
      }
      return `  ${pieces.join(" ")}`;
    });
    if (primaryKeys.length) {
      columns.push(`  PRIMARY KEY (${primaryKeys.map((field) => quoteBacktick(field.name)).join(", ")})`);
    }
    if (
      incrementField &&
      (primaryKeys.length !== 1 || primaryKeys[0]?.id !== incrementField.id) &&
      !needsStandaloneUnique(
        table,
        incrementField,
        oneToOneFields.has(incrementField.id),
      )
    ) {
      columns.push(
        `  UNIQUE KEY ${quoteBacktick(safeConstraintName(`uq_${table.name}_${incrementField.name}_auto`, 64))} (${quoteBacktick(incrementField.name)})`,
      );
    }
    blocks.push(`CREATE TABLE ${qualifiedSqlName(table, quoteBacktick)} (\n${columns.join(",\n")}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`);
  }

  for (const foreignKey of physicalForeignKeys(document)) {
    const name = safeConstraintName(
      `fk_${foreignKey.childTable.schema ?? "default"}_${foreignKey.childTable.name}_${foreignKey.childField.name}_${stableHash(foreignKey.relation.id).slice(0, 5)}`,
      64,
    );
    blocks.push(
      `ALTER TABLE ${qualifiedSqlName(foreignKey.childTable, quoteBacktick)}\n  ADD CONSTRAINT ${quoteBacktick(name)} ${sqlForeignKeyClause(foreignKey, quoteBacktick, (table) => qualifiedSqlName(table, quoteBacktick))};`,
    );
  }
  return `${blocks.join("\n\n")}\n`;
}

function sqliteTableName(table: DbmlTable) {
  return table.schema ? `${table.schema}__${table.name}` : table.name;
}

export function exportSqliteSql(document: DbmlDocument) {
  const blocks: string[] = [
    "-- Generated by Relix",
    "-- SQLite 3 schema",
    "PRAGMA foreign_keys = ON;",
  ];
  const warnings = relationWarnings(document, "--");
  if (warnings.length) blocks.push(warnings.join("\n"));
  const oneToOneFields = oneToOneFieldIds(document);
  const foreignKeysByTable = new Map<string, PhysicalForeignKey[]>();
  for (const foreignKey of physicalForeignKeys(document)) {
    const list = foreignKeysByTable.get(foreignKey.childTable.id) ?? [];
    list.push(foreignKey);
    foreignKeysByTable.set(foreignKey.childTable.id, list);
  }

  for (const table of document.tables) {
    const primaryKeys = table.fields.filter((field) => field.primaryKey);
    const columns = table.fields.map((field) => {
      const exactAutoPrimary =
        field.increment &&
        field.primaryKey &&
        primaryKeys.length === 1 &&
        INTEGER_TYPES.has(parseType(field.type).base);
      const pieces = [quoteDouble(field.name), exactAutoPrimary ? "INTEGER" : sqliteType(field)];
      if (exactAutoPrimary) pieces.push("PRIMARY KEY AUTOINCREMENT");
      else if (primaryKeys.length === 1 && field.primaryKey) pieces.push("PRIMARY KEY");
      if ((field.notNull || field.primaryKey) && !exactAutoPrimary) pieces.push("NOT NULL");
      if (needsStandaloneUnique(table, field, oneToOneFields.has(field.id))) {
        pieces.push("UNIQUE");
      }
      const defaultValue = renderSqlDefault(field.default, "sqlite");
      if (defaultValue !== undefined && !field.increment) pieces.push(`DEFAULT ${defaultValue}`);
      return `  ${pieces.join(" ")}`;
    });
    if (primaryKeys.length > 1) {
      columns.push(`  PRIMARY KEY (${primaryKeys.map((field) => quoteDouble(field.name)).join(", ")})`);
    }
    for (const foreignKey of foreignKeysByTable.get(table.id) ?? []) {
      columns.push(
        `  ${sqlForeignKeyClause(foreignKey, quoteDouble, (parent) => quoteDouble(sqliteTableName(parent)))}`,
      );
    }
    blocks.push(`CREATE TABLE ${quoteDouble(sqliteTableName(table))} (\n${columns.join(",\n")}\n);`);
  }
  return `${blocks.join("\n\n")}\n`;
}

function pascalCase(value: string) {
  const words = value.split(/[^A-Za-z0-9]+/).filter(Boolean);
  let result = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join("") || "Model";
  if (/^\d/.test(result)) result = `Model${result}`;
  return result;
}

function camelCase(value: string) {
  const pascal = pascalCase(value);
  let result = pascal.charAt(0).toLowerCase() + pascal.slice(1);
  if (/^\d/.test(result)) result = `field${result}`;
  return result || "field";
}

function uniqueNames<T>(items: T[], baseName: (item: T) => string, key: (item: T) => string) {
  const used = new Set<string>();
  const result = new Map<string, string>();
  for (const item of items) {
    const base = baseName(item);
    let candidate = base;
    let index = 2;
    while (used.has(candidate)) {
      candidate = `${base}${index}`;
      index += 1;
    }
    used.add(candidate);
    result.set(key(item), candidate);
  }
  return result;
}

function prismaType(field: DbmlField) {
  const type = parseType(field.type);
  let scalar: string;
  let native = "";
  if (type.base === "uuid") {
    scalar = "String";
    native = " @db.Uuid";
  } else if (STRING_TYPES.has(type.base)) {
    scalar = "String";
    if (["varchar", "character varying"].includes(type.base) && type.args[0]) native = ` @db.VarChar(${type.args[0]})`;
    else if (["char", "character"].includes(type.base) && type.args[0]) native = ` @db.Char(${type.args[0]})`;
    else if (type.base === "text") native = " @db.Text";
  } else if (["int", "integer", "int2", "int4", "smallint", "serial", "smallserial"].includes(type.base)) scalar = "Int";
  else if (["bigint", "int8", "bigserial"].includes(type.base)) scalar = "BigInt";
  else if (["decimal", "numeric", "money"].includes(type.base)) {
    scalar = "Decimal";
    if (type.args.length) native = ` @db.Decimal(${type.args.join(", ")})`;
  } else if (["real", "float", "float4", "double", "double precision", "float8"].includes(type.base)) scalar = "Float";
  else if (["bool", "boolean"].includes(type.base)) scalar = "Boolean";
  else if (["datetime", "timestamp", "timestamptz", "timestamp with time zone", "date", "time"].includes(type.base)) scalar = "DateTime";
  else if (["json", "jsonb"].includes(type.base)) {
    scalar = "Json";
    if (type.base === "jsonb") native = " @db.JsonB";
  } else if (["blob", "binary", "varbinary", "bytea"].includes(type.base)) scalar = "Bytes";
  else scalar = `Unsupported(${JSON.stringify(type.raw)})`;
  if (type.array && !scalar.startsWith("Unsupported")) scalar += "[]";
  return { scalar, native };
}

function prismaDefault(field: DbmlField) {
  if (field.increment && ["Int", "BigInt"].includes(prismaType(field).scalar)) return " @default(autoincrement())";
  const parsed = parseDefault(field.default);
  if (!parsed || parsed.kind === "null") return "";
  if (parsed.kind === "string") return ` @default(${JSON.stringify(parsed.value)})`;
  if (parsed.kind === "number" || parsed.kind === "boolean") return ` @default(${String(parsed.value)})`;
  if (parsed.kind === "json") return ` @default(${JSON.stringify(JSON.stringify(parsed.value))})`;
  if (/^(now\(\)|current_timestamp(?:\(\))?)$/i.test(parsed.value)) return " @default(now())";
  return ` @default(dbgenerated(${JSON.stringify(parsed.value)}))`;
}

function prismaReferentialAction(action: string | undefined) {
  if (!action) return undefined;
  const actions: Record<string, string> = {
    CASCADE: "Cascade",
    RESTRICT: "Restrict",
    "NO ACTION": "NoAction",
    "SET NULL": "SetNull",
    "SET DEFAULT": "SetDefault",
  };
  return actions[action];
}

export function exportPrismaSchema(document: DbmlDocument) {
  const tableNames = uniqueNames(document.tables, (table) => pascalCase(table.name), (table) => table.id);
  const fieldNames = new Map<string, Map<string, string>>();
  for (const table of document.tables) {
    fieldNames.set(table.id, uniqueNames(table.fields, (field) => camelCase(field.name), (field) => field.id));
  }
  const ignoredTables = new Set(
    document.tables
      .filter(
        (table) =>
          !table.fields.some((field) => field.primaryKey) &&
          !table.fields.some((field) => field.unique && field.notNull),
      )
      .map((table) => table.id),
  );
  const normalizedForeignKeys = physicalForeignKeys(document);
  const oneToOneFields = new Set(
    normalizedForeignKeys
      .filter((foreignKey) => foreignKey.oneToOne)
      .map((foreignKey) => foreignKey.childField.id),
  );
  const explicitSchemas = document.tables
    .map((table) => table.schema)
    .filter((schema): schema is string => Boolean(schema));
  const schemas = explicitSchemas.length
    ? [...new Set(["public", ...explicitSchemas])]
    : [];
  const header = [
    "// Generated by Relix",
    "generator client {",
    '  provider = "prisma-client-js"',
    "}",
    "",
    "datasource db {",
    '  provider = "postgresql"',
    '  url      = env("DATABASE_URL")',
    ...(schemas.length ? [`  schemas  = [${schemas.map((schema) => JSON.stringify(schema)).join(", ")}]`] : []),
    "}",
  ];
  const warnings = relationWarnings(document, "//");
  if (warnings.length) header.push("", ...warnings);

  const relationFields = new Map<string, string[]>();
  const reserveRelationName = (tableId: string, line: string) => {
    const list = relationFields.get(tableId) ?? [];
    list.push(line);
    relationFields.set(tableId, list);
  };
  for (const foreignKey of normalizedForeignKeys) {
    if (ignoredTables.has(foreignKey.childTable.id) || ignoredTables.has(foreignKey.parentTable.id)) continue;
    if (!fieldIsIndividuallyUnique(foreignKey.parentTable, foreignKey.parentField)) continue;
    const childModel = tableNames.get(foreignKey.childTable.id)!;
    const parentModel = tableNames.get(foreignKey.parentTable.id)!;
    const childScalar = fieldNames.get(foreignKey.childTable.id)!.get(foreignKey.childField.id)!;
    const parentScalar = fieldNames.get(foreignKey.parentTable.id)!.get(foreignKey.parentField.id)!;
    const suffix = stableHash(foreignKey.relation.id).slice(0, 6);
    const relationName = `Relix_${suffix}`;
    const childRelationField = `relix${parentModel}${suffix}Parent`;
    const parentRelationField = `relix${childModel}${suffix}${foreignKey.oneToOne ? "Child" : "Children"}`;
    const optional = foreignKey.childField.notNull || foreignKey.childField.primaryKey ? "" : "?";
    const actions = [
      prismaReferentialAction(foreignKey.onDelete)
        ? `onDelete: ${prismaReferentialAction(foreignKey.onDelete)}`
        : "",
      prismaReferentialAction(foreignKey.onUpdate)
        ? `onUpdate: ${prismaReferentialAction(foreignKey.onUpdate)}`
        : "",
    ].filter(Boolean);
    reserveRelationName(
      foreignKey.childTable.id,
      `  ${childRelationField} ${parentModel}${optional} @relation(${JSON.stringify(relationName)}, fields: [${childScalar}], references: [${parentScalar}]${actions.length ? `, ${actions.join(", ")}` : ""})`,
    );
    reserveRelationName(
      foreignKey.parentTable.id,
      `  ${parentRelationField} ${childModel}${foreignKey.oneToOne ? "?" : "[]"} @relation(${JSON.stringify(relationName)})`,
    );
  }

  const models = document.tables.map((table) => {
    const modelName = tableNames.get(table.id)!;
    const names = fieldNames.get(table.id)!;
    const primaryKeys = table.fields.filter((field) => field.primaryKey);
    const lines = table.fields.map((field) => {
      const name = names.get(field.id)!;
      const mapped = name !== field.name ? ` @map(${JSON.stringify(field.name)})` : "";
      const type = prismaType(field);
      const optional = !field.notNull && !field.primaryKey && !type.scalar.endsWith("[]") ? "?" : "";
      const id = primaryKeys.length === 1 && field.primaryKey ? " @id" : "";
      const unique =
        (field.unique || oneToOneFields.has(field.id)) &&
        !(primaryKeys.length === 1 && field.primaryKey)
          ? " @unique"
          : "";
      return `  ${name} ${type.scalar}${optional}${id}${unique}${prismaDefault(field)}${type.native}${mapped}`;
    });
    lines.push(...(relationFields.get(table.id) ?? []));
    if (primaryKeys.length > 1) {
      lines.push(`  @@id([${primaryKeys.map((field) => names.get(field.id)).join(", ")}])`);
    }
    lines.push(`  @@map(${JSON.stringify(table.name)})`);
    if (schemas.length) {
      lines.push(`  @@schema(${JSON.stringify(table.schema ?? "public")})`);
    }
    if (ignoredTables.has(table.id)) lines.push("  @@ignore");
    return `model ${modelName} {\n${lines.join("\n")}\n}`;
  });
  return `${[...header, "", ...models].join("\n\n").replace(/\n{3,}/g, "\n\n")}\n`;
}

function drizzleBuilder(field: DbmlField) {
  const type = parseType(field.type);
  const column = JSON.stringify(field.name);
  let builder: string;
  if (field.increment && ["bigint", "int8", "bigserial"].includes(type.base)) builder = `bigserial(${column}, { mode: "bigint" })`;
  else if (field.increment && INTEGER_TYPES.has(type.base)) builder = `serial(${column})`;
  else if (type.base === "uuid") builder = `uuid(${column})`;
  else if (["varchar", "character varying", "string"].includes(type.base)) builder = `varchar(${column}${type.args[0] ? `, { length: ${type.args[0]} }` : ""})`;
  else if (["char", "character"].includes(type.base)) builder = `char(${column}${type.args[0] ? `, { length: ${type.args[0]} }` : ""})`;
  else if (["text", "citext"].includes(type.base)) builder = `text(${column})`;
  else if (["int", "integer", "int4", "serial"].includes(type.base)) builder = `integer(${column})`;
  else if (["smallint", "int2", "smallserial"].includes(type.base)) builder = `smallint(${column})`;
  else if (["bigint", "int8", "bigserial"].includes(type.base)) builder = `bigint(${column}, { mode: "bigint" })`;
  else if (["decimal", "numeric", "money"].includes(type.base)) {
    const options = type.args.length ? `, { precision: ${type.args[0]}, scale: ${type.args[1] ?? "0"} }` : "";
    builder = `numeric(${column}${options})`;
  }
  else if (["real", "float", "float4"].includes(type.base)) builder = `real(${column})`;
  else if (["double", "double precision", "float8"].includes(type.base)) builder = `doublePrecision(${column})`;
  else if (["bool", "boolean"].includes(type.base)) builder = `boolean(${column})`;
  else if (["datetime", "timestamp"].includes(type.base)) builder = `timestamp(${column}, { mode: "date", withTimezone: false })`;
  else if (["timestamptz", "timestamp with time zone"].includes(type.base)) builder = `timestamp(${column}, { mode: "date", withTimezone: true })`;
  else if (type.base === "date") builder = `date(${column}, { mode: "date" })`;
  else if (type.base === "time") builder = `time(${column})`;
  else if (type.base === "json") builder = `json(${column})`;
  else if (type.base === "jsonb") builder = `jsonb(${column})`;
  else return `customType<{ data: unknown }>({ dataType() { return ${JSON.stringify(type.raw)}; } })(${column})`;

  return type.array ? `${builder}.array()` : builder;
}

function drizzleDefault(field: DbmlField) {
  if (field.increment) return "";
  const parsed = parseDefault(field.default);
  if (!parsed || parsed.kind === "null") return "";
  if (parsed.kind === "number") {
    return `.default(sql.raw(${JSON.stringify(parsed.value)}))`;
  }
  if (parsed.kind === "string" || parsed.kind === "boolean" || parsed.kind === "json") {
    return `.default(${JSON.stringify(parsed.value)})`;
  }
  if (/^(now\(\)|current_timestamp(?:\(\))?)$/i.test(parsed.value)) {
    const type = parseType(field.type);
    if (["datetime", "timestamp", "timestamptz", "timestamp with time zone"].includes(type.base)) {
      return ".defaultNow()";
    }
  }
  return `.default(sql.raw(${JSON.stringify(parsed.value)}))`;
}

export function exportDrizzleSchema(document: DbmlDocument) {
  const tableNames = uniqueNames(document.tables, (table) => camelCase(table.name), (table) => table.id);
  const fieldNames = new Map<string, Map<string, string>>();
  for (const table of document.tables) {
    fieldNames.set(table.id, uniqueNames(table.fields, (field) => camelCase(field.name), (field) => field.id));
  }
  const schemaNames = uniqueNames(
    [...new Set(document.tables.map((table) => table.schema).filter((schema): schema is string => Boolean(schema)))],
    (schema) => `${camelCase(schema)}Schema`,
    (schema) => schema,
  );
  const foreignKeyByField = new Map<string, PhysicalForeignKey>();
  for (const foreignKey of physicalForeignKeys(document)) {
    if (!foreignKeyByField.has(foreignKey.childField.id)) foreignKeyByField.set(foreignKey.childField.id, foreignKey);
  }
  const oneToOneFields = oneToOneFieldIds(document);
  const imports = [
    "AnyPgColumn",
    "bigint",
    "bigserial",
    "boolean",
    "char",
    "customType",
    "date",
    "doublePrecision",
    "integer",
    "json",
    "jsonb",
    "numeric",
    "pgSchema",
    "pgTable",
    "primaryKey",
    "real",
    "serial",
    "smallint",
    "text",
    "time",
    "timestamp",
    "uuid",
    "varchar",
  ];
  const lines = [
    "// Generated by Relix",
    `import { ${imports.join(", ")} } from "drizzle-orm/pg-core";`,
    'import { sql } from "drizzle-orm";',
  ];
  const warnings = relationWarnings(document, "//");
  if (warnings.length) lines.push("", ...warnings);
  for (const [schema, variable] of schemaNames) {
    lines.push("", `export const ${variable} = pgSchema(${JSON.stringify(schema)});`);
  }

  for (const table of document.tables) {
    const variable = tableNames.get(table.id)!;
    const names = fieldNames.get(table.id)!;
    const primaryKeys = table.fields.filter((field) => field.primaryKey);
    const tableFactory = table.schema ? `${schemaNames.get(table.schema)}.table` : "pgTable";
    const fieldLines = table.fields.map((field) => {
      let builder = drizzleBuilder(field);
      if (primaryKeys.length === 1 && field.primaryKey) builder += ".primaryKey()";
      if (field.notNull || field.primaryKey) builder += ".notNull()";
      if (needsStandaloneUnique(table, field, oneToOneFields.has(field.id))) {
        builder += ".unique()";
      }
      builder += drizzleDefault(field);
      const foreignKey = foreignKeyByField.get(field.id);
      if (foreignKey) {
        const targetTable = tableNames.get(foreignKey.parentTable.id);
        const targetField = fieldNames.get(foreignKey.parentTable.id)?.get(foreignKey.parentField.id);
        if (targetTable && targetField) {
          const actions = [
            foreignKey.onDelete ? `onDelete: ${JSON.stringify(foreignKey.onDelete.toLowerCase().replace(/\s+/g, " "))}` : "",
            foreignKey.onUpdate ? `onUpdate: ${JSON.stringify(foreignKey.onUpdate.toLowerCase().replace(/\s+/g, " "))}` : "",
          ].filter(Boolean);
          builder += `.references((): AnyPgColumn => ${targetTable}.${targetField}${actions.length ? `, { ${actions.join(", ")} }` : ""})`;
        }
      }
      return `  ${names.get(field.id)}: ${builder},`;
    });
    const callback =
      primaryKeys.length > 1
        ? `,\n(table) => [\n  primaryKey({ columns: [${primaryKeys.map((field) => `table.${names.get(field.id)}`).join(", ")}] }),\n]`
        : "";
    lines.push(
      "",
      `export const ${variable} = ${tableFactory}(${JSON.stringify(table.name)}, {\n${fieldLines.join("\n")}\n}${callback});`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function jsonSchemaForType(field: DbmlField): Record<string, unknown> {
  const type = parseType(field.type);
  let schema: Record<string, unknown>;
  if (INTEGER_TYPES.has(type.base)) schema = { type: "integer" };
  else if (["decimal", "numeric", "money", "real", "float", "float4", "double", "double precision", "float8"].includes(type.base)) schema = { type: "number" };
  else if (["bool", "boolean"].includes(type.base)) schema = { type: "boolean" };
  else if (["json", "jsonb"].includes(type.base)) schema = {};
  else if (["blob", "binary", "varbinary", "bytea"].includes(type.base)) schema = { type: "string", contentEncoding: "base64" };
  else {
    schema = { type: "string" };
    if (type.base === "uuid") schema.format = "uuid";
    else if (type.base === "date") schema.format = "date";
    else if (["datetime", "timestamp", "timestamptz", "timestamp with time zone"].includes(type.base)) schema.format = "date-time";
    else if (type.base === "time") schema.format = "time";
    if (["varchar", "character varying", "char", "character"].includes(type.base) && /^\d+$/.test(type.args[0] ?? "")) {
      schema.maxLength = Number(type.args[0]);
    }
  }
  if (type.array) schema = { type: "array", items: schema };
  if (!field.notNull && !field.primaryKey && Object.keys(schema).length) {
    schema = { anyOf: [schema, { type: "null" }] };
  }
  return schema;
}

function exactJsonNumber(value: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  if (!value.includes(".")) {
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  const normalize = (input: string) => {
    const negative = input.startsWith("-");
    const unsigned = negative ? input.slice(1) : input;
    const [integerPart, fractionPart = ""] = unsigned.split(".");
    const integer = (integerPart || "0").replace(/^0+(?=\d)/, "");
    const fraction = fractionPart.replace(/0+$/, "");
    return `${negative ? "-" : ""}${integer || "0"}${fraction ? `.${fraction}` : ""}`;
  };
  return normalize(String(parsed)) === normalize(value) ? parsed : undefined;
}

export function exportJsonSchema(document: DbmlDocument) {
  const foreignKeys = physicalForeignKeys(document);
  const root: Record<string, unknown> = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://relix.dev/generated/database.schema.json",
    title: "Relix database schema",
    description: "Generated from DBML. Cross-row constraints are recorded as x-* annotations.",
    type: "object",
    properties: {},
    additionalProperties: false,
    $defs: {},
    "x-relations": foreignKeys.map((foreignKey) => ({
      name: foreignKey.relation.name,
      childTable: qualifiedName(foreignKey.childTable),
      childField: foreignKey.childField.name,
      parentTable: qualifiedName(foreignKey.parentTable),
      parentField: foreignKey.parentField.name,
      cardinality: foreignKey.oneToOne ? "one-to-one" : "many-to-one",
      onDelete: foreignKey.onDelete,
      onUpdate: foreignKey.onUpdate,
    })),
  };
  const properties = root.properties as Record<string, unknown>;
  const definitions = root.$defs as Record<string, unknown>;
  for (const table of document.tables) {
    const key = qualifiedName(table);
    properties[key] = { type: "array", items: { $ref: `#/$defs/${key.replaceAll("~", "~0").replaceAll("/", "~1")}` } };
    const rowProperties: Record<string, unknown> = {};
    for (const field of table.fields) {
      const schema = jsonSchemaForType(field);
      schema["x-db-type"] = field.type;
      if (field.primaryKey) schema["x-primary-key"] = true;
      if (field.unique) schema["x-unique"] = true;
      if (field.increment) schema["x-increment"] = true;
      if (field.note) schema.description = field.note;
      const defaultValue = parseDefault(field.default);
      if (defaultValue?.kind === "number") {
        const numericDefault = exactJsonNumber(defaultValue.value);
        if (numericDefault === undefined) {
          schema["x-db-default"] = defaultValue.value;
        } else {
          schema.default = numericDefault;
        }
      } else if (defaultValue && ["string", "boolean", "null", "json"].includes(defaultValue.kind)) {
        schema.default = defaultValue.value;
      } else if (defaultValue?.kind === "expression") {
        schema["x-db-default"] = defaultValue.value;
      }
      const fieldForeignKeys = foreignKeys.filter(
        (foreignKey) => foreignKey.childTable.id === table.id && foreignKey.childField.id === field.id,
      );
      if (fieldForeignKeys.length) {
        schema["x-foreign-key"] = fieldForeignKeys.map((foreignKey) => ({
          table: qualifiedName(foreignKey.parentTable),
          field: foreignKey.parentField.name,
          cardinality: foreignKey.oneToOne ? "one-to-one" : "many-to-one",
        }));
      }
      rowProperties[field.name] = schema;
    }
    definitions[key] = {
      type: "object",
      title: key,
      ...(table.note ? { description: table.note } : {}),
      properties: rowProperties,
      required: table.fields.filter((field) => field.notNull || field.primaryKey).map((field) => field.name),
      additionalProperties: false,
      "x-primary-key": table.fields.filter((field) => field.primaryKey).map((field) => field.name),
    };
  }
  return `${JSON.stringify(root, null, 2)}\n`;
}

export function exportSchema(document: DbmlDocument, format: SchemaExportFormat) {
  switch (format) {
    case "postgresql":
      return exportPostgresSql(document);
    case "mysql":
      return exportMySql(document);
    case "sqlite":
      return exportSqliteSql(document);
    case "prisma":
      return exportPrismaSchema(document);
    case "drizzle":
      return exportDrizzleSchema(document);
    case "json-schema":
      return exportJsonSchema(document);
  }
}
