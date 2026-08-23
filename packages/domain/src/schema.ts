/**
 * PII-minimized relation rows accepted at the domain package boundary.
 *
 * Effect Schema owns each decoded row boundary. Array shape is checked without
 * copying rows so per-row Schema failures retain deterministic source indexes;
 * names, emails, descriptions, and person payloads never enter the core.
 */

import { Result, Schema, SchemaAST, SchemaIssue } from "effect";

export type SchemaFailureCode =
  | "ROW_NOT_OBJECT"
  | "UNEXPECTED_FIELD"
  | "MISSING_FIELD"
  | "INVALID_INTEGER"
  | "INVALID_NULLABLE_INTEGER"
  | "INVALID_BOOLEAN"
  | "INVALID_STRING";

export class SchemaInputError extends Error {
  readonly code = "INVALID_ARRAY" as const;
  readonly file: string;

  constructor(file: string) {
    super("input file must contain a JSON array");
    this.name = "SchemaInputError";
    this.file = file;
  }
}

export interface DecodeFailure {
  readonly file: string;
  readonly index: number;
  readonly code: SchemaFailureCode;
  readonly message: string;
}

export type DecodeResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly failure: Omit<DecodeFailure, "file" | "index"> };

export interface DepartmentRow {
  readonly id: number;
}

export interface TeamRow {
  readonly id: number;
  readonly departmentId: number | null;
}

export interface TeamMembershipRow {
  readonly id: number;
  readonly userId: number;
  readonly teamId: number | null;
}

export interface GlobalContainerRow {
  readonly id: number;
}

export interface GlobalMembershipRow {
  readonly id: number;
  readonly userId: number;
  readonly boardId: number | null;
}

const BooleanFlag = Schema.Union([Schema.Boolean, Schema.Literals([0, 1])]);
const OptionalNullableInteger = Schema.optional(Schema.NullOr(Schema.Int));
const OptionalBooleanFlag = Schema.optional(BooleanFlag);

type IssueNode = {
  readonly tag: SchemaIssue.Issue["_tag"];
  readonly path: ReadonlyArray<PropertyKey>;
  readonly ast?: SchemaAST.AST;
};

const astForIssue = (
  issue: SchemaIssue.Issue,
  fallback: SchemaAST.AST | undefined,
): SchemaAST.AST | undefined => {
  switch (issue._tag) {
    case "Composite":
    case "AnyOf":
    case "Encoding":
    case "InvalidType":
    case "UnexpectedKey":
    case "OneOf":
      return issue.ast;
    default:
      return fallback;
  }
};

const collectIssueNodes = (
  issue: SchemaIssue.Issue,
  path: ReadonlyArray<PropertyKey> = [],
  nodes: IssueNode[] = [],
  astContext: SchemaAST.AST | undefined = undefined,
): ReadonlyArray<IssueNode> => {
  const ast = astForIssue(issue, astContext);
  nodes.push({ tag: issue._tag, path, ast });
  switch (issue._tag) {
    case "Pointer":
      collectIssueNodes(issue.issue, [...path, ...issue.path], nodes, ast);
      break;
    case "Composite":
    case "AnyOf":
      for (const child of issue.issues) collectIssueNodes(child, path, nodes, ast);
      break;
    case "Filter":
    case "Encoding":
      collectIssueNodes(issue.issue, path, nodes, ast);
      break;
  }
  return nodes;
};

type AstShape = {
  hasIntegerNumber: boolean;
  hasNull: boolean;
  hasBoolean: boolean;
  hasString: boolean;
};

const inspectAstShape = (ast: SchemaAST.AST, shape: AstShape, seen: Set<SchemaAST.AST>): void => {
  if (seen.has(ast)) return;
  seen.add(ast);
  switch (ast._tag) {
    case "Number":
      if (ast.checks?.some((check) => check._tag === "Filter")) shape.hasIntegerNumber = true;
      break;
    case "Null":
      shape.hasNull = true;
      break;
    case "Boolean":
      shape.hasBoolean = true;
      break;
    case "String":
      shape.hasString = true;
      break;
    case "Union":
      for (const member of ast.types) inspectAstShape(member, shape, seen);
      break;
    case "Objects":
      for (const property of ast.propertySignatures) inspectAstShape(property.type, shape, seen);
      break;
    case "Arrays":
      for (const element of ast.elements) inspectAstShape(element, shape, seen);
      for (const rest of ast.rest) inspectAstShape(rest, shape, seen);
      break;
    case "Declaration":
      for (const parameter of ast.typeParameters) inspectAstShape(parameter, shape, seen);
      break;
    case "Suspend":
      inspectAstShape(ast.thunk(), shape, seen);
      break;
  }
  if (ast.encoding !== undefined) {
    for (const link of ast.encoding) inspectAstShape(link.to, shape, seen);
  }
};

const astAtPath = (
  ast: SchemaAST.AST | undefined,
  path: ReadonlyArray<PropertyKey>,
): SchemaAST.AST | undefined => {
  let current = ast;
  for (const segment of path) {
    if (current === undefined || !SchemaAST.isObjects(current)) return undefined;
    const property = current.propertySignatures.find((candidate) => candidate.name === segment);
    if (property === undefined) return undefined;
    current = property.type;
  }
  return current;
};

const issueShape = (nodes: ReadonlyArray<IssueNode>): AstShape => {
  const shape: AstShape = {
    hasIntegerNumber: false,
    hasNull: false,
    hasBoolean: false,
    hasString: false,
  };
  const rootAst = nodes.find((node) => node.path.length === 0)?.ast;
  const fieldNode = nodes.find((node) => node.path.length > 0);
  const fieldAst =
    fieldNode === undefined
      ? undefined
      : rootAst === undefined
        ? fieldNode.ast
        : astAtPath(rootAst, fieldNode.path);
  if (fieldAst !== undefined) inspectAstShape(fieldAst, shape, new Set());
  return shape;
};

const hasIssueTag = (nodes: ReadonlyArray<IssueNode>, tag: IssueNode["tag"]): boolean =>
  nodes.some((node) => node.tag === tag);

/** Raw structural schemas. Optional legacy fields are validated and discarded. */
export const DepartmentRowSchema = Schema.Struct({
  id: Schema.Int,
  shortName: Schema.optional(Schema.String),
});

export const TeamRowSchema = Schema.Struct({
  id: Schema.Int,
  departmentId: Schema.NullOr(Schema.Int),
});

export const TeamMembershipRowSchema = Schema.Struct({
  id: Schema.Int,
  userId: Schema.Int,
  teamId: Schema.NullOr(Schema.Int),
  startSemesterId: OptionalNullableInteger,
  endSemesterId: OptionalNullableInteger,
  positionId: OptionalNullableInteger,
  isTeamLeader: OptionalBooleanFlag,
  isLeader: OptionalBooleanFlag,
  isSuspended: OptionalBooleanFlag,
  isActive: OptionalBooleanFlag,
});

export const GlobalContainerRowSchema = Schema.Struct({
  id: Schema.Int,
});

export const GlobalMembershipRowSchema = Schema.Struct({
  id: Schema.Int,
  userId: Schema.Int,
  boardId: Schema.NullOr(Schema.Int),
  startSemesterId: OptionalNullableInteger,
  endSemesterId: OptionalNullableInteger,
  positionId: OptionalNullableInteger,
  isLeader: OptionalBooleanFlag,
  isSuspended: OptionalBooleanFlag,
  isActive: OptionalBooleanFlag,
});

const safeFailureCode = (issue: SchemaIssue.Issue): SchemaFailureCode => {
  const nodes = collectIssueNodes(issue);
  if (hasIssueTag(nodes, "UnexpectedKey")) return "UNEXPECTED_FIELD";
  if (hasIssueTag(nodes, "MissingKey")) return "MISSING_FIELD";
  if (nodes.some((node) => node.path.length === 0 && node.tag === "InvalidType"))
    return "ROW_NOT_OBJECT";

  const hasTypeOrFilterFailure =
    hasIssueTag(nodes, "InvalidType") ||
    hasIssueTag(nodes, "Filter") ||
    hasIssueTag(nodes, "InvalidValue") ||
    hasIssueTag(nodes, "AnyOf");
  const shape = issueShape(nodes);
  if (hasTypeOrFilterFailure && shape.hasNull && shape.hasIntegerNumber)
    return "INVALID_NULLABLE_INTEGER";
  if (hasTypeOrFilterFailure && shape.hasBoolean) return "INVALID_BOOLEAN";
  if (hasTypeOrFilterFailure && shape.hasString) return "INVALID_STRING";
  return "INVALID_INTEGER";
};

const safeFailureMessage = (code: SchemaFailureCode): string => `schema rejected row (${code})`;

const decodeWith = <A>(
  schema: Schema.ConstraintDecoder<A, never>,
  value: unknown,
): DecodeResult<A> => {
  const decoded = Schema.decodeUnknownResult(schema, { onExcessProperty: "error" })(value);
  if (Result.isSuccess(decoded)) return { ok: true, value: decoded.success };
  const code = safeFailureCode(decoded.failure.issue);
  return { ok: false, failure: { code, message: safeFailureMessage(code) } };
};

export const decodeDepartment = (value: unknown): DecodeResult<DepartmentRow> => {
  const decoded = decodeWith(DepartmentRowSchema, value);
  return decoded.ok ? { ok: true, value: { id: decoded.value.id } } : decoded;
};

export const decodeTeam = (value: unknown): DecodeResult<TeamRow> => {
  const decoded = decodeWith(TeamRowSchema, value);
  return decoded.ok
    ? { ok: true, value: { id: decoded.value.id, departmentId: decoded.value.departmentId } }
    : decoded;
};

export const decodeTeamMembership = (value: unknown): DecodeResult<TeamMembershipRow> => {
  const decoded = decodeWith(TeamMembershipRowSchema, value);
  return decoded.ok
    ? {
        ok: true,
        value: { id: decoded.value.id, userId: decoded.value.userId, teamId: decoded.value.teamId },
      }
    : decoded;
};

export const decodeGlobalContainer = (value: unknown): DecodeResult<GlobalContainerRow> => {
  const decoded = decodeWith(GlobalContainerRowSchema, value);
  return decoded.ok ? { ok: true, value: { id: decoded.value.id } } : decoded;
};

export const decodeGlobalMembership = (value: unknown): DecodeResult<GlobalMembershipRow> => {
  const decoded = decodeWith(GlobalMembershipRowSchema, value);
  return decoded.ok
    ? {
        ok: true,
        value: {
          id: decoded.value.id,
          userId: decoded.value.userId,
          boardId: decoded.value.boardId,
        },
      }
    : decoded;
};

export const decodeRows = <A>(
  value: unknown,
  file: string,
  decoder: (value: unknown) => DecodeResult<A>,
): { readonly rows: ReadonlyArray<A>; readonly failures: ReadonlyArray<DecodeFailure> } => {
  if (!Array.isArray(value)) throw new SchemaInputError(file);
  const rowsInput: ReadonlyArray<unknown> = value;

  const rows: A[] = [];
  const failures: DecodeFailure[] = [];
  for (let index = 0; index < rowsInput.length; index += 1) {
    const decoded = decoder(rowsInput[index]);
    if (decoded.ok) {
      rows.push(decoded.value);
    } else {
      failures.push({ file, index, ...decoded.failure });
    }
  }
  return { rows, failures };
};
