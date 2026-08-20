import { execFileSync } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join } from "node:path"
import { tmpdir } from "node:os"
import { canonicalJson, compareByteOrder, declarationId, edgeId, observationId, relationId, rowId, sha256, sortUnique } from "./canonical.js"
import { addSourceReference, effectiveIgnoreRule, matchesLiteralPattern, readSourceText, readSourceTextDetailed, sanitizeScalar, sourceTextSafetyReason, unsafeScalarReason, unsafeSourceTextReason, unsafeStructuredValueReason, type ManifestContext, type OutOfBandSourceCapture, type ScanFile } from "./source-manifest.js"
import { inspectJsonMembers } from "./json-safety.js"
import { skipPhpTrivia } from "./php-trivia.js"
import type {
  ApiOperationDetails,
  CollectorExecutableProvenance,
  CollectorExecutables,
  DerivationEdge,
  InventoryEnvelope,
  InventoryLink,
  InventoryObservation,
  InventoryRow,
  Mismatch,
  MonoRouteDetails,
  OpenApiReconciliation,
  ReportFailure,
  RuntimeExecutableDigests,
  RuntimeExecutableProvenance,
  RuntimeObservation,
} from "./types.js"

export interface ApiCollection {
  readonly inventory: InventoryEnvelope
  readonly reconciliation: OpenApiReconciliation
  readonly failures: readonly ApiCollectionFailure[]
  readonly rows: readonly InventoryRow[]
  readonly h3RouteRows: readonly InventoryRow[]
  readonly h3RouteEdges: readonly DerivationEdge[]
  readonly h3RouteObservations: readonly InventoryObservation[]
}

export interface ApiCollectionFailure {
  readonly status: "schema_invalid" | "unresolved" | "runtime_unavailable" | "source_unavailable" | "stale"
  readonly reasonCode: string
  readonly rowIds: readonly string[]
  readonly sourceRefIds: readonly string[]
}

interface ClassLocation {
  readonly path: string
  readonly line: number
  readonly classRef: string
}

interface ApiDeclaration {
  readonly logicalPath: string
  readonly ordinal: number
  readonly sourceRefIds: readonly string[]
  readonly resourceClassRef: string | null
  readonly resourceKey: string | null
  readonly operationName: string | null
  readonly method: string | null
  readonly uriTemplate: string | null
  readonly operationId: string | null
  readonly providerRef: string | null
  readonly processorRef: string | null
  readonly schemaRef: string | null
  readonly reasonCodes: readonly string[]
}

interface RuntimeOperation {
  readonly method: string | null
  readonly uriTemplate: string | null
  readonly operationId: string | null
  readonly operationName: string | null
  readonly resourceClassRef: string | null
  readonly resourceKey: string | null
  readonly providerRef: string | null
  readonly processorRef: string | null
  readonly schemaRef: string | null
}
export interface ApiRuntimeFixtureInput {
  readonly path: string
  readonly bytes: Uint8Array
}

interface RuntimeCollection {
  readonly operations: readonly RuntimeOperation[]
  readonly observation: RuntimeObservation
  readonly openApiObservation: RuntimeObservation | null
  readonly openApiPayload: unknown | null
  readonly sourceRefIds: readonly string[]
  readonly failures: readonly ApiCollectionFailure[]
}

interface NormalizedOperation {
  readonly identity: string
  readonly digest: string
}

const HTTP_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "CONNECT", "TRACE"])
const OPERATION_METHODS: Readonly<Record<string, string>> = {
  Get: "GET",
  GetCollection: "GET",
  Head: "HEAD",
  HeadCollection: "HEAD",
  Post: "POST",
  Put: "PUT",
  Patch: "PATCH",
  Delete: "DELETE",
  Options: "OPTIONS",
}
export const API_RUNTIME_FIXTURE_PATH = "apps/server/var/parity/api-operations.json"
const RUNTIME_FIXTURE_PATHS = [
  API_RUNTIME_FIXTURE_PATH,
  "apps/server/var/parity/runtime-api-operations.json",
  "runtime/api-operations.json",
  "runtime/api.json",
] as const
const OPENAPI_PATH = "packages/sdk/openapi.json"
const CONSOLE_PATH = "apps/server/bin/console"
const H3_GENERATOR_PATH = "apps/server/tools/security-h3/0015/generate.ts"
const H3_SOURCE_MANIFEST_PATH = "evidence/security-h3/0015/source-manifest.json"
const H3_COLLECTOR_PATH = "evidence/security-h3/0015/route-collector.json"
const H3_ROUTE_PATH = "evidence/security-h3/0015/current-route-inventory.json"
const H3_RESOURCE_PATH = "evidence/security-h3/0015/current-resource-inventory.json"
type CollectorExecutableKind = "php" | "bwrap"
export interface ValidatedCollectorExecutable {
  readonly kind: CollectorExecutableKind
  readonly path: string
  readonly digest: string
  readonly provenance: CollectorExecutableProvenance
}
export interface ValidatedCollectorExecutables {
  readonly php: ValidatedCollectorExecutable
  readonly bwrap: ValidatedCollectorExecutable
}
export interface CollectorSandboxInvocation {
  readonly executable: string
  readonly arguments: readonly string[]
}
const PHP_NIX_PATTERN = /^\/nix\/store\/[a-z0-9]{32}-(?:php|php-with-extensions)-[^/]+\/bin\/php$/
const BWRAP_NIX_PATTERN = /^\/nix\/store\/[a-z0-9]{32}-bubblewrap-[^/]+\/bin\/bwrap$/
export const collectorExecutableProvenance = (kind: CollectorExecutableKind, path: string): CollectorExecutableProvenance | null => {
  if (path === `/usr/bin/${kind}`) return "usr-bin"
  if (kind === "php" && PHP_NIX_PATTERN.test(path)) return "nix-store"
  if (kind === "bwrap" && BWRAP_NIX_PATTERN.test(path)) return "nix-store"
  return null
}
export const validateCollectorExecutablePath = (kind: CollectorExecutableKind, requestedPath: string): ValidatedCollectorExecutable | null => {
  if (!isAbsolute(requestedPath) || requestedPath.includes("\u0000")) return null
  const provenance = collectorExecutableProvenance(kind, requestedPath)
  if (provenance === null) return null
  try {
    const link = lstatSync(requestedPath)
    const canonicalPath = realpathSync(requestedPath)
    const stat = statSync(requestedPath)
    if (link.isSymbolicLink() || canonicalPath !== requestedPath || !stat.isFile() || (stat.mode & 0o111) === 0 || (stat.mode & 0o022) !== 0) return null
    if (collectorExecutableProvenance(kind, canonicalPath) !== provenance) return null
    return { kind, path: canonicalPath, digest: sha256(readFileSync(canonicalPath)), provenance }
  } catch {
    return null
  }
}
const closedCollectorExecutables = (value: CollectorExecutables | undefined): value is CollectorExecutables => {
  if (value === undefined || value === null || typeof value !== "object") return false
  const keys = Object.keys(value).sort()
  return keys.length === 2 && keys[0] === "bwrapExecutable" && keys[1] === "phpExecutable" && typeof value.phpExecutable === "string" && typeof value.bwrapExecutable === "string"
}
export const resolveCollectorExecutables = (configured?: CollectorExecutables): ValidatedCollectorExecutables | null => {
  const selected = configured ?? (existsSync(PHP_EXECUTABLE) && existsSync(BWRAP_EXECUTABLE) ? { phpExecutable: PHP_EXECUTABLE, bwrapExecutable: BWRAP_EXECUTABLE } : undefined)
  if (!closedCollectorExecutables(selected)) return null
  const php = validateCollectorExecutablePath("php", selected.phpExecutable)
  const bwrap = validateCollectorExecutablePath("bwrap", selected.bwrapExecutable)
  return php === null || bwrap === null ? null : { php, bwrap }
}
const collectorNeedsNixStore = (executables: CollectorExecutables): boolean => collectorExecutableProvenance("php", executables.phpExecutable) === "nix-store" || collectorExecutableProvenance("bwrap", executables.bwrapExecutable) === "nix-store"
export const buildCollectorSandboxArguments = (executables: CollectorExecutables, args: readonly string[], workspacePath = "/workspace"): CollectorSandboxInvocation => {
  const libraryBinds = ["/lib", "/lib64", "/usr/lib"].filter((path) => existsSync(path)).flatMap((path) => ["--ro-bind", path, path])
  const nixStoreBind = collectorNeedsNixStore(executables) ? ["--dir", "/nix", "--ro-bind", "/nix/store", "/nix/store"] : []
  return {
    executable: executables.bwrapExecutable,
    arguments: ["--die-with-parent", "--unshare-net", "--unshare-pid", "--unshare-uts", "--unshare-ipc", "--clearenv", "--tmpfs", "/", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/etc", "--dir", "/usr", "--dir", "/usr/bin", "--dir", "/usr/lib", "--ro-bind", executables.phpExecutable, "/usr/bin/php", ...nixStoreBind, ...libraryBinds, "--ro-bind", workspacePath, "/workspace", "--tmpfs", "/workspace/apps/server/var", "--chdir", "/workspace", "--setenv", "PATH", "/usr/bin", "--setenv", "HOME", "/tmp", "--setenv", "APP_ENV", "test", "--setenv", "APP_DEBUG", "0", "--setenv", "COMPOSER_HOME", "/tmp", "--", "/usr/bin/php", ...args],
  }
}
const PHP_EXECUTABLE = "/usr/bin/php"
const BWRAP_EXECUTABLE = "/usr/bin/bwrap"

const lineAt = (source: string, offset: number): number => source.slice(0, Math.max(0, offset)).split("\n").length
type SafeScalar = { readonly value: string | null; readonly unsafe: boolean }

const decodeScalar = (value: unknown, fieldName: string): SafeScalar => {
  if (typeof value !== "string") return { value: null, unsafe: false }
  const normalized = value.trim().normalize("NFC")
  return unsafeScalarReason(normalized, fieldName) === null
    ? { value: normalized, unsafe: false }
    : { value: null, unsafe: true }
}

const sourceFailureRef = (context: ManifestContext, path: string, reason: string, role: string, captureMode: "static" | "runtime" | "generated" = "static"): string => addSourceReference(context, {
  authorityLine: "mono",
  authorityRole: role,
  rootRef: "mono",
  path,
  lineStart: null,
  lineEnd: null,
  symbol: null,
  captureMode,
  failureStatus: "source_unavailable",
  failureReason: reason,
})

const balancedEnd = (source: string, start: number, open: string, close: string): number | null => {
  if (source[start] !== open) return null
  let depth = 0
  let quote: string | null = null
  let escaped = false
  for (let index = start; index < source.length; index += 1) {
    const character = source[index]
    if (quote !== null) {
      if (escaped) escaped = false
      else if (character === "\\") escaped = true
      else if (character === quote) quote = null
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      continue
    }
    if (character === open) depth += 1
    else if (character === close) {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return null
}
const apiResourceSourceRef = (context: ManifestContext, path: string, lineStart: number | null, lineEnd: number | null, role = "mono_api_resource_authority"): string => addSourceReference(context, {
  authorityLine: "mono",
  authorityRole: role,
  rootRef: "mono",
  path,
  lineStart,
  lineEnd,
  symbol: null,
})

const readQuotedToken = (payload: string, start: number): { readonly raw: string; readonly end: number; readonly unsafe: boolean } | null => {
  const quote = payload[start]
  if (quote !== "'" && quote !== '"') return null
  let escaped = false
  for (let index = start + 1; index < payload.length; index += 1) {
    const character = payload[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (character === "\\") {
      escaped = true
      continue
    }
    if (character === quote) return { raw: payload.slice(start + 1, index), end: index + 1, unsafe: false }
  }
  return { raw: payload.slice(start + 1), end: payload.length, unsafe: true }
}

const quotedValueSafe = (payload: string, key: string): SafeScalar => {
  const expression = new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*`, "ig")
  for (const match of payload.matchAll(expression)) {
    const start = (match.index ?? 0) + match[0].length
    const token = readQuotedToken(payload, start)
    if (token === null) continue
    return token.unsafe ? { value: null, unsafe: true } : decodeScalar(token.raw, key)
  }
  return { value: null, unsafe: false }
}

const quotedValue = (payload: string, key: string): string | null => quotedValueSafe(payload, key).value

const payloadUnsafe = (payload: string): boolean => {
  let quote: string | null = null
  let quoteStart = -1
  let escaped = false
  for (let index = 0; index < payload.length; index += 1) {
    const character = payload[index]
    if (quote === null) {
      if (character === "'" || character === '"') {
        quote = character
        quoteStart = index
      }
      continue
    }
    if (escaped) {
      escaped = false
      continue
    }
    if (character === "\\") {
      escaped = true
      continue
    }
    if (character === quote) {
      const safe = decodeScalar(payload.slice(quoteStart + 1, index), "field")
      if (safe.unsafe) return true
      quote = null
      quoteStart = -1
    }
  }
  return quote !== null
}

const classValue = (payload: string, key: string, namespace: string, uses: ReadonlyMap<string, string>): string | null => {
  const expression = new RegExp(`\\b${key}\\s*:\\s*([A-Za-z_][A-Za-z0-9_\\\\]*)::class`, "i").exec(payload)
  if (expression === null) return null
  return resolveClassRef(expression[1] ?? "", namespace, uses)
}

const resolveClassRef = (raw: string, namespace: string, uses: ReadonlyMap<string, string>): string | null => {
  const value = raw.replace(/^\\+/, "").trim()
  if (value.length === 0) return null
  const first = value.split("\\")[0] ?? value
  const imported = uses.get(first)
  const resolved = imported === undefined
    ? value.includes("\\") ? value : namespace.length > 0 ? `${namespace}\\${value}` : value
    : value === first ? imported : `${imported}\\${value.slice(first.length + 1)}`
  return sanitizeScalar(resolved, "resource")
}

const useMap = (source: string): Map<string, string> => {
  const result = new Map<string, string>()
  const pattern = /\buse\s+([^;]+);/gi
  for (const match of source.matchAll(pattern)) {
    const declaration = (match[1] ?? "").trim().replace(/^function\s+|^const\s+|^class\s+/i, "")
    const [targetPart, aliasPart] = declaration.split(/\s+as\s+/i)
    const target = targetPart?.trim().replace(/^\\+/, "")
    if (target === undefined || target.length === 0) continue
    const alias = aliasPart?.trim() || target.split("\\").at(-1)
    if (alias !== undefined && alias.length > 0) result.set(alias, target)
  }
  return result
}

const namespaceOf = (source: string): string => source.match(/\bnamespace\s+([^;]+);/i)?.[1]?.trim().replace(/^\\+/, "") ?? ""

const classLocations = (context: ManifestContext, paths: readonly string[]): Map<string, ClassLocation> => {
  const locations = new Map<string, ClassLocation>()
  for (const path of paths) {
    const text = readSourceText(context, "mono", path)
    if (text === null) continue
    const namespace = namespaceOf(text)
    const pattern = /\bclass\s+([A-Za-z_][A-Za-z0-9_]*)/g
    for (const match of text.matchAll(pattern)) {
      const shortName = match[1]
      if (shortName === undefined) continue
      const classRef = namespace.length > 0 ? `${namespace}\\${shortName}` : shortName
      locations.set(classRef, { path, line: lineAt(text, match.index ?? 0), classRef })
    }
  }
  return locations
}

const apiSourcePaths = (context: ManifestContext): string[] => context.scans.mono.files
  .filter((file) => file.availability === "available" && !file.unsafe && (file.path.endsWith(".php") || file.path.endsWith(".inc")))
  .filter((file) => matchesLiteralPattern(file.path, "apps/server/src/App/**/Api/Resource/**/*.php") || matchesLiteralPattern(file.path, "apps/server/src/App/**/Api/State/**/*.php") || matchesLiteralPattern(file.path, "apps/server/src/App/**/Infrastructure/Entity/**/*.php"))
  .map((file) => file.path)
  .sort(compareByteOrder)
const parseOperationEntries = (source: string, payload: string, payloadOffset: number): readonly { readonly name: string | null; readonly payload: string; readonly offset: number; readonly end: number }[] => {
  const entries: Array<{ readonly name: string | null; readonly payload: string; readonly offset: number; readonly end: number }> = []
  const pattern = /\bnew\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g
  for (const match of payload.matchAll(pattern)) {
    const name = match[1] ?? null
    const openOffset = payloadOffset + (match.index ?? 0) + (match[0]?.lastIndexOf("(") ?? 0)
    const end = balancedEnd(source, openOffset, "(", ")")
    if (end === null) continue
    entries.push({ name, payload: source.slice(openOffset + 1, end), offset: openOffset, end })
  }
  return entries
}

const parseDeclarations = (context: ManifestContext): { readonly declarations: readonly ApiDeclaration[]; readonly failures: readonly ApiCollectionFailure[] } => {
  const paths = apiSourcePaths(context)
  const classIndex = classLocations(context, paths)
  const declarations: ApiDeclaration[] = []
  const failures: ApiCollectionFailure[] = []
  let ordinal = 0
  for (const path of paths) {
    const decoded = readSourceTextDetailed(context, "mono", path)
    if (decoded.status !== "available") {
      const sourceRefId = sourceFailureRef(context, path, decoded.reason, "mono_api_resource_authority")
      failures.push({ status: "source_unavailable", reasonCode: decoded.reason, rowIds: [], sourceRefIds: [sourceRefId] })
      continue
    }
    const source = decoded.text
    const namespace = namespaceOf(source)
    const uses = useMap(source)
    const attributes = /#\[\s*ApiResource\b/gi
    for (const attribute of source.matchAll(attributes)) {
      const attributeOffset = attribute.index ?? 0
      const openOffset = source.indexOf("(", attributeOffset)
      if (openOffset < 0) {
        const sourceRefId = apiResourceSourceRef(context, path, lineAt(source, attributeOffset), lineAt(source, attributeOffset))
        failures.push({ status: "unresolved", reasonCode: "SOURCE_PARSE_ERROR", rowIds: [], sourceRefIds: [sourceRefId] })
        continue
      }
      const payloadEnd = balancedEnd(source, openOffset, "(", ")")
      if (payloadEnd === null) {
        const sourceRefId = apiResourceSourceRef(context, path, lineAt(source, attributeOffset), lineAt(source, attributeOffset))
        failures.push({ status: "unresolved", reasonCode: "SOURCE_PARSE_ERROR", rowIds: [], sourceRefIds: [sourceRefId] })
        continue
      }
      const closingAttribute = /^\s*\]/.exec(source.slice(payloadEnd + 1))
      if (closingAttribute === null) {
        const sourceRefId = apiResourceSourceRef(context, path, lineAt(source, attributeOffset), lineAt(source, attributeOffset))
        failures.push({ status: "unresolved", reasonCode: "SOURCE_PARSE_ERROR", rowIds: [], sourceRefIds: [sourceRefId] })
        continue
      }
      const trivia = skipPhpTrivia(source, payloadEnd + 1 + closingAttribute[0].length)
      if (trivia.malformed) {
        const sourceRefId = apiResourceSourceRef(context, path, lineAt(source, attributeOffset), lineAt(source, attributeOffset))
        failures.push({ status: "unresolved", reasonCode: "SOURCE_PARSE_ERROR", rowIds: [], sourceRefIds: [sourceRefId] })
        continue
      }
      const classMatch = /^(?:(?:final|abstract|readonly)\s+)*class\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(source.slice(trivia.cursor))
      if (classMatch === null || classMatch.index === undefined) {
        const sourceRefId = apiResourceSourceRef(context, path, lineAt(source, attributeOffset), lineAt(source, attributeOffset))
        failures.push({ status: "unresolved", reasonCode: "SOURCE_PARSE_ERROR", rowIds: [], sourceRefIds: [sourceRefId] })
        continue
      }
      const className = classMatch[1] ?? null
      const classSafe = decodeScalar(className, "resource")
      const resourceClassRef = classSafe.value === null ? null : resolveClassRef(classSafe.value, namespace, new Map())
      const payload = source.slice(openOffset + 1, payloadEnd)
      if (classSafe.unsafe || payloadUnsafe(payload)) {
        const sourceRefId = sourceFailureRef(context, path, "UNSAFE_SOURCE", "mono_api_resource_authority")
        failures.push({ status: "source_unavailable", reasonCode: "UNSAFE_SOURCE", rowIds: [], sourceRefIds: [sourceRefId] })
        continue
      }
      const resourceKey = quotedValue(payload, "shortName") ?? quotedValue(payload, "resourceKey")
      const operationsStart = /\boperations\s*:\s*\[/i.exec(payload)
      const operationEntries = operationsStart === null
        ? []
        : (() => {
          const open = openOffset + 1 + (operationsStart.index ?? 0) + (operationsStart[0]?.lastIndexOf("[") ?? 0)
          const end = balancedEnd(source, open, "[", "]")
          return end === null ? [] : parseOperationEntries(source, source.slice(open + 1, end), open + 1)
        })()
      const entries = operationEntries.length > 0 ? operationEntries : [{ name: null, payload: "", offset: openOffset, end: payloadEnd }]
      for (const entry of entries) {
        ordinal += 1
        const operationName = entry.name === null ? null : decodeScalar(entry.name, "field").value
        const method = operationName === null ? null : OPERATION_METHODS[operationName] ?? null
        const uriTemplate = quotedValue(entry.payload, "uriTemplate") ?? quotedValue(entry.payload, "uri_template")
        const operationId = quotedValue(entry.payload, "name") ?? quotedValue(entry.payload, "operationId")
        const providerRef = classValue(entry.payload, "provider", namespace, uses)
        const processorRef = classValue(entry.payload, "processor", namespace, uses)
        const schemaRef = classValue(entry.payload, "output", namespace, uses) ?? classValue(entry.payload, "input", namespace, uses)
        const operationLineEnd = lineAt(source, entry.end)
        const sourceRefs = [apiResourceSourceRef(context, path, lineAt(source, attributeOffset), operationLineEnd)]
        for (const [reference, role] of [[providerRef, "mono_api_state_authority"], [processorRef, "mono_api_state_authority"]] as const) {
          if (reference === null) continue
          const location = classIndex.get(reference)
          if (location !== undefined) sourceRefs.push(apiResourceSourceRef(context, location.path, location.line, location.line, role))
        }
        const reasons: string[] = []
        if (resourceClassRef === null) reasons.push("SOURCE_PARSE_ERROR")
        if (operationName === null || method === null) reasons.push("METHOD_UNRESOLVED")
        if (uriTemplate === null) reasons.push("URI_TEMPLATE_UNRESOLVED")
        if (providerRef !== null && !classIndex.has(providerRef)) reasons.push("PROVIDER_UNRESOLVED")
        if (processorRef !== null && !classIndex.has(processorRef)) reasons.push("PROCESSOR_UNRESOLVED")
        declarations.push({ logicalPath: path, ordinal, sourceRefIds: sortUnique(sourceRefs), resourceClassRef, resourceKey, operationName, method, uriTemplate, operationId, providerRef, processorRef, schemaRef, reasonCodes: sortUnique(reasons) })
      }
    }
  }
  return { declarations, failures }
}

const apiSignature = (operation: Pick<ApiDeclaration, "resourceClassRef" | "operationName" | "method" | "uriTemplate" | "operationId"> | RuntimeOperation): string => canonicalJson({ resource_class_ref: operation.resourceClassRef, operation_name: operation.operationName, method: operation.method, uri_template: operation.uriTemplate, operation_id_or_null: operation.operationId })
const apiCanonicalKey = (declaration: Pick<ApiDeclaration, "resourceClassRef" | "operationName" | "method" | "uriTemplate" | "operationId">): string => canonicalJson(["api_operation", declaration.resourceClassRef, declaration.operationName, declaration.method, declaration.uriTemplate, declaration.operationId])
const runtimeCanonicalKey = (operation: RuntimeOperation): string => canonicalJson(["api_operation", operation.resourceClassRef, operation.operationName, operation.method, operation.uriTemplate, operation.operationId])

const mismatch = (kind: Mismatch["kind"], counterpartRowIds: readonly string[], reason: string | null): Mismatch => ({ kind, disposition: "none", accepted_intent_ref_ids: [], counterpart_row_ids: sortUnique(counterpartRowIds), reason })

const runtimeSourceRef = (context: ManifestContext, path: string, role: string): string => addSourceReference(context, {
  authorityLine: "mono",
  authorityRole: role,
  rootRef: "mono",
  path,
  lineStart: null,
  lineEnd: null,
  symbol: null,
  captureMode: "runtime",
})

const NO_EXECUTABLE_DIGESTS: RuntimeExecutableDigests = { php: null, bwrap: null }
const NO_EXECUTABLE_PROVENANCE: RuntimeExecutableProvenance = { php: null, bwrap: null }
const collectorBytes = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) return value
  if (typeof value === "string") return new TextEncoder().encode(value)
  return new Uint8Array()
}
export const routePayloadContainsUnsafe = (value: unknown): boolean => {
  const visit = (candidate: unknown, fieldName: string, documentRoot: boolean): boolean => {
    if (typeof candidate === "string") return unsafeScalarReason(candidate, fieldName) !== null
    if (Array.isArray(candidate)) return candidate.some((entry) => visit(entry, fieldName, false))
    if (candidate === null || typeof candidate !== "object") return false
    return Object.entries(candidate).some(
      ([key, entry]) =>
        (documentRoot && unsafeScalarReason(key, "route_name") !== null) ||
        visit(entry, key, false),
    )
  }
  return visit(value, "field", true)
}

type CollectorSafetyPolicy = "generic" | "openapi" | "route"
type CollectorOutputMode = "success" | "failure"
type CollectorOutputReason = "NON_UTF8_OUTPUT" | "UNSAFE_SOURCE" | "SOURCE_PARSE_ERROR" | "OPENAPI_SOURCE_PARSE_ERROR"
const sanitizeCollectorOutput = (
  value: unknown,
  fallbackReason: string,
  policy: CollectorSafetyPolicy = "generic",
  mode: CollectorOutputMode = "failure",
): { readonly bytes: Uint8Array; readonly text: string; readonly reason: CollectorOutputReason | null } => {
  const bytes = collectorBytes(value)
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    const fallback = new TextEncoder().encode(fallbackReason)
    return { bytes: fallback, text: fallbackReason, reason: "NON_UTF8_OUTPUT" }
  }
  if (mode === "failure") {
    if (unsafeSourceTextReason(text) !== null) {
      const fallback = new TextEncoder().encode(fallbackReason)
      return { bytes: fallback, text: fallbackReason, reason: "UNSAFE_SOURCE" }
    }
    return { bytes: new TextEncoder().encode(text), text, reason: null }
  }
  const trimmed = text.trimStart()
  const looksLikeJson = trimmed.startsWith("{") || trimmed.startsWith("[")
  if (policy === "openapi" && !looksLikeJson) {
    const fallback = new TextEncoder().encode("OPENAPI_SOURCE_PARSE_ERROR")
    return { bytes: fallback, text: "OPENAPI_SOURCE_PARSE_ERROR", reason: "OPENAPI_SOURCE_PARSE_ERROR" }
  }
  if (!looksLikeJson) {
    if (unsafeSourceTextReason(text) !== null) {
      const fallback = new TextEncoder().encode(fallbackReason)
      return { bytes: fallback, text: fallbackReason, reason: "UNSAFE_SOURCE" }
    }
    return { bytes: new TextEncoder().encode(text), text, reason: null }
  }
  const memberScan = inspectJsonMembers(text)
  if (memberScan !== "valid") {
    const fallbackReasonForScan: CollectorOutputReason = memberScan === "duplicate"
      ? "UNSAFE_SOURCE"
      : policy === "openapi"
        ? "OPENAPI_SOURCE_PARSE_ERROR"
        : "SOURCE_PARSE_ERROR"
    const fallback = new TextEncoder().encode(fallbackReasonForScan)
    return { bytes: fallback, text: fallbackReasonForScan, reason: fallbackReasonForScan }
  }
  const unsafe =
    policy === "openapi"
      ? (() => {
          try {
            return openApiPayloadContainsUnsafe(JSON.parse(text) as unknown)
          } catch {
            return true
          }
        })()
      : policy === "route"
        ? (() => {
            try {
              return routePayloadContainsUnsafe(JSON.parse(text) as unknown)
            } catch {
              return true
            }
          })()
        : unsafeSourceTextReason(text) !== null
  if (unsafe) {
    const fallback = new TextEncoder().encode(fallbackReason)
    return { bytes: fallback, text: fallbackReason, reason: "UNSAFE_SOURCE" }
  }
  return { bytes: new TextEncoder().encode(text), text, reason: null }
}
export const recordRuntimeObservation = (context: ManifestContext, input: {
  readonly collectorKind: string
  readonly logicalCommandId?: string
  readonly command: string
  readonly arguments: readonly string[]
  readonly stdout: Uint8Array | string
  readonly stderr: Uint8Array | string
  readonly exitCode: number
  readonly result: unknown
  readonly availability: "available" | "unavailable"
  readonly revisionRefId: string
  readonly executableDigests?: RuntimeExecutableDigests
  readonly executableProvenance?: RuntimeExecutableProvenance
  readonly outOfBand?: true
}): RuntimeObservation => {
  const stdout = sanitizeCollectorOutput(input.stdout, "UNSAFE_SOURCE")
  const stderr = sanitizeCollectorOutput(input.stderr, "UNSAFE_SOURCE")
  const executableDigests = input.executableDigests ?? NO_EXECUTABLE_DIGESTS
  const executableProvenance = input.executableProvenance ?? NO_EXECUTABLE_PROVENANCE
  const logicalCommandId = input.logicalCommandId ?? input.command
  const resultBytes = canonicalJson(input.result)
  const argumentDigest = sha256(canonicalJson(input.arguments))
  const identity = {
    collector_kind: input.collectorKind,
    logical_command_id: logicalCommandId,
    revision_ref_id: input.revisionRefId,
    command: input.command,
    argument_digest: argumentDigest,
    executable_digests: executableDigests,
    executable_provenance: executableProvenance,
    stdout_sha256: sha256(stdout.bytes),
    stderr_sha256: sha256(stderr.bytes),
    exit_code: input.exitCode,
    result_sha256: sha256(resultBytes),
    availability: input.availability,
    ...(input.outOfBand === true ? { out_of_band: true as const } : {}),
  }
  const observation: RuntimeObservation = {
    runtime_observation_ref_id: `runtime-${sha256Hex(canonicalJson(identity))}`,
    revision_ref_id: input.revisionRefId,
    collector_kind: identity.collector_kind,
    logical_command_id: logicalCommandId,
    command: input.command,
    argument_digest: argumentDigest,
    executable_digests: executableDigests,
    executable_provenance: executableProvenance,
    stdout_sha256: identity.stdout_sha256,
    stderr_sha256: identity.stderr_sha256,
    exit_code: input.exitCode,
    result_sha256: identity.result_sha256,
    availability: input.availability,
    ...(input.outOfBand === true ? { out_of_band: true as const } : {}),
  }
  const existing = context.runtimeObservations.find((entry) => entry.runtime_observation_ref_id === observation.runtime_observation_ref_id)
  if (existing === undefined) context.runtimeObservations.push(observation)
  return existing ?? observation
}
const sha256Hex = (value: string): string => sha256(value).slice("sha256:".length)

const normaliseMethod = (value: unknown): string | null => {
  if (typeof value !== "string") return null
  const method = value.trim().toUpperCase()
  return HTTP_METHODS.has(method) ? method : null
}
const runtimeOperationFromUnknown = (value: unknown): RuntimeOperation | null => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  const methodValue = candidate.method ?? (Array.isArray(candidate.methods) ? candidate.methods[0] : null)
  const method = normaliseMethod(methodValue)
  const pathValue = candidate.uri_template ?? candidate.path_template ?? candidate.path
  const uriTemplate = typeof pathValue === "string" ? sanitizeScalar(pathValue, "route_path") : null
  const operationIdValue = candidate.operation_id ?? candidate.operationId ?? candidate.name
  const operationNameValue = candidate.operation_name ?? candidate.operationName ?? candidate.operation
  const resourceClassValue = candidate.resource_class_ref ?? candidate.resourceClassRef ?? candidate.resource_class
  const resourceKeyValue = candidate.resource_key ?? candidate.resourceKey
  const providerValue = candidate.provider_ref ?? candidate.providerRef ?? candidate.provider
  const processorValue = candidate.processor_ref ?? candidate.processorRef ?? candidate.processor
  const schemaValue = candidate.schema_ref ?? candidate.schemaRef ?? candidate.schema
  const stringOrNull = (raw: unknown, fieldName: string): string | null => typeof raw === "string" ? sanitizeScalar(raw, fieldName) : null
  if (method === null && uriTemplate === null && operationIdValue === undefined && operationNameValue === undefined) return null
  return { method, uriTemplate, operationId: stringOrNull(operationIdValue, "field"), operationName: stringOrNull(operationNameValue, "field"), resourceClassRef: stringOrNull(resourceClassValue, "resource"), resourceKey: stringOrNull(resourceKeyValue, "resource"), providerRef: stringOrNull(providerValue, "resource"), processorRef: stringOrNull(processorValue, "resource"), schemaRef: stringOrNull(schemaValue, "field") }
}
const runtimeOperationsFromPayload = (payload: unknown): RuntimeOperation[] | null => {
  const values: unknown[] = Array.isArray(payload)
    ? payload
    : payload !== null && typeof payload === "object"
      ? (() => {
        const object = payload as Record<string, unknown>
        if (Array.isArray(object.operations)) return object.operations
        if (Array.isArray(object.api_operations)) return object.api_operations
        return []
      })()
      : []
  const operations = values.map(runtimeOperationFromUnknown).filter((operation): operation is RuntimeOperation => operation !== null)
  return operations.length === values.length ? operations : null
}

const runtimeFixturePath = (context: ManifestContext): string | null => RUNTIME_FIXTURE_PATHS.find((path) => context.scans.mono.files.some((file) => file.path === path && file.availability === "available")) ?? null
const fixtureRuntimeSourcePath = (path: string): string => `fixture://runtime/${path}`
const fixtureRuntimeSourceRef = (
  context: ManifestContext,
  input: ApiRuntimeFixtureInput,
  capture: boolean,
  failureReason?: string,
): string => {
  const source = {
    authorityLine: "mono" as const,
    authorityRole: "mono_api_runtime_fixture",
    rootRef: "mono" as const,
    path: fixtureRuntimeSourcePath(input.path),
    lineStart: null,
    lineEnd: null,
    symbol: null,
    captureMode: "runtime" as const,
  };
  return addSourceReference(
    context,
    capture
      ? {
          ...source,
          outOfBand: {
            bytes: input.bytes,
            revisionRefId: context.scans.mono.revisionRefId,
          } satisfies OutOfBandSourceCapture,
        }
      : {
          ...source,
          failureStatus: "source_unavailable" as const,
          failureReason: failureReason ?? "SOURCE_UNAVAILABLE",
        },
  );
}


export const API_OPENAPI_SCRIPT = String.raw`$root = '/workspace/apps/server';
require $root . '/vendor/autoload.php';
(new \Symfony\Component\Dotenv\Dotenv())->usePutenv()->load($root . '/.env.test');
$kernel = new \Kernel('test', false);
$kernel->boot();
$container = $kernel->getContainer()->get('test.service_container');
$serializer = $container->get('serializer');
$factory = $container->get(\ApiPlatform\OpenApi\Factory\OpenApiFactoryInterface::class);
$normalized = $serializer->normalize($factory(), 'json', ['spec_version' => '3']);
if (!is_array($normalized)) throw new \UnexpectedValueException('OpenAPI normalization did not return an array');
echo json_encode($normalized, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);`

export const API_METADATA_SCRIPT = String.raw`$root = '/workspace/apps/server';
require $root . '/vendor/autoload.php';
(new \Symfony\Component\Dotenv\Dotenv())->usePutenv()->load($root . '/.env.test');
$kernel = new \Kernel('test', false);
$kernel->boot();
$container = $kernel->getContainer()->get('test.service_container');
$factory = $container->get('api_platform.metadata.resource.metadata_collection_factory');
$classes = json_decode($argv[1] ?? '[]', true, 512, JSON_THROW_ON_ERROR);
$out = [];
foreach ($classes as $class) {
    if (!is_string($class) || $class === '') continue;
    try { $collections = $factory->create($class); } catch (\Throwable $e) { continue; }
    foreach ($collections as $resource) {
        $operations = $resource->getOperations();
        foreach ($operations as $name => $operation) {
            $provider = $operation->getProvider();
            $processor = $operation->getProcessor();
            $output = $operation->getOutput();
            $input = $operation->getInput();
            $operationName = method_exists($operation, 'getName') ? $operation->getName() : $name;
            $out[] = [
                'resource_class_ref' => $resource->getClass(),
                'resource_key' => $resource->getShortName(),
                'operation_name' => (new \ReflectionClass($operation))->getShortName(),
                'method' => $operation->getMethod(),
                'uri_template' => $operation->getUriTemplate(),
                'operation_id' => is_string($operationName) ? $operationName : null,
                'provider_ref' => is_string($provider) ? $provider : (is_object($provider) ? $provider::class : null),
                'processor_ref' => is_string($processor) ? $processor : (is_object($processor) ? $processor::class : null),
                'schema_ref' => is_string($output) ? $output : (is_string($input) ? $input : null),
            ];
        }
    }
}
echo json_encode($out, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);`

export interface CollectorRun {
  readonly availability: "available" | "unavailable"
  readonly stdout: string
  readonly stderr: string
  readonly stdoutBytes: Uint8Array<ArrayBufferLike>
  readonly stderrBytes: Uint8Array<ArrayBufferLike>
  readonly exitCode: number
  readonly reason?: string
  readonly executableDigests: RuntimeExecutableDigests
  readonly executableProvenance: RuntimeExecutableProvenance
}
const strictUtf8 = (bytes: Uint8Array<ArrayBufferLike>): string | null => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes as unknown as Uint8Array<ArrayBuffer>)
  } catch {
    return null
  }
}
const unavailableCollector = (reason: string, exitCode = 127, _stdoutBytes: Uint8Array<ArrayBufferLike> = new Uint8Array(), _stderrBytes: Uint8Array<ArrayBufferLike> = new TextEncoder().encode(reason), executableDigests: RuntimeExecutableDigests = NO_EXECUTABLE_DIGESTS, executableProvenance: RuntimeExecutableProvenance = NO_EXECUTABLE_PROVENANCE): CollectorRun => {
  const reasonBytes = new TextEncoder().encode(reason)
  return {
    availability: "unavailable",
    stdout: reason,
    stderr: reason,
    stdoutBytes: reasonBytes,
    stderrBytes: reasonBytes,
    exitCode,
    reason,
    executableDigests,
    executableProvenance,
  }
}

const COLLECTOR_TEST_ENV_PATH = "apps/server/.env.test"
const COLLECTOR_ENV_PATH_PATTERN = /(?:^|\/)\.env(?:$|[.-])/iu
const collectorStagePath = (path: string): boolean =>
  path === COLLECTOR_TEST_ENV_PATH ||
  (!COLLECTOR_ENV_PATH_PATTERN.test(path) &&
    (path === "apps/server/bin/console" ||
      path === "apps/server/composer.json" ||
      path === "apps/server/composer.lock" ||
      path.startsWith("apps/server/config/") ||
      path.startsWith("apps/server/src/") ||
      path.startsWith("apps/server/vendor/")))

const scannedCollectorFileIsApproved = (file: ScanFile): boolean => {
  if (file.path !== COLLECTOR_TEST_ENV_PATH) return true
  if (file.bytes === null || sourceTextSafetyReason(file.path, file.bytes) !== null) return false
  try {
    const link = lstatSync(file.absolutePath)
    return !link.isSymbolicLink() && link.isFile() && realpathSync(file.absolutePath) === file.absolutePath
  } catch {
    return false
  }
}

const stageCollectorInputs = (context: ManifestContext): string | null => {
  const files = context.scans.mono.files.filter((file) => collectorStagePath(file.path) && !file.path.startsWith("apps/server/vendor/") && effectiveIgnoreRule("mono", file.path) === null && file.availability === "available" && file.bytes !== null && !file.unsafe && scannedCollectorFileIsApproved(file))
  const vendorRoot = join(context.scans.mono.rootPath, "apps/server/vendor")
  let immutableVendorRoot: string
  try {
    immutableVendorRoot = realpathSync(vendorRoot)
  } catch {
    return null
  }
  if (!(immutableVendorRoot === "/nix/store" || immutableVendorRoot.startsWith("/nix/store/")) || !existsSync(join(immutableVendorRoot, "autoload.php"))) return null
  if (!files.some((file) => file.path === "apps/server/bin/console") || !files.some((file) => file.path === COLLECTOR_TEST_ENV_PATH)) return null
  const stage = mkdtempSync(join(tmpdir(), "parity-api-collector-"))
  try {
    for (const file of files) {
      const target = join(stage, file.path)
      mkdirSync(dirname(target), { recursive: true, mode: 0o755 })
      writeFileSync(target, file.bytes as Uint8Array, { mode: 0o644 })
    }
    const copyVendor = (source: string, target: string): void => {
      for (const entry of readdirSync(source, { withFileTypes: true })) {
        const sourceEntry = join(source, entry.name)
        const targetEntry = join(target, entry.name)
        if (entry.isSymbolicLink()) throw new Error(`collector dependency is a symbolic link: ${sourceEntry}`)
        if (entry.isDirectory()) {
          mkdirSync(targetEntry, { recursive: true, mode: 0o755 })
          copyVendor(sourceEntry, targetEntry)
        } else if (entry.isFile()) {
          const size = statSync(sourceEntry).size
          if (!Number.isSafeInteger(size) || size > 16 * 1024 * 1024) throw new Error(`collector dependency exceeds bounded read limit: ${sourceEntry}`)
          mkdirSync(dirname(targetEntry), { recursive: true, mode: 0o755 })
          writeFileSync(targetEntry, readFileSync(sourceEntry), { mode: 0o644 })
        } else {
          throw new Error(`collector dependency is not a regular file: ${sourceEntry}`)
        }
      }
    }
    const vendorTarget = join(stage, "apps/server/vendor")
    mkdirSync(vendorTarget, { recursive: true, mode: 0o755 })
    copyVendor(immutableVendorRoot, vendorTarget)
    mkdirSync(join(stage, "apps/server/var"), { recursive: true, mode: 0o755 })
    return stage
  } catch {
    rmSync(stage, { recursive: true, force: true })
    return null
  }
}

export const runTrustedPhpCollector = (
  context: ManifestContext,
  args: readonly string[],
  configured?: CollectorExecutables,
  safetyPolicy: CollectorSafetyPolicy = "generic",
): CollectorRun => {
  const selected = resolveCollectorExecutables(configured)
  if (selected === null) return unavailableCollector(configured === undefined ? "COLLECTOR_EXECUTABLE_CONFIG_MISSING" : "COLLECTOR_EXECUTABLE_INVALID")
  const executableDigests: RuntimeExecutableDigests = { php: selected.php.digest, bwrap: selected.bwrap.digest }
  const executableProvenance: RuntimeExecutableProvenance = { php: selected.php.provenance, bwrap: selected.bwrap.provenance }
  const stage = stageCollectorInputs(context)
  if (stage === null) return unavailableCollector("COLLECTOR_INPUTS_UNAVAILABLE", 127, new Uint8Array(), new TextEncoder().encode("COLLECTOR_INPUTS_UNAVAILABLE"), executableDigests, executableProvenance)
  try {
    const executableConfig: CollectorExecutables = { phpExecutable: selected.php.path, bwrapExecutable: selected.bwrap.path }
    const invocation = buildCollectorSandboxArguments(executableConfig, args, stage)
    const output = execFileSync(invocation.executable, invocation.arguments, { cwd: stage, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024, env: { PATH: "/usr/bin", HOME: "/tmp", APP_ENV: "test", APP_DEBUG: "0", COMPOSER_HOME: "/tmp" } })
    const stdout = sanitizeCollectorOutput(output, "NON_UTF8_OUTPUT", safetyPolicy, "success")
    const stderr = sanitizeCollectorOutput(new Uint8Array(), "NON_UTF8_OUTPUT", "generic", "success")
    const outputReason = stdout.reason ?? stderr.reason
    if (outputReason !== null) return unavailableCollector(outputReason, 1, stdout.bytes, stderr.bytes, executableDigests, executableProvenance)
    return { availability: "available", stdout: stdout.text, stderr: stderr.text, stdoutBytes: stdout.bytes, stderrBytes: stderr.bytes, exitCode: 0, executableDigests, executableProvenance }
  } catch (cause) {
    const error = cause as { readonly stdout?: unknown; readonly stderr?: unknown; readonly status?: number }
    const stdout = sanitizeCollectorOutput(error.stdout, "COLLECTOR_EXECUTION_FAILED", safetyPolicy, "failure")
    const stderr = sanitizeCollectorOutput(error.stderr, "COLLECTOR_EXECUTION_FAILED", "generic", "failure")
    const exitCode = typeof error.status === "number" ? error.status : 1
    const outputReason = stdout.reason ?? stderr.reason
    if (outputReason !== null) return unavailableCollector(outputReason, exitCode, stdout.bytes, stderr.bytes, executableDigests, executableProvenance)
    return unavailableCollector("COLLECTOR_EXECUTION_FAILED", exitCode, stdout.bytes, stderr.bytes, executableDigests, executableProvenance)
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

const payloadContainsUnsafe = (value: unknown, _fieldName = "field"): boolean =>
  unsafeStructuredValueReason(value) !== null

const runtimeOpenApiFromOperations = (operations: readonly RuntimeOperation[]): Record<string, unknown> => {
  const paths: Record<string, Record<string, unknown>> = Object.create(null) as Record<string, Record<string, unknown>>
  for (const operation of operations) {
    if (operation.method === null || operation.uriTemplate === null || !operation.uriTemplate.startsWith("/")) continue
    const path = paths[operation.uriTemplate] ?? (Object.create(null) as Record<string, unknown>)
    path[operation.method.toLowerCase()] = { operationId: operation.operationId, responses: { "200": { description: "OK" } } }
    paths[operation.uriTemplate] = path
  }
  return { openapi: "3.1.0", info: { title: "Runtime API", version: "1.0.0" }, paths, components: {} }
}
const collectRuntime = (context: ManifestContext, declarations: readonly ApiDeclaration[], allowFixture: boolean, configured?: CollectorExecutables, fixtureInput?: ApiRuntimeFixtureInput): RuntimeCollection => {
  const revisionRefId = context.scans.mono.revisionRefId
  const consoleFile = context.scans.mono.files.find((file) => file.path === CONSOLE_PATH)
  let consoleSourceRef: string | null = null
  const consoleRef = (): string => consoleSourceRef ??= consoleFile?.availability === "available"
    ? runtimeSourceRef(context, CONSOLE_PATH, "mono_api_runtime_observation")
    : sourceFailureRef(context, CONSOLE_PATH, "SOURCE_UNAVAILABLE", "mono_api_runtime_observation", "runtime")
  const unavailable = (
    collectorKind: string,
    command: string,
    args: readonly string[],
    reason: string,
    exitCode = 127,
    run: CollectorRun | null = null,
    outOfBand?: true,
    sourceRefOverride?: string,
  ): RuntimeCollection => {
    const reasonBytes = new TextEncoder().encode(reason)
    const observation = recordRuntimeObservation(context, { collectorKind, logicalCommandId: command, command, arguments: args, stdout: reasonBytes, stderr: reasonBytes, exitCode, result: null, availability: "unavailable", revisionRefId, executableDigests: run?.executableDigests, executableProvenance: run?.executableProvenance, ...(outOfBand === true ? { outOfBand: true as const } : {}) })
    const sourceRef = sourceRefOverride ?? consoleRef()
    const status: ApiCollectionFailure["status"] = ["UNSAFE_SOURCE", "SOURCE_PARSE_ERROR", "OPENAPI_SOURCE_PARSE_ERROR", "NON_UTF8_OUTPUT"].includes(reason) ? "source_unavailable" : "runtime_unavailable"
    return { operations: [], observation, openApiObservation: null, openApiPayload: null, sourceRefIds: [sourceRef], failures: [{ status, reasonCode: reason, rowIds: [], sourceRefIds: [sourceRef] }] }
  }
  if (allowFixture) {
    if (fixtureInput !== undefined) {
      const fixturePath = fixtureInput.path
      const failedFixture = (reason: string): RuntimeCollection => {
        const fixtureRef = fixtureRuntimeSourceRef(context, fixtureInput, false, reason)
        return unavailable("api_platform_metadata", `fixture ${fixturePath}`, [], reason, 1, null, true, fixtureRef)
      }
      const decoded = strictUtf8(fixtureInput.bytes)
      if (decoded === null) return failedFixture("NON_UTF8_OUTPUT")
      const memberScan = inspectJsonMembers(decoded)
      if (memberScan !== "valid") return failedFixture(memberScan === "duplicate" ? "UNSAFE_SOURCE" : "SOURCE_PARSE_ERROR")
      let parsed: unknown
      try {
        parsed = JSON.parse(decoded) as unknown
      } catch {
        return failedFixture("SOURCE_PARSE_ERROR")
      }
      if (payloadContainsUnsafe(parsed)) return failedFixture("UNSAFE_SOURCE")
      const operations = runtimeOperationsFromPayload(parsed)
      if (operations === null) return failedFixture("SOURCE_PARSE_ERROR")
      const fixtureRef = fixtureRuntimeSourceRef(context, fixtureInput, true)
      const observation = recordRuntimeObservation(context, { collectorKind: "api_platform_metadata", command: `fixture ${fixturePath}`, arguments: [], stdout: canonicalJson(operations), stderr: "", exitCode: 0, result: operations, availability: "available", revisionRefId, outOfBand: true })
      const openApiPayload = runtimeOpenApiFromOperations(operations)
      const openApiObservation = recordRuntimeObservation(context, { collectorKind: "openapi_projection", command: `fixture ${fixturePath}`, arguments: [], stdout: canonicalJson(openApiPayload), stderr: "", exitCode: 0, result: openApiPayload, availability: "available", revisionRefId, outOfBand: true })
      return { operations, observation, openApiObservation, openApiPayload, sourceRefIds: [fixtureRef], failures: [] }
    }
    const fixturePath = runtimeFixturePath(context)
    if (fixturePath !== null) return unavailable("api_platform_metadata", `fixture ${fixturePath}`, [], "SOURCE_UNAVAILABLE")
  }
  if (consoleFile === undefined || consoleFile.availability !== "available") return unavailable("api_platform_metadata", "api-platform-metadata", [], "RUNTIME_UNAVAILABLE")
  const resourceClasses = sortUnique(declarations.map((declaration) => declaration.resourceClassRef).filter((value): value is string => value !== null))
  const metadataArgs = ["-r", API_METADATA_SCRIPT, "--", JSON.stringify(resourceClasses)]
  const metadataRun = runTrustedPhpCollector(context, metadataArgs, configured)
  if (metadataRun.availability !== "available") return unavailable("api_platform_metadata", "api-platform-metadata", metadataArgs, metadataRun.reason ?? "RUNTIME_UNAVAILABLE", metadataRun.exitCode, metadataRun)
  let metadataPayload: unknown
  try { metadataPayload = JSON.parse(metadataRun.stdout) as unknown } catch { return unavailable("api_platform_metadata", "api-platform-metadata", metadataArgs, "SOURCE_PARSE_ERROR", metadataRun.exitCode, metadataRun) }
  if (payloadContainsUnsafe(metadataPayload)) return unavailable("api_platform_metadata", "api-platform-metadata", metadataArgs, "UNSAFE_SOURCE", 1, metadataRun)
  const operations = runtimeOperationsFromPayload(metadataPayload)
  if (operations === null) return unavailable("api_platform_metadata", "api-platform-metadata", metadataArgs, "SOURCE_PARSE_ERROR", 1, metadataRun)
  const metadataObservation = recordRuntimeObservation(context, { collectorKind: "api_platform_metadata", logicalCommandId: "api-platform-metadata", command: "api-platform-metadata", arguments: metadataArgs, stdout: canonicalJson(operations), stderr: "", exitCode: metadataRun.exitCode, result: operations, availability: "available", revisionRefId, executableDigests: metadataRun.executableDigests, executableProvenance: metadataRun.executableProvenance })
  const openApiArgs = ["-r", API_OPENAPI_SCRIPT]
  const openApiRun = runTrustedPhpCollector(context, openApiArgs, configured, "openapi")
  const sourceRef = consoleRef()
  if (openApiRun.availability !== "available") {
    const reason = openApiRun.reason ?? "RUNTIME_UNAVAILABLE"
    const reasonBytes = new TextEncoder().encode(reason)
    const openApiObservation = recordRuntimeObservation(context, { collectorKind: "openapi_projection", logicalCommandId: "api:openapi:export", command: "api:openapi:export", arguments: openApiArgs, stdout: reasonBytes, stderr: reasonBytes, exitCode: openApiRun.exitCode, result: null, availability: "unavailable", revisionRefId, executableDigests: openApiRun.executableDigests, executableProvenance: openApiRun.executableProvenance })
    const status: ApiCollectionFailure["status"] = ["NON_UTF8_OUTPUT", "OPENAPI_SOURCE_PARSE_ERROR", "UNSAFE_SOURCE"].includes(reason) ? "source_unavailable" : "runtime_unavailable"
    return { operations: [], observation: metadataObservation, openApiObservation, openApiPayload: null, sourceRefIds: [sourceRef], failures: [{ status, reasonCode: reason, rowIds: [], sourceRefIds: [sourceRef] }] }
  }
  let openApiPayload: unknown
  try { openApiPayload = JSON.parse(openApiRun.stdout) as unknown } catch {
    const reason = "OPENAPI_SOURCE_PARSE_ERROR"
    const reasonBytes = new TextEncoder().encode(reason)
    const openApiObservation = recordRuntimeObservation(context, { collectorKind: "openapi_projection", logicalCommandId: "api:openapi:export", command: "api:openapi:export", arguments: openApiArgs, stdout: reasonBytes, stderr: reasonBytes, exitCode: openApiRun.exitCode, result: null, availability: "unavailable", revisionRefId, executableDigests: openApiRun.executableDigests, executableProvenance: openApiRun.executableProvenance })
    return { operations: [], observation: metadataObservation, openApiObservation, openApiPayload: null, sourceRefIds: [sourceRef], failures: [{ status: "source_unavailable", reasonCode: reason, rowIds: [], sourceRefIds: [sourceRef] }] }
  }
  if (openApiPayloadContainsUnsafe(openApiPayload)) return unavailable("openapi_projection", "api:openapi:export", openApiArgs, "UNSAFE_SOURCE", 1, openApiRun)
  const openApiObservation = recordRuntimeObservation(context, { collectorKind: "openapi_projection", logicalCommandId: "api:openapi:export", command: "api:openapi:export", arguments: openApiArgs, stdout: openApiRun.stdoutBytes, stderr: openApiRun.stderrBytes, exitCode: openApiRun.exitCode, result: openApiPayload, availability: "available", revisionRefId, executableDigests: openApiRun.executableDigests, executableProvenance: openApiRun.executableProvenance })
  return { operations, observation: metadataObservation, openApiObservation, openApiPayload, sourceRefIds: [sourceRef], failures: [] }
}

const makeStaticRows = (context: ManifestContext, declarations: readonly ApiDeclaration[], runtime: RuntimeCollection): InventoryRow[] => declarations.map((declaration) => {
  const canonicalKey = apiCanonicalKey(declaration)
  const declarationIdentity = declarationId("mono", "mono", declaration.logicalPath, "api_operation", declaration.ordinal)
  const rowIdentity = rowId("api_operation", declarationIdentity, canonicalKey)
  const status: InventoryRow["status"] = declaration.reasonCodes.length > 0 || runtime.observation.availability === "unavailable" ? "unresolved" : "unresolved"
  const details: ApiOperationDetails = { resource_class_ref: declaration.resourceClassRef, resource_key: declaration.resourceKey, operation_name: declaration.operationName, method: declaration.method, uri_template: declaration.uriTemplate, operation_id: declaration.operationId, provider_ref: declaration.providerRef, processor_ref: declaration.processorRef, schema_ref: declaration.schemaRef, openapi_projection_ref: null }
  const reasons = runtime.observation.availability === "unavailable" ? [...declaration.reasonCodes, "RUNTIME_UNAVAILABLE"] : declaration.reasonCodes
  return { row_id: rowIdentity, declaration_id: declarationIdentity, inventory_kind: "api_operation", authority_line: "mono", canonical_key: canonicalKey, signature: apiSignature(declaration), status, observation_kinds: ["static_source"], source_ref_ids: declaration.sourceRefIds, revision_ref_ids: [context.scans.mono.revisionRefId], runtime_observation_ref_ids: [runtime.observation.runtime_observation_ref_id], coverage_ref_ids: [], accepted_intent_ref_ids: [], duplicate_group_id: null, mismatch: mismatch("unresolved", [], sortUnique(reasons)[0] ?? "RUNTIME_OPERATION_UNRESOLVED"), reason_codes: sortUnique(reasons), related_row_ids: [], details }
})

const makeRuntimeRow = (context: ManifestContext, operation: RuntimeOperation, sourceRefIds: readonly string[], observation: RuntimeObservation, ordinal: number): InventoryRow => {
  const canonicalKey = runtimeCanonicalKey(operation)
  const declarationIdentity = declarationId("mono", "mono", "runtime/api-operations.json", "runtime_api_operation", ordinal)
  const rowIdentity = rowId("api_operation", declarationIdentity, canonicalKey)
  const details: ApiOperationDetails = { resource_class_ref: operation.resourceClassRef, resource_key: operation.resourceKey, operation_name: operation.operationName, method: operation.method, uri_template: operation.uriTemplate, operation_id: operation.operationId, provider_ref: operation.providerRef, processor_ref: operation.processorRef, schema_ref: operation.schemaRef, openapi_projection_ref: null }
  return { row_id: rowIdentity, declaration_id: declarationIdentity, inventory_kind: "api_operation", authority_line: "mono", canonical_key: canonicalKey, signature: apiSignature(operation), status: "extra", observation_kinds: ["runtime_resolution"], source_ref_ids: sortUnique(sourceRefIds), revision_ref_ids: [context.scans.mono.revisionRefId], runtime_observation_ref_ids: [observation.runtime_observation_ref_id], coverage_ref_ids: [], accepted_intent_ref_ids: [], duplicate_group_id: null, mismatch: mismatch("extra", [], "RUNTIME_ONLY_SOURCE"), reason_codes: ["RUNTIME_ONLY_SOURCE"], related_row_ids: [], details }
}

const declaredValueMatchesRuntime = <Value>(declared: Value | null, runtime: Value | null): boolean =>
  declared === null || declared === runtime

const sameOperation = (left: Pick<ApiDeclaration, "resourceClassRef" | "method" | "uriTemplate" | "operationId" | "operationName">, right: RuntimeOperation): boolean =>
  left.resourceClassRef === right.resourceClassRef &&
  left.operationName === right.operationName &&
  declaredValueMatchesRuntime(left.method, right.method) &&
  declaredValueMatchesRuntime(left.uriTemplate, right.uriTemplate) &&
  declaredValueMatchesRuntime(left.operationId, right.operationId)
const sameOperationObservations = (left: Pick<ApiDeclaration, "resourceKey" | "providerRef" | "processorRef" | "schemaRef">, right: RuntimeOperation): boolean =>
  declaredValueMatchesRuntime(left.resourceKey, right.resourceKey) &&
  declaredValueMatchesRuntime(left.providerRef, right.providerRef) &&
  declaredValueMatchesRuntime(left.processorRef, right.processorRef) &&
  declaredValueMatchesRuntime(left.schemaRef, right.schemaRef)


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
    const duplicateGroupId = `dup-${sha256Hex(canonicalJson({ authority_scope: first.authority_line, inventory_kind: first.inventory_kind, canonical_key: first.canonical_key }))}`
    for (const row of group) {
      const index = rows.findIndex((candidate) => candidate.row_id === row.row_id)
      rows[index] = { ...row, status: "duplicate", duplicate_group_id: duplicateGroupId, mismatch: mismatch("duplicate", group.filter((candidate) => candidate.row_id !== row.row_id).map((candidate) => candidate.row_id), "DUPLICATE_CANONICAL_IDENTITY"), reason_codes: sortUnique([...row.reason_codes, "DUPLICATE_CANONICAL_IDENTITY"]) }
    }
  }
}

const openApiSourceRef = (context: ManifestContext): string => runtimeSourceRef(context, OPENAPI_PATH, "mono_openapi_projection")

const isOpenApiRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
const hasOwn = (value: Record<string, unknown>, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key)
const OPENAPI_METHOD_KEYS: Record<string, true> = {
  get: true,
  head: true,
  post: true,
  put: true,
  patch: true,
  delete: true,
  options: true,
  trace: true,
}
const OPENAPI_COMPONENT_KEYS: Record<string, true> = {
  schemas: true,
  responses: true,
  parameters: true,
  examples: true,
  requestBodies: true,
  headers: true,
  securitySchemes: true,
  links: true,
  callbacks: true,
  pathItems: true,
}
const OPENAPI_PATH_ITEM_KEYS: Record<string, true> = {
  $ref: true,
  summary: true,
  description: true,
  servers: true,
  parameters: true,
  ...OPENAPI_METHOD_KEYS,
}

const OPENAPI_ROUTE_KEY_PREFIX = "__openapi_route_template_"
const OPENAPI_COMPONENT_KEY_PREFIX = "__openapi_component_entry_"

const openApiRouteKeyIsUnsafe = (key: string): boolean => unsafeScalarReason(key, "route_path") !== null
const openApiPayloadIsParsedDocument = (value: unknown): value is Record<string, unknown> =>
  isOpenApiRecord(value) &&
  typeof value.openapi === "string" &&
  isOpenApiRecord(value.info) &&
  isOpenApiRecord(value.paths) &&
  isOpenApiRecord(value.components)
type OpenApiPathsMapContext = "none" | "root" | "wrapper"
type OpenApiComponentsMapContext = "none" | "document" | "section"
type OpenApiSafetyProjectionResult = { readonly value: unknown; readonly unsafe: boolean }
const OPENAPI_SCHEMA_PROPERTY_PREFIX = "__openapi_schema_property_"
const OPENAPI_SCHEMA_VALUE_KEYS: Record<string, true> = {
  example: true,
  examples: true,
  default: true,
  defaults: true,
  value: true,
  values: true,
  const: true,
  enum: true,
}
const openApiSchemaPropertyIsSensitive = (key: string): boolean => unsafeScalarReason("fixture", key) !== null
const openApiSensitiveSchemaValueUnsafe = (key: string, value: unknown): boolean =>
  unsafeStructuredValueReason({ token: { [key]: value } }) !== null
const openApiSafetyProjection = (
  value: unknown,
  pathsMap: OpenApiPathsMapContext = "none",
  atDocumentRoot = false,
  routeOrdinal = { value: 0 },
  sensitiveSchemaProperty = false,
  schemaPropertyValueRoot = false,
  componentsMap: OpenApiComponentsMapContext = "none",
): OpenApiSafetyProjectionResult => {
  if (Array.isArray(value)) {
    const projectedEntries: unknown[] = []
    for (const entry of value) {
      const projected = openApiSafetyProjection(entry, "none", false, routeOrdinal, sensitiveSchemaProperty, schemaPropertyValueRoot)
      if (projected.unsafe) return projected
      projectedEntries.push(projected.value)
    }
    return { value: projectedEntries, unsafe: false }
  }
  if (!isOpenApiRecord(value)) {
    if (schemaPropertyValueRoot && value !== null && value !== undefined && openApiSensitiveSchemaValueUnsafe("value", value)) return { value, unsafe: true }
    return { value, unsafe: false }
  }
  const projected: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  if (componentsMap === "section") {
    for (const [, component] of Object.entries(value).sort(([left], [right]) => compareByteOrder(left, right))) {
      let componentKey: string
      do {
        componentKey = `${OPENAPI_COMPONENT_KEY_PREFIX}${routeOrdinal.value}`
        routeOrdinal.value += 1
      } while (hasOwn(value, componentKey))
      const child = openApiSafetyProjection(component, "none", false, routeOrdinal, sensitiveSchemaProperty, schemaPropertyValueRoot)
      if (child.unsafe) return child
      projected[componentKey] = child.value
    }
    return { value: projected, unsafe: false }
  }
  for (const [key, entry] of Object.entries(value)) {
    if (pathsMap !== "none" && key.startsWith("/")) {
      if (openApiRouteKeyIsUnsafe(key)) return { value, unsafe: true }
      let routeKey: string
      do {
        routeKey = `${OPENAPI_ROUTE_KEY_PREFIX}${routeOrdinal.value}`
        routeOrdinal.value += 1
      } while (hasOwn(value, routeKey))
      const child = openApiSafetyProjection(entry, "none", false, routeOrdinal, sensitiveSchemaProperty)
      if (child.unsafe) return child
      projected[routeKey] = child.value
      continue
    }
    if (key === "properties" && isOpenApiRecord(entry)) {
      const projectedProperties: Record<string, unknown> = Object.create(null) as Record<string, unknown>
      for (const [propertyName, schema] of Object.entries(entry).sort(([left], [right]) => compareByteOrder(left, right))) {
        let propertyKey: string
        do {
          propertyKey = `${OPENAPI_SCHEMA_PROPERTY_PREFIX}${routeOrdinal.value}`
          routeOrdinal.value += 1
        } while (hasOwn(entry, propertyKey))
        const child = openApiSafetyProjection(
          schema,
          "none",
          false,
          routeOrdinal,
          sensitiveSchemaProperty || openApiSchemaPropertyIsSensitive(propertyName),
          true,
        )
        if (child.unsafe) return child
        projectedProperties[propertyKey] = child.value
      }
      projected[key] = projectedProperties
      continue
    }
    if (sensitiveSchemaProperty && OPENAPI_SCHEMA_VALUE_KEYS[key] === true && openApiSensitiveSchemaValueUnsafe(key, entry))
      return { value, unsafe: true }
    const childPathsMap: OpenApiPathsMapContext =
      !isOpenApiRecord(entry)
        ? "none"
        : atDocumentRoot && key === "paths"
          ? "root"
          : pathsMap === "root" && key === "paths"
            ? "wrapper"
            : "none"
    const childComponentsMap: OpenApiComponentsMapContext =
      !isOpenApiRecord(entry)
        ? "none"
        : atDocumentRoot && key === "components"
          ? "document"
          : componentsMap === "document" && OPENAPI_COMPONENT_KEYS[key] === true
            ? "section"
            : "none"
    const child = openApiSafetyProjection(entry, childPathsMap, false, routeOrdinal, sensitiveSchemaProperty, false, childComponentsMap)
    if (child.unsafe) return child
    projected[key] = child.value
  }
  return { value: projected, unsafe: false }
}
const openApiPayloadContainsUnsafe = (value: unknown): boolean => {
  if (!openApiPayloadIsParsedDocument(value)) return payloadContainsUnsafe(value)
  const projected = openApiSafetyProjection(value, "none", true)
  return projected.unsafe || payloadContainsUnsafe(projected.value)
}

const openApiRefTarget = (root: Record<string, unknown>, reference: string): unknown => {
  if (!reference.startsWith("#/components/")) return undefined
  const components = root.components
  if (!isOpenApiRecord(components)) return undefined
  let current: unknown = components
  for (const segment of reference.slice("#/components/".length).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))) {
    if (!isOpenApiRecord(current) || !hasOwn(current, segment)) return undefined
    current = current[segment]
  }
  return current
}

const openApiRefsResolvable = (root: Record<string, unknown>, value: unknown, seen = new Set<object>()): boolean => {
  if (Array.isArray(value)) return value.every((entry) => openApiRefsResolvable(root, entry, seen))
  if (!isOpenApiRecord(value)) return true
  if (seen.has(value)) return true
  seen.add(value)
  const reference = value.$ref
  if (reference !== undefined && (typeof reference !== "string" || openApiRefTarget(root, reference) === undefined)) return false
  return Object.values(value).every((entry) => openApiRefsResolvable(root, entry, seen))
}

const openApiResponseValid = (response: Record<string, unknown>): boolean => {
  if (hasOwn(response, "$ref")) {
    if (typeof response.$ref !== "string" || response.$ref.length === 0) return false
    return Object.entries(response).every(([key, value]) => key === "$ref" || (key === "summary" || key === "description") && typeof value === "string")
  }
  return hasOwn(response, "description") && typeof response.description === "string"
}

const openApiOperationValid = (operation: Record<string, unknown>): boolean => {
  if (hasOwn(operation, "operationId") && typeof operation.operationId !== "string") return false
  if (!hasOwn(operation, "responses") || !isOpenApiRecord(operation.responses) || Object.keys(operation.responses).length === 0) return false
  return Object.entries(operation.responses).every(([status, response]) =>
    (status === "default" || /^[1-5](?:\d{2}|XX)$/.test(status)) && isOpenApiRecord(response) && openApiResponseValid(response))
}

const openApiPathItemValid = (item: Record<string, unknown>): boolean => {
  for (const [key, value] of Object.entries(item)) {
    if (OPENAPI_PATH_ITEM_KEYS[key] !== true) return false
    if (OPENAPI_METHOD_KEYS[key] === true) {
      if (!isOpenApiRecord(value) || !openApiOperationValid(value)) return false
      continue
    }
    if (key === "$ref" || key === "summary" || key === "description") {
      if (typeof value !== "string" || value.length === 0) return false
      continue
    }
    if ((key === "servers" || key === "parameters") && (!Array.isArray(value) || value.some((entry) => !isOpenApiRecord(entry)))) return false
  }
  return true
}

const openApiComponentsValid = (components: Record<string, unknown>): boolean => {
  for (const [sectionName, section] of Object.entries(components)) {
    if (OPENAPI_COMPONENT_KEYS[sectionName] !== true || !isOpenApiRecord(section)) return false
    if (Object.values(section).some((entry) => !isOpenApiRecord(entry) || sectionName === "responses" && !openApiResponseValid(entry))) return false
  }
  return true
}

interface ValidOpenApiDocument {
  readonly paths: Record<string, unknown>
  readonly documentSha256: string
}

const validOpenApiDocument = (value: unknown): ValidOpenApiDocument | null => {
  if (!isOpenApiRecord(value) || openApiPayloadContainsUnsafe(value)) return null
  const openapi = value.openapi
  if (typeof openapi !== "string" || !/^3\.(?:0|1)\.\d+$/.test(openapi)) return null
  const info = value.info
  if (!isOpenApiRecord(info) || typeof info.title !== "string" || typeof info.version !== "string") return null
  const components = value.components
  if (!isOpenApiRecord(components) || !openApiComponentsValid(components)) return null
  const paths = value.paths
  if (!isOpenApiRecord(paths)) return null
  if (Object.keys(paths).some((path) => !path.startsWith("/") || !isOpenApiRecord(paths[path]) || !openApiPathItemValid(paths[path] as Record<string, unknown>))) return null
  if (!openApiRefsResolvable(value, paths) || !openApiRefsResolvable(value, components)) return null
  try {
    return { paths, documentSha256: sha256(canonicalJson(value)) }
  } catch {
    return null
  }
}

const projectedOpenApiPath = (path: string): string => {
  if (path === "/api" || path.startsWith("/api/")) return path
  if (path === "/") return "/api"
  return `/api${path.startsWith("/") ? path : `/${path}`}`
}
const safeSchema = (value: unknown, depth = 0): unknown => {
  if (depth > 12 || value === null || typeof value !== "object" || Array.isArray(value)) return null
  const object = value as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const key of ["$ref", "type", "format", "nullable"] as const) {
    const scalar = object[key]
    if (typeof scalar === "string" || typeof scalar === "boolean") {
      const safe = decodeScalar(scalar, key)
      if (!safe.unsafe) result[key] = safe.value ?? scalar
    }
  }
  if (Array.isArray(object.required)) result.required = object.required.filter((entry): entry is string => typeof entry === "string" && !payloadContainsUnsafe(entry, "field")).sort(compareByteOrder)
  if (object.items !== undefined) result.items = safeSchema(object.items, depth + 1)
  if (object.properties !== null && typeof object.properties === "object" && !Array.isArray(object.properties)) {
    result.properties = Object.fromEntries(Object.entries(object.properties as Record<string, unknown>).sort(([left], [right]) => compareByteOrder(left, right)).map(([key, schema]) => [key, safeSchema(schema, depth + 1)]))
  }
  return result
}

const responseSchemaDigest = (operation: Record<string, unknown>): string => {
  const responses = operation.responses
  const responseDigest = responses !== null && typeof responses === "object" && !Array.isArray(responses)
    ? Object.fromEntries(Object.entries(responses as Record<string, unknown>).sort(([left], [right]) => compareByteOrder(left, right)).map(([status, response]) => {
      if (response === null || typeof response !== "object" || Array.isArray(response)) return [status, null]
      const content = (response as Record<string, unknown>).content
      const contentDigest = content !== null && typeof content === "object" && !Array.isArray(content)
        ? Object.fromEntries(Object.entries(content as Record<string, unknown>).sort(([left], [right]) => compareByteOrder(left, right)).map(([media, item]) => [media, item !== null && typeof item === "object" && !Array.isArray(item) ? safeSchema((item as Record<string, unknown>).schema) : null]))
        : null
      return [status, contentDigest]
    }))
    : null
  return sha256(canonicalJson({ responses: responseDigest }))
}

interface NormalizedOpenApiDocument {
  readonly operations: readonly NormalizedOperation[]
  readonly documentSha256: string
}

const normaliseOpenApiDocument = (payload: unknown): NormalizedOpenApiDocument | null => {
  const validated = validOpenApiDocument(payload)
  if (validated === null) return null
  const operations: NormalizedOperation[] = []
  for (const path of Object.keys(validated.paths).sort(compareByteOrder)) {
    const safePath = decodeScalar(path, "route_path")
    if (safePath.unsafe || safePath.value === null) return null
    const projectedPath = projectedOpenApiPath(safePath.value)
    const item = validated.paths[path]
    if (!isOpenApiRecord(item)) return null
    for (const [rawMethod, value] of Object.entries(item).sort(([left], [right]) => compareByteOrder(left, right))) {
      const method = normaliseMethod(rawMethod)
      if (method === null) continue
      if (value === null) continue
      if (!isOpenApiRecord(value)) return null
      const operationId = decodeScalar(value.operationId, "field")
      if (operationId.unsafe) return null
      const identity = canonicalJson({ method, operation_id_or_null: operationId.value, path_template: projectedPath })
      const responseDigest = responseSchemaDigest(value)
      operations.push({ identity, digest: sha256(canonicalJson({ document_sha256: validated.documentSha256, response_schema_sha256: responseDigest })) })
    }
  }
  return { operations: operations.sort((left, right) => compareByteOrder(left.identity, right.identity) || compareByteOrder(left.digest, right.digest)), documentSha256: validated.documentSha256 }
}

const normaliseOpenApi = (payload: unknown): readonly NormalizedOperation[] | null => normaliseOpenApiDocument(payload)?.operations ?? null

const operationSetDigest = (operations: readonly NormalizedOperation[]): string => sha256(canonicalJson(operations))

const reconcileOpenApi = (context: ManifestContext, sourceManifestSha256: string, runtime: RuntimeCollection): OpenApiReconciliation => {
  const committedResult = readSourceTextDetailed(context, "mono", OPENAPI_PATH)
  const committedRef = committedResult.status === "available" ? openApiSourceRef(context) : sourceFailureRef(context, OPENAPI_PATH, committedResult.reason, "mono_openapi_projection")
  let committedDocument: NormalizedOpenApiDocument | null = null
  if (committedResult.status === "available" && inspectJsonMembers(committedResult.text) === "valid") {
    try { committedDocument = normaliseOpenApiDocument(JSON.parse(committedResult.text) as unknown) } catch { committedDocument = null }
  }
  const regeneratedDocument = runtime.openApiPayload === null ? null : normaliseOpenApiDocument(runtime.openApiPayload)
  const committed = committedDocument?.operations ?? null
  const regenerated = regeneratedDocument?.operations ?? null
  const committedByIdentity = new Map((committed ?? []).map((operation) => [operation.identity, operation.digest]))
  const regeneratedByIdentity = new Map((regenerated ?? []).map((operation) => [operation.identity, operation.digest]))
  const onlyCommitted = [...committedByIdentity.keys()].filter((key) => !regeneratedByIdentity.has(key)).sort(compareByteOrder)
  const onlyRegenerated = [...regeneratedByIdentity.keys()].filter((key) => !committedByIdentity.has(key)).sort(compareByteOrder)
  const changedOperations = [...committedByIdentity.keys()].filter((key) => regeneratedByIdentity.has(key) && committedByIdentity.get(key) !== regeneratedByIdentity.get(key)).sort(compareByteOrder)
  const documentsChanged = committedDocument !== null && regeneratedDocument !== null && committedDocument.documentSha256 !== regeneratedDocument.documentSha256
  const canCompare = committedDocument !== null && regeneratedDocument !== null
  const status: OpenApiReconciliation["status"] = !canCompare ? "unresolved" : onlyCommitted.length === 0 && onlyRegenerated.length === 0 && changedOperations.length === 0 && !documentsChanged ? "current" : "stale"
  return { $schema: "https://json-schema.org/draft/2020-12/schema", schema_version: "functional-parity-openapi-reconciliation/v1", status, source_manifest_sha256: canCompare ? sourceManifestSha256 : null, committed_source_ref_ids: [committedRef], regenerated_source_ref_ids: runtime.openApiPayload === null ? [] : runtime.sourceRefIds, committed_document_sha256: committedDocument?.documentSha256 ?? null, regenerated_document_sha256: regeneratedDocument?.documentSha256 ?? null, committed_sha256: committed === null ? null : operationSetDigest(committed), regenerated_sha256: regenerated === null ? null : operationSetDigest(regenerated), only_committed: onlyCommitted, only_regenerated: onlyRegenerated, changed_operations: changedOperations }
}
const openApiValidationFailure = (context: ManifestContext, runtime: RuntimeCollection): ApiCollectionFailure | null => {
  const committedResult = readSourceTextDetailed(context, "mono", OPENAPI_PATH)
  if (committedResult.status !== "available") {
    return { status: "source_unavailable", reasonCode: committedResult.reason, rowIds: [], sourceRefIds: [sourceFailureRef(context, OPENAPI_PATH, committedResult.reason, "mono_openapi_projection")] }
  }
  const memberScan = inspectJsonMembers(committedResult.text)
  if (memberScan !== "valid") {
    return memberScan === "duplicate"
      ? { status: "schema_invalid", reasonCode: "OPENAPI_SCHEMA_INVALID", rowIds: [], sourceRefIds: [openApiSourceRef(context)] }
      : { status: "source_unavailable", reasonCode: "OPENAPI_SOURCE_PARSE_ERROR", rowIds: [], sourceRefIds: [openApiSourceRef(context)] }
  }
  let committedPayload: unknown
  try { committedPayload = JSON.parse(committedResult.text) as unknown } catch {
    return { status: "source_unavailable", reasonCode: "OPENAPI_SOURCE_PARSE_ERROR", rowIds: [], sourceRefIds: [openApiSourceRef(context)] }
  }
  if (normaliseOpenApi(committedPayload) === null) {
    return { status: "schema_invalid", reasonCode: "OPENAPI_SCHEMA_INVALID", rowIds: [], sourceRefIds: [openApiSourceRef(context)] }
  }
  if (runtime.openApiPayload !== null && normaliseOpenApi(runtime.openApiPayload) === null) {
    return { status: "schema_invalid", reasonCode: "OPENAPI_SCHEMA_INVALID", rowIds: [], sourceRefIds: runtime.sourceRefIds }
  }
  return null
}
const openApiProjectionRef = (operation: Pick<ApiDeclaration, "method" | "uriTemplate" | "operationId"> | ApiOperationDetails | RuntimeOperation, projection: readonly NormalizedOperation[] | null): string | null => {
  if (projection === null) return null
  const operationId = "operation_id" in operation ? operation.operation_id : operation.operationId
  const uriTemplate = "uri_template" in operation ? operation.uri_template : operation.uriTemplate
  const identity = canonicalJson({ method: operation.method, operation_id_or_null: operationId, path_template: uriTemplate === null ? null : projectedOpenApiPath(uriTemplate) })
  return projection.some((candidate) => candidate.identity === identity) ? identity : null
}

interface H3Collection {
  readonly apiRows: readonly InventoryRow[]
  readonly routeRows: readonly InventoryRow[]
  readonly apiEdges: readonly DerivationEdge[]
  readonly routeEdges: readonly DerivationEdge[]
  readonly apiObservations: readonly InventoryObservation[]
  readonly routeObservations: readonly InventoryObservation[]
  readonly sourceRefIds: readonly string[]
  readonly failures: readonly ApiCollectionFailure[]
}

const h3RowSourceRefs = (context: ManifestContext, refs: readonly string[], artifactPath: string, failures: ApiCollectionFailure[], sourceManifestDigests: ReadonlyMap<string, string>): string[] => {
  const result = [runtimeSourceRef(context, artifactPath, "mono_h3_derivation")]
  for (const ref of refs) {
    const source = /^source:(.+):(\d+|\?):([a-f0-9]{64})$/i.exec(ref)
    const collector = /^collector:sha256:([a-f0-9]{64}):/i.exec(ref)
    if (source !== null) {
      const path = source[1]
      const line = source[2] === "?" ? null : Number(source[2])
      const digest = source[3]
      const file = path === undefined ? undefined : context.scans.mono.files.find((candidate) => candidate.path === path)
      if (file === undefined || file.availability !== "available" || file.digest !== `sha256:${digest}`) {
        failures.push({ status: "schema_invalid", reasonCode: "H3_SOURCE_DIGEST_MISMATCH", rowIds: [], sourceRefIds: [result[0] as string] })
        continue
      }
      if (path === undefined || sourceManifestDigests.get(path) !== `sha256:${digest}`) {
        failures.push({ status: "schema_invalid", reasonCode: "H3_SOURCE_MANIFEST_DIGEST_MISMATCH", rowIds: [], sourceRefIds: [result[0] as string] })
        continue
      }
      result.push(apiResourceSourceRef(context, path, line, line, "mono_h3_derivation"))
      continue
    }
    if (collector !== null) {
      const file = context.scans.mono.files.find((candidate) => candidate.path === H3_COLLECTOR_PATH)
      if (file === undefined || file.availability !== "available" || file.digest !== `sha256:${collector[1]}`) {
        failures.push({ status: "schema_invalid", reasonCode: "H3_COLLECTOR_DIGEST_MISMATCH", rowIds: [], sourceRefIds: [result[0] as string] })
        continue
      }
      result.push(runtimeSourceRef(context, H3_COLLECTOR_PATH, "mono_h3_derivation"))
      continue
    }
    failures.push({ status: "schema_invalid", reasonCode: "H3_SOURCE_REF_INVALID", rowIds: [], sourceRefIds: [result[0] as string] })
  }
  return sortUnique(result)
}
const sharesH3Source = (
  context: ManifestContext,
  row: InventoryRow,
  h3SourceRefs: readonly string[],
): boolean => {
  const verifiedPaths = new Set(
    h3SourceRefs.flatMap((sourceRefId) => {
      const source = context.sourcePathById.get(sourceRefId)
      return source?.rootRef === "mono" ? [source.path] : []
    }),
  )
  return row.source_ref_ids.some((sourceRefId) => {
    const source = context.sourcePathById.get(sourceRefId)
    return source?.rootRef === "mono" && verifiedPaths.has(source.path)
  })
}


const h3Path = (value: unknown): string | null => {
  if (typeof value !== "string") return null
  const safe = decodeScalar(value, "route_path")
  if (safe.unsafe || safe.value === null) return null
  const withoutApiPrefix = safe.value.startsWith("/api/") ? safe.value.slice(4) : safe.value === "/api" ? "/" : safe.value
  return withoutApiPrefix.replaceAll(".{_format}", "{._format}")
}

const h3Methods = (value: Record<string, unknown>): readonly string[] => {
  const values = Array.isArray(value.methods) ? value.methods : [value.method]
  return sortUnique(values.map(normaliseMethod).filter((method): method is string => method !== null))
}

interface H3ApiIdentity {
  readonly resourceClassRef: string | null
  readonly operationName: string | null
  readonly declarationLine: number | null
}

const h3Operation = (value: unknown): H3ApiIdentity => {
  if (typeof value !== "string") return { resourceClassRef: null, operationName: null, declarationLine: null }
  const safe = decodeScalar(value, "field")
  if (safe.unsafe || safe.value === null || !safe.value.startsWith("api:")) return { resourceClassRef: null, operationName: null, declarationLine: null }
  const body = safe.value.slice(4)
  const separator = body.indexOf(":")
  const tail = body.lastIndexOf(":")
  const declarationLine = Number(body.slice(tail + 1))
  if (separator < 1 || tail <= separator || !Number.isSafeInteger(declarationLine) || declarationLine < 1) return { resourceClassRef: null, operationName: null, declarationLine: null }
  return { resourceClassRef: body.slice(0, separator), operationName: body.slice(separator + 1, tail), declarationLine }
}
const h3RouteName = (value: unknown): string | null => {
  if (typeof value !== "string") return null
  const safe = decodeScalar(value, "field")
  if (safe.unsafe || safe.value === null || !safe.value.startsWith("route:")) return null
  return safe.value.slice(6)
}

const makeH3ApiRow = (context: ManifestContext, path: string, ordinal: number, sourceRefs: readonly string[], operation: H3ApiIdentity, methods: readonly string[], uriTemplate: string | null): InventoryRow => {
  const details: ApiOperationDetails = { resource_class_ref: operation.resourceClassRef, resource_key: null, operation_name: operation.operationName, method: methods[0] ?? null, uri_template: uriTemplate, operation_id: null, provider_ref: null, processor_ref: null, schema_ref: null, openapi_projection_ref: null }
  const canonicalKey = apiCanonicalKey({ resourceClassRef: details.resource_class_ref, operationName: details.operation_name, method: details.method, uriTemplate: details.uri_template, operationId: details.operation_id })
  const declarationIdValue = declarationId("cross_line", "mono", path, "h3_api_operation", operation.declarationLine ?? ordinal)
  return { row_id: rowId("api_operation", declarationIdValue, canonicalKey), declaration_id: declarationIdValue, inventory_kind: "api_operation", authority_line: "cross_line", canonical_key: canonicalKey, signature: apiSignature({ resourceClassRef: details.resource_class_ref, operationName: details.operation_name, method: details.method, uriTemplate: details.uri_template, operationId: details.operation_id }), status: "unresolved", observation_kinds: ["derived_h3"], source_ref_ids: sortUnique(sourceRefs), revision_ref_ids: [context.scans.mono.revisionRefId], runtime_observation_ref_ids: [], coverage_ref_ids: [], accepted_intent_ref_ids: [], duplicate_group_id: null, mismatch: mismatch("unresolved", [], "H3_UNMATCHED_DRIFT"), reason_codes: ["H3_DERIVATION_ONLY", "H3_UNMATCHED_DRIFT"], related_row_ids: [], details }
}

const makeH3RouteRow = (context: ManifestContext, path: string, ordinal: number, sourceRefs: readonly string[], routeName: string | null, methods: readonly string[], pathTemplate: string | null): InventoryRow => {
  const details: MonoRouteDetails = { declaration_kind: "imported_route", route_origin: "imported", route_name: routeName, path_template: pathTemplate, method: methods[0] ?? null, owner_ref: null, runtime_resolved: false, imported_from_ref: sourceRefs[0] ?? null }
  const canonicalKey = canonicalJson(["http_route", details.method, details.path_template, details.route_name])
  const declarationIdValue = declarationId("cross_line", "mono", path, "h3_route", ordinal)
  return { row_id: rowId("mono_route", declarationIdValue, canonicalKey), declaration_id: declarationIdValue, inventory_kind: "mono_route", authority_line: "cross_line", canonical_key: canonicalKey, signature: canonicalKey, status: "unresolved", observation_kinds: ["derived_h3"], source_ref_ids: sortUnique(sourceRefs), revision_ref_ids: [context.scans.mono.revisionRefId], runtime_observation_ref_ids: [], coverage_ref_ids: [], accepted_intent_ref_ids: [], duplicate_group_id: null, mismatch: mismatch("unresolved", [], "H3_UNMATCHED_DRIFT"), reason_codes: ["H3_DERIVATION_ONLY", "H3_UNMATCHED_DRIFT"], related_row_ids: [], details }
}

const h3Edge = (edgeName: string, edgeType: DerivationEdge["edge_type"], fromRefs: readonly string[], rowIds: readonly string[]): DerivationEdge | null => {
  const ids = sortUnique(rowIds)
  if (ids.length === 0) return null
  return { edge_id: edgeId(edgeName, fromRefs, ids), edge_type: edgeType, from_ref_ids: sortUnique(fromRefs), to_row_ids: ids, derivation: edgeName }
}

const addH3Edges = (context: ManifestContext, rows: readonly InventoryRow[], routeRows: readonly InventoryRow[]): H3Collection => {
  const apiRows = [...rows]
  const derivedRouteRows = [...routeRows]
  const apiEdges: DerivationEdge[] = []
  const routeEdges: DerivationEdge[] = []
  const apiObservations: InventoryObservation[] = []
  const routeObservations: InventoryObservation[] = []
  const sourceRefIds: string[] = []
  const failures: ApiCollectionFailure[] = []
  const supportRefs: string[] = []
  const sourceManifestDigests = new Map<string, string>()
  for (const supportPath of [H3_GENERATOR_PATH, H3_SOURCE_MANIFEST_PATH, H3_COLLECTOR_PATH] as const) {
    const decoded = readSourceTextDetailed(context, "mono", supportPath)
    if (decoded.status !== "available") {
      const ref = sourceFailureRef(context, supportPath, decoded.reason, "mono_h3_derivation", "generated")
      supportRefs.push(ref)
      failures.push({ status: "source_unavailable", reasonCode: decoded.reason, rowIds: [], sourceRefIds: [ref] })
      continue
    }
    const supportRef = addSourceReference(context, { authorityLine: "mono", authorityRole: "mono_h3_derivation", rootRef: "mono", path: supportPath, lineStart: null, lineEnd: null, symbol: null, captureMode: "generated" })
    supportRefs.push(supportRef)
    if (supportPath === H3_GENERATOR_PATH) continue
    let supportPayload: unknown
    try { supportPayload = JSON.parse(decoded.text) as unknown } catch {
      failures.push({ status: "schema_invalid", reasonCode: "H3_DERIVATION_ONLY", rowIds: [], sourceRefIds: [supportRef] })
      continue
    }
    if (supportPath === H3_SOURCE_MANIFEST_PATH) {
      if (!Array.isArray(supportPayload)) {
        failures.push({ status: "schema_invalid", reasonCode: "H3_SOURCE_MANIFEST_INVALID", rowIds: [], sourceRefIds: [supportRef] })
        continue
      }
      for (const entry of supportPayload) {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue
        const path = (entry as Record<string, unknown>).path
        const rawDigest = (entry as Record<string, unknown>).sha256
        if (typeof path !== "string" || typeof rawDigest !== "string") continue
        const digest = rawDigest.startsWith("sha256:") ? rawDigest : `sha256:${rawDigest}`
        if (!/^sha256:[0-9a-f]{64}$/i.test(digest)) continue
        sourceManifestDigests.set(path, digest.toLowerCase())
      }
    } else if (supportPath === H3_COLLECTOR_PATH && (supportPayload === null || typeof supportPayload !== "object" || Array.isArray(supportPayload))) {
      failures.push({ status: "schema_invalid", reasonCode: "H3_COLLECTOR_INVALID", rowIds: [], sourceRefIds: [supportRef] })
    }
  }
  const artifactRows: Array<{ readonly path: string; readonly kind: "route" | "resource"; readonly artifactRef: string; readonly records: readonly unknown[] }> = []
  for (const [path, kind] of [[H3_ROUTE_PATH, "route"], [H3_RESOURCE_PATH, "resource"]] as const) {
    const decoded = readSourceTextDetailed(context, "mono", path)
    const artifactRef = decoded.status === "available" ? addSourceReference(context, { authorityLine: "mono", authorityRole: "mono_h3_derivation", rootRef: "mono", path, lineStart: null, lineEnd: null, symbol: null, captureMode: "generated" }) : sourceFailureRef(context, path, decoded.reason, "mono_h3_derivation", "generated")
    sourceRefIds.push(artifactRef)
    if (decoded.status !== "available") {
      failures.push({ status: "source_unavailable", reasonCode: decoded.reason, rowIds: [], sourceRefIds: [artifactRef] })
      continue
    }
    let payload: unknown
    try { payload = JSON.parse(decoded.text) as unknown } catch {
      failures.push({ status: "schema_invalid", reasonCode: "H3_DERIVATION_ONLY", rowIds: [], sourceRefIds: [artifactRef] })
      continue
    }
    if (!Array.isArray(payload) || payload.length === 0 || payload.some((entry) => entry === null || typeof entry !== "object" || Array.isArray(entry))) {
      failures.push({ status: "schema_invalid", reasonCode: "H3_DERIVATION_ONLY", rowIds: [], sourceRefIds: [artifactRef] })
      continue
    }
    artifactRows.push({ path, kind, artifactRef, records: payload })
  }
  const seenH3Identities = new Set<string>()
  for (const artifact of artifactRows) {
    const targetIds: string[] = []
    const artifactObservationRefs = sortUnique([artifact.artifactRef, ...supportRefs])
    const artifactDigest = context.scans.mono.files.find((file) => file.path === artifact.path)?.digest ?? sha256(canonicalJson(artifact.records))
    const observation: InventoryObservation = { observation_id: observationId("derived_h3", artifactObservationRefs, artifactDigest), observation_kind: "derived_h3", source_ref_ids: artifactObservationRefs, value_digest: artifactDigest, normative: false, label: artifact.kind === "route" ? "h3_route_inventory" : "h3_resource_inventory", count: artifact.records.length }
    ;(artifact.kind === "route" ? routeObservations : apiObservations).push(observation)
    for (const [index, record] of artifact.records.entries()) {
      if (record === null || typeof record !== "object" || Array.isArray(record)) {
        failures.push({ status: "schema_invalid", reasonCode: "H3_DERIVATION_ONLY", rowIds: [], sourceRefIds: [artifact.artifactRef] })
        continue
      }
      const value = record as Record<string, unknown>
      const rawRefs = value.source_ref_ids ?? value.sourceRefIds ?? value.classification_basis_refs
      if (!Array.isArray(rawRefs) || rawRefs.length === 0 || rawRefs.some((entry) => typeof entry !== "string")) {
        failures.push({ status: "schema_invalid", reasonCode: "H3_DERIVATION_ONLY", rowIds: [], sourceRefIds: [artifact.artifactRef] })
        continue
      }
      const refs = h3RowSourceRefs(context, rawRefs as string[], artifact.path, failures, sourceManifestDigests)
      const fromRefs = sortUnique([...artifactObservationRefs, ...refs])
      const pathTemplate = h3Path(value.path_template ?? value.uri_template)
      const observedMethods = h3Methods(value)
      const methods = artifact.kind === "route" && pathTemplate !== null && observedMethods.length === 0
        ? ["ANY"]
        : observedMethods
      const rawOperationId = value.operation_id
      const operation = h3Operation(rawOperationId)
      const routeName = h3RouteName(rawOperationId)
      const h3Identity = artifact.kind === "resource"
        ? operation.resourceClassRef === null || operation.operationName === null || pathTemplate === null || methods.length === 0 ? null : canonicalJson(["api", operation.resourceClassRef, operation.operationName, pathTemplate, methods])
        : routeName === null || pathTemplate === null || methods.length === 0 ? null : canonicalJson(["route", routeName, pathTemplate, methods])
      if (h3Identity !== null) {
        if (seenH3Identities.has(h3Identity)) continue
        seenH3Identities.add(h3Identity)
      }
      if (artifact.kind === "resource") {
        const exactMatches = apiRows.filter((row) => {
          const details = row.details as ApiOperationDetails
          return details.resource_class_ref === operation.resourceClassRef && details.operation_name === operation.operationName && details.method !== null && methods.includes(details.method) && details.uri_template === pathTemplate
        })
        const sourceMatches = exactMatches.length === 0
          ? apiRows.filter((row) => {
              if (!row.observation_kinds.includes("static_source") || !sharesH3Source(context, row, refs)) return false
              const details = row.details as ApiOperationDetails
              return details.resource_class_ref === operation.resourceClassRef &&
                details.operation_name === operation.operationName &&
                details.method !== null &&
                methods.includes(details.method) &&
                (details.uri_template === null || details.uri_template === pathTemplate)
            })
          : []
        const matched = exactMatches.length > 0 ? exactMatches : sourceMatches.length === 1 ? sourceMatches : []
        if (matched.length > 0) {
          for (const row of matched) {
            const rowIndex = apiRows.findIndex((candidate) => candidate.row_id === row.row_id)
            apiRows[rowIndex] = { ...row, observation_kinds: sortUnique([...row.observation_kinds, "derived_h3"]) as InventoryRow["observation_kinds"], source_ref_ids: sortUnique([...row.source_ref_ids, ...fromRefs]) }
            targetIds.push(row.row_id)
          }
        } else {
          const derived = makeH3ApiRow(context, artifact.path, index + 1, fromRefs, operation, methods, pathTemplate)
          apiRows.push(derived)
          targetIds.push(derived.row_id)
          failures.push({ status: "schema_invalid", reasonCode: "H3_DERIVATION_ONLY", rowIds: [derived.row_id], sourceRefIds: fromRefs })
        }
      } else {
        const exactMatches = derivedRouteRows.filter((row) => {
          const details = row.details as { readonly method?: string | null; readonly path_template?: string | null; readonly route_name?: string | null }
          const method = details.method
          const methodMatches = methods.length === 0 ? method === null : typeof method === "string" && methods.includes(method)
          return h3Path(details.path_template) === pathTemplate && details.route_name === routeName && methodMatches
        })
        const sourceMatches = exactMatches.length === 0
          ? derivedRouteRows.filter((row) => {
              if (!row.observation_kinds.includes("static_source") || !sharesH3Source(context, row, refs)) return false
              const details = row.details as { readonly method?: string | null; readonly path_template?: string | null; readonly route_name?: string | null }
              const method = details.method
              const methodMatches = methods.length === 0 ? method === null : typeof method === "string" && methods.includes(method)
              return h3Path(details.path_template) === pathTemplate &&
                (details.route_name === null || details.route_name === routeName) &&
                methodMatches
            })
          : []
        const sourceMethods = sourceMatches.map((row) => {
          const details = row.details
          return "path_template" in details ? details.method : null
        })
        const sourceMethodsComplete =
          sourceMethods.length > 0 &&
          new Set(sourceMethods).size === sourceMethods.length &&
          (methods.length === 0
            ? sourceMethods.length === 1 && sourceMethods[0] === null
            : sourceMethods.length === methods.length && methods.every((method) => sourceMethods.includes(method)))
        const matched = exactMatches.length > 0 ? exactMatches : sourceMethodsComplete ? sourceMatches : []
        if (matched.length > 0) {
          for (const row of matched) {
            const rowIndex = derivedRouteRows.findIndex((candidate) => candidate.row_id === row.row_id)
            derivedRouteRows[rowIndex] = { ...row, observation_kinds: sortUnique([...row.observation_kinds, "derived_h3"]) as InventoryRow["observation_kinds"], source_ref_ids: sortUnique([...row.source_ref_ids, ...fromRefs]) }
            targetIds.push(row.row_id)
          }
        } else {
          const derived = makeH3RouteRow(context, artifact.path, index + 1, fromRefs, routeName, methods, pathTemplate)
          derivedRouteRows.push(derived)
          targetIds.push(derived.row_id)
          failures.push({ status: "schema_invalid", reasonCode: "H3_DERIVATION_ONLY", rowIds: [derived.row_id], sourceRefIds: fromRefs })
        }
      }
    }
    const canonicalTargetIds = sortUnique(targetIds)
    const canonicalization = h3Edge("E-H3-CANONICALIZATION", "derived_projection", supportRefs, canonicalTargetIds)
    const reconciliation = h3Edge("E-H3-RECONCILIATION", "reconciles", artifactObservationRefs, canonicalTargetIds)
    if (artifact.kind === "route") {
      const derivation = h3Edge("E-H3-ROUTE-DERIVATION", "observed_inventory", artifactObservationRefs, canonicalTargetIds)
      if (derivation !== null) routeEdges.push(derivation)
      if (canonicalization !== null) routeEdges.push(canonicalization)
      if (reconciliation !== null) routeEdges.push(reconciliation)
    } else {
      const derivation = h3Edge("E-H3-RESOURCE-DERIVATION", "observed_inventory", artifactObservationRefs, canonicalTargetIds)
      if (derivation !== null) apiEdges.push(derivation)
      if (canonicalization !== null) apiEdges.push(canonicalization)
      if (reconciliation !== null) apiEdges.push(reconciliation)
    }
  }
  return { apiRows, routeRows: derivedRouteRows, apiEdges: [...new Map(apiEdges.map((edge) => [edge.edge_id, edge])).values()], routeEdges: [...new Map(routeEdges.map((edge) => [edge.edge_id, edge])).values()], apiObservations, routeObservations, sourceRefIds: sortUnique(sourceRefIds), failures }
}

const makeEnvelope = (context: ManifestContext, rows: readonly InventoryRow[], links: readonly InventoryLink[], observations: readonly InventoryObservation[], edges: readonly DerivationEdge[], sourceManifestSha256: string, runtimeAvailable: boolean): InventoryEnvelope => ({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  schema_version: "functional-parity-inventory/v1",
  inventory_kind: "api_operation",
  authority_line: "mono",
  source_manifest_sha256: sourceManifestSha256,
  revision_ref_ids: [context.scans.mono.revisionRefId],
  observation_kinds: sortUnique(["static_source", ...(runtimeAvailable ? ["runtime_resolution"] : []), ...(observations.some((observation) => observation.observation_kind === "generated_projection") ? ["generated_projection"] : []), ...(edges.length > 0 ? ["derived_h3"] : [])]) as InventoryEnvelope["observation_kinds"],
  rows: [...rows].sort((left, right) => compareByteOrder(left.row_id, right.row_id) || compareByteOrder(left.canonical_key, right.canonical_key)),
  links: [...links].sort((left, right) => compareByteOrder(left.relation_id, right.relation_id)),
  observations: [...observations].sort((left, right) => compareByteOrder(left.observation_id, right.observation_id)),
  derivation_edges: [...edges].sort((left, right) => compareByteOrder(left.edge_id, right.edge_id)),
})

export const collectApiOperations = (context: ManifestContext, sourceManifestSha256: string, routeRows: readonly InventoryRow[] = [], allowFixture = false, configured?: CollectorExecutables, fixtureInput?: ApiRuntimeFixtureInput): ApiCollection => {
  const parsed = parseDeclarations(context)
  const runtime = collectRuntime(context, parsed.declarations, allowFixture, configured, fixtureInput)
  const staticRows = makeStaticRows(context, parsed.declarations, runtime)
  const runtimeRows = runtime.operations.map((operation, index) => makeRuntimeRow(context, operation, runtime.sourceRefIds, runtime.observation, index + 1))
  let rows: InventoryRow[] = [...staticRows, ...runtimeRows]
  const links: InventoryLink[] = []
  const runtimeUsed = new Set<string>()
  for (const staticRow of staticRows) {
    const declaration = parsed.declarations.find((candidate) => rowId("api_operation", declarationId("mono", "mono", candidate.logicalPath, "api_operation", candidate.ordinal), apiCanonicalKey(candidate)) === staticRow.row_id)
    if (declaration === undefined) continue
    const exactRuntimeIndex = runtime.operations.findIndex((operation, index) => !runtimeUsed.has(String(index)) && sameOperation(declaration, operation))
    const runtimeIndex = exactRuntimeIndex >= 0
      ? exactRuntimeIndex
      : runtime.operations.findIndex((operation, index) => !runtimeUsed.has(String(index)) && operation.resourceClassRef === declaration.resourceClassRef && operation.operationName === declaration.operationName)
    if (runtimeIndex < 0) {
      const index = rows.findIndex((row) => row.row_id === staticRow.row_id)
      rows[index] = { ...staticRow, status: "unresolved", mismatch: mismatch("unresolved", [], runtime.observation.availability === "available" ? "RUNTIME_OPERATION_UNRESOLVED" : "RUNTIME_UNAVAILABLE"), reason_codes: sortUnique([...staticRow.reason_codes, runtime.observation.availability === "available" ? "RUNTIME_OPERATION_UNRESOLVED" : "RUNTIME_UNAVAILABLE"]) }
      continue
    }
    runtimeUsed.add(String(runtimeIndex))
    const runtimeRow = runtimeRows[runtimeIndex]
    const runtimeOperation = runtime.operations[runtimeIndex]
    if (runtimeRow === undefined || runtimeOperation === undefined) continue
    const changed = !sameOperation(declaration, runtimeOperation) || !sameOperationObservations(declaration, runtimeOperation)
    const unresolvedReasons = staticRow.reason_codes.filter(
      (reason) =>
        !(
          reason === "URI_TEMPLATE_UNRESOLVED" &&
          declaration.uriTemplate === null &&
          runtimeOperation.uriTemplate !== null
        ),
    )
    const staticIndex = rows.findIndex((row) => row.row_id === staticRow.row_id)
    const runtimeRowIndex = rows.findIndex((row) => row.row_id === runtimeRow.row_id)
    const relation = relationId("reconciles", staticRow.row_id, runtimeRow.row_id, [...staticRow.source_ref_ids, ...runtimeRow.source_ref_ids])
    links.push({ relation_id: relation, relation_kind: "reconciles", from_row_id: staticRow.row_id, to_row_id: runtimeRow.row_id, source_ref_ids: sortUnique([...staticRow.source_ref_ids, ...runtimeRow.source_ref_ids]) })
    const status: InventoryRow["status"] = changed ? "changed" : unresolvedReasons.length > 0 ? "unresolved" : "covered"
    const reason = changed ? "STATIC_RUNTIME_MISMATCH" : unresolvedReasons[0] ?? null
    const related = [runtimeRow.row_id]
    rows[staticIndex] = { ...staticRow, status, observation_kinds: ["static_source", "runtime_resolution"], runtime_observation_ref_ids: [runtime.observation.runtime_observation_ref_id], mismatch: mismatch(changed ? "changed" : status === "unresolved" ? "unresolved" : "none", related, reason), reason_codes: reason === null ? unresolvedReasons : sortUnique([...unresolvedReasons, reason]), related_row_ids: related }
    rows[runtimeRowIndex] = { ...runtimeRow, status, mismatch: mismatch(changed ? "changed" : "none", [staticRow.row_id], reason), reason_codes: reason === null ? [] : [reason], related_row_ids: [staticRow.row_id] }
  }
  for (const [index, runtimeRow] of runtimeRows.entries()) {
    if (runtimeUsed.has(String(index))) continue
    const rowIndex = rows.findIndex((row) => row.row_id === runtimeRow.row_id)
    rows[rowIndex] = runtimeRow
  }
  applyDuplicateGroups(rows)
  const reconciliation = reconcileOpenApi(context, sourceManifestSha256, runtime)
  const generatedProjection = runtime.openApiPayload === null ? null : normaliseOpenApi(runtime.openApiPayload)
  const observations: InventoryObservation[] = [{ observation_id: observationId("runtime_resolution", runtime.sourceRefIds, runtime.observation.result_sha256), observation_kind: "runtime_resolution", source_ref_ids: runtime.sourceRefIds, value_digest: runtime.observation.result_sha256, normative: false, label: "local_api_runtime" }]
  if (runtime.openApiObservation !== null) observations.push({ observation_id: observationId("generated_projection", runtime.sourceRefIds, runtime.openApiObservation.result_sha256), observation_kind: "generated_projection", source_ref_ids: runtime.sourceRefIds, value_digest: runtime.openApiObservation.result_sha256, normative: false, label: "local_openapi_projection" })
  const projection = generatedProjection
  for (const row of rows) {
    const details = row.details as ApiOperationDetails
    const projectionRef = openApiProjectionRef(details, projection)
    if (projectionRef === null) continue
    const index = rows.findIndex((candidate) => candidate.row_id === row.row_id)
    rows[index] = { ...row, details: { ...details, openapi_projection_ref: projectionRef }, observation_kinds: row.observation_kinds.includes("generated_projection") ? row.observation_kinds : [...row.observation_kinds, "generated_projection"] }
  }
  const h3 = addH3Edges(context, rows, routeRows)
  rows = [...h3.apiRows]
  const inventory = makeEnvelope(context, rows, links, [...observations, ...h3.apiObservations], h3.apiEdges, sourceManifestSha256, runtime.observation.availability === "available")
  const failures: ApiCollectionFailure[] = [...parsed.failures, ...runtime.failures, ...h3.failures]
  for (const row of rows) {
    if (row.status === "changed") failures.push({ status: "unresolved", reasonCode: "STATIC_RUNTIME_MISMATCH", rowIds: [row.row_id, ...row.related_row_ids], sourceRefIds: row.source_ref_ids })
    else if (row.status === "unresolved") failures.push({ status: row.reason_codes.includes("RUNTIME_UNAVAILABLE") ? "runtime_unavailable" : row.reason_codes.includes("UNSAFE_SOURCE") ? "source_unavailable" : "unresolved", reasonCode: row.reason_codes[0] ?? "RUNTIME_OPERATION_UNRESOLVED", rowIds: [row.row_id], sourceRefIds: row.source_ref_ids })
    else if (row.status === "extra") failures.push({ status: "unresolved", reasonCode: "RUNTIME_ONLY_SOURCE", rowIds: [row.row_id], sourceRefIds: row.source_ref_ids })
  }
  const openApiFailure = openApiValidationFailure(context, runtime)
  if (openApiFailure !== null) failures.push(openApiFailure)
  else if (reconciliation.status === "stale") failures.push({ status: "stale", reasonCode: "STALE_OPENAPI_PROJECTION", rowIds: [], sourceRefIds: reconciliation.committed_source_ref_ids })
  else if (reconciliation.status === "unresolved") failures.push({ status: "unresolved", reasonCode: "OPENAPI_PROJECTION_UNRESOLVED", rowIds: [], sourceRefIds: reconciliation.committed_source_ref_ids })
  return { inventory, reconciliation, failures, rows, h3RouteRows: h3.routeRows, h3RouteEdges: h3.routeEdges, h3RouteObservations: h3.routeObservations }
}

export const reportFailuresFromApi = (failures: readonly ApiCollectionFailure[]): readonly ReportFailure[] => failures.map((failure) => ({ failure_id: `failure-${sha256Hex(canonicalJson({ status: failure.status, reason_code: failure.reasonCode, row_ids: sortUnique(failure.rowIds), source_ref_ids: sortUnique(failure.sourceRefIds) }))}`, status: failure.status, reason_code: failure.reasonCode, row_ids: sortUnique(failure.rowIds), source_ref_ids: sortUnique(failure.sourceRefIds), accepted_intent_ref_ids: [] }))

export const apiRowsBySignature = (inventory: InventoryEnvelope): Map<string, InventoryRow[]> => {
  const result = new Map<string, InventoryRow[]>()
  for (const row of inventory.rows) {
    const current = result.get(row.signature)
    if (current === undefined) result.set(row.signature, [row])
    else current.push(row)
  }
  return result
}
