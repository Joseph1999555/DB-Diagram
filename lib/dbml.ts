/**
 * A dependency-free DBML reader/writer for the diagram editor.
 *
 * This intentionally implements the useful, visual subset of DBML rather than
 * trying to be a validating compiler. Unknown settings are retained so an
 * import/edit/export cycle does not discard information the canvas does not
 * currently understand.
 */

export type DbmlRelationOperator = ">" | "<" | "-" | "<>";

export type DbmlRelationCardinality =
  | "many-to-one"
  | "one-to-many"
  | "one-to-one"
  | "many-to-many";

export interface DbmlField {
  id: string;
  name: string;
  type: string;
  primaryKey: boolean;
  notNull: boolean;
  unique: boolean;
  increment: boolean;
  default?: string;
  note?: string;
  extraSettings?: string[];
}

export interface DbmlTable {
  id: string;
  name: string;
  schema?: string;
  alias?: string;
  note?: string;
  color?: string;
  fields: DbmlField[];
  extraSettings?: string[];
}

export interface DbmlRelation {
  id: string;
  name?: string;
  fromTableId: string;
  fromFieldId: string;
  toTableId: string;
  toFieldId: string;
  /** Qualified DBML table name. Kept as a fallback for unresolved references. */
  fromTable: string;
  fromField: string;
  /** Qualified DBML table name. Kept as a fallback for unresolved references. */
  toTable: string;
  toField: string;
  operator: DbmlRelationOperator;
  cardinality: DbmlRelationCardinality;
  source: "inline" | "standalone";
  settings?: string[];
}

export interface DbmlGroup {
  id: string;
  name: string;
  tableIds: string[];
  /** Names parallel to tableIds, used to preserve unresolved group members. */
  tableNames: string[];
  color?: string;
  note?: string;
  extraSettings?: string[];
}

export interface DbmlDiagnostic {
  level: "warning" | "error";
  code: string;
  message: string;
  line?: number;
}

export interface DbmlDocument {
  tables: DbmlTable[];
  relations: DbmlRelation[];
  groups: DbmlGroup[];
  diagnostics: DbmlDiagnostic[];
}

export interface DbmlSerializeOptions {
  indent?: string;
  includeGeneratedHeader?: boolean;
}

interface BlockDeclaration {
  kind: "table" | "group";
  start: number;
  open: number;
  end: number;
  header: string;
  body: string;
  line: number;
}

interface Endpoint {
  table: string;
  field: string;
}

interface RawRelation {
  name?: string;
  left: Endpoint;
  right: Endpoint;
  operator: DbmlRelationOperator;
  source: "inline" | "standalone";
  settings?: string[];
  line?: number;
}

interface TableLookup {
  exact: Map<string, DbmlTable>;
  aliases: Map<string, DbmlTable>;
  byBaseName: Map<string, DbmlTable[]>;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const RESERVED_IDENTIFIERS = new Set([
  "as",
  "enum",
  "indexes",
  "note",
  "project",
  "ref",
  "table",
  "tablegroup",
]);

export function createEmptyDbmlDocument(): DbmlDocument {
  return { tables: [], relations: [], groups: [], diagnostics: [] };
}

/** Create a readable, deterministic id from semantic DBML content. */
export function makeDbmlId(kind: string, key: string): string {
  const kindSlug = slug(kind) || "item";
  const keySlug = slug(key).slice(0, 42) || "unnamed";
  let hash = 0x811c9dc5;

  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return `${kindSlug}_${keySlug}_${(hash >>> 0).toString(36)}`;
}

export function parseDBML(source: string): DbmlDocument {
  const diagnostics: DbmlDiagnostic[] = [];
  const cleanSource = stripComments(source);
  const blocks = collectBlocks(cleanSource, diagnostics);
  const tables: DbmlTable[] = [];
  const rawRelations: RawRelation[] = [];
  const tableOccurrences = new Map<string, number>();

  for (const block of blocks) {
    if (block.kind !== "table") continue;

    const declaration = parseDeclarationHeader(block.header);
    if (!declaration.name) {
      diagnostics.push({
        level: "error",
        code: "invalid-table",
        message: "A Table declaration is missing its name.",
        line: block.line,
      });
      continue;
    }

    const tableParts = splitIdentifierPath(declaration.name);
    if (tableParts.length === 0) {
      diagnostics.push({
        level: "error",
        code: "invalid-table-name",
        message: `Could not read table name ${declaration.name}.`,
        line: block.line,
      });
      continue;
    }

    const name = tableParts.at(-1) ?? "untitled";
    const schema = tableParts.length > 1 ? tableParts.slice(0, -1).join(".") : undefined;
    const qualifiedName = schema ? `${schema}.${name}` : name;
    const occurrenceKey = canonical(qualifiedName);
    const occurrence = tableOccurrences.get(occurrenceKey) ?? 0;
    tableOccurrences.set(occurrenceKey, occurrence + 1);

    if (occurrence > 0) {
      diagnostics.push({
        level: "warning",
        code: "duplicate-table",
        message: `Table ${qualifiedName} is declared more than once.`,
        line: block.line,
      });
    }

    const tableSettings = parseNamedSettings(declaration.settings);
    const table: DbmlTable = {
      id: makeDbmlId("table", `${occurrenceKey}#${occurrence}`),
      name,
      schema,
      alias: declaration.alias,
      note: tableSettings.note,
      color: tableSettings.color,
      fields: [],
      extraSettings: optionalArray(tableSettings.extra),
    };

    const fieldOccurrences = new Map<string, number>();
    for (const statement of splitStatements(block.body)) {
      const trimmed = statement.trim();
      if (!trimmed) continue;

      const tableNote = /^note\s*:\s*([\s\S]+)$/i.exec(trimmed);
      if (tableNote) {
        table.note = unquoteValue(tableNote[1].trim());
        continue;
      }

      if (/^(indexes?|checks?)\s*\{/i.test(trimmed)) continue;

      const parsedField = parseFieldStatement(trimmed);
      if (!parsedField) {
        diagnostics.push({
          level: "warning",
          code: "unrecognized-field",
          message: `Skipped an unrecognized line in ${qualifiedName}: ${compact(trimmed)}`,
          line: block.line,
        });
        continue;
      }

      const fieldKey = canonical(parsedField.name);
      const fieldOccurrence = fieldOccurrences.get(fieldKey) ?? 0;
      fieldOccurrences.set(fieldKey, fieldOccurrence + 1);
      const field: DbmlField = {
        id: makeDbmlId(
          "field",
          `${canonical(qualifiedName)}.${fieldKey}#${fieldOccurrence}`,
        ),
        name: parsedField.name,
        type: parsedField.type,
        primaryKey: parsedField.primaryKey,
        notNull: parsedField.notNull,
        unique: parsedField.unique,
        increment: parsedField.increment,
        default: parsedField.default,
        note: parsedField.note,
        extraSettings: optionalArray(parsedField.extraSettings),
      };
      table.fields.push(field);

      for (const reference of parsedField.references) {
        const target = parseEndpoint(reference.target);
        if (!target) {
          diagnostics.push({
            level: "warning",
            code: "invalid-inline-reference",
            message: `Could not read reference target ${reference.target}.`,
            line: block.line,
          });
          continue;
        }

        rawRelations.push({
          left: { table: qualifiedName, field: field.name },
          right: target,
          operator: reference.operator,
          source: "inline",
          line: block.line,
        });
      }
    }

    tables.push(table);
  }

  const lookup = createTableLookup(tables);
  const maskedTopLevel = maskBlockRanges(cleanSource, blocks);

  for (const statement of splitStatements(maskedTopLevel)) {
    if (!/^ref(?:\s|:)/i.test(statement.trim())) continue;
    rawRelations.push(...parseStandaloneReference(statement, diagnostics));
  }

  const relations = materializeRelations(rawRelations, lookup, diagnostics);
  const groups: DbmlGroup[] = [];
  const groupOccurrences = new Map<string, number>();

  for (const block of blocks) {
    if (block.kind !== "group") continue;

    const declaration = parseDeclarationHeader(block.header, false);
    if (!declaration.name) {
      diagnostics.push({
        level: "warning",
        code: "invalid-group",
        message: "A TableGroup declaration is missing its name.",
        line: block.line,
      });
      continue;
    }

    const groupName = normalizeIdentifier(declaration.name);
    const key = canonical(groupName);
    const occurrence = groupOccurrences.get(key) ?? 0;
    groupOccurrences.set(key, occurrence + 1);
    const settings = parseNamedSettings(declaration.settings);
    const tableNames = tokenizeIdentifierList(block.body);
    const tableIds = tableNames.map((tableName) => {
      const table = resolveTable(tableName, lookup);
      if (!table) {
        diagnostics.push({
          level: "warning",
          code: "unknown-group-table",
          message: `TableGroup ${groupName} references unknown table ${tableName}.`,
          line: block.line,
        });
      }
      return table?.id ?? makeDbmlId("table", canonical(tableName));
    });

    groups.push({
      id: makeDbmlId("group", `${key}#${occurrence}`),
      name: groupName,
      tableIds,
      tableNames,
      color: settings.color,
      note: settings.note,
      extraSettings: optionalArray(settings.extra),
    });
  }

  return { tables, relations, groups, diagnostics };
}

export const parseDbml = parseDBML;

export function serializeDBML(
  document: DbmlDocument,
  options: DbmlSerializeOptions = {},
): string {
  const indent = options.indent ?? "  ";
  const chunks: string[] = [];
  const tablesById = new Map(document.tables.map((table) => [table.id, table]));

  if (options.includeGeneratedHeader) {
    chunks.push("// Generated by the ER diagram editor");
  }

  for (const table of document.tables) {
    const headerSettings: string[] = [];
    if (table.color) headerSettings.push(`headercolor: ${table.color}`);
    headerSettings.push(...(table.extraSettings ?? []));

    const alias = table.alias ? ` as ${formatIdentifier(table.alias)}` : "";
    const settings = headerSettings.length > 0 ? ` [${headerSettings.join(", ")}]` : "";
    const lines = [`Table ${formatTable(table)}${alias}${settings} {`];

    for (const field of table.fields) {
      const fieldSettings: string[] = [];
      if (field.primaryKey) fieldSettings.push("pk");
      if (field.notNull) fieldSettings.push("not null");
      if (field.unique) fieldSettings.push("unique");
      if (field.increment) fieldSettings.push("increment");
      if (field.default !== undefined) fieldSettings.push(`default: ${field.default}`);
      if (field.note !== undefined) fieldSettings.push(`note: ${quoteValue(field.note)}`);
      fieldSettings.push(...(field.extraSettings ?? []));

      const suffix = fieldSettings.length > 0 ? ` [${fieldSettings.join(", ")}]` : "";
      lines.push(
        `${indent}${formatIdentifier(field.name)} ${field.type.trim() || "varchar"}${suffix}`,
      );
    }

    if (table.note !== undefined) {
      if (table.fields.length > 0) lines.push("");
      lines.push(`${indent}Note: ${quoteValue(table.note)}`);
    }

    lines.push("}");
    chunks.push(lines.join("\n"));
  }

  for (const relation of document.relations) {
    const from = serializeRelationEndpoint(
      relation.fromTableId,
      relation.fromFieldId,
      relation.fromTable,
      relation.fromField,
      tablesById,
    );
    const to = serializeRelationEndpoint(
      relation.toTableId,
      relation.toFieldId,
      relation.toTable,
      relation.toField,
      tablesById,
    );
    const name = relation.name ? ` ${formatIdentifier(relation.name)}` : "";
    const settings = relation.settings?.length
      ? ` [${relation.settings.join(", ")}]`
      : "";
    chunks.push(`Ref${name}: ${from} ${relation.operator} ${to}${settings}`);
  }

  for (const group of document.groups) {
    const groupSettings: string[] = [];
    if (group.color) groupSettings.push(`color: ${group.color}`);
    if (group.note !== undefined) groupSettings.push(`note: ${quoteValue(group.note)}`);
    groupSettings.push(...(group.extraSettings ?? []));
    const settings = groupSettings.length > 0 ? ` [${groupSettings.join(", ")}]` : "";
    const members = group.tableIds.map((tableId, index) => {
      const table = tablesById.get(tableId);
      return table ? formatTable(table) : formatIdentifierPath(group.tableNames[index] ?? "unknown");
    });
    const lines = [`TableGroup ${formatIdentifier(group.name)}${settings} {`];
    lines.push(...members.map((member) => `${indent}${member}`));
    lines.push("}");
    chunks.push(lines.join("\n"));
  }

  return `${chunks.filter(Boolean).join("\n\n").trim()}\n`;
}

export const serializeDbml = serializeDBML;

function parseFieldStatement(statement: string): {
  name: string;
  type: string;
  primaryKey: boolean;
  notNull: boolean;
  unique: boolean;
  increment: boolean;
  default?: string;
  note?: string;
  extraSettings: string[];
  references: { operator: DbmlRelationOperator; target: string }[];
} | null {
  const identifier = takeIdentifier(statement);
  if (!identifier) return null;

  const extracted = extractTrailingSettings(identifier.rest.trim());
  const type = extracted.base.trim().replace(/[;,]\s*$/, "");
  if (!type || type === "{") return null;

  const result = {
    name: normalizeIdentifier(identifier.value),
    type,
    primaryKey: false,
    notNull: false,
    unique: false,
    increment: false,
    default: undefined as string | undefined,
    note: undefined as string | undefined,
    extraSettings: [] as string[],
    references: [] as { operator: DbmlRelationOperator; target: string }[],
  };

  for (const setting of splitTopLevel(extracted.settings ?? "", ",")) {
    const value = setting.trim();
    if (!value) continue;
    const normalized = value.toLowerCase().replace(/\s+/g, " ");

    if (normalized === "pk" || normalized === "primary key") result.primaryKey = true;
    else if (normalized === "not null") result.notNull = true;
    else if (normalized === "unique") result.unique = true;
    else if (normalized === "increment") result.increment = true;
    else if (/^default\s*:/i.test(value)) result.default = settingValue(value);
    else if (/^note\s*:/i.test(value)) result.note = unquoteValue(settingValue(value));
    else if (/^ref\s*:/i.test(value)) {
      const parsed = parseInlineReference(settingValue(value));
      if (parsed) result.references.push(parsed);
      else result.extraSettings.push(value);
    } else result.extraSettings.push(value);
  }

  return result;
}

function parseInlineReference(
  value: string,
): { operator: DbmlRelationOperator; target: string } | null {
  const match = /^(<>|>|<|-)\s*([\s\S]+)$/.exec(value.trim());
  if (!match) return null;
  return { operator: match[1] as DbmlRelationOperator, target: match[2].trim() };
}

function parseStandaloneReference(
  statement: string,
  diagnostics: DbmlDiagnostic[],
): RawRelation[] {
  const text = statement.trim().replace(/;$/, "").trim();
  const colon = findOutside(text, ":");
  if (colon < 0) {
    diagnostics.push({
      level: "warning",
      code: "invalid-reference",
      message: `Reference is missing a colon: ${compact(text)}`,
    });
    return [];
  }

  const prefix = text.slice(0, colon).trim();
  if (!/^ref(?:\s|$)/i.test(prefix)) return [];
  const rawName = prefix.replace(/^ref\b/i, "").trim();
  const name = rawName ? normalizeIdentifier(rawName) : undefined;
  const extracted = extractTrailingSettings(text.slice(colon + 1).trim());
  const operatorMatch = findRelationOperator(extracted.base);

  if (!operatorMatch) {
    diagnostics.push({
      level: "warning",
      code: "invalid-reference",
      message: `Reference has no supported relation operator: ${compact(text)}`,
    });
    return [];
  }

  const leftList = parseEndpointList(extracted.base.slice(0, operatorMatch.index));
  const rightList = parseEndpointList(
    extracted.base.slice(operatorMatch.index + operatorMatch.operator.length),
  );
  if (leftList.length === 0 || rightList.length === 0 || leftList.length !== rightList.length) {
    diagnostics.push({
      level: "warning",
      code: "invalid-reference-endpoint",
      message: `Could not pair reference endpoints: ${compact(text)}`,
    });
    return [];
  }

  const settings = optionalArray(
    splitTopLevel(extracted.settings ?? "", ",").map((item) => item.trim()).filter(Boolean),
  );

  return leftList.map((left, index) => ({
    name,
    left,
    right: rightList[index],
    operator: operatorMatch.operator,
    source: "standalone",
    settings,
  }));
}

function materializeRelations(
  relations: RawRelation[],
  lookup: TableLookup,
  diagnostics: DbmlDiagnostic[],
): DbmlRelation[] {
  const occurrences = new Map<string, number>();

  return relations.map((relation) => {
    const from = resolveEndpoint(relation.left, lookup, diagnostics, relation.line);
    const to = resolveEndpoint(relation.right, lookup, diagnostics, relation.line);
    const semanticKey = [
      canonical(from.tableName),
      canonical(from.fieldName),
      relation.operator,
      canonical(to.tableName),
      canonical(to.fieldName),
      canonical(relation.name ?? ""),
    ].join("|");
    const occurrence = occurrences.get(semanticKey) ?? 0;
    occurrences.set(semanticKey, occurrence + 1);

    return {
      id: makeDbmlId("relation", `${semanticKey}#${occurrence}`),
      name: relation.name,
      fromTableId: from.tableId,
      fromFieldId: from.fieldId,
      toTableId: to.tableId,
      toFieldId: to.fieldId,
      fromTable: from.tableName,
      fromField: from.fieldName,
      toTable: to.tableName,
      toField: to.fieldName,
      operator: relation.operator,
      cardinality: cardinalityFor(relation.operator),
      source: relation.source,
      settings: relation.settings,
    };
  });
}

function resolveEndpoint(
  endpoint: Endpoint,
  lookup: TableLookup,
  diagnostics: DbmlDiagnostic[],
  line?: number,
): { tableId: string; fieldId: string; tableName: string; fieldName: string } {
  const table = resolveTable(endpoint.table, lookup);
  if (!table) {
    diagnostics.push({
      level: "warning",
      code: "unknown-reference-table",
      message: `Reference points to unknown table ${endpoint.table}.`,
      line,
    });
    const tableId = makeDbmlId("table", canonical(endpoint.table));
    return {
      tableId,
      fieldId: makeDbmlId("field", `${tableId}.${canonical(endpoint.field)}`),
      tableName: endpoint.table,
      fieldName: endpoint.field,
    };
  }

  const field = table.fields.find((candidate) => canonical(candidate.name) === canonical(endpoint.field));
  const tableName = qualifiedTableName(table);
  if (!field) {
    diagnostics.push({
      level: "warning",
      code: "unknown-reference-field",
      message: `Reference points to unknown field ${tableName}.${endpoint.field}.`,
      line,
    });
  }

  return {
    tableId: table.id,
    fieldId: field?.id ?? makeDbmlId("field", `${table.id}.${canonical(endpoint.field)}`),
    tableName,
    fieldName: field?.name ?? endpoint.field,
  };
}

function createTableLookup(tables: DbmlTable[]): TableLookup {
  const exact = new Map<string, DbmlTable>();
  const aliases = new Map<string, DbmlTable>();
  const byBaseName = new Map<string, DbmlTable[]>();

  for (const table of tables) {
    const qualified = canonical(qualifiedTableName(table));
    if (!exact.has(qualified)) exact.set(qualified, table);
    if (table.alias && !aliases.has(canonical(table.alias))) {
      aliases.set(canonical(table.alias), table);
    }
    const base = canonical(table.name);
    byBaseName.set(base, [...(byBaseName.get(base) ?? []), table]);
  }

  return { exact, aliases, byBaseName };
}

function resolveTable(name: string, lookup: TableLookup): DbmlTable | undefined {
  const key = canonical(normalizeIdentifierPath(name));
  const exact = lookup.exact.get(key) ?? lookup.aliases.get(key);
  if (exact) return exact;

  const parts = splitIdentifierPath(name);
  const base = canonical(parts.at(-1) ?? name);
  const candidates = lookup.byBaseName.get(base) ?? [];
  return candidates.length === 1 ? candidates[0] : undefined;
}

function parseEndpointList(value: string): Endpoint[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  const inner = hasOuterParens(trimmed) ? trimmed.slice(1, -1) : trimmed;
  return splitTopLevel(inner, ",").map(parseEndpoint).filter(isDefined);
}

function parseEndpoint(value: string): Endpoint | null {
  const parts = splitIdentifierPath(value.trim());
  if (parts.length < 2) return null;
  return { table: parts.slice(0, -1).join("."), field: parts.at(-1) ?? "" };
}

function cardinalityFor(operator: DbmlRelationOperator): DbmlRelationCardinality {
  if (operator === ">") return "many-to-one";
  if (operator === "<") return "one-to-many";
  if (operator === "<>") return "many-to-many";
  return "one-to-one";
}

function parseDeclarationHeader(header: string, allowAlias = true): {
  name: string;
  alias?: string;
  settings?: string;
} {
  const extracted = extractTrailingSettings(header.trim(), false);
  const aliasIndex = allowAlias ? findKeyword(extracted.base, "as") : -1;
  const rawName = aliasIndex >= 0 ? extracted.base.slice(0, aliasIndex).trim() : extracted.base.trim();
  const rawAlias = aliasIndex >= 0 ? extracted.base.slice(aliasIndex + 2).trim() : "";

  return {
    name: normalizeIdentifierPath(rawName),
    alias: rawAlias ? normalizeIdentifier(rawAlias) : undefined,
    settings: extracted.settings,
  };
}

function parseNamedSettings(settings?: string): {
  color?: string;
  note?: string;
  extra: string[];
} {
  const parsed: { color?: string; note?: string; extra: string[] } = { extra: [] };

  for (const rawSetting of splitTopLevel(settings ?? "", ",")) {
    const setting = rawSetting.trim();
    if (!setting) continue;
    if (/^(?:headercolor|color)\s*:/i.test(setting)) parsed.color = settingValue(setting);
    else if (/^note\s*:/i.test(setting)) parsed.note = unquoteValue(settingValue(setting));
    else parsed.extra.push(setting);
  }

  return parsed;
}

function collectBlocks(source: string, diagnostics: DbmlDiagnostic[]): BlockDeclaration[] {
  const blocks: BlockDeclaration[] = [];
  const lineStarts = collectLineStarts(source);
  let index = 0;
  let depth = 0;
  let quote: string | null = null;

  while (index < source.length) {
    const character = source[index];
    if (quote) {
      if (character === "\\") index += 2;
      else if (character === quote) {
        if (source[index + 1] === quote && quote !== "`") index += 2;
        else {
          quote = null;
          index += 1;
        }
      } else index += 1;
      continue;
    }

    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      index += 1;
      continue;
    }
    if (character === "{") {
      depth += 1;
      index += 1;
      continue;
    }
    if (character === "}") {
      depth = Math.max(0, depth - 1);
      index += 1;
      continue;
    }

    if (depth === 0 && isWordStart(character)) {
      const wordEnd = readWordEnd(source, index);
      const word = source.slice(index, wordEnd).toLowerCase();
      if ((word === "table" || word === "tablegroup") && isDeclarationStart(source, index)) {
        const open = findOpeningBrace(source, wordEnd);
        if (open < 0) {
          index = wordEnd;
          continue;
        }
        const end = findMatchingBrace(source, open);
        const line = lineNumberAt(lineStarts, index);
        if (end < 0) {
          diagnostics.push({
            level: "error",
            code: "unclosed-block",
            message: `${word === "table" ? "Table" : "TableGroup"} block is not closed.`,
            line,
          });
          break;
        }

        blocks.push({
          kind: word === "table" ? "table" : "group",
          start: index,
          open,
          end,
          header: source.slice(wordEnd, open),
          body: source.slice(open + 1, end),
          line,
        });
        index = end + 1;
        continue;
      }
      index = wordEnd;
      continue;
    }

    index += 1;
  }

  return blocks;
}

function findOpeningBrace(source: string, start: number): number {
  let quote: string | null = null;
  let squareDepth = 0;

  for (let index = start; index < source.length; index += 1) {
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
    else if (character === "[") squareDepth += 1;
    else if (character === "]") squareDepth = Math.max(0, squareDepth - 1);
    else if (character === "{" && squareDepth === 0) return index;
  }

  return -1;
}

function findMatchingBrace(source: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;

  for (let index = open; index < source.length; index += 1) {
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
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
}

function maskBlockRanges(source: string, blocks: BlockDeclaration[]): string {
  const characters = [...source];
  for (const block of blocks) {
    for (let index = block.start; index <= block.end; index += 1) {
      if (characters[index] !== "\n" && characters[index] !== "\r") characters[index] = " ";
    }
  }
  return characters.join("");
}

function stripComments(source: string): string {
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
        if (next === quote && quote !== "`") {
          output += next;
          index += 1;
        } else quote = null;
      }
      continue;
    }

    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      output += character;
    } else if (character === "/" && next === "/") {
      output += "  ";
      index += 2;
      while (index < source.length && source[index] !== "\n") {
        output += " ";
        index += 1;
      }
      if (index < source.length) output += source[index];
    } else if (character === "/" && next === "*") {
      output += "  ";
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        output += source[index] === "\n" || source[index] === "\r" ? source[index] : " ";
        index += 1;
      }
      if (index < source.length) {
        output += "  ";
        index += 1;
      }
    } else output += character;
  }

  return output;
}

function splitStatements(source: string): string[] {
  const statements: string[] = [];
  let current = "";
  let squareDepth = 0;
  let parenDepth = 0;
  let braceDepth = 0;
  let quote: string | null = null;

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
    else if (character === "[") squareDepth += 1;
    else if (character === "]") squareDepth = Math.max(0, squareDepth - 1);
    else if (character === "(") parenDepth += 1;
    else if (character === ")") parenDepth = Math.max(0, parenDepth - 1);
    else if (character === "{") braceDepth += 1;
    else if (character === "}") braceDepth = Math.max(0, braceDepth - 1);

    const isSeparator = character === "\n" || character === ";";
    if (isSeparator && squareDepth === 0 && parenDepth === 0 && braceDepth === 0) {
      if (current.trim()) statements.push(current.trim());
      current = "";
    } else current += character;
  }

  if (current.trim()) statements.push(current.trim());
  return statements;
}

function splitTopLevel(source: string, delimiter: string): string[] {
  const result: string[] = [];
  let current = "";
  let quote: string | null = null;
  let parenDepth = 0;
  let squareDepth = 0;
  let braceDepth = 0;

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
    else if (character === "(") parenDepth += 1;
    else if (character === ")") parenDepth = Math.max(0, parenDepth - 1);
    else if (character === "[") squareDepth += 1;
    else if (character === "]") squareDepth = Math.max(0, squareDepth - 1);
    else if (character === "{") braceDepth += 1;
    else if (character === "}") braceDepth = Math.max(0, braceDepth - 1);

    if (
      character === delimiter &&
      parenDepth === 0 &&
      squareDepth === 0 &&
      braceDepth === 0
    ) {
      result.push(current);
      current = "";
    } else current += character;
  }

  result.push(current);
  return result;
}

function extractTrailingSettings(
  source: string,
  requireWhitespace = true,
): { base: string; settings?: string } {
  const trimmed = source.trim();
  let quote: string | null = null;
  let parenDepth = 0;
  let open = -1;
  let depth = 0;
  let candidate: { open: number; close: number } | null = null;

  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) {
        if (trimmed[index + 1] === quote && quote !== "`") index += 1;
        else quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === "`") quote = character;
    else if (character === "(") parenDepth += 1;
    else if (character === ")") parenDepth = Math.max(0, parenDepth - 1);
    else if (character === "[" && parenDepth === 0) {
      if (depth === 0) open = index;
      depth += 1;
    } else if (character === "]" && parenDepth === 0 && depth > 0) {
      depth -= 1;
      if (depth === 0 && open >= 0) candidate = { open, close: index };
    }
  }

  if (!candidate || trimmed.slice(candidate.close + 1).trim() !== "") return { base: trimmed };
  if (requireWhitespace && candidate.open > 0 && !/\s/.test(trimmed[candidate.open - 1])) {
    return { base: trimmed };
  }

  return {
    base: trimmed.slice(0, candidate.open).trim(),
    settings: trimmed.slice(candidate.open + 1, candidate.close),
  };
}

function findRelationOperator(
  source: string,
): { operator: DbmlRelationOperator; index: number } | null {
  let quote: string | null = null;
  let parenDepth = 0;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") quote = character;
    else if (character === "(") parenDepth += 1;
    else if (character === ")") parenDepth = Math.max(0, parenDepth - 1);
    else if (parenDepth === 0) {
      const pair = source.slice(index, index + 2);
      if (pair === "<>") return { operator: "<>", index };
      if (character === ">" || character === "<" || character === "-") {
        return { operator: character, index };
      }
    }
  }
  return null;
}

function findOutside(source: string, target: string): number {
  let quote: string | null = null;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = null;
    } else if (character === "'" || character === '"' || character === "`") quote = character;
    else if (character === target) return index;
  }
  return -1;
}

function findKeyword(source: string, keyword: string): number {
  let quote: string | null = null;
  for (let index = 0; index <= source.length - keyword.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    const candidate = source.slice(index, index + keyword.length);
    const before = source[index - 1];
    const after = source[index + keyword.length];
    if (
      candidate.toLowerCase() === keyword.toLowerCase() &&
      (!before || /\s/.test(before)) &&
      (!after || /\s/.test(after))
    ) return index;
  }
  return -1;
}

function takeIdentifier(source: string): { value: string; rest: string } | null {
  const trimmed = source.trim();
  if (!trimmed) return null;
  const first = trimmed[0];

  if (first === '"' || first === "`") {
    for (let index = 1; index < trimmed.length; index += 1) {
      if (trimmed[index] === "\\") index += 1;
      else if (trimmed[index] === first) {
        if (trimmed[index + 1] === first) index += 1;
        else return { value: trimmed.slice(0, index + 1), rest: trimmed.slice(index + 1) };
      }
    }
    return null;
  }

  const match = /^([^\s]+)/.exec(trimmed);
  return match ? { value: match[1], rest: trimmed.slice(match[1].length) } : null;
}

function splitIdentifierPath(source: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: string | null = null;
  const trimmed = source.trim();

  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index];
    if (quote) {
      current += character;
      if (character === "\\" && trimmed[index + 1] !== undefined) {
        current += trimmed[index + 1];
        index += 1;
      } else if (character === quote) {
        if (trimmed[index + 1] === quote) {
          current += trimmed[index + 1];
          index += 1;
        } else quote = null;
      }
    } else if (character === '"' || character === "`") {
      quote = character;
      current += character;
    } else if (character === ".") {
      if (current.trim()) parts.push(normalizeIdentifier(current));
      current = "";
    } else current += character;
  }

  if (current.trim()) parts.push(normalizeIdentifier(current));
  return parts;
}

function tokenizeIdentifierList(source: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: string | null = null;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      current += character;
      if (character === "\\" && source[index + 1] !== undefined) {
        current += source[index + 1];
        index += 1;
      } else if (character === quote) {
        if (source[index + 1] === quote) {
          current += source[index + 1];
          index += 1;
        } else quote = null;
      }
    } else if (character === '"' || character === "`") {
      quote = character;
      current += character;
    } else if (/\s|,/.test(character)) {
      if (current.trim()) tokens.push(normalizeIdentifierPath(current));
      current = "";
    } else current += character;
  }

  if (current.trim()) tokens.push(normalizeIdentifierPath(current));
  return tokens.filter(Boolean);
}

function normalizeIdentifierPath(source: string): string {
  return splitIdentifierPath(source).join(".");
}

function normalizeIdentifier(source: string): string {
  const value = source.trim();
  if (value.length >= 2) {
    const quote = value[0];
    if ((quote === '"' || quote === "`") && value.at(-1) === quote) {
      const inner = value.slice(1, -1);
      return inner.replaceAll(`${quote}${quote}`, quote).replaceAll(`\\${quote}`, quote);
    }
  }
  return value;
}

function unquoteValue(source: string): string {
  const value = source.trim();
  if (value.length >= 2) {
    const quote = value[0];
    if ((quote === "'" || quote === '"' || quote === "`") && value.at(-1) === quote) {
      return value
        .slice(1, -1)
        .replaceAll(`${quote}${quote}`, quote)
        .replaceAll(`\\${quote}`, quote)
        .replaceAll("\\\\", "\\");
    }
  }
  return value;
}

function settingValue(setting: string): string {
  const colon = findOutside(setting, ":");
  return colon >= 0 ? setting.slice(colon + 1).trim() : "";
}

function serializeRelationEndpoint(
  tableId: string,
  fieldId: string,
  fallbackTable: string,
  fallbackField: string,
  tablesById: Map<string, DbmlTable>,
): string {
  const table = tablesById.get(tableId);
  if (!table) return `${formatIdentifierPath(fallbackTable)}.${formatIdentifier(fallbackField)}`;
  const field = table.fields.find((candidate) => candidate.id === fieldId);
  return `${formatTable(table)}.${formatIdentifier(field?.name ?? fallbackField)}`;
}

function formatTable(table: DbmlTable): string {
  return table.schema
    ? `${formatIdentifierPath(table.schema)}.${formatIdentifier(table.name)}`
    : formatIdentifier(table.name);
}

function formatIdentifierPath(path: string): string {
  return splitIdentifierPath(path).map(formatIdentifier).join(".");
}

function formatIdentifier(identifier: string): string {
  const value = normalizeIdentifier(identifier);
  if (IDENTIFIER.test(value) && !RESERVED_IDENTIFIERS.has(value.toLowerCase())) return value;
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteValue(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

function qualifiedTableName(table: DbmlTable): string {
  return table.schema ? `${table.schema}.${table.name}` : table.name;
}

function hasOuterParens(source: string): boolean {
  if (!source.startsWith("(") || !source.endsWith(")")) return false;
  let depth = 0;
  let quote: string | null = null;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = null;
    } else if (character === "'" || character === '"' || character === "`") quote = character;
    else if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0 && index < source.length - 1) return false;
    }
  }
  return depth === 0;
}

function collectLineStarts(source: string): number[] {
  const lineStarts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") lineStarts.push(index + 1);
  }
  return lineStarts;
}

function lineNumberAt(lineStarts: readonly number[], index: number): number {
  let lower = 0;
  let upper = lineStarts.length;

  while (lower < upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    if (lineStarts[middle] <= index) lower = middle + 1;
    else upper = middle;
  }

  return lower;
}

function readWordEnd(source: string, start: number): number {
  let index = start + 1;
  while (index < source.length && /[A-Za-z0-9_$]/.test(source[index])) index += 1;
  return index;
}

function isDeclarationStart(source: string, index: number): boolean {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const character = source[cursor];
    if (character === "\n" || character === "\r" || character === ";") return true;
    if (!/\s/.test(character)) return character === "}";
  }
  return true;
}

function isWordStart(character: string | undefined): boolean {
  return Boolean(character && /[A-Za-z_]/.test(character));
}

function canonical(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function slug(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function optionalArray<T>(items: T[]): T[] | undefined {
  return items.length > 0 ? items : undefined;
}

function isDefined<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

function compact(value: string): string {
  const result = value.replace(/\s+/g, " ").trim();
  return result.length > 90 ? `${result.slice(0, 87)}...` : result;
}
