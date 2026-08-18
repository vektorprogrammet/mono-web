import { canonicalJson, compareByteOrder, sha256, stableId } from "./canonical.js"
import type {
  AuthorityLine,
  CensusRoot,
  IgnoreRule,
  RevisionRecord,
  RootCensusRecord,
  RuntimeObservation,
  SourceManifest,
  SourceRecord,
} from "./types.js"

export interface SourceFamily {
  readonly family_id: string
  readonly authority_line: "legacy" | "mono"
  readonly authority_role: string
  readonly patterns: readonly string[]
  readonly empty_allowed: boolean
}

const RATIONALE = {
  repository_metadata: "Git administrative bytes are not application declarations.",
  dependency_cache: "Nested JavaScript dependency bytes are not first-party declarations.",
  vendor_cache: "Nested third-party dependency bytes are not first-party declarations.",
  generated_output: "Distribution output is derived and is not a declaration authority.",
  build_output: "Build output is derived and is not a declaration authority.",
  turbo_cache: "Turbo cache bytes are generated build state.",
  tool_cache: "Tool cache bytes are generated build state.",
  legacy_application_cache: "Legacy application cache is generated execution state.",
  legacy_root_cache: "Legacy root cache is generated execution state.",
  legacy_var_cache: "Legacy var cache is generated execution state.",
  legacy_var_data: "Legacy var data is generated runtime state.",
  mono_server_runtime: "Server runtime state is generated execution data.",
  legacy_application_logs: "Legacy application logs are execution evidence.",
  legacy_root_logs: "Legacy root logs are execution evidence.",
  legacy_var_logs: "Legacy var logs are execution evidence.",
  test_support: "Coverage output is test evidence, not parity authority.",
  binary_tool: "Bundled Composer is an executable tool, not a source declaration.",
} as const

type RuleSpec = Omit<IgnoreRule, "ignore_rule_id" | "authority_line"> & { readonly rule_kind: IgnoreRule["rule_kind"] }

const LEGACY_RULES: readonly RuleSpec[] = [
  { root_ref: "legacy", precedence: 10, pattern: "**/.git/**", selection: "ordered_set_difference", rule_kind: "repository_metadata", rationale: RATIONALE.repository_metadata },
  { root_ref: "legacy", precedence: 20, pattern: "**/node_modules/**", selection: "ordered_set_difference", rule_kind: "dependency_cache", rationale: RATIONALE.dependency_cache },
  { root_ref: "legacy", precedence: 21, pattern: "**/vendor/**", selection: "ordered_set_difference", rule_kind: "dependency_cache", rationale: RATIONALE.vendor_cache },
  { root_ref: "legacy", precedence: 30, pattern: "**/dist/**", selection: "ordered_set_difference", rule_kind: "generated_output", rationale: RATIONALE.generated_output },
  { root_ref: "legacy", precedence: 31, pattern: "**/build/**", selection: "ordered_set_difference", rule_kind: "generated_output", rationale: RATIONALE.build_output },
  { root_ref: "legacy", precedence: 40, pattern: "**/.turbo/**", selection: "ordered_set_difference", rule_kind: "build_cache", rationale: RATIONALE.turbo_cache },
  { root_ref: "legacy", precedence: 41, pattern: "**/.cache/**", selection: "ordered_set_difference", rule_kind: "build_cache", rationale: RATIONALE.tool_cache },
  { root_ref: "legacy", precedence: 50, pattern: "app/cache/**", selection: "ordered_set_difference", rule_kind: "runtime_cache", rationale: RATIONALE.legacy_application_cache },
  { root_ref: "legacy", precedence: 51, pattern: "cache/**", selection: "ordered_set_difference", rule_kind: "runtime_cache", rationale: RATIONALE.legacy_root_cache },
  { root_ref: "legacy", precedence: 52, pattern: "var/cache/**", selection: "ordered_set_difference", rule_kind: "runtime_cache", rationale: RATIONALE.legacy_var_cache },
  { root_ref: "legacy", precedence: 53, pattern: "var/data/**", selection: "ordered_set_difference", rule_kind: "runtime_cache", rationale: RATIONALE.legacy_var_data },
  { root_ref: "legacy", precedence: 60, pattern: "app/logs/**", selection: "ordered_set_difference", rule_kind: "runtime_log", rationale: RATIONALE.legacy_application_logs },
  { root_ref: "legacy", precedence: 61, pattern: "logs/**", selection: "ordered_set_difference", rule_kind: "runtime_log", rationale: RATIONALE.legacy_root_logs },
  { root_ref: "legacy", precedence: 62, pattern: "var/logs/**", selection: "ordered_set_difference", rule_kind: "runtime_log", rationale: RATIONALE.legacy_var_logs },
  { root_ref: "legacy", precedence: 70, pattern: "**/coverage/**", selection: "ordered_set_difference", rule_kind: "test_support", rationale: RATIONALE.test_support },
  { root_ref: "legacy", precedence: 80, pattern: "composer.phar", selection: "ordered_set_difference", rule_kind: "binary_tool", rationale: RATIONALE.binary_tool },
]

const MONO_RULES: readonly RuleSpec[] = [
  { root_ref: "mono", precedence: 10, pattern: "**/.git/**", selection: "ordered_set_difference", rule_kind: "repository_metadata", rationale: RATIONALE.repository_metadata },
  { root_ref: "mono", precedence: 20, pattern: "**/node_modules/**", selection: "ordered_set_difference", rule_kind: "dependency_cache", rationale: RATIONALE.dependency_cache },
  { root_ref: "mono", precedence: 21, pattern: "**/vendor/**", selection: "ordered_set_difference", rule_kind: "dependency_cache", rationale: RATIONALE.vendor_cache },
  { root_ref: "mono", precedence: 30, pattern: "**/dist/**", selection: "ordered_set_difference", rule_kind: "generated_output", rationale: RATIONALE.generated_output },
  { root_ref: "mono", precedence: 31, pattern: "**/build/**", selection: "ordered_set_difference", rule_kind: "generated_output", rationale: RATIONALE.build_output },
  { root_ref: "mono", precedence: 40, pattern: "**/.turbo/**", selection: "ordered_set_difference", rule_kind: "build_cache", rationale: RATIONALE.turbo_cache },
  { root_ref: "mono", precedence: 41, pattern: "**/.cache/**", selection: "ordered_set_difference", rule_kind: "build_cache", rationale: RATIONALE.tool_cache },
  { root_ref: "mono", precedence: 53, pattern: "apps/server/var/**", selection: "ordered_set_difference", rule_kind: "runtime_cache", rationale: RATIONALE.mono_server_runtime },
  { root_ref: "mono", precedence: 70, pattern: "**/coverage/**", selection: "ordered_set_difference", rule_kind: "test_support", rationale: RATIONALE.test_support },
]

export const IGNORE_RULES: readonly IgnoreRule[] = [...LEGACY_RULES.map((rule) => makeIgnoreRule("legacy", rule)), ...MONO_RULES.map((rule) => makeIgnoreRule("mono", rule))]

const routeLegacyPatterns = [
  "app/config/routing.yml",
  "app/config/routing_api.yml",
  "app/config/routing_dev.yml",
  "app/config/routing*.yml",
  "src/AppBundle/**/Controller/**/*.php",
] as const

const routeMonoPatterns = [
  "apps/server/config/routes.yaml",
  "apps/server/src/App/**/Controller/**/*.php",
] as const

export const SOURCE_FAMILIES: readonly SourceFamily[] = [
  {
    family_id: "legacy_routes",
    authority_line: "legacy",
    authority_role: "legacy_route_authority",
    patterns: routeLegacyPatterns,
    empty_allowed: false,
  },
  {
    family_id: "legacy_api_resources",
    authority_line: "legacy",
    authority_role: "legacy_api_resource_authority",
    patterns: ["src/AppBundle/**/Controller/Api/**/*.php", "src/AppBundle/**/Entity/**/*.php", "src/AppBundle/**/Form/**/*.php"],
    empty_allowed: false,
  },
  {
    family_id: "legacy_commands_writes",
    authority_line: "legacy",
    authority_role: "legacy_command_write_authority",
    patterns: ["src/AppBundle/**/Command/**/*.php", "src/AppBundle/**/Controller/**/*.php", "src/AppBundle/**/Service/**/*.php", "src/AppBundle/**/Entity/**/*.php", "src/AppBundle/**/Event/**/*.php", "src/AppBundle/**/EventSubscriber/**/*.php", "src/AppBundle/**/Repository/**/*.php", "app/config/services*.yml", "app/config/config*.yml"],
    empty_allowed: false,
  },
  {
    family_id: "legacy_schedules",
    authority_line: "legacy",
    authority_role: "legacy_schedule_authority",
    patterns: ["app/config/**/*.yml", "app/config/**/*.yaml", "src/AppBundle/**/Command/**/*.php", "src/AppBundle/**/EventSubscriber/**/*.php", ".github/workflows/**/*.yml", ".github/workflows/**/*.yaml"],
    empty_allowed: true,
  },
  {
    family_id: "legacy_integrations",
    authority_line: "legacy",
    authority_role: "legacy_integration_authority",
    patterns: ["src/AppBundle/**/Google/**/*.php", "src/AppBundle/**/Slack/**/*.php", "src/AppBundle/**/Sms/**/*.php", "src/AppBundle/**/Mailer/**/*.php", "src/AppBundle/**/Service/**/*.php", "src/AppBundle/**/Controller/**/*.php", "app/config/services*.yml"],
    empty_allowed: false,
  },
  {
    family_id: "legacy_journeys",
    authority_line: "legacy",
    authority_role: "legacy_journey_reference",
    patterns: ["docs/**/*.md", "design-specs/**/*.md"],
    empty_allowed: true,
  },
  {
    family_id: "mono_routes",
    authority_line: "mono",
    authority_role: "mono_route_authority",
    patterns: routeMonoPatterns,
    empty_allowed: false,
  },
  {
    family_id: "mono_api_resources",
    authority_line: "mono",
    authority_role: "mono_api_resource_authority",
    patterns: ["apps/server/src/App/**/Api/Resource/**/*.php", "apps/server/src/App/**/Api/State/**/*.php", "apps/server/src/App/**/Infrastructure/Entity/**/*.php"],
    empty_allowed: false,
  },
  {
    family_id: "mono_commands_writes",
    authority_line: "mono",
    authority_role: "mono_command_write_authority",
    patterns: ["apps/server/src/App/**/Infrastructure/Command/**/*.php", "apps/server/src/App/**/Controller/**/*.php", "apps/server/src/App/**/Infrastructure/Repository/**/*.php", "apps/server/src/App/**/Infrastructure/Service/**/*.php", "apps/server/src/App/**/Event/**/*.php", "apps/server/src/App/**/EventSubscriber/**/*.php", "apps/server/config/services*.yaml", "apps/server/config/packages/*.yaml"],
    empty_allowed: false,
  },
  {
    family_id: "mono_schedules",
    authority_line: "mono",
    authority_role: "mono_schedule_authority",
    patterns: [".github/workflows/**/*.yml", ".github/workflows/**/*.yaml", "infra/**/*.ts", "infra/**/*.tsx", "infra/**/*.js", "infra/**/*.mjs", "infra/**/*.yml", "infra/**/*.yaml", "apps/server/config/**/*.yaml", "apps/server/src/App/**/Infrastructure/Command/**/*.php", "apps/server/src/App/**/EventSubscriber/**/*.php"],
    empty_allowed: true,
  },
  {
    family_id: "mono_integrations",
    authority_line: "mono",
    authority_role: "mono_integration_authority",
    patterns: ["apps/server/src/App/**/Infrastructure/**/*.php", "apps/server/src/App/**/Support/**/*.php", "apps/server/src/App/**/Controller/**/*.php", "packages/**/*.ts", "packages/**/*.tsx", "packages/**/*.js", ".github/workflows/**/*.yml", ".github/workflows/**/*.yaml", "infra/**/*.ts", "infra/**/*.tsx", "infra/**/*.js", "infra/**/*.mjs"],
    empty_allowed: false,
  },
  {
    family_id: "mono_journeys",
    authority_line: "mono",
    authority_role: "mono_journey_reference",
    patterns: ["docs/**/*.md", "design-specs/**/*.md", "apps/**/routes/**/*.tsx", "apps/**/routes/**/*.ts"],
    empty_allowed: false,
  },
  {
    family_id: "mono_h3",
    authority_line: "mono",
    authority_role: "mono_h3_derivation",
    patterns: ["apps/server/tools/security-h3/0015/generate.ts", "apps/server/tools/security-h3/0015/generate.test.ts", "apps/server/tools/security-h3/0015/reason-codes.json", "apps/server/tools/security-h3/0015/schema.json", "apps/server/tools/security-h3/0015/fixtures/**/*.json", "evidence/security-h3/0015/current-route-inventory.json", "evidence/security-h3/0015/current-resource-inventory.json", "evidence/security-h3/0015/source-manifest.json", "evidence/security-h3/0015/route-collector.json", "evidence/security-h3/0015/decision-packet.json"],
    empty_allowed: false,
  },
]

export interface ScanFile {
  readonly path: string
  readonly absolutePath: string
  readonly bytes: Uint8Array | null
  readonly byteLength: number | null
  readonly digest: string | null
  readonly availability: "available" | "unavailable"
  readonly unsafe: boolean
}

export interface RootScanSnapshot {
  readonly rootRef: "legacy" | "mono"
  readonly authorityLine: "legacy" | "mono"
  readonly rootPath: string
  readonly files: readonly ScanFile[]
  readonly revision: RevisionRecord
  readonly revisionRefId: string
}

export interface ManifestContext {
  readonly scans: Readonly<Record<"legacy" | "mono", RootScanSnapshot>>
  readonly sources: SourceRecord[]
  readonly rootCensus: RootCensusRecord[]
  readonly censusRoots: CensusRoot[]
  readonly revisions: RevisionRecord[]
  readonly runtimeObservations: RuntimeObservation[]
  readonly ignoreRules: readonly IgnoreRule[]
  readonly sourceByKey: Map<string, string>
  readonly sourcePathById: Map<string, { readonly rootRef: "legacy" | "mono"; readonly path: string }>
}

function makeIgnoreRule(authorityLine: "legacy" | "mono", spec: RuleSpec): IgnoreRule {
  const identity = {
    authority_line: authorityLine,
    root_ref: spec.root_ref,
    precedence: spec.precedence,
    pattern: spec.pattern,
    selection: spec.selection,
    rule_kind: spec.rule_kind,
    rationale: spec.rationale,
  }
  return { ignore_rule_id: stableId("ignore", identity), authority_line: authorityLine, ...spec }
}

const escapeRegex = (value: string): string => value.replace(/[.+^${}()|[\]\\]/g, "\\$&")

export const literalPatternRegex = (pattern: string): RegExp => {
  let regex = "^"
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === undefined) continue
    if (char === "*" && pattern[index + 1] === "*") {
      if (pattern[index + 2] === "/") {
        regex += "(?:.*/)?"
        index += 2
      } else {
        regex += ".*"
        index += 1
      }
    } else if (char === "*") {
      regex += "[^/]*"
    } else if (char === "?") {
      regex += "[^/]"
    } else {
      regex += escapeRegex(char)
    }
  }
  return new RegExp(`${regex}$`)
}

export const matchesLiteralPattern = (path: string, pattern: string): boolean => literalPatternRegex(pattern).test(path)
const unsafePathSegmentPattern = /(?:^|\/)(?:\.env(?:$|\.)|credentials?(?:$|[._-]|\/)|secrets?(?:$|[._-]|\/)|private[-_]?keys?(?:$|[._-]|\/)|(?:raw[-_]?payloads?|payloads?|logs?|backups?|dumps?)(?:\/|$))/i
const unsafePathExtensionPattern = /\.(?:pem|key|p12|pfx|jks|keystore|sqlite|sqlite3|db|dump|bak|backup|sql|log|ndjson|har|http)$/i
const unsafeKeyPattern = /^(?:password|passwd|secret|secrets|token|access[_-]?token|refresh[_-]?token|api[_-]?key|authorization|client[_-]?secret|payload|raw[_-]?payload|user[_-]?id|account[_-]?id|customer[_-]?id|member[_-]?id|identity[_-]?id|email|phone)$/i
const identityFieldPattern = /^(?:user|account|customer|member|identity)[_-]?id(?:s)?$/i
const emailPattern = /[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})/i
const phonePattern = /\+?[0-9][0-9().\-\s]{6,}[0-9]/
const sourcePhonePattern = /\+[0-9][0-9().\-\s]{6,}[0-9]/
const knownCredentialTokenPattern = /(?:^|[^A-Za-z0-9])(?:sk_(?:live|test)_[A-Za-z0-9]{8,}|gh[pous]_[A-Za-z0-9]{8,}|github[_-]?token(?:[_-][A-Za-z0-9]+)+|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{8,}|AIza[0-9A-Za-z_-]{20,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|(?:Bearer|Basic)\s+[A-Za-z0-9\-._~+/]+={0,})(?![A-Za-z0-9\-._~+/=])/i
const credentialAssignmentPattern = /(?:^|[\s?&#,/[{])(?:password|passwd|secret|secrets|token|access[_-]?token|refresh[_-]?token|api[_-]?key|authorization|client[_-]?secret)\s*[:=]\s*[^\s,}\]]+/i
const colonCredentialAssignmentPattern = /:(?:password|passwd|secret|secrets|token|access[_-]?token|refresh[_-]?token|api[_-]?key|authorization|client[_-]?secret)\s*=\s*[^\s,}\]]+/i

/** Returns true only for source path classes that must be blocked before hashing. */
export const isUnsafeSourcePath = (path: string): boolean => {
  const normalized = path.replaceAll("\\", "/")
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1)
  return unsafePathSegmentPattern.test(normalized) || unsafePathExtensionPattern.test(basename)
}

const isReservedEmail = (_value: string, match: RegExpMatchArray): boolean => {
  const domain = (match[1] ?? "").toLowerCase()
  return domain === "example.com" || domain === "example.org" || domain === "example.net" || domain === "example.invalid" || domain === "example.test" || domain === "localhost" || domain.endsWith(".invalid") || domain.endsWith(".test")
}

const hasHighEntropySecretShape = (value: string): boolean => {
  if (value.length < 32 || /^[a-f0-9]{32,}$/i.test(value)) return false
  let classes = 0
  if (/[a-z]/.test(value)) classes += 1
  if (/[A-Z]/.test(value)) classes += 1
  if (/[0-9]/.test(value)) classes += 1
  if (/[^A-Za-z0-9]/.test(value)) classes += 1
  return classes >= 3
}
const unsafeSourceSymbol = (value: string): boolean => {
  if (knownCredentialTokenPattern.test(value)) return true
  const controller = value.match(/(?:^|\\)([A-Za-z0-9_!@#$%^&*]{32,})Controller(?:::|$)/)
  return controller !== null && hasHighEntropySecretShape(controller[1] ?? "")
}

const frameworkPlaceholderPattern = /^(?:\{[^{}]+\}|<[^<>]+>|:[A-Za-z_][A-Za-z0-9_-]*)$/
const credentialRouteContextPattern = /(?:^|\/)(?:reset|verify|invite|activation|confirm|password-reset|magic|magic-link)(?:[-_]|\/|$)/i
const longHexAssetSegmentPattern = /^(?=[a-f0-9]{32,}$)(?=.*[a-f])[a-f0-9]+$/i
export type ScalarContext = "route_path" | "route_name" | "controller" | "owner" | "resource" | "source_path" | "source_symbol" | "field"

const scalarContext = (fieldName: string | undefined, source: boolean): ScalarContext => {
  const field = fieldName?.trim().toLowerCase() ?? ""
  if (source) {
    if (field === "path" || field === "source_path") return "source_path"
    if (field === "symbol" || field === "source_symbol") return "source_symbol"
    if (field === "owner" || field === "owner_ref") return "owner"
    return "field"
  }
  if (field === "path" || field === "route_path") return "route_path"
  if (field === "name" || field === "route_name") return "route_name"
  if (field === "controller" || field === "_controller") return "controller"
  if (field === "owner" || field === "owner_ref" || field === "symbol") return "owner"
  if (field === "resource") return "resource"
  return "field"
}

const stripFrameworkPlaceholders = (value: string, context: ScalarContext): string => {
  if (context !== "route_path") return value
  return value.replace(/\{[^{}]+\}|<[^<>]+>|(?:^|\/):[A-Za-z_][A-Za-z0-9_-]*(?=$|\/)/g, "")
}
const explicitUnsafeScalarReason = (normalized: string, context: ScalarContext, rawField: string): "UNSAFE_SOURCE" | null => {
  const literal = stripFrameworkPlaceholders(normalized, context)
  if (identityFieldPattern.test(rawField) && /^(?:\d{1,12}|[A-Za-z]{1,3}\d{1,8})$/.test(literal)) return "UNSAFE_SOURCE"
  if (knownCredentialTokenPattern.test(literal)) return "UNSAFE_SOURCE"
  if (credentialAssignmentPattern.test(literal) || colonCredentialAssignmentPattern.test(literal)) return "UNSAFE_SOURCE"
  if (unsafeKeyPattern.test(rawField)) return "UNSAFE_SOURCE"
  if (context === "route_path") {
    const query = normalized.match(/[?&](password|passwd|secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|authorization|client[_-]?secret)=([^&#]*)/i)
    if (query !== null && query[2] !== undefined && !frameworkPlaceholderPattern.test(query[2]) && query[2].length > 0) return "UNSAFE_SOURCE"
    const pathSecret = normalized.match(/(?:^|[/?&#])(password|passwd|secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|authorization|client[_-]?secret)(?:=|\/)([^/?&#]+)/i)
    if (pathSecret !== null && pathSecret[2] !== undefined && !frameworkPlaceholderPattern.test(pathSecret[2]) && pathSecret[2].length > 0) return "UNSAFE_SOURCE"
  }
  const emails = normalized.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []
  if (emails.some((candidate) => {
    const match = candidate.match(emailPattern)
    return match !== null && !isReservedEmail(candidate, match)
  })) return "UNSAFE_SOURCE"
  return null
}

/** Returns a sanitized failure reason without returning the unsafe scalar. */
export const unsafeScalarReason = (value: string, fieldName?: string): "UNSAFE_SOURCE" | null => {
  const normalized = value.trim().normalize("NFC")
  if (normalized.length === 0) return null
  const rawField = fieldName?.trim() ?? ""
  const context = scalarContext(rawField, false)
  const explicit = explicitUnsafeScalarReason(normalized, context, rawField)
  if (context === "owner" && unsafeSourceSymbol(normalized)) return "UNSAFE_SOURCE"
  if (explicit !== null) return explicit
  const segments = normalized.split(/[/?&#]/)
  if (segments.some((segment) => phonePattern.test(segment) && !longHexAssetSegmentPattern.test(segment))) return "UNSAFE_SOURCE"
  if (context === "route_path") {
    if (credentialRouteContextPattern.test(normalized) && segments.some((segment) => /^[a-f0-9]{32,}$/i.test(segment))) return "UNSAFE_SOURCE"
    if (segments.some((segment) => hasHighEntropySecretShape(segment) && !frameworkPlaceholderPattern.test(segment))) return "UNSAFE_SOURCE"
  }
  return null
}

/** Returns a source-path/scalar failure reason without generic entropy detection. */
export const unsafeSourceScalarReason = (value: string, fieldName?: string): "UNSAFE_SOURCE" | null => {
  const normalized = value.trim().normalize("NFC")
  if (normalized.length === 0) return null
  const rawField = fieldName?.trim() ?? ""
  const context = scalarContext(rawField, true)
  if ((context === "owner" || context === "source_symbol") && unsafeSourceSymbol(normalized)) return "UNSAFE_SOURCE"
  if (sourcePhonePattern.test(normalized)) return "UNSAFE_SOURCE"
  return explicitUnsafeScalarReason(normalized, context, rawField)
}
/** Returns a sanitized source failure before unsafe content can enter a digest or row. */
export const unsafeSourceTextReason = (value: Uint8Array | string): "UNSAFE_SOURCE" | null => {
  let text: string
  try {
    text = typeof value === "string" ? value : new TextDecoder("utf-8", { fatal: true }).decode(value)
  } catch {
    return null
  }
  if (knownCredentialTokenPattern.test(text) || credentialAssignmentPattern.test(text) || colonCredentialAssignmentPattern.test(text)) return "UNSAFE_SOURCE"
  if (/(?:["']?(?:payload|raw[_-]?payload|user[_-]?id|account[_-]?id|customer[_-]?id|email|phone)["']?)\s*[:=]/i.test(text)) return "UNSAFE_SOURCE"
  const emails = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []
  if (emails.some((candidate) => {
    const match = candidate.match(emailPattern)
    return match !== null && !isReservedEmail(candidate, match)
  })) return "UNSAFE_SOURCE"
  if (sourcePhonePattern.test(text)) return "UNSAFE_SOURCE"
  return null
}


/** Returns null instead of emitting a credential, identity, or raw payload scalar. */
export const sanitizeScalar = (value: string, fieldName?: string): string | null => unsafeScalarReason(value, fieldName) === null ? value.trim().normalize("NFC") : null

const sortedRulesFor = (rootRef: "legacy" | "mono"): readonly IgnoreRule[] =>
  IGNORE_RULES.filter((rule) => rule.root_ref === rootRef).sort((a, b) => a.precedence - b.precedence || compareByteOrder(a.pattern, b.pattern) || compareByteOrder(a.ignore_rule_id, b.ignore_rule_id))

export const effectiveIgnoreRule = (rootRef: "legacy" | "mono", path: string): IgnoreRule | null => {
  const rules = sortedRulesFor(rootRef)
  const matched = new Set<string>()
  for (const rule of rules) {
    if (matchesLiteralPattern(path, rule.pattern) && !matched.has(path)) return rule
    if (matchesLiteralPattern(path, rule.pattern)) matched.add(path)
  }
  return null
}

const REDACTED_SOURCE_SCALAR = "unsafe-source-redacted"

const redactedStructuralScalar = (value: string | null, fieldName: string): { readonly value: string | null; readonly unsafe: boolean } => {
  if (value === null) return { value: null, unsafe: false }
  const normalized = value.trim().normalize("NFC")
  if (normalized === REDACTED_SOURCE_SCALAR) return { value: normalized, unsafe: true }
  if (unsafeSourceScalarReason(normalized, fieldName) === null) return { value: normalized, unsafe: false }
  return { value: REDACTED_SOURCE_SCALAR, unsafe: true }
}

const sourceKey = (authorityLine: AuthorityLine, role: string, rootRef: string, path: string, lineStart: number | null, lineEnd: number | null, symbol: string | null): string => canonicalJson({ authority_line: authorityLine, authority_role: role, root_ref: rootRef, path, line_start: lineStart, line_end: lineEnd, symbol })

const makeSource = (context: ManifestContext, params: {
  readonly authorityLine: AuthorityLine
  readonly authorityRole: string
  readonly rootRef: "legacy" | "mono"
  readonly path: string
  readonly lineStart: number | null
  readonly lineEnd: number | null
  readonly symbol: string | null
  readonly captureMode?: SourceRecord["capture_mode"]
  readonly failureStatus?: SourceRecord["failure_status"]
  readonly failureReason?: string | null
}): SourceRecord => {
  const safePath = redactedStructuralScalar(params.path, "source_path")
  const safeSymbol = redactedStructuralScalar(params.symbol, "source_symbol")
  const path = safePath.value ?? "unsafe-source-null"
  const symbol = safeSymbol.value
  const key = sourceKey(params.authorityLine, params.authorityRole, params.rootRef, path, params.lineStart, params.lineEnd, symbol)
  const existing = context.sourceByKey.get(key)
  if (existing !== undefined) {
    const found = context.sources.find((source) => source.source_id === existing)
    if (found !== undefined) return found
  }
  const scanFile = context.scans[params.rootRef].files.find((file) => file.path === path)
  const unsafe = safePath.unsafe || safeSymbol.unsafe || scanFile?.unsafe === true
  const unavailable = scanFile === undefined || scanFile.availability === "unavailable" || unsafe
  const classificationStatus = params.failureReason === "UNCLASSIFIED_SOURCE" ? "unclassified" as const : "classified" as const
  const sourceId = stableId("src", { authority_line: params.authorityLine, authority_role: params.authorityRole, repository_ref: params.rootRef, revision_ref_id: context.scans[params.rootRef].revisionRefId, path, line_start: params.lineStart, line_end: params.lineEnd, symbol })
  const recordBase = {
    source_id: sourceId,
    authority_line: params.authorityLine,
    authority_role: params.authorityRole,
    repository_ref: params.rootRef,
    revision_ref_id: context.scans[params.rootRef].revisionRefId,
    path,
    line_start: params.lineStart,
    line_end: params.lineEnd,
    symbol,
    byte_length: unavailable ? null : scanFile?.byteLength ?? null,
    sha256: unavailable ? null : scanFile?.digest ?? null,
    capture_mode: params.captureMode ?? "static",
    availability: unavailable ? "unavailable" as const : "available" as const,
    classification_status: classificationStatus,
  }
  const record: SourceRecord = unavailable || params.failureStatus !== undefined || params.failureReason !== undefined
    ? { ...recordBase, failure_status: params.failureStatus ?? (unsafe ? "source_unavailable" : classificationStatus === "unclassified" ? "unresolved" : "source_unavailable"), failure_reason: params.failureReason ?? (unsafe ? "UNSAFE_SOURCE" : unavailable ? "SOURCE_UNAVAILABLE" : null) }
    : recordBase
  context.sourceByKey.set(key, record.source_id)
  context.sourcePathById.set(record.source_id, { rootRef: params.rootRef, path })
  context.sources.push(record)
  return record
}
export const addSourceReference = (context: ManifestContext, params: Parameters<typeof makeSource>[1]): string => makeSource(context, params).source_id

export type SourceTextResult =
  | { readonly status: "available"; readonly text: string }
  | { readonly status: "unavailable"; readonly reason: "SOURCE_UNAVAILABLE" | "INVALID_UTF8" }

export const readSourceTextDetailed = (context: ManifestContext, rootRef: "legacy" | "mono", path: string): SourceTextResult => {
  const scan = context.scans[rootRef].files.find((file) => file.path === path)
  if (scan === undefined || scan.availability === "unavailable" || scan.bytes === null) return { status: "unavailable", reason: "SOURCE_UNAVAILABLE" }
  try {
    return { status: "available", text: new TextDecoder("utf-8", { fatal: true }).decode(scan.bytes) }
  } catch {
    return { status: "unavailable", reason: "INVALID_UTF8" }
  }
}

export const readSourceText = (context: ManifestContext, rootRef: "legacy" | "mono", path: string): string | null => {
  const result = readSourceTextDetailed(context, rootRef, path)
  return result.status === "available" ? result.text : null
}

const sourceFamiliesFor = (rootRef: "legacy" | "mono"): readonly SourceFamily[] => SOURCE_FAMILIES.filter((family) => family.authority_line === rootRef)

const makeRootCensus = (context: ManifestContext, scan: RootScanSnapshot): void => {
  const familyMatches = sourceFamiliesFor(scan.rootRef)
  for (const file of scan.files) {
    const ignore = effectiveIgnoreRule(scan.rootRef, file.path)
    if (ignore !== null && !file.unsafe) {
      context.rootCensus.push({
        census_id: stableId("census", { authority_line: scan.authorityLine, root_ref: scan.rootRef, path: file.path, byte_length: file.byteLength, sha256: file.digest, availability: file.availability, classification: "ignored", source_ref_ids: [], ignore_rule_id: ignore.ignore_rule_id }),
        authority_line: scan.authorityLine,
        root_ref: scan.rootRef,
        path: file.path,
        byte_length: file.availability === "available" ? file.byteLength : null,
        sha256: file.availability === "available" ? file.digest : null,
        availability: file.availability,
        classification: "ignored",
        source_ref_ids: [],
        ignore_rule_id: ignore.ignore_rule_id,
      })
      continue
    }
    const unsafe = file.unsafe || unsafeSourceScalarReason(file.path, "source_path") !== null
    const availability = file.availability
    const sources: string[] = []
    const censusSource = makeSource(context, { authorityLine: scan.authorityLine, authorityRole: "census_all_regular_files", rootRef: scan.rootRef, path: file.path, lineStart: null, lineEnd: null, symbol: null, failureStatus: availability === "unavailable" ? "source_unavailable" : undefined, failureReason: unsafe ? "UNSAFE_SOURCE" : availability === "unavailable" ? "SOURCE_UNAVAILABLE" : undefined })
    sources.push(censusSource.source_id)
    for (const family of familyMatches) {
      if (!family.patterns.some((pattern) => matchesLiteralPattern(file.path, pattern))) continue
      const source = makeSource(context, { authorityLine: scan.authorityLine, authorityRole: family.authority_role, rootRef: scan.rootRef, path: file.path, lineStart: null, lineEnd: null, symbol: null, failureStatus: availability === "unavailable" ? "source_unavailable" : undefined, failureReason: unsafe ? "UNSAFE_SOURCE" : availability === "unavailable" ? "SOURCE_UNAVAILABLE" : undefined })
      sources.push(source.source_id)
    }
    const classification = availability === "available" ? "matched" as const : "unclassified" as const
    const censusIdentity = { authority_line: scan.authorityLine, root_ref: scan.rootRef, path: file.path, byte_length: availability === "available" ? file.byteLength : null, sha256: availability === "available" ? file.digest : null, availability, classification, source_ref_ids: sources, ignore_rule_id: null }
    const censusId = stableId("census", censusIdentity)
    context.rootCensus.push({
      authority_line: scan.authorityLine,
      census_id: censusId,
      root_ref: scan.rootRef,
      path: file.path,
      byte_length: availability === "available" ? file.byteLength : null,
      sha256: availability === "available" ? file.digest : null,
      availability,
      classification,
      source_ref_ids: sources,
      ignore_rule_id: null,
    })
  }
  for (const family of familyMatches) {
    const matched = scan.files.some((file) => !file.unsafe && effectiveIgnoreRule(scan.rootRef, file.path) === null && family.patterns.some((pattern) => matchesLiteralPattern(file.path, pattern)))
    if (matched || family.empty_allowed) continue
    for (const pattern of family.patterns) {
      const source = makeSource(context, { authorityLine: scan.authorityLine, authorityRole: family.authority_role, rootRef: scan.rootRef, path: pattern, lineStart: null, lineEnd: null, symbol: null, failureStatus: "source_unavailable", failureReason: "SOURCE_UNAVAILABLE" })
      if (!context.sources.some((entry) => entry.source_id === source.source_id)) context.sources.push(source)
    }
  }
}

export const createManifestContextFromSnapshots = (legacy: RootScanSnapshot, mono: RootScanSnapshot): ManifestContext => {
  const context: ManifestContext = {
    scans: { legacy, mono },
    sources: [],
    rootCensus: [],
    censusRoots: [
      { root_ref: "legacy", authority_line: "legacy", repository_ref: "legacy", revision_ref_id: legacy.revisionRefId, root_kind: "repository", scan_mode: "all_regular_files" },
      { root_ref: "mono", authority_line: "mono", repository_ref: "mono", revision_ref_id: mono.revisionRefId, root_kind: "repository", scan_mode: "all_regular_files" },
    ],
    revisions: [legacy.revision, mono.revision],
    runtimeObservations: [],
    ignoreRules: IGNORE_RULES,
    sourceByKey: new Map(),
    sourcePathById: new Map(),
  }
  makeRootCensus(context, legacy)
  makeRootCensus(context, mono)
  return context
}

export const finalizeManifest = (context: ManifestContext): SourceManifest => {
  const sources = [...context.sources].sort((a, b) => compareByteOrder(a.source_id, b.source_id))
  const rootCensus = [...context.rootCensus].sort((a, b) => compareByteOrder(a.census_id, b.census_id))
  const ignoreRules = [...context.ignoreRules].sort((a, b) => compareByteOrder(a.root_ref, b.root_ref) || a.precedence - b.precedence || compareByteOrder(a.pattern, b.pattern) || compareByteOrder(a.ignore_rule_id, b.ignore_rule_id))
  const censusRoots = [...context.censusRoots].sort((a, b) => compareByteOrder(a.root_ref, b.root_ref))
  const revisions = [...context.revisions].sort((a, b) => compareByteOrder(a.revision_ref_id, b.revision_ref_id))
  const runtimeObservations = [...context.runtimeObservations].sort((a, b) => compareByteOrder(a.runtime_observation_ref_id, b.runtime_observation_ref_id))
  const logical = { census_roots: censusRoots, revisions, runtime_observations: runtimeObservations, root_census: rootCensus, ignore_rules: ignoreRules, sources }
  const sourceSetSha = sha256(canonicalJson(logical))
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    schema_version: "functional-parity-source-manifest/v1",
    manifest_id: stableId("source-manifest", { source_set: "legacy-and-mono-functional-parity", source_set_sha256: sourceSetSha }),
    source_set: "legacy-and-mono-functional-parity",
    census_roots: censusRoots,
    revisions,
    runtime_observations: runtimeObservations,
    root_census: rootCensus,
    ignore_rules: ignoreRules,
    sources,
    source_set_sha256: sourceSetSha,
  }
}

export const sourceDigestForManifest = (manifest: SourceManifest): string => sha256(canonicalJson(manifest))

export const sourceById = (manifest: SourceManifest, sourceId: string): SourceRecord | undefined => manifest.sources.find((source) => source.source_id === sourceId)

export const sourceRelativePath = (manifest: SourceManifest, sourceId: string): string | null => sourceById(manifest, sourceId)?.path ?? null

export const rootRevision = (context: ManifestContext, rootRef: "legacy" | "mono"): RevisionRecord => context.scans[rootRef].revision

export const sourceFamilyMatchedPaths = (context: ManifestContext, family: SourceFamily): readonly string[] => {
  const scan = context.scans[family.authority_line]
  return scan.files.filter((file) => effectiveIgnoreRule(scan.rootRef, file.path) === null && family.patterns.some((pattern) => matchesLiteralPattern(file.path, pattern))).map((file) => file.path).sort(compareByteOrder)
}

export const censusUnclassifiedCount = (manifest: SourceManifest): number => manifest.root_census.filter((record) => record.classification === "unclassified").length
