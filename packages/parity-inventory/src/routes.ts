import { parseDocument, type Document } from "yaml"
import {
  canonicalJson,
  observationId,
  canonicalRouteKey,
  compareByteOrder,
  declarationId,
  normalizePath,
  normalizeScalar,
  relationId,
  rowId,
  sha256,
  sortUnique,
} from "./canonical.js"
import { addSourceReference, matchesLiteralPattern, readSourceText, sanitizeScalar, SOURCE_FAMILIES, unsafeScalarReason, type ManifestContext } from "./source-manifest.js"
import { lineCommentEnd, skipPhpTrivia } from "./php-trivia.js"
import { routePayloadContainsUnsafe, runTrustedPhpCollector, recordRuntimeObservation, type CollectorRun } from "./api.js"
import type {
  CollectorExecutables,
  InventoryEnvelope,
  InventoryLink,
  InventoryObservation,
  InventoryRow,
  LegacyRouteDetails,
  Mismatch,
  MonoRouteDetails,
  RouteParseFailure,
  RuntimeObservation,
} from "./types.js"

interface RouteDeclaration {
  readonly authority: "legacy" | "mono"
  readonly logicalPath: string
  readonly declarationKind: LegacyRouteDetails["declaration_kind"] | MonoRouteDetails["declaration_kind"]
  readonly routeOrigin?: MonoRouteDetails["route_origin"]
  readonly routeName: string | null
  readonly pathTemplate: string | null
  readonly methods: readonly string[]
  readonly controllerRef: string | null
  readonly importRef: string | null
  readonly ownerRef: string | null
  readonly lineStart: number | null
  readonly lineEnd: number | null
  readonly symbol: string | null
  readonly deprecated: boolean
  readonly imported: boolean
  readonly runtimeResolved: boolean
  readonly ordinal: number
  readonly sourceRefId: string
  readonly reasonCodes: readonly string[]
}

interface CollectedRoutes {
  readonly legacy: readonly RouteDeclaration[]
  readonly mono: readonly RouteDeclaration[]
  readonly failures: readonly RouteParseFailure[]
}

export interface RuntimeRoute {
  readonly routeName: string
  readonly pathTemplate: string
  readonly methods: readonly string[]
}

interface RuntimeRouteCollection {
  readonly routes: readonly RuntimeRoute[]
  readonly observation: RuntimeObservation
  readonly sourceRefId: string
  readonly failures: readonly RouteParseFailure[]
}

const SUPPORTED_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "CONNECT", "TRACE"])
const ROUTE_CONSOLE_PATH = "apps/server/bin/console"
const ROUTE_COMMAND = "php bin/console debug:router --format=json --env=test --no-debug"
const ROUTE_LOGICAL_COMMAND_ID = "debug:router"
const ROUTE_COLLECTOR_ARGS = [ROUTE_CONSOLE_PATH, "debug:router", "--format=json", "--env=test", "--no-debug"] as const

const runtimeRouteMethods = (value: unknown): readonly string[] | null => {
  if (value === undefined || value === null) return []
  const values = Array.isArray(value) ? value : typeof value === "string" ? [value] : null
  if (values === null) return null
  const tokens: string[] = []
  let unresolved = false
  for (const entry of values) {
    if (typeof entry !== "string") return null
    if (entry.trim().length === 0) continue
    const pieces = entry.split("|")
    if (pieces.some((piece) => piece.trim().length === 0)) return null
    for (const piece of pieces) {
      const normalized = normalizeScalar(piece)
      if (normalized === null || normalized.length === 0) return null
      const safe = sanitizeScalar(normalized, "method")
      if (safe === null) return null
      const method = safe.toUpperCase()
      if (method === "ANY") {
        unresolved = true
        continue
      }
      if (!SUPPORTED_METHODS.has(method)) return null
      tokens.push(method)
    }
  }
  return unresolved ? [] : sortUnique(tokens)
}

export const decodeRuntimeRoutePayload = (payload: unknown): readonly RuntimeRoute[] | null => {
  if (routePayloadContainsUnsafe(payload) || payload === null || typeof payload !== "object" || Array.isArray(payload)) return null
  const routes: RuntimeRoute[] = []
  for (const [rawRouteName, rawEntry] of Object.entries(payload as Record<string, unknown>)) {
    const routeName = sanitizeScalar(rawRouteName, "route_name")
    if (routeName === null || routeName.length === 0 || rawEntry === null || typeof rawEntry !== "object" || Array.isArray(rawEntry)) return null
    const pathValue = (rawEntry as Record<string, unknown>).path
    if (typeof pathValue !== "string") return null
    const safePath = sanitizeScalar(pathValue, "route_path")
    const pathTemplate = normalizePath(safePath)
    if (pathTemplate === null || pathTemplate.length === 0) return null
    const methods = runtimeRouteMethods((rawEntry as Record<string, unknown>).method)
    if (methods === null) return null
    routes.push({ routeName, pathTemplate, methods })
  }
  return routes.sort((left, right) =>
    compareByteOrder(left.routeName, right.routeName) ||
    compareByteOrder(left.pathTemplate, right.pathTemplate) ||
    compareByteOrder(canonicalJson(left.methods), canonicalJson(right.methods)),
  )
}

const decodeRuntimeRouteOutput = (text: string): { readonly routes: readonly RuntimeRoute[] | null; readonly reasonCode: string | null } => {
  let payload: unknown
  try {
    payload = JSON.parse(text) as unknown
  } catch {
    return { routes: null, reasonCode: "SOURCE_PARSE_ERROR" }
  }
  const routes = decodeRuntimeRoutePayload(payload)
  return routes === null ? { routes: null, reasonCode: "SOURCE_PARSE_ERROR" } : { routes, reasonCode: null }
}
const PATH = /(?:^|[,\s])path\s*[:=]\s*(['"])(.*?)\1/is
const NAME = /(?:^|[,\s])name\s*[:=]\s*(['"])(.*?)\1/is

const lineAt = (source: string, offset: number): number => {
  let line = 1
  for (let index = 0; index < offset; index += 1) if (source[index] === "\n") line += 1
  return line
}


const balanced = (source: string, start: number, open: string, close: string): { readonly body: string; readonly end: number } | null => {
  const closingByOpening = new Map([
    ["(", ")"],
    ["[", "]"],
    ["{", "}"],
  ])
  const stack: string[] = [close]
  let quote: string | null = null
  let comment: "line" | "block" | null = null
  let escaped = false
  for (let index = start; index < source.length; index += 1) {
    const char = source[index] ?? ""
    const next = source[index + 1] ?? ""
    if (comment === "line") {
      if (char === "\r" || char === "\n") comment = null
      continue
    }
    if (comment === "block") {
      if (char === "*" && next === "/") {
        comment = null
        index += 1
      }
      continue
    }
    if (quote !== null) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === quote) quote = null
      continue
    }
    if (char === "\"" || char === "'") {
      quote = char
      continue
    }
    if (char === "/" && next === "/") {
      comment = "line"
      index += 1
      continue
    }
    if (char === "/" && next === "*") {
      comment = "block"
      index += 1
      continue
    }
    if (char === "#") {
      comment = "line"
      continue
    }
    const nestedClose = closingByOpening.get(char)
    if (nestedClose !== undefined) {
      if (index === start) {
        if (char !== open) return null
        continue
      }
      stack.push(nestedClose)
      continue
    }
    if (char === ")" || char === "]" || char === "}") {
      if (stack.at(-1) !== char) return null
      stack.pop()
      if (stack.length === 0) return { body: source.slice(start + 1, index), end: index + 1 }
    }
  }
  return null
}

const quotedValues = (value: string): string[] => {
  const result: string[] = []
  const pattern = /(['"])((?:\\.|(?!\1).)*)\1/g
  for (const match of value.matchAll(pattern)) {
    const text = match[2]
    if (text !== undefined) result.push(text.replaceAll('\\"', '"').replaceAll("\\'", "'"))
  }
  return result
}

interface ParsedMethods {
  readonly methods: string[]
  readonly unsafe: boolean
}

const normalizeRouteMethods = (values: readonly unknown[]): ParsedMethods => {
  const methods: string[] = []
  let unsafe = false
  for (const value of values) {
    if (typeof value !== "string") {
      unsafe = true
      continue
    }
    for (const raw of value.split(",")) {
      const normalized = normalizeScalar(raw)
      if (normalized === null || normalized.length === 0) continue
      const safe = sanitizeScalar(normalized, "method")
      if (safe === null || !SUPPORTED_METHODS.has(normalized.toUpperCase())) {
        unsafe = true
        continue
      }
      methods.push(normalized.toUpperCase())
    }
  }
  return { methods: sortUnique(methods), unsafe }
}

const parseMethodBody = (body: string): ParsedMethods => {
  const values: string[] = []
  let quoted = false
  let unquoted = false
  let malformed = false
  let previousToken = false
  let index = 0
  while (index < body.length) {
    while (index < body.length && /\s/.test(body[index] ?? "")) index += 1
    if (index >= body.length) break
    if (body[index] === "/" && body[index + 1] === "*") {
      const end = body.indexOf("*/", index + 2)
      if (end < 0) {
        malformed = true
        break
      }
      index = end + 2
      continue
    }
    if ((body[index] === "/" && body[index + 1] === "/") || body[index] === "#") {
      index = lineCommentEnd(body, index + (body[index] === "#" ? 1 : 2))
      continue
    }
    if (body[index] === ",") {
      previousToken = false
      index += 1
      continue
    }
    if (previousToken) malformed = true
    const start = index
    const first = body[index]
    if (first === "'" || first === "\"") {
      quoted = true
      const quote = first
      index += 1
      let escaped = false
      let closed = false
      let token = ""
      while (index < body.length) {
        const char = body[index] ?? ""
        index += 1
        if (escaped) {
          token += char
          escaped = false
        } else if (char === "\\") {
          escaped = true
        } else if (char === quote) {
          closed = true
          break
        } else {
          token += char
        }
      }
      if (!closed || escaped) {
        malformed = true
        break
      }
      values.push(token)
    } else {
      unquoted = true
      while (index < body.length && !/[\s,]/.test(body[index] ?? "")) index += 1
      const token = body.slice(start, index)
      if (token.length === 0) malformed = true
      else values.push(token)
    }
    previousToken = true
  }
  const parsed = normalizeRouteMethods(values)
  return { methods: parsed.methods, unsafe: parsed.unsafe || malformed || (quoted && unquoted) }
}


const methodKeyValueStarts = (source: string): { readonly starts: number[]; readonly unsafe: boolean } => {
  const starts: number[] = []
  let quote: string | null = null
  let comment: "line" | "block" | null = null
  let escaped = false
  let depth = 0
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] ?? ""
    const next = source[index + 1] ?? ""
    if (comment === "line") {
      if (char === "\r" || char === "\n") comment = null
      continue
    }
    if (comment === "block") {
      if (char === "*" && next === "/") {
        comment = null
        index += 1
      }
      continue
    }
    if (quote !== null) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === quote) quote = null
      continue
    }
    if (char === "\"" || char === "'") {
      quote = char
      continue
    }
    if (char === "/" && next === "/") {
      comment = "line"
      index += 1
      continue
    }
    if (char === "/" && next === "*") {
      comment = "block"
      index += 1
      continue
    }
    if (char === "#") {
      comment = "line"
      continue
    }
    if (char === "[" || char === "{" || char === "(") {
      depth += 1
      continue
    }
    if (char === "]" || char === "}" || char === ")") {
      if (depth === 0) continue
      depth -= 1
      continue
    }
    if (depth !== 0 || source.slice(index, index + 7).toLowerCase() !== "methods") continue
    const before = source[index - 1]
    const after = source[index + 7]
    if ((before !== undefined && /[A-Za-z0-9_]/.test(before)) || (after !== undefined && /[A-Za-z0-9_]/.test(after))) continue
    const separator = skipPhpTrivia(source, index + 7)
    if (separator.malformed) return { starts: [], unsafe: true }
    let cursor = separator.cursor
    if (source[cursor] !== ":" && source[cursor] !== "=") continue
    cursor += 1
    const value = skipPhpTrivia(source, cursor)
    if (value.malformed) return { starts: [], unsafe: true }
    starts.push(value.cursor)
    index = value.cursor - 1
  }
  return { starts, unsafe: quote !== null || comment === "block" }
}

const parseMethods = (value: string): ParsedMethods => {
  const parsedStarts = methodKeyValueStarts(value)
  if (parsedStarts.unsafe) return { methods: [], unsafe: true }
  const starts = parsedStarts.starts
  if (starts.length === 0) return { methods: [], unsafe: false }
  if (starts.length !== 1) return { methods: [], unsafe: true }
  const start = starts[0]
  if (start === undefined || start >= value.length) return { methods: [], unsafe: true }
  const opener = value[start]
  if (opener === "[" || opener === "{") {
    const parsed = balanced(value, start, opener, opener === "[" ? "]" : "}")
    if (parsed === null) return { methods: [], unsafe: true }
    const trailing = value.slice(parsed.end).trim()
    const result = parseMethodBody(parsed.body)
    return { methods: result.methods, unsafe: result.unsafe || (trailing.length > 0 && !trailing.startsWith(",")) }
  }
  return parseMethodBody(value.slice(start))
}
interface ParsedScalar {
  readonly value: string | null
  readonly present: boolean
  readonly unsafe: boolean
}

const routeScalarContext = (fieldName: string): string => {
  if (fieldName === "path") return "route_path"
  if (fieldName === "name") return "route_name"
  if (fieldName === "_controller" || fieldName === "controller") return "controller"
  return fieldName
}

const parsedScalar = (value: string | null, fieldName: string): ParsedScalar => {
  const normalized = normalizeScalar(value)
  if (normalized === null) return { value: null, present: value !== null, unsafe: false }
  const context = routeScalarContext(fieldName)
  return { value: sanitizeScalar(normalized, context), present: true, unsafe: unsafeScalarReason(normalized, context) !== null }
}

const parseNamed = (value: string, expression: RegExp, fieldName: string): ParsedScalar => {
  const match = value.match(expression)
  return parsedScalar(match?.[2] ?? null, fieldName)
}

interface ParsedRoutePayload {
  readonly path: string | null
  readonly name: string | null
  readonly methods: string[]
  readonly reasonCodes: readonly string[]
}

const normalizePhpDocContinuationTrivia = (value: string): string => {
  let normalized = ""
  let quote: string | null = null
  let escaped = false
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? ""
    if (quote !== null) {
      normalized += character
      if (escaped) escaped = false
      else if (character === "\\") escaped = true
      else if (character === quote) quote = null
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      normalized += character
      continue
    }
    if (character === "\r" || character === "\n") {
      normalized += character
      if (character === "\r" && value[index + 1] === "\n") {
        normalized += "\n"
        index += 1
      }
      let cursor = index + 1
      while (cursor < value.length && (value[cursor] === " " || value[cursor] === "\t")) cursor += 1
      if (value[cursor] === "*") {
        index = cursor
        if (value[index + 1] === " " || value[index + 1] === "\t") index += 1
      }
      continue
    }
    normalized += character
  }
  return normalized
}

const parseRoutePayload = (payload: string, positionalPath = true): ParsedRoutePayload => {
  const namedPath = parseNamed(payload, PATH, "path")
  const first = positionalPath ? quotedValues(payload)[0] ?? null : null
  const positional = parsedScalar(first, "path")
  const selectedPath = namedPath.present ? namedPath : positional
  const name = parseNamed(payload, NAME, "name")
  const parsedMethods = parseMethods(payload)
  const unsafe = selectedPath.unsafe || name.unsafe || parsedMethods.unsafe
  return {
    path: normalizePath(selectedPath.value),
    name: name.value,
    methods: parsedMethods.methods,
    reasonCodes: unsafe ? ["UNSAFE_SOURCE"] : [],
  }
}

const namespaceOf = (source: string): string => normalizeScalar(source.match(/namespace\s+([^;]+);/i)?.[1] ?? null) ?? ""

const classBefore = (source: string, offset: number): string | null => {
  let result: string | null = null
  const prefix = source.slice(0, offset)
  for (const match of prefix.matchAll(/\bclass\s+([A-Za-z_][A-Za-z0-9_]*)/g)) result = match[1] ?? result
  return result
}

const methodAfter = (source: string, offset: number): string | null => normalizeScalar(source.slice(offset).match(/\bfunction\s+&?\s*([A-Za-z_][A-Za-z0-9_]*)/i)?.[1] ?? null)

const ownerRef = (source: string, offset: number, end: number): string | null => {
  const className = classBefore(source, offset)
  if (className === null) return null
  const method = methodAfter(source, end)
  const namespace = namespaceOf(source)
  const qualifiedClass = namespace.length > 0 ? `${namespace}\\${className}` : className
  return method === null ? qualifiedClass : `${qualifiedClass}::${method}`
}

const phpSourceRef = (
  context: ManifestContext,
  authority: "legacy" | "mono",
  logicalPath: string,
  lineStart: number,
  lineEnd: number,
  symbol: string | null,
  role: string,
): string => addSourceReference(context, {
  authorityLine: authority,
  authorityRole: role,
  rootRef: authority,
  path: logicalPath,
  lineStart,
  lineEnd,
  symbol,
})

const yamlSourceRef = (context: ManifestContext, authority: "legacy" | "mono", path: string, lineStart: number, lineEnd: number): string => addSourceReference(context, {
  authorityLine: authority,
  authorityRole: authority === "legacy" ? "legacy_route_authority" : "mono_route_authority",
  rootRef: authority,
  path,
  lineStart,
  lineEnd,
  symbol: null,
})

const sourceForFailure = (context: ManifestContext, authority: "legacy" | "mono", path: string, role: string, status: RouteParseFailure["status"] = "unresolved", reasonCode = "SOURCE_PARSE_ERROR"): string => addSourceReference(context, {
  authorityLine: authority,
  authorityRole: role,
  rootRef: authority,
  path,
  lineStart: null,
  lineEnd: null,
  symbol: null,
  failureStatus: status,
  failureReason: reasonCode,
})
const runtimeRouteSourceRef = (context: ManifestContext): string => {
  const consoleFile = context.scans.mono.files.find((file) => file.path === ROUTE_CONSOLE_PATH)
  return consoleFile?.availability === "available"
    ? addSourceReference(context, { authorityLine: "mono", authorityRole: "mono_route_runtime_observation", rootRef: "mono", path: ROUTE_CONSOLE_PATH, lineStart: null, lineEnd: null, symbol: null, captureMode: "runtime" })
    : sourceForFailure(context, "mono", ROUTE_CONSOLE_PATH, "mono_route_runtime_observation", "source_unavailable", "SOURCE_UNAVAILABLE")
}

const collectRuntimeRoutes = (context: ManifestContext, configured?: CollectorExecutables): RuntimeRouteCollection => {
  const revisionRefId = context.scans.mono.revisionRefId
  const sourceRefId = runtimeRouteSourceRef(context)
  const consoleFile = context.scans.mono.files.find((file) => file.path === ROUTE_CONSOLE_PATH)
  const unavailable = (reason: string, run?: CollectorRun): RuntimeRouteCollection => {
    const reasonBytes = new TextEncoder().encode(reason)
    const observation = recordRuntimeObservation(context, {
      collectorKind: "route_collector",
      logicalCommandId: ROUTE_LOGICAL_COMMAND_ID,
      command: ROUTE_COMMAND,
      arguments: ROUTE_COLLECTOR_ARGS,
      stdout: run?.stdoutBytes ?? reasonBytes,
      stderr: run?.stderrBytes ?? reasonBytes,
      exitCode: run?.exitCode ?? 127,
      result: null,
      availability: "unavailable",
      revisionRefId,
      executableDigests: run?.executableDigests,
      executableProvenance: run?.executableProvenance,
    })
    const sourceStatus: RouteParseFailure["status"] = ["UNSAFE_SOURCE", "NON_UTF8_OUTPUT", "SOURCE_PARSE_ERROR"].includes(reason) ? "source_unavailable" : "unresolved"
    return { routes: [], observation, sourceRefId, failures: [{ source_ref_id: sourceRefId, reason_code: reason, status: sourceStatus }] }
  }
  if (consoleFile === undefined || consoleFile.availability !== "available") return unavailable("RUNTIME_UNAVAILABLE")
  const run = runTrustedPhpCollector(context, ROUTE_COLLECTOR_ARGS, configured, "route")
  if (run.availability !== "available") return unavailable(run.reason ?? "RUNTIME_UNAVAILABLE", run)
  const decoded = decodeRuntimeRouteOutput(run.stdout)
  if (decoded.routes === null) {
    const observation = recordRuntimeObservation(context, {
      collectorKind: "route_collector",
      logicalCommandId: ROUTE_LOGICAL_COMMAND_ID,
      command: ROUTE_COMMAND,
      arguments: ROUTE_COLLECTOR_ARGS,
      stdout: run.stdoutBytes,
      stderr: run.stderrBytes,
      exitCode: run.exitCode,
      result: null,
      availability: "unavailable",
      revisionRefId,
      executableDigests: run.executableDigests,
      executableProvenance: run.executableProvenance,
    })
    return { routes: [], observation, sourceRefId, failures: [{ source_ref_id: sourceRefId, reason_code: decoded.reasonCode ?? "SOURCE_PARSE_ERROR", status: "source_unavailable" }] }
  }
  const observation = recordRuntimeObservation(context, {
    collectorKind: "route_collector",
    logicalCommandId: ROUTE_LOGICAL_COMMAND_ID,
    command: ROUTE_COMMAND,
    arguments: ROUTE_COLLECTOR_ARGS,
    stdout: run.stdoutBytes,
    stderr: run.stderrBytes,
    exitCode: run.exitCode,
    result: decoded.routes,
    availability: "available",
    revisionRefId,
    executableDigests: run.executableDigests,
    executableProvenance: run.executableProvenance,
  })
  return { routes: decoded.routes, observation, sourceRefId, failures: [] }
}
const makeImportedPrefixes = (declarations: readonly RouteDeclaration[]): string[] => sortUnique(declarations.map((declaration) => declaration.importRef).filter((value): value is string => value !== null))

const sourceFamilyPatterns = (authority: "legacy" | "mono", familyId: string): readonly string[] =>
  SOURCE_FAMILIES.find((family) => family.authority_line === authority && family.family_id === familyId)?.patterns ?? []

const filesMatchingFamily = (context: ManifestContext, authority: "legacy" | "mono", familyId: string, extension: RegExp): readonly { readonly path: string; readonly availability: "available" | "unavailable" }[] =>
  context.scans[authority].files.filter((file) => file.availability === "available" && extension.test(file.path) && sourceFamilyPatterns(authority, familyId).some((pattern) => matchesLiteralPattern(file.path, pattern))).sort((a, b) => compareByteOrder(a.path, b.path))
const importedController = (authority: "legacy" | "mono", path: string, prefixes: readonly string[]): boolean => {
  if (authority === "legacy") return prefixes.some((prefix) => prefix.includes("AppBundle/Controller") && path.startsWith("src/AppBundle/Controller/"))
  return prefixes.some((prefix) => {
    let normalized = prefix.replace(/^\.\.\//, "")
    if (normalized.startsWith("src/")) normalized = `apps/server/${normalized}`
    return normalized.includes("src/App/") && normalized.includes("/Controller") && path.startsWith(normalized.replace(/\/$/, "") + "/")
  })
}

const objectValue = (value: unknown, key: string): unknown => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
  return (value as Record<string, unknown>)[key]
}

const stringValue = (value: unknown, key: string): ParsedScalar => {
  const found = objectValue(value, key)
  return parsedScalar(typeof found === "string" ? found : null, key)
}

const methodsValue = (value: unknown): ParsedMethods => {
  const methods = objectValue(value, "methods")
  if (Array.isArray(methods)) return normalizeRouteMethods(methods)
  if (typeof methods === "string") return normalizeRouteMethods([methods])
  if (methods === undefined || methods === null) return { methods: [], unsafe: false }
  return { methods: [], unsafe: true }
}

const controllerValue = (value: unknown): ParsedScalar => {
  const defaults = objectValue(value, "defaults")
  const fromDefaults = stringValue(defaults, "_controller")
  return fromDefaults.present ? fromDefaults : stringValue(value, "controller")
}
const unsafeRoutePayload = (value: unknown, fieldName = "field"): boolean => {
  if (typeof value === "string") return unsafeScalarReason(value, fieldName) !== null
  if (Array.isArray(value)) return value.some((entry) => unsafeRoutePayload(entry, fieldName))
  if (value !== null && typeof value === "object") return Object.entries(value).some(([key, entry]) => unsafeRoutePayload(entry, key))
  return false
}

const routeReasonCodes = (route: Pick<RouteDeclaration, "pathTemplate" | "methods" | "routeName" | "reasonCodes">): string[] => {
  const reasons = [...route.reasonCodes]
  if (route.pathTemplate === null) reasons.push("SOURCE_PARSE_ERROR")
  if (route.methods.length === 0) reasons.push("METHOD_UNRESOLVED")
  if (route.routeName === null) reasons.push("SOURCE_PARSE_ERROR")
  return sortUnique(reasons)
}
const parseYamlRoutes = (
  context: ManifestContext,
  authority: "legacy" | "mono",
  path: string,
  text: string,
): { readonly declarations: RouteDeclaration[]; readonly failures: RouteParseFailure[] } => {
  const declarations: RouteDeclaration[] = []
  const failures: RouteParseFailure[] = []
  const role = authority === "legacy" ? "legacy_route_authority" : "mono_route_authority"
  let document: Document.Parsed
  try {
    document = parseDocument(text, { prettyErrors: false })
    if (document.errors.some((error) => error.code !== "DUPLICATE_KEY")) throw new Error("yaml document errors")
  } catch {
    const sourceRefId = sourceForFailure(context, authority, path, role)
    failures.push({ source_ref_id: sourceRefId, reason_code: "SOURCE_PARSE_ERROR", status: "unresolved" })
    return { declarations, failures }
  }
  const contents = document.contents
  const items = contents !== null && typeof contents === "object" && "items" in contents && Array.isArray(contents.items) ? contents.items : []
  const nodeValue = (node: unknown): unknown => {
    if (node !== null && typeof node === "object" && "toJSON" in node && typeof node.toJSON === "function") return node.toJSON()
    return node
  }
  const entries: Array<readonly [string, unknown]> = []
  for (const item of items) {
    if (item === null || typeof item !== "object" || !("key" in item) || !("value" in item)) continue
    const routeName = nodeValue(item.key)
    if (typeof routeName !== "string") continue
    entries.push([routeName, nodeValue(item.value)])
  }
  if (entries.length === 0) return { declarations, failures }
  const nextStart = new Map<string, number>()
  entries.forEach(([routeName, value], index) => {
    const offset = nextStart.get(routeName) ?? 0
    const start = text.indexOf(`${routeName}:`, offset)
    if (start >= 0) nextStart.set(routeName, start + routeName.length + 1)
    const lineStart = start < 0 ? null : lineAt(text, start)
    const lineEnd = lineStart
    const resource = stringValue(value, "resource")
    const pathValue = stringValue(value, "path")
    const methods = methodsValue(value)
    const controllerRef = controllerValue(value)
    const typeValue = stringValue(value, "type")
    const payloadUnsafe = unsafeRoutePayload(value)
    const routeNameValue = parsedScalar(routeName, "route_name")
    const vendor = resource.value?.startsWith("@") === true
    const apiPlatform = typeValue.value === "api_platform"
    const pathTemplate = normalizePath(pathValue.value)
    const declarationKind: RouteDeclaration["declarationKind"] = resource.value !== null && pathTemplate === null ? (vendor ? "vendor_route" : "imported_route") : authority === "legacy" ? "yaml_route_block" : apiPlatform ? "api_platform" : "imported_route"
    const routeOrigin = authority === "mono" ? (vendor ? "vendor" : apiPlatform ? "api_platform" : resource.value !== null ? "imported" : "imported") : undefined
    const line = lineStart ?? 1
    const sourceRefId = yamlSourceRef(context, authority, path, line, lineEnd ?? line)
    declarations.push({
      authority,
      logicalPath: path,
      declarationKind,
      routeOrigin,
      routeName: routeNameValue.value,
      pathTemplate,
      methods: methods.methods,
      importRef: resource.value,
      controllerRef: controllerRef.value,
      ownerRef: controllerRef.value,
      lineStart,
      lineEnd,
      symbol: routeNameValue.value,
      deprecated: false,
      imported: resource.value !== null || declarationKind === "yaml_route_block",
      runtimeResolved: false,
      ordinal: index + 1,
      sourceRefId,
      reasonCodes: routeReasonCodes({ pathTemplate, methods: methods.methods, routeName: routeNameValue.value, reasonCodes: payloadUnsafe || resource.unsafe || pathValue.unsafe || methods.unsafe || typeValue.unsafe || controllerRef.unsafe || routeNameValue.unsafe ? ["UNSAFE_SOURCE"] : [] }),
    })
  })
  return { declarations, failures }
}

const parseLegacyAnnotations = (context: ManifestContext, path: string, text: string): { readonly declarations: RouteDeclaration[]; readonly failures: RouteParseFailure[] } => {
  const declarations: RouteDeclaration[] = []
  const failures: RouteParseFailure[] = []
  let ordinal = 0
  let cursor = 0
  while (cursor < text.length) {
    const marker = text.indexOf("@Route", cursor)
    if (marker < 0) break
    const open = text.indexOf("(", marker + 6)
    if (open < 0) {
      cursor = marker + 6
      continue
    }
    const parsed = balanced(text, open, "(", ")")
    if (parsed === null) {
      const line = lineAt(text, marker)
      const sourceRefId = phpSourceRef(context, "legacy", path, line, line, null, "legacy_route_authority")
      failures.push({ source_ref_id: sourceRefId, reason_code: "SOURCE_PARSE_ERROR", status: "unresolved" })
      break
    }
    ordinal += 1
    const route = parseRoutePayload(normalizePhpDocContinuationTrivia(parsed.body))
    const lineStart = lineAt(text, marker)
    const lineEnd = lineAt(text, parsed.end)
    const rawOwner = ownerRef(text, marker, parsed.end)
    const ownerUnsafe = rawOwner !== null && unsafeScalarReason(rawOwner, "owner") !== null
    const owner = ownerUnsafe ? null : rawOwner
    const sourceRefId = phpSourceRef(context, "legacy", path, lineStart, lineEnd, ownerUnsafe ? "unsafe-source-redacted" : rawOwner, "legacy_route_authority")
    declarations.push({
      authority: "legacy",
      logicalPath: path,
      declarationKind: "controller_annotation",
      routeName: route.name,
      pathTemplate: route.path,
      methods: route.methods,
      controllerRef: owner,
      importRef: null,
      ownerRef: owner,
      lineStart,
      lineEnd,
      symbol: owner,
      deprecated: /@deprecated\b/i.test(text.slice(Math.max(0, marker - 120), parsed.end)),
      imported: false,
      runtimeResolved: false,
      ordinal,
      sourceRefId,
      reasonCodes: routeReasonCodes({ pathTemplate: route.path, methods: route.methods, routeName: route.name, reasonCodes: ownerUnsafe ? [...route.reasonCodes, "UNSAFE_SOURCE"] : route.reasonCodes }),
    })
    cursor = parsed.end
  }
  return { declarations, failures }
}

const parseAttributePayload = (payload: string, attributeName: string): { readonly path: string | null; readonly name: string | null; readonly methods: string[]; readonly reasonCodes: readonly string[]; readonly routeOrigin: MonoRouteDetails["route_origin"]; readonly declarationKind: MonoRouteDetails["declaration_kind"] } => {
  const route = parseRoutePayload(payload)
  const upper = attributeName.toUpperCase()
  const methodByAttribute: Record<string, string> = { GET: "GET", POST: "POST", PUT: "PUT", PATCH: "PATCH", DELETE: "DELETE", HEAD: "HEAD", OPTIONS: "OPTIONS", TRACE: "TRACE" }
  const method = methodByAttribute[upper]
  const methods = method === undefined ? route.methods : [method]
  const isApi = attributeName !== "Route" && method !== undefined
  return { path: route.path, name: route.name, methods, reasonCodes: route.reasonCodes, routeOrigin: isApi ? "api_platform" : "controller", declarationKind: isApi ? "api_platform" : "controller_attribute" }
}
const parseMonoAttributes = (context: ManifestContext, path: string, text: string): { readonly declarations: RouteDeclaration[]; readonly failures: RouteParseFailure[] } => {
  const declarations: RouteDeclaration[] = []
  const failures: RouteParseFailure[] = []
  const pattern = /#\[\s*(Route|Get|Post|Put|Patch|Delete|Head|Options|Trace)\s*/g
  let match: RegExpExecArray | null
  let ordinal = 0
  while ((match = pattern.exec(text)) !== null) {
    const name = match[1] ?? "Route"
    const open = text.indexOf("(", match.index + match[0].length)
    const hasPayload = open >= 0 && open < text.indexOf("]", match.index + match[0].length)
    const parsed = hasPayload ? balanced(text, open, "(", ")") : { body: "", end: match.index + match[0].length }
    if (parsed === null) {
      const line = lineAt(text, match.index)
      const sourceRefId = phpSourceRef(context, "mono", path, line, line, null, "mono_route_authority")
      failures.push({ source_ref_id: sourceRefId, reason_code: "SOURCE_PARSE_ERROR", status: "unresolved" })
      continue
    }
    ordinal += 1
    const route = parseAttributePayload(parsed.body, name)
    const lineStart = lineAt(text, match.index)
    const lineEnd = lineAt(text, parsed.end)
    const rawOwner = ownerRef(text, match.index, parsed.end)
    const ownerUnsafe = rawOwner !== null && unsafeScalarReason(rawOwner, "owner") !== null
    const owner = ownerUnsafe ? null : rawOwner
    const sourceRefId = phpSourceRef(context, "mono", path, lineStart, lineEnd, ownerUnsafe ? "unsafe-source-redacted" : rawOwner, "mono_route_authority")
    declarations.push({
      authority: "mono",
      logicalPath: path,
      declarationKind: route.declarationKind,
      routeOrigin: route.routeOrigin,
      routeName: route.name,
      pathTemplate: route.path,
      methods: route.methods,
      controllerRef: null,
      importRef: null,
      ownerRef: owner,
      lineStart,
      lineEnd,
      symbol: owner,
      deprecated: false,
      imported: false,
      runtimeResolved: false,
      ordinal,
      sourceRefId,
      reasonCodes: routeReasonCodes({ pathTemplate: route.path, methods: route.methods, routeName: route.name, reasonCodes: ownerUnsafe ? [...route.reasonCodes, "UNSAFE_SOURCE"] : route.reasonCodes }),
    })
    pattern.lastIndex = Math.max(pattern.lastIndex, parsed.end)
  }
  return { declarations, failures }
}

const parseLegacy = (context: ManifestContext): { readonly declarations: RouteDeclaration[]; readonly failures: RouteParseFailure[] } => {
  const declarations: RouteDeclaration[] = []
  const failures: RouteParseFailure[] = []
  const yamlFiles = context.scans.legacy.files.filter((file) => file.availability === "available" && /^app\/config\/routing.*\.ya?ml$/.test(file.path)).sort((a, b) => compareByteOrder(a.path, b.path))
  for (const file of yamlFiles) {
    const text = readSourceText(context, "legacy", file.path)
    if (text === null) {
      failures.push({ source_ref_id: sourceForFailure(context, "legacy", file.path, "legacy_route_authority"), reason_code: "SOURCE_UNAVAILABLE", status: "source_unavailable" })
      continue
    }
    const parsed = parseYamlRoutes(context, "legacy", file.path, text)
    declarations.push(...parsed.declarations)
    failures.push(...parsed.failures)
  }
  const controllerFiles = filesMatchingFamily(context, "legacy", "legacy_routes", /\.php$/)
  for (const file of controllerFiles) {
    const text = readSourceText(context, "legacy", file.path)
    if (text === null) {
      failures.push({ source_ref_id: sourceForFailure(context, "legacy", file.path, "legacy_route_authority"), reason_code: "SOURCE_UNAVAILABLE", status: "source_unavailable" })
      continue
    }
    const parsed = parseLegacyAnnotations(context, file.path, text)
    declarations.push(...parsed.declarations)
    failures.push(...parsed.failures)
  }
  const imports = makeImportedPrefixes(declarations)
  return { declarations: declarations.map((declaration) => declaration.declarationKind === "controller_annotation" ? { ...declaration, imported: importedController("legacy", declaration.logicalPath, imports), reasonCodes: importedController("legacy", declaration.logicalPath, imports) ? declaration.reasonCodes : sortUnique([...declaration.reasonCodes, "DEAD_UNIMPORTED_SOURCE"]) } : declaration), failures }
}

const parseMono = (context: ManifestContext): { readonly declarations: RouteDeclaration[]; readonly failures: RouteParseFailure[] } => {
  const declarations: RouteDeclaration[] = []
  const failures: RouteParseFailure[] = []
  const yaml = context.scans.mono.files.find((file) => file.path === "apps/server/config/routes.yaml" && file.availability === "available")
  if (yaml !== undefined) {
    const text = readSourceText(context, "mono", yaml.path)
    if (text !== null) {
      const parsed = parseYamlRoutes(context, "mono", yaml.path, text)
      declarations.push(...parsed.declarations)
      failures.push(...parsed.failures)
    }
  }
  const controllerFiles = filesMatchingFamily(context, "mono", "mono_routes", /\.php$/)
  for (const file of controllerFiles) {
    const text = readSourceText(context, "mono", file.path)
    if (text === null) {
      failures.push({ source_ref_id: sourceForFailure(context, "mono", file.path, "mono_route_authority"), reason_code: "SOURCE_UNAVAILABLE", status: "source_unavailable" })
      continue
    }
    const parsed = parseMonoAttributes(context, file.path, text)
    declarations.push(...parsed.declarations)
    failures.push(...parsed.failures)
  }
  const imports = declarations.filter((declaration) => declaration.importRef !== null)
  return { declarations: declarations.map((declaration) => declaration.declarationKind === "controller_attribute" || declaration.declarationKind === "api_platform" ? { ...declaration, imported: importedController("mono", declaration.logicalPath, imports.map((entry) => entry.importRef).filter((value): value is string => value !== null)), reasonCodes: importedController("mono", declaration.logicalPath, imports.map((entry) => entry.importRef).filter((value): value is string => value !== null)) ? declaration.reasonCodes : sortUnique([...declaration.reasonCodes, "DEAD_UNIMPORTED_SOURCE"]) } : declaration), failures }
}

const rowMismatch = (kind: Mismatch["kind"], counterpartRowIds: readonly string[], reason: string | null): Mismatch => ({ kind, disposition: "none", accepted_intent_ref_ids: [], counterpart_row_ids: sortUnique(counterpartRowIds), reason })

const makeRows = (
  context: ManifestContext,
  declarations: readonly RouteDeclaration[],
  authority: "legacy" | "mono",
  runtimeObservation: RuntimeObservation | null = null,
): InventoryRow[] => {
  const inventoryKind = authority === "legacy" ? "legacy_route" : "mono_route"
  const rows: InventoryRow[] = []
  for (const declaration of declarations) {
    const methods = declaration.methods.length > 0 ? declaration.methods : [null]
    const declarationIdentity = declarationId(authority, authority, declaration.logicalPath, declaration.declarationKind, declaration.ordinal)
    for (const method of methods) {
      const canonicalKey = canonicalRouteKey(method, declaration.pathTemplate, declaration.routeName)
      const rowIdentity = rowId(inventoryKind, declarationIdentity, canonicalKey)
      const reasonCodes = routeReasonCodes({ pathTemplate: declaration.pathTemplate, methods: declaration.methods, routeName: declaration.routeName, reasonCodes: declaration.reasonCodes })
      if (!declaration.imported && declaration.declarationKind !== "yaml_route_block" && declaration.declarationKind !== "imported_route" && declaration.declarationKind !== "vendor_route") reasonCodes.push("DEAD_UNIMPORTED_SOURCE")
      const status: InventoryRow["status"] = declaration.pathTemplate === null || declaration.methods.length === 0 ? "unresolved" : declaration.imported ? "covered" : "dead_unimported"
      const details: LegacyRouteDetails | MonoRouteDetails = authority === "legacy"
        ? { declaration_kind: declaration.declarationKind as LegacyRouteDetails["declaration_kind"], route_name: declaration.routeName, path_template: declaration.pathTemplate, method, methods_declared: declaration.methods, controller_ref: declaration.controllerRef, import_ref: declaration.importRef, deprecated: declaration.deprecated }
        : { declaration_kind: declaration.declarationKind as MonoRouteDetails["declaration_kind"], route_origin: declaration.routeOrigin ?? "imported", route_name: declaration.routeName, path_template: declaration.pathTemplate, method, owner_ref: declaration.ownerRef, runtime_resolved: declaration.runtimeResolved, imported_from_ref: declaration.importRef }
      rows.push({
        row_id: rowIdentity,
        declaration_id: declarationIdentity,
        inventory_kind: inventoryKind,
        authority_line: authority,
        canonical_key: canonicalKey,
        signature: canonicalKey,
        status,
        observation_kinds: ["static_source"],
        source_ref_ids: [declaration.sourceRefId],
        revision_ref_ids: [context.scans[authority].revisionRefId],
        mismatch: rowMismatch(status === "unresolved" ? "unresolved" : status === "dead_unimported" ? "dead_unimported" : "none", [], status === "covered" ? null : sortUnique(reasonCodes)[0] ?? null),
        runtime_observation_ref_ids: runtimeObservation === null ? [] : [runtimeObservation.runtime_observation_ref_id],
        coverage_ref_ids: [],
        accepted_intent_ref_ids: [],
        duplicate_group_id: null,
        reason_codes: sortUnique(reasonCodes),
        related_row_ids: [],
        details,
      })
    }
  }
  return rows
}

const runtimeRouteDetails = (route: RuntimeRoute, method: string | null, runtimeResolved = true): MonoRouteDetails => ({
  declaration_kind: "unknown",
  route_origin: "imported",
  route_name: route.routeName,
  path_template: route.pathTemplate,
  method,
  owner_ref: null,
  runtime_resolved: runtimeResolved,
  imported_from_ref: null,
})

const makeRuntimeRows = (revisionRefId: string, runtime: RuntimeRouteCollection): InventoryRow[] => {
  const rows: InventoryRow[] = []
  let ordinal = 0
  for (const route of runtime.routes) {
    const methods = route.methods.length > 0 ? route.methods : [null]
    for (const method of methods) {
      ordinal += 1
      const details = runtimeRouteDetails(route, method)
      const canonicalKey = canonicalRouteKey(method, route.pathTemplate, route.routeName)
      const declarationIdentity = declarationId("mono", "mono", ROUTE_CONSOLE_PATH, "runtime_route", ordinal)
      const rowIdentity = rowId("mono_route", declarationIdentity, canonicalKey)
      rows.push({
        row_id: rowIdentity,
        declaration_id: declarationIdentity,
        inventory_kind: "mono_route",
        authority_line: "mono",
        canonical_key: canonicalKey,
        status: "extra",
        observation_kinds: ["runtime_resolution"],
        source_ref_ids: [runtime.sourceRefId],
        revision_ref_ids: [revisionRefId],
        signature: canonicalKey,
        mismatch: rowMismatch("extra", [], "RUNTIME_ONLY_SOURCE"),
        runtime_observation_ref_ids: [runtime.observation.runtime_observation_ref_id],
        coverage_ref_ids: [],
        accepted_intent_ref_ids: [],
        duplicate_group_id: null,
        reason_codes: ["RUNTIME_ONLY_SOURCE"],
        related_row_ids: [],
        details,
      })
    }
  }
  return rows
}

const routeDetailsComparable = (row: InventoryRow): Pick<MonoRouteDetails, "route_name" | "path_template" | "method"> => {
  const details = row.details as MonoRouteDetails
  return { route_name: details.route_name, path_template: details.path_template, method: details.method }
}

const sameRouteObservation = (left: InventoryRow, right: InventoryRow): boolean => {
  const a = routeDetailsComparable(left)
  const b = routeDetailsComparable(right)
  return a.route_name === b.route_name && a.path_template === b.path_template && a.method === b.method
}

const routeNameMatches = (left: InventoryRow, right: InventoryRow): boolean => {
  const a = routeDetailsComparable(left)
  const b = routeDetailsComparable(right)
  return a.route_name !== null && a.route_name === b.route_name
}

const reconcileRuntimeRoutes = (
  revisionRefId: string,
  staticRows: readonly InventoryRow[],
  runtime: RuntimeRouteCollection,
): { readonly rows: InventoryRow[]; readonly links: readonly InventoryLink[] } => {
  const runtimeRows = makeRuntimeRows(revisionRefId, runtime)
  const rows: InventoryRow[] = [...staticRows, ...runtimeRows]
  const links: InventoryLink[] = []
  const runtimeUsed = new Set<number>()
  for (const staticRow of staticRows) {
    const exactIndex = runtimeRows.findIndex((candidate, index) => !runtimeUsed.has(index) && sameRouteObservation(staticRow, candidate))
    const runtimeIndex = exactIndex >= 0
      ? exactIndex
      : runtimeRows.findIndex((candidate, index) => !runtimeUsed.has(index) && routeNameMatches(staticRow, candidate))
    const staticIndex = rows.findIndex((candidate) => candidate.row_id === staticRow.row_id)
    if (runtimeIndex < 0) {
      const reason = runtime.observation.availability === "available"
        ? runtime.failures[0]?.reason_code ?? "RUNTIME_ROUTE_UNRESOLVED"
        : runtime.failures[0]?.reason_code ?? "RUNTIME_UNAVAILABLE"
      const status: InventoryRow["status"] = runtime.observation.availability === "available" && staticRow.status === "dead_unimported" ? "dead_unimported" : "unresolved"
      const mismatchKind: Mismatch["kind"] = status === "dead_unimported" ? "dead_unimported" : "unresolved"
      rows[staticIndex] = { ...staticRow, runtime_observation_ref_ids: [runtime.observation.runtime_observation_ref_id], status, mismatch: rowMismatch(mismatchKind, [], reason), reason_codes: sortUnique([...staticRow.reason_codes, reason]) }
      continue
    }
    runtimeUsed.add(runtimeIndex)
    const runtimeRow = runtimeRows[runtimeIndex]
    if (runtimeRow === undefined) continue
    const changed = !sameRouteObservation(staticRow, runtimeRow)
    const staticStatus: InventoryRow["status"] = changed
      ? "changed"
      : staticRow.status === "dead_unimported"
        ? "dead_unimported"
        : staticRow.status === "unresolved"
          ? "unresolved"
          : "covered"
    const reason = changed ? "STATIC_RUNTIME_MISMATCH" : staticStatus === "covered" ? null : staticRow.reason_codes[0] ?? null
    const related = [runtimeRow.row_id]
    const relationIdValue = relationId("reconciles", staticRow.row_id, runtimeRow.row_id, [...staticRow.source_ref_ids, ...runtimeRow.source_ref_ids])
    links.push({ relation_id: relationIdValue, relation_kind: "reconciles", from_row_id: staticRow.row_id, to_row_id: runtimeRow.row_id, source_ref_ids: sortUnique([...staticRow.source_ref_ids, ...runtimeRow.source_ref_ids]) })
    const staticDetails = staticRow.details as MonoRouteDetails
    rows[staticIndex] = {
      ...staticRow,
      status: staticStatus,
      observation_kinds: ["static_source", "runtime_resolution"],
      runtime_observation_ref_ids: [runtime.observation.runtime_observation_ref_id],
      mismatch: rowMismatch(changed ? "changed" : staticStatus === "dead_unimported" ? "dead_unimported" : staticStatus === "unresolved" ? "unresolved" : "none", related, reason),
      reason_codes: reason === null ? staticRow.reason_codes : sortUnique([...staticRow.reason_codes, reason]),
      related_row_ids: related,
      details: { ...staticDetails, runtime_resolved: true },
    }
    const runtimeIndexInRows = rows.findIndex((candidate) => candidate.row_id === runtimeRow.row_id)
    rows[runtimeIndexInRows] = { ...runtimeRow, status: changed ? "changed" : "covered", mismatch: rowMismatch(changed ? "changed" : "none", [staticRow.row_id], changed ? "STATIC_RUNTIME_MISMATCH" : null), reason_codes: changed ? ["STATIC_RUNTIME_MISMATCH"] : [], related_row_ids: [staticRow.row_id] }
  }
  return { rows, links }
}
export const reconcileRuntimeRouteRows = (
  revisionRefId: string,
  staticRows: readonly InventoryRow[],
  runtimeRoutes: readonly RuntimeRoute[],
  runtimeObservation: RuntimeObservation,
  sourceRefId: string,
  failures: readonly RouteParseFailure[] = [],
): { readonly rows: InventoryRow[]; readonly links: readonly InventoryLink[] } =>
  reconcileRuntimeRoutes(revisionRefId, staticRows, { routes: runtimeRoutes, observation: runtimeObservation, sourceRefId, failures })

const applyDuplicateGroups = (rows: InventoryRow[]): void => {
  const groups = new Map<string, InventoryRow[]>()
  for (const row of rows.filter((candidate) => candidate.observation_kinds.includes("static_source"))) {
    const key = `${row.authority_line}\u0000${row.inventory_kind}\u0000${row.canonical_key}`
    const group = groups.get(key)
    if (group === undefined) groups.set(key, [row])
    else group.push(row)
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const first = group[0]
    if (first === undefined) continue
    const duplicateGroupId = `dup-${sha256(canonicalJson({ authority_scope: first.authority_line, inventory_kind: first.inventory_kind, canonical_key: first.canonical_key })).slice(7)}`
    for (const row of group) {
      const index = rows.indexOf(row)
      rows[index] = { ...row, status: "duplicate", duplicate_group_id: duplicateGroupId, mismatch: rowMismatch("duplicate", group.filter((candidate) => candidate.row_id !== row.row_id).map((candidate) => candidate.row_id), "DUPLICATE_CANONICAL_IDENTITY"), reason_codes: sortUnique([...row.reason_codes, "DUPLICATE_CANONICAL_IDENTITY"]) }
    }
  }
}

const runtimeInventoryObservation = (runtime: RuntimeRouteCollection): InventoryObservation => ({
  observation_id: observationId("runtime_resolution", [runtime.sourceRefId], runtime.observation.result_sha256),
  observation_kind: "runtime_resolution",
  source_ref_ids: [runtime.sourceRefId],
  value_digest: runtime.observation.result_sha256,
  normative: false,
  label: "local_route_runtime",
  count: runtime.routes.length,
})

const makeEnvelope = (
  context: ManifestContext,
  authority: "legacy" | "mono",
  rows: readonly InventoryRow[],
  sourceManifestSha256: string,
  runtime: RuntimeRouteCollection | null = null,
  links: readonly InventoryLink[] = [],
): InventoryEnvelope => ({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  schema_version: "functional-parity-inventory/v1",
  inventory_kind: authority === "legacy" ? "legacy_route" : "mono_route",
  authority_line: authority,
  source_manifest_sha256: sourceManifestSha256,
  revision_ref_ids: [context.scans[authority].revisionRefId],
  observation_kinds: authority === "mono" && runtime?.observation.availability === "available" ? ["static_source", "runtime_resolution"] : ["static_source"],
  rows: [...rows].sort((a, b) => compareByteOrder(a.row_id, b.row_id) || compareByteOrder(a.canonical_key, b.canonical_key)),
  links: [...links].sort((left, right) => compareByteOrder(left.relation_id, right.relation_id)),
  observations: runtime === null ? [] : [runtimeInventoryObservation(runtime)],
  derivation_edges: [],
})

export interface CollectedRouteArtifacts {
  readonly legacy: InventoryEnvelope
  readonly mono: InventoryEnvelope
  readonly failures: readonly RouteParseFailure[]
  readonly declarations: CollectedRoutes
  readonly runtimeObservation: RuntimeObservation
}
export const collectRoutes = (
  context: ManifestContext,
  sourceManifestSha256: string,
  configured?: CollectorExecutables,
  allowFixture = false,
): CollectedRouteArtifacts => {
  const legacy = parseLegacy(context)
  const mono = parseMono(context)
  const legacyRows = makeRows(context, legacy.declarations, "legacy")
  applyDuplicateGroups(legacyRows)
  if (allowFixture) {
    const monoRows = makeRows(context, mono.declarations, "mono")
    applyDuplicateGroups(monoRows)
    const runtimeObservation = recordRuntimeObservation(context, {
      collectorKind: "route_collector",
      logicalCommandId: "fixture-route-runtime",
      command: "fixture route-runtime",
      arguments: [],
      stdout: canonicalJson([]),
      stderr: "",
      exitCode: 0,
      result: [],
      availability: "available",
      revisionRefId: context.scans.mono.revisionRefId,
      outOfBand: true,
    })
    return {
      legacy: makeEnvelope(context, "legacy", legacyRows, sourceManifestSha256),
      mono: makeEnvelope(context, "mono", monoRows, sourceManifestSha256),
      failures: [...legacy.failures, ...mono.failures],
      declarations: { legacy: legacy.declarations, mono: mono.declarations, failures: [...legacy.failures, ...mono.failures] },
      runtimeObservation,
    }
  }
  const runtime = collectRuntimeRoutes(context, configured)
  const monoStaticRows = makeRows(context, mono.declarations, "mono", runtime.observation)
  const reconciled = reconcileRuntimeRoutes(context.scans.mono.revisionRefId, monoStaticRows, runtime)
  applyDuplicateGroups(reconciled.rows)
  return {
    legacy: makeEnvelope(context, "legacy", legacyRows, sourceManifestSha256),
    mono: makeEnvelope(context, "mono", reconciled.rows, sourceManifestSha256, runtime, reconciled.links),
    failures: [...legacy.failures, ...mono.failures, ...runtime.failures],
    declarations: { legacy: legacy.declarations, mono: mono.declarations, failures: [...legacy.failures, ...mono.failures, ...runtime.failures] },
    runtimeObservation: runtime.observation,
  }
}

export const routeRowsBySignature = (inventory: InventoryEnvelope): Map<string, InventoryRow[]> => {
  const result = new Map<string, InventoryRow[]>()
  for (const row of inventory.rows) {
    const rows = result.get(row.signature)
    if (rows === undefined) result.set(row.signature, [row])
    else rows.push(row)
  }
  return result
}

export const setRowMismatch = (row: InventoryRow, kind: Mismatch["kind"], counterparts: readonly string[], reason: string): InventoryRow => {
  const status: InventoryRow["status"] = kind === "duplicate" ? "duplicate" : kind === "unresolved" ? "unresolved" : kind === "dead_unimported" ? "dead_unimported" : kind === "missing" ? "missing" : kind === "extra" ? "extra" : kind === "changed" ? "changed" : kind === "uncovered" ? "uncovered" : "covered"
  const reasonCodes = reason.length > 0 ? sortUnique([...row.reason_codes, reason]) : row.reason_codes
  return { ...row, status, mismatch: rowMismatch(kind, counterparts, reason.length > 0 ? reason : null), reason_codes: reasonCodes }
}

export const updateEnvelopeRows = (inventory: InventoryEnvelope, rows: readonly InventoryRow[]): InventoryEnvelope => ({ ...inventory, rows: [...rows].sort((a, b) => compareByteOrder(a.row_id, b.row_id) || compareByteOrder(a.canonical_key, b.canonical_key)) })
