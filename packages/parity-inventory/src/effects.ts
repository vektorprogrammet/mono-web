import { parseDocument } from "yaml"
import {
  canonicalJson,
  compareByteOrder,
  declarationId,
  duplicateGroupId,
  edgeId,
  observationId,
  relationId,
  rowId,
  sha256,
  sortUnique,
} from "./canonical.js"
import {
  addSourceReference,
  effectiveIgnoreRule,
  matchesLiteralPattern,
  readSourceText,
  SOURCE_FAMILIES,
  sanitizeScalar,
  unsafeScalarReason,
  type ManifestContext,
} from "./source-manifest.js"
import type {
  CommandWriteDetails,
  ExternalIntegrationDetails,
  InventoryEnvelope,
  InventoryLink,
  InventoryObservation,
  InventoryRow,
  Mismatch,
  ScheduleBackgroundDetails,
} from "./types.js"

export type EffectClass = CommandWriteDetails["effect_classes"][number]
export type C2FailureStatus = "gaps_found" | "unresolved" | "source_unavailable"

export interface C2CollectionFailure {
  readonly status: C2FailureStatus
  readonly reasonCode: string
  readonly rowIds: readonly string[]
  readonly sourceRefIds: readonly string[]
}

export interface C2Collection {
  readonly commandWrites: InventoryEnvelope
  readonly schedules: InventoryEnvelope
  readonly integrations: InventoryEnvelope
  readonly failures: readonly C2CollectionFailure[]
  readonly rows: readonly InventoryRow[]
}

interface SourceUnit {
  readonly authority: "legacy" | "mono"
  readonly path: string
  readonly text: string
  readonly sourceRefId: string
  readonly sourceRefIds: readonly string[]
}

interface ParsedRow {
  readonly row: InventoryRow
  readonly path: string
  readonly sourceRefIds: readonly string[]
  readonly ownerRef: string | null
  readonly imported: boolean
  readonly importerPath: string | null
}

interface IntegrationCall {
  readonly authority: "legacy" | "mono"
  readonly path: string
  readonly sourceRefId: string
  readonly ownerRef: string | null
  readonly symbolRef: string | null
  readonly providerRef: string | null
  readonly direction: ExternalIntegrationDetails["direction"]
  readonly protocol: string | null
  readonly endpointRef: string | null
  readonly credentialSlotRef: string | null
  readonly effectClasses: readonly EffectClass[]
  readonly reasonCodes: readonly string[]
  readonly imported: boolean
  readonly importerPath: string | null
  readonly line: number
}

const C2_FAMILY_IDS = {
  legacyCommands: "legacy_commands_writes",
  monoCommands: "mono_commands_writes",
  legacySchedules: "legacy_schedules",
  monoSchedules: "mono_schedules",
  legacyIntegrations: "legacy_integrations",
  monoIntegrations: "mono_integrations",
} as const

const familyFor = (authority: "legacy" | "mono", familyId: string) => SOURCE_FAMILIES.find((family) => family.authority_line === authority && family.family_id === familyId)

const pathsForFamily = (context: ManifestContext, authority: "legacy" | "mono", familyId: string): readonly string[] => {
  const family = familyFor(authority, familyId)
  if (family === undefined) return []
  return context.scans[authority].files
    .filter((file) => !file.unsafe && effectiveIgnoreRule(authority, file.path) === null)
    .filter((file) => family.patterns.some((pattern) => matchesLiteralPattern(file.path, pattern)))
    .filter((file) => context.rootCensus.some((record) => record.root_ref === authority && record.path === file.path && record.classification === "matched"))
    .map((file) => file.path)
    .sort(compareByteOrder)
}

const sourceRefFor = (
  context: ManifestContext,
  authority: "legacy" | "mono",
  role: string,
  path: string,
  lineStart: number | null,
  lineEnd: number | null,
  symbol: string | null,
  failureReason?: string,
): string => addSourceReference(context, {
  authorityLine: authority,
  authorityRole: role,
  rootRef: authority,
  path,
  lineStart,
  lineEnd,
  symbol,
  ...(failureReason === undefined ? {} : { failureStatus: "unresolved" as const, failureReason }),
})

const lineAt = (text: string, offset: number): number => {
  let line = 1
  for (let index = 0; index < offset; index += 1) if (text[index] === "\n") line += 1
  return line
}

const normalizeSafe = (value: string | null, fieldName: string, reasons: string[]): string | null => {
  if (value === null) return null
  const normalized = sanitizeScalar(value, fieldName)
  if (normalized === null) reasons.push("UNSAFE_SOURCE")
  return normalized
}

const namespaceOf = (text: string): string | null => {
  const match = /\bnamespace\s+([^;\s]+)\s*;/i.exec(withoutComments(text))
  return match?.[1] ?? null
}

const classMatches = (text: string): readonly { readonly name: string; readonly offset: number }[] => {
  const result: Array<{ readonly name: string; readonly offset: number }> = []
  const pattern = /\bclass\s+([A-Za-z_][A-Za-z0-9_]*)/g
  for (const match of withoutComments(text).matchAll(pattern)) {
    const name = match[1]
    if (name !== undefined && match.index !== undefined) result.push({ name, offset: match.index })
  }
  return result
}

const functionMatches = (text: string, start: number, end: number): readonly { readonly name: string; readonly offset: number }[] => {
  const result: Array<{ readonly name: string; readonly offset: number }> = []
  const body = withoutComments(text).slice(start, end)
  const pattern = /\bfunction\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g
  for (const match of body.matchAll(pattern)) {
    const name = match[1]
    if (name !== undefined && match.index !== undefined) result.push({ name, offset: start + match.index })
  }
  return result
}

const classOwner = (text: string, name: string, reasons: string[]): string | null => {
  const namespace = namespaceOf(text)
  const raw = namespace === null ? name : `${namespace}\\${name}`
  return normalizeSafe(raw, "owner_ref", reasons)
}

const ownerShortName = (owner: string | null): string | null => {
  if (owner === null) return null
  const pieces = owner.split("\\")
  return pieces.at(-1) ?? owner
}

const sourceUnits = (context: ManifestContext, authority: "legacy" | "mono", familyId: string, role: string): { readonly units: readonly SourceUnit[]; readonly failures: readonly C2CollectionFailure[] } => {
  const paths = pathsForFamily(context, authority, familyId)
  const units: SourceUnit[] = []
  const failures: C2CollectionFailure[] = []
  for (const path of paths) {
    const sourceRefId = sourceRefFor(context, authority, role, path, null, null, null)
    const text = readSourceText(context, authority, path)
    if (text === null) {
      failures.push({ status: "source_unavailable", reasonCode: "SOURCE_UNAVAILABLE", rowIds: [], sourceRefIds: [sourceRefId] })
      continue
    }
    units.push({ authority, path, text, sourceRefId, sourceRefIds: [sourceRefId] })
  }
  return { units, failures }
}

const absentSource = (context: ManifestContext, authority: "legacy" | "mono", familyId: string, role: string): string => {
  const family = familyFor(authority, familyId)
  const path = family?.patterns[0] ?? `__absent__/${familyId}`
  return sourceRefFor(context, authority, role, path, null, null, null, "ABSENT_SOURCE_FAMILY")
}

const mismatch = (kind: Mismatch["kind"], counterpartRowIds: readonly string[], reason: string | null): Mismatch => ({
  kind,
  disposition: "none",
  accepted_intent_ref_ids: [],
  counterpart_row_ids: sortUnique(counterpartRowIds),
  reason,
})
const preserveCommentWhitespace = (value: string): string => value.replace(/[^\n]/g, " ")

const withoutComments = (source: string): string => {
  let output = ""
  let quote: "'" | '"' | "`" | null = null
  let escaped = false
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] ?? ""
    const next = source[index + 1] ?? ""
    if (quote !== null) {
      output += char
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === quote) quote = null
      continue
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char
      output += char
      continue
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2)
      const commentEnd = end < 0 ? source.length : end + 2
      output += preserveCommentWhitespace(source.slice(index, commentEnd))
      index = commentEnd - 1
      continue
    }
    if (char === "/" && next === "/") {
      const end = source.indexOf("\n", index + 2)
      const commentEnd = end < 0 ? source.length : end
      output += preserveCommentWhitespace(source.slice(index, commentEnd))
      index = commentEnd - 1
      continue
    }
    if (char === "#" && next !== "[") {
      const end = source.indexOf("\n", index + 1)
      const commentEnd = end < 0 ? source.length : end
      output += preserveCommentWhitespace(source.slice(index, commentEnd))
      index = commentEnd - 1
      continue
    }
    output += char
  }
  return output
}
const withoutLiterals = (source: string): string =>
  source.replace(/'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*"|`(?:\\[\s\S]|[^`\\])*`/g, preserveCommentWhitespace)

const stringLiteralValue = (raw: string): string | null => {
  const value = raw.trim()
  if (value.length < 2) return null
  const quote = value[0]
  if ((quote !== "'" && quote !== '"' && quote !== "`") || value.at(-1) !== quote) return null
  return value.slice(1, -1).replace(/\\(["'`\\])/g, "$1").replace(/\\n/g, "\n")
}

interface LiteralCall {
  readonly args: readonly (string | null)[]
  readonly rawArgs: readonly string[]
  readonly offset: number
}

const literalCallsFor = (source: string, name: string): readonly LiteralCall[] => {
  const calls: LiteralCall[] = []
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (char === "'" || char === '"' || char === "`") {
      const quote = char
      index += 1
      while (index < source.length) {
        if (source[index] === "\\") index += 1
        else if (source[index] === quote) break
        index += 1
      }
      continue
    }
    if (!source.startsWith(name, index)) continue
    const previous = source[index - 1]
    const next = source[index + name.length]
    if ((previous !== undefined && /[A-Za-z0-9_$]/.test(previous)) || (next !== undefined && /[A-Za-z0-9_$]/.test(next))) continue
    const callOffset = index
    let open = index + name.length
    while (/\s/.test(source[open] ?? "")) open += 1
    if (source[open] !== "(") continue
    const args: string[] = []
    let argumentStart = open + 1
    let depth = 1
    let quote: string | null = null
    let closed = false
    for (let cursor = open + 1; cursor < source.length; cursor += 1) {
      const current = source[cursor]
      if (quote !== null) {
        if (current === "\\") cursor += 1
        else if (current === quote) quote = null
        continue
      }
      if (current === "'" || current === '"' || current === "`") {
        quote = current
        continue
      }
      if (current === "(") {
        depth += 1
        continue
      }
      if (current === ")") {
        depth -= 1
        if (depth === 0) {
          args.push(source.slice(argumentStart, cursor))
          closed = true
          index = cursor
          break
        }
        continue
      }
      if (current === "," && depth === 1) {
        args.push(source.slice(argumentStart, cursor))
        argumentStart = cursor + 1
      }
    }
    if (closed) calls.push({ args: args.map(stringLiteralValue), rawArgs: args, offset: callOffset })
  }
  return calls
}


interface EffectCall {
  readonly chain: string
  readonly receiver: string | null
  readonly callable: string
  readonly offset: number
  readonly constructorCall: boolean
}
interface EffectScope {
  readonly owner: LanguageClass | undefined
  readonly start: number
  readonly end: number
}

const effectCallExpressionsFor = (source: string): readonly EffectCall[] => {
  const structure = withoutLiterals(withoutComments(source))
  const calls: EffectCall[] = []
  const pattern = /\\?(?:\$?[A-Za-z_][A-Za-z0-9_$\\]*(?:(?:->|::|\.)\$?[A-Za-z_][A-Za-z0-9_$\\]*)*)\s*\(/g
  const ignored = new Set(["if", "for", "while", "switch", "catch", "match", "isset", "empty", "array", "list"])
  for (const match of structure.matchAll(pattern)) {
    const chain = match[0]?.replace(/\s*\($/, "").trim() ?? ""
    const offset = match.index ?? 0
    const segments = chain.split(/->|::|\./).filter((segment) => segment.length > 0)
    const callable = segments.at(-1)
    if (callable === undefined || ignored.has(callable.toLowerCase())) continue
    const prefix = structure.slice(0, offset).trimEnd()
    if (/(?:function|class|interface|trait|enum)\s*$/i.test(prefix)) continue
    const constructorCall = /\bnew\s+$/i.test(prefix)
    calls.push({
      chain,
      receiver: segments.length > 1 ? segments.slice(0, -1).join("->") : null,
      callable,
      offset,
      constructorCall,
    })
  }
  return calls
}
const attributeCallFor = (source: string, offset: number): boolean => {
  const prefix = source.slice(0, offset)
  return prefix.lastIndexOf("#[") > prefix.lastIndexOf("]")
}
interface FunctionContext {
  readonly name: string | null
  readonly parameters: string
  readonly bodyStart: number
  readonly bodyEnd: number
}

const functionContextFor = (source: string, offset: number, namedOnly = false): FunctionContext | null => {
  const structure = withoutLiterals(withoutComments(source))
  const candidates: { readonly name: string | null; readonly parameters: string; readonly bodyStart: number }[] = []
  const phpFunctions = /\bfunction\s*(?:&\s*)?(?:([A-Za-z_$][A-Za-z0-9_$]*)\s*)?\(([^)]*)\)\s*(?:\:[^{]+)?\s*\{/g
  for (const match of structure.matchAll(phpFunctions)) {
    const bodyStart = (match.index ?? 0) + (match[0]?.lastIndexOf("{") ?? -1)
    if (bodyStart >= 0 && match[2] !== undefined) candidates.push({ name: match[1] ?? null, parameters: match[2], bodyStart })
  }
  const arrows = /(?:(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*)?(?:async\s*)?(?:\(([^()]*)\)|([A-Za-z_$][A-Za-z0-9_$]*))\s*=>\s*\{/g
  for (const match of structure.matchAll(arrows)) {
    const bodyStart = (match.index ?? 0) + (match[0]?.lastIndexOf("{") ?? -1)
    if (bodyStart >= 0) candidates.push({ name: match[1] ?? null, parameters: match[2] ?? match[3] ?? "", bodyStart })
  }
  const ignoredMethods = new Set(["if", "for", "while", "switch", "catch", "with"])
  const typedMethods = /(?:^|[;{}\n])\s*(?:(?:public|private|protected|static|readonly|abstract|override|async|get|set)\s+)*([A-Za-z_$][A-Za-z0-9_$]*)\s*\(([^)]*)\)\s*(?::[^{=>]+)?\s*\{/gm
  for (const match of structure.matchAll(typedMethods)) {
    const name = match[1]
    const bodyStart = (match.index ?? 0) + (match[0]?.lastIndexOf("{") ?? -1)
    if (name !== undefined && !ignoredMethods.has(name) && bodyStart >= 0 && match[2] !== undefined) candidates.push({ name, parameters: match[2], bodyStart })
  }
  let selected: FunctionContext | null = null
  for (const candidate of candidates) {
    if (candidate.bodyStart >= offset || (namedOnly && candidate.name === null)) continue
    let depth = 1
    let bodyEnd = structure.length
    for (let index = candidate.bodyStart + 1; index < structure.length; index += 1) {
      if (structure[index] === "{") depth += 1
      else if (structure[index] === "}") {
        depth -= 1
        if (depth === 0) {
          bodyEnd = index
          break
        }
      }
    }
    if (offset <= bodyEnd && (selected === null || candidate.bodyStart > selected.bodyStart)) selected = { ...candidate, bodyEnd }
  }
  return selected
}

interface MethodScope {
  readonly name: string
  readonly start: number
  readonly end: number
}

const methodScopeFor = (source: string, offset: number, limit: number): MethodScope | null => {
  const structure = withoutLiterals(withoutComments(source))
  const open = structure.indexOf("{", offset)
  if (open < 0 || open >= limit) return null
  const context = functionContextFor(source, open + 1)
  if (context === null || context.bodyStart !== open || context.bodyEnd >= limit) return null
  const name = /\bfunction\s*(?:&\s*)?([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/.exec(structure.slice(offset, open))?.[1]
  return name === undefined ? null : { name, start: offset, end: context.bodyEnd + 1 }
}

const normalizeLocalType = (raw: string | undefined): string | null => {
  const value = raw?.trim().replace(/^\?/, "").split("|")[0]?.trim() ?? ""
  return value.length === 0 || /^(?:mixed|object|array|callable|iterable|void|never|self|static|parent|unknown|any)$/i.test(value) ? null : value
}

const localReceiverTypesFor = (unit: SourceUnit, offset: number): ReadonlyMap<string, string | null> => {
  const localTypes = new Map<string, string | null>()
  const context = functionContextFor(unit.text, offset)
  if (context === null) return localTypes
  const parameters = context.parameters
  for (const match of parameters.matchAll(/(?:^|,)\s*(?:(\\?[A-Za-z_][A-Za-z0-9_\\]*(?:\s*\|\s*\\?[A-Za-z_][A-Za-z0-9_\\]*)*)\s+)?&?\s*\$([A-Za-z_][A-Za-z0-9_]*)\b/g)) {
    if (match[2] !== undefined) localTypes.set(`$${match[2]}`, normalizeLocalType(match[1]))
  }
  for (const match of parameters.matchAll(/(?:^|,)\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::\s*([A-Za-z_$][A-Za-z0-9_.$]*))?/g)) {
    if (match[1] !== undefined && !match[1].startsWith("$")) localTypes.set(match[1], normalizeLocalType(match[2]))
  }
  const body = withoutLiterals(withoutComments(unit.text)).slice(context.bodyStart + 1, Math.min(offset, context.bodyEnd))
  for (const match of body.matchAll(/(?:^|[;{}\n])\s*(?:final\s+|public\s+|private\s+|protected\s+|readonly\s+|static\s+)*(\\?[A-Za-z_][A-Za-z0-9_\\]*(?:\s*\|\s*\\?[A-Za-z_][A-Za-z0-9_\\]*)*)\s+&?\$([A-Za-z_][A-Za-z0-9_]*)\b/g)) {
    if (match[2] !== undefined && !/^(?:return|throw|yield|new|if|while|for|foreach|switch|catch)$/i.test(match[1] ?? "")) localTypes.set(`$${match[2]}`, normalizeLocalType(match[1]))
  }
  for (const match of body.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)\s*=\s*new\s+([\\A-Za-z_][A-Za-z0-9_\\]*)\b/g)) {
    if (match[1] !== undefined) localTypes.set(`$${match[1]}`, normalizeLocalType(match[2]))
  }
  for (const match of body.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)\s*=\s*null\b/g)) {
    if (match[1] !== undefined) localTypes.set(`$${match[1]}`, null)
  }
  for (const match of body.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*([A-Za-z_$][A-Za-z0-9_.$]*)/g)) {
    if (match[1] !== undefined) localTypes.set(match[1], normalizeLocalType(match[2]))
  }
  for (const match of body.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*new\s+([A-Za-z_$][A-Za-z0-9_.$]*)\b/g)) {
    if (match[1] !== undefined) localTypes.set(match[1], normalizeLocalType(match[2]))
  }
  for (const match of body.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*null\b/g)) {
    if (match[1] !== undefined) localTypes.set(match[1], null)
  }
  return localTypes
}
const effectClassForCallable = (callable: string): EffectClass | null => {
  switch (callable.toLowerCase()) {
    case "persist":
    case "flush":
    case "insert":
    case "update":
    case "delete":
    case "remove":
    case "save":
    case "executestatement":
    case "transaction":
    case "commit":
    case "upsert":
      return "durable_write"
    case "grant":
    case "revoke":
    case "authorize":
    case "authenticate":
    case "setpassword":
    case "setrole":
    case "setroles":
    case "setuser":
    case "identity":
    case "permission":
      return "identity_or_authority"
    case "fetch":
    case "curlexec":
    case "curlinit":
    case "request":
    case "publish":
    case "dispatch":
    case "send":
    case "mailer":
    case "mail":
    case "smtp":
    case "slack":
    case "google":
    case "twilio":
    case "sms":
    case "webhook":
      return "outbound"
    case "writefile":
    case "writefilesync":
    case "mkdir":
    case "mkdirsync":
    case "unlink":
    case "unlinksync":
    case "filesystem":
    case "storage":
      return "filesystem"
    case "schedule":
    case "scheduler":
    case "cron":
    case "setinterval":
    case "settimeout":
      return "scheduler"
    case "find":
    case "findone":
    case "findall":
    case "select":
    case "query":
    case "lookup":
    case "read":
      return "read_only"
    default:
      return null
  }
}

const effectEvidence = (
  unit: SourceUnit,
  authority: AuthorityGraph,
  scope?: EffectScope,
  visited: ReadonlySet<string> = new Set(),
): { readonly effects: readonly EffectClass[]; readonly targets: readonly string[] } => {
  const effects: EffectClass[] = []
  const targets: string[] = []
  let unresolved = false
  const source = scope === undefined ? unit.text : unit.text.slice(scope.start, scope.end)
  for (const call of effectCallExpressionsFor(source)) {
    if (call.callable === "AsCommand" && attributeCallFor(source, call.offset)) continue
    const markUnresolved = (): void => {
      unresolved = true
      targets.push(`unresolved:${scope?.owner?.fqn ?? unit.path}::${call.callable}`)
    }
    const callableEffect = effectClassForCallable(call.callable)
    const resolved = resolveEffectCall(authority, unit, call, scope?.owner, scope?.start ?? 0)
    if (resolved === null) {
      const receiver = call.receiver ?? null
      const receiverParts = receiver?.split(/->|::|\./) ?? []
      const receiverRoot = receiverParts[0] ?? null
      const localTypes = localReceiverTypesFor(unit, call.offset + (scope?.start ?? 0))
      const typedLocalReceiver = receiverRoot !== null && localTypes.has(receiverRoot) && localTypes.get(receiverRoot) !== null
      const typedOwnerProperty = receiverRoot === "$this"
        && receiverParts[1] !== undefined
        && scope?.owner?.properties.has(receiverParts[1]) === true
      const explicitlyUnknownReceiver = receiver !== null && !typedLocalReceiver && !typedOwnerProperty
      if (callableEffect !== null && callableEffect !== "read_only") {
        if (receiver === null) markUnresolved()
        else {
          effects.push(callableEffect)
          if (explicitlyUnknownReceiver) markUnresolved()
        }
      } else if (callableEffect === null && /^(?:perform|execute|handle|process|apply|run|invoke|mutate|write)$/i.test(call.callable)) {
        markUnresolved()
      }
      continue
    }
    targets.push(resolved.symbol)
    if (call.constructorCall) continue
    if (callableEffect !== null) {
      if (callableEffect !== "read_only") effects.push(callableEffect)
      continue
    }
    if (visited.has(resolved.symbol)) continue
    const target = effectScopeForTarget(authority, resolved.targetClass, call.callable)
    if (target === null) {
      markUnresolved()
      continue
    }
    const nested = effectEvidence(target.unit, authority, target.scope, new Set([...visited, resolved.symbol]))
    effects.push(...nested.effects.filter((effect) => effect !== "read_only"))
    targets.push(...nested.targets)
  }
  if (unresolved) effects.push("unknown")
  else if (effects.length === 0) effects.push("read_only")
  return { effects: sortUnique(effects) as EffectClass[], targets: sortUnique(targets) }
}

const entryKindForPath = (path: string): CommandWriteDetails["entry_kind"] => {
  if (/\/Command\//i.test(path)) return "custom_command"
  if (/\/Controller\//i.test(path)) return "controller_write"
  if (/\/Repository\//i.test(path)) return "repository_write"
  if (/\/EventSubscriber\//i.test(path) || /\/Event\//i.test(path)) return "event_handler"
  if (/\/Infrastructure\/Service\//i.test(path) || /\/Service\//i.test(path)) return "integration_write"
  return "unknown"
}

const commandNameFor = (text: string, reasons: string[]): string | null => {
  const patterns = [
    /#\[\s*(?:\\?[A-Za-z_][A-Za-z0-9_\\]*\\)?AsCommand\b[^\]]*?\bname\s*[:=]\s*["']([^"']+)["']/i,
    /#\[\s*(?:\\?[A-Za-z_][A-Za-z0-9_\\]*\\)?AsCommand\s*\(\s*["']([^"']+)["']/i,
    /(?:\bdefaultName\b|\bdefault_name\b)\s*[:=]\s*["']([^"']+)["']/i,
    /(?:\bcommand\b\s*[:=]\s*["'])([^"']+)(?:["'])/i,
  ]
  const source = withoutComments(text)
  for (const pattern of patterns) {
    const match = pattern.exec(source)
    if (match?.[1] !== undefined) return normalizeSafe(match[1], "command_name", reasons)
  }
  return null
}

const contractRefFor = (text: string, reasons: string[]): string | null => {
  const match = /(?:writeContractRef|write_contract_ref)\s*[:=]\s*["']([^"']+)["']/i.exec(withoutComments(text))
  return match?.[1] === undefined ? null : normalizeSafe(match[1], "field", reasons)
}
const commandDeclarationAnchorFor = (text: string, className: string | null): boolean => {
  const source = withoutComments(text)
  if (commandNameFor(source, []) !== null) return true
  if (/\#\[\s*(?:\\?[A-Za-z_][A-Za-z0-9_\\]*\\)?(?:AsCommand|AsMessageHandler|AsEventListener)\b/i.test(source)) return true
  if (/\b(?:extends|implements)\s+[^{;]*(?:Command(?:Handler|Interface)?|MessageHandler(?:Interface)?|EventSubscriber(?:Interface)?|EventListener(?:Interface)?)\b/i.test(source)) return true
  if (/\b(?:writeContractRef|write_contract_ref)\s*[:=]/i.test(source)) return true
  if (/(?:^|[{\n,])\s*command\s*[:=]\s*["']/im.test(source)) return true
  if (className !== null && new RegExp(`\\bclass\\s+${className.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\b`, "i").test(source) && /Command$/i.test(className)) return true
  return false
}

interface LoaderNode {
  readonly path: string
  readonly imports: readonly string[]
  readonly classes: readonly string[]
  readonly resources: readonly string[]
  readonly excludes: readonly string[]
  readonly root: boolean
  readonly invalid: boolean
}

interface LoaderYamlNode {
  readonly key?: unknown
  readonly value?: unknown
  readonly type?: unknown
  readonly items?: readonly unknown[]
  readonly range?: readonly number[]
}

interface LanguageClass {
  readonly path: string
  readonly name: string
  readonly fqn: string
  readonly methods: ReadonlySet<string>
  readonly properties: ReadonlyMap<string, string>
}

interface AuthorityGraph {
  readonly authority: "legacy" | "mono"
  readonly loaderNodes: readonly LoaderNode[]
  readonly reachableLoaders: ReadonlySet<string>
  readonly cyclicLoaders: ReadonlySet<string>
  readonly reachableSources: ReadonlySet<string>
  readonly cyclicSources: ReadonlySet<string>
  readonly cyclicOnlySources: ReadonlySet<string>
  readonly importerBySource: ReadonlyMap<string, string>
  readonly classesByPath: ReadonlyMap<string, readonly LanguageClass[]>
  readonly classByName: ReadonlyMap<string, LanguageClass>
  readonly aliasesByPath: ReadonlyMap<string, ReadonlyMap<string, string>>
  readonly sourceImports: ReadonlyMap<string, readonly string[]>
  readonly runtimeEntrySources: ReadonlySet<string>
  readonly runtimeImporterBySource: ReadonlyMap<string, string>
  readonly functionsByPath: ReadonlyMap<string, ReadonlySet<string>>
  readonly sourceTextByPath: ReadonlyMap<string, string>
}

const normalizedRelativePath = (base: string, target: string): string | null => {
  const raw = target.replaceAll("\\", "/").trim()
  if (raw.length === 0 || raw.startsWith("@") || raw.includes(":")) return null
  const parts = [...base.slice(0, Math.max(0, base.lastIndexOf("/"))).split("/"), ...raw.split("/")]
  const normalized: string[] = []
  for (const part of parts) {
    if (part === "" || part === ".") continue
    if (part === "..") {
      if (normalized.length === 0) return null
      normalized.pop()
    } else normalized.push(part)
  }
  return normalized.join("/")
}

const loaderConfigRoot = (authority: "legacy" | "mono"): string => authority === "legacy" ? "app/config" : "apps/server/config"
const loaderSourceRoots = (authority: "legacy" | "mono"): readonly string[] => authority === "legacy" ? ["src/"] : ["apps/server/src/"]
const expandLoaderPathPattern = (value: string): readonly string[] => {
  const start = value.indexOf("{")
  if (start < 0) return [value]
  let depth = 0
  let end = -1
  for (let index = start; index < value.length; index += 1) {
    const character = value[index]
    if (character === "{") depth += 1
    else if (character === "}") {
      depth -= 1
      if (depth === 0) {
        end = index
        break
      }
    }
  }
  if (end < 0) return [value]
  const alternatives: string[] = []
  let partStart = start + 1
  depth = 0
  for (let index = start + 1; index < end; index += 1) {
    const character = value[index]
    if (character === "{") depth += 1
    else if (character === "}") depth -= 1
    else if (character === "," && depth === 0) {
      alternatives.push(value.slice(partStart, index))
      partStart = index + 1
    }
  }
  alternatives.push(value.slice(partStart, end))
  if (alternatives.length === 1) return [value]
  const prefix = value.slice(0, start)
  const suffix = value.slice(end + 1)
  return alternatives.flatMap((alternative) => expandLoaderPathPattern(`${prefix}${alternative}${suffix}`))
}
const loaderRootNames = (authority: "legacy" | "mono"): ReadonlySet<string> =>
  authority === "legacy"
    ? new Set(["app/config/services.yml", "app/config/services.yaml", "app/config/config.yml", "app/config/config.yaml"])
    : new Set(["apps/server/config/services.yml", "apps/server/config/services.yaml"])
const isLoaderRootPath = (path: string, authority: "legacy" | "mono"): boolean =>
  loaderRootNames(authority).has(path)
  || (authority === "legacy"
    ? /^app\/config\/routing\.ya?ml$/i.test(path)
    : /^apps\/server\/config\/routes(?:\.ya?ml|\/.*\.ya?ml)$/i.test(path))
const isLoaderConfigPath = (path: string, authority: "legacy" | "mono"): boolean => {
  const root = loaderConfigRoot(authority)
  return path.startsWith(`${root}/`) && /\.(?:ya?ml|json)$/i.test(path)
}

const loaderYamlNode = (value: unknown): LoaderYamlNode | null => typeof value === "object" && value !== null ? value as LoaderYamlNode : null
const loaderYamlPairs = (value: unknown): readonly LoaderYamlNode[] => {
  const node = loaderYamlNode(value)
  if (node === null || node.items === undefined) return []
  return node.items.map(loaderYamlNode).filter((pair): pair is LoaderYamlNode => pair !== null && pair.key !== undefined)
}
const loaderYamlKey = (value: unknown): string | null => {
  const node = loaderYamlNode(value)
  if (node === null || typeof node.value !== "string") return null
  if (node.type !== undefined && node.type !== "PLAIN") return null
  return node.value.trim()
}
const loaderYamlScalar = (value: unknown): string | null => {
  const node = loaderYamlNode(value)
  if (node === null || typeof node.value !== "string") return null
  if (typeof node.type === "string" && !["PLAIN", "QUOTE_SINGLE", "QUOTE_DOUBLE"].includes(node.type)) return null
  return node.value.trim()
}

const fqcnPattern = /^(?:[A-Za-z_][A-Za-z0-9_]*\\)+[A-Za-z_][A-Za-z0-9_]*$/
const fqcnPrefixPattern = /^(?:[A-Za-z_][A-Za-z0-9_]*\\)+$/
const ordinaryServicePattern = /^[A-Za-z_][A-Za-z0-9_.:-]*$/
const loaderMetadataFields: ReadonlySet<string> = new Set(["_defaults", "_instanceof", "parameters", "imports", "framework", "when@dev", "when@test", "when@prod"])

interface LoaderValues {
  readonly imports: readonly string[]
  readonly classes: readonly string[]
  readonly resources: readonly string[]
  readonly excludes: readonly string[]
  readonly invalid: boolean
}

const loaderValuesFor = (source: string): LoaderValues => {
  const imports: string[] = []
  const classes: string[] = []
  const resources: string[] = []
  const excludes: string[] = []
  let invalid = false
  const collectImportList = (value: unknown): void => {
    const node = loaderYamlNode(value)
    if (node?.items === undefined) {
      invalid = true
      return
    }
    for (const item of node.items) {
      const scalarItem = loaderYamlScalar(item)
      if (scalarItem !== null) {
        imports.push(scalarItem)
        continue
      }
      const itemNode = loaderYamlNode(item)
      const nestedPairs = loaderYamlPairs(item)
      const pair = itemNode?.key !== undefined ? itemNode : nestedPairs.length === 1 ? nestedPairs[0] ?? null : null
      const key = pair === null ? null : loaderYamlKey(pair.key)
      const scalar = pair === null ? null : loaderYamlScalar(pair.value)
      if ((key === "resource" || key === "import") && scalar !== null) imports.push(scalar)
      else invalid = true
    }
  }
  const collectServiceMap = (value: unknown): void => {
    const node = loaderYamlNode(value)
    if (node?.items === undefined) {
      invalid = true
      return
    }
    for (const pair of loaderYamlPairs(value)) {
      const key = loaderYamlKey(pair.key)
      if (key === null || loaderMetadataFields.has(key)) continue
      const keyIsClass = fqcnPattern.test(key)
      const keyIsPrefix = fqcnPrefixPattern.test(key)
      if (!keyIsClass && !keyIsPrefix && !ordinaryServicePattern.test(key)) continue
      const child = loaderYamlNode(pair.value)
      const childPairs = loaderYamlPairs(pair.value)
      const explicitClass = childPairs.find((childPair) => loaderYamlKey(childPair.key) === "class")
      const explicitClassNode = explicitClass === undefined ? null : loaderYamlNode(explicitClass.value)
      const explicitClassValue = explicitClass === undefined ? null : loaderYamlScalar(explicitClass.value)
      if (explicitClass !== undefined) {
        if (explicitClassValue !== null && fqcnPattern.test(explicitClassValue)) classes.push(explicitClassValue)
        else if (keyIsClass && explicitClassNode?.value === null && explicitClassNode.type === "PLAIN") classes.push(key)
        else invalid = true
      } else if (keyIsClass && (child?.items !== undefined || (child?.items === undefined && child?.value === null))) {
        classes.push(key)
      } else if (keyIsClass) {
        invalid = true
      }
      for (const childPair of childPairs) {
        const childKey = loaderYamlKey(childPair.key)
        const scalar = loaderYamlScalar(childPair.value)
        if (childKey === "resource" && keyIsPrefix) {
          if (scalar !== null) resources.push(scalar)
          else invalid = true
        } else if (childKey === "exclude" && keyIsPrefix) {
          if (scalar !== null) excludes.push(scalar)
          else {
            const values = loaderYamlNode(childPair.value)?.items
            if (values === undefined) invalid = true
            else for (const item of values) {
              const excluded = loaderYamlScalar(item)
              if (excluded !== null) excludes.push(excluded)
              else invalid = true
            }
          }
        }
      }
    }
  }
  const collectRouteResource = (value: unknown): void => {
    const resourcePair = loaderYamlPairs(value).find((pair) => loaderYamlKey(pair.key) === "resource")
    const resource = resourcePair === undefined ? null : loaderYamlScalar(resourcePair.value)
    if (resource === null) return
    if (/\.ya?ml$/i.test(resource)) imports.push(resource)
    else resources.push(resource)
  }
  try {
    const document = parseDocument(source, { prettyErrors: false })
    if (document.errors.length > 0) invalid = true
    for (const pair of loaderYamlPairs(document.contents)) {
      const key = loaderYamlKey(pair.key)
      if (key === "imports") collectImportList(pair.value)
      else if (key === "services") collectServiceMap(pair.value)
      else collectRouteResource(pair.value)
    }
  } catch {
    invalid = true
  }
  return { imports, classes, resources, excludes, invalid }
}
const runtimePackageEntryTargetsFor = (
  context: ManifestContext,
  authority: "legacy" | "mono",
  unit: { readonly path: string; readonly text: string },
  languagePaths: ReadonlySet<string>,
  sourceTextByPath: ReadonlyMap<string, string>,
): readonly string[] => {
  if (!/(?:^|\/)package\.json$/i.test(unit.path)) return []
  try {
    const parsed: unknown = JSON.parse(unit.text)
    if (typeof parsed !== "object" || parsed === null) return []
    const record = parsed as Record<string, unknown>
    const targets = new Set<string>()
    const packagePrefix = unit.path.slice(0, -"package.json".length)
    const tsconfigPath = `${packagePrefix}tsconfig.json`
    const tsconfigText = sourceTextByPath.get(tsconfigPath) ?? readSourceText(context, authority, tsconfigPath)
    let buildProjection: { readonly outDir: string; readonly sourceRoot: string } | null = null
    if (typeof tsconfigText === "string") {
      try {
        const tsconfig = JSON.parse(tsconfigText) as {
          readonly compilerOptions?: { readonly outDir?: unknown }
          readonly include?: unknown
        }
        const outDir = tsconfig.compilerOptions?.outDir
        const sourceRoot = Array.isArray(tsconfig.include) && tsconfig.include.length === 1 ? tsconfig.include[0] : null
        if (
          typeof outDir === "string"
          && typeof sourceRoot === "string"
          && /^[A-Za-z0-9_.-]+$/.test(outDir)
          && /^[A-Za-z0-9_.-]+$/.test(sourceRoot)
        ) buildProjection = { outDir, sourceRoot }
      } catch {
        buildProjection = null
      }
    }
    const runtimeCommands = new Set(["bun", "deno", "jiti", "node", "ts-node", "tsx", "vite-node"])
    const sourceToken = /^(?:\.\/)?[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*\.(?:ts|tsx|js|mjs)$/
    const wordsFor = (value: string): readonly string[] | null => {
      const words: string[] = []
      let word = ""
      let wordStarted = false
      let quote: "'" | "\"" | null = null
      let escaped = false
      const push = (): void => {
        if (wordStarted) words.push(word)
        word = ""
        wordStarted = false
      }
      for (const character of value) {
        if (escaped) {
          word += character
          wordStarted = true
          escaped = false
        } else if (character === "\\") {
          wordStarted = true
          escaped = true
        } else if (quote !== null) {
          if (character === quote) quote = null
          else word += character
        } else if (character === "'" || character === "\"") {
          wordStarted = true
          quote = character
        } else if (/[;&|<>()$\r\n]/.test(character)) return null
        else if (/\s/.test(character)) push()
        else {
          wordStarted = true
          word += character
        }
      }
      if (escaped || quote !== null) return null
      push()
      return words
    }
    const addScriptTarget = (value: unknown): void => {
      if (typeof value !== "string") return
      const words = wordsFor(value)
      if (words === null) return
      const command = words[0]
      const source = words.at(-1)
      if (command === undefined || source === undefined || !runtimeCommands.has(command) || !sourceToken.test(source)) return
      const validForm =
        (words.length === 2 && runtimeCommands.has(command)) ||
        (words.length === 3 && ((command === "bun" || command === "deno") && words[1] === "run"))
      if (!validForm) return
      const resolved = sourcePathForImport(unit.path, source.startsWith("./") ? source : `./${source}`, languagePaths)
      if (resolved !== null) targets.add(resolved)
    }
    const runtimeConditions = new Set(["browser", "bun", "default", "deno", "development", "import", "node", "production", "react-native", "require", "worker", "workerd"])
    const addExportTargets = (value: unknown): void => {
      if (typeof value === "string") {
        const resolved = value.startsWith("./") ? sourcePathForImport(unit.path, value, languagePaths) : null
        if (resolved !== null) {
          targets.add(resolved)
          return
        }
        if (buildProjection === null || !value.startsWith(`./${buildProjection.outDir}/`)) return
        const outputStem = value
          .slice(`./${buildProjection.outDir}/`.length)
          .replace(/(?:\.d\.ts|\.(?:mjs|cjs|js))$/, "")
        for (const extension of [".ts", ".tsx", ".js", ".mjs"]) {
          const projected = sourcePathForImport(
            unit.path,
            `./${buildProjection.sourceRoot}/${outputStem}${extension}`,
            languagePaths,
          )
          if (projected !== null) {
            targets.add(projected)
            return
          }
        }
      } else if (Array.isArray(value)) {
        for (const item of value) addExportTargets(item)
      } else if (typeof value === "object" && value !== null) {
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
          if (key === "." || key.startsWith("./") || runtimeConditions.has(key)) addExportTargets(item)
        }
      }
    }
    const scripts = record.scripts
    if (typeof scripts === "object" && scripts !== null) for (const value of Object.values(scripts as Record<string, unknown>)) addScriptTarget(value)
    addExportTargets(record.exports)
    return [...targets].sort(compareByteOrder)
  } catch {
    return []
  }
}
const runtimeImportClauseFor = (raw: string): boolean => {
  const clause = raw.replace(/\s+from\s*["'][^"']+["']\s*$/, "")
  if (/^\s*(?:import|export)\s+type\b/.test(clause)) return false
  const named = /\{([^}]*)\}/.exec(clause)?.[1]
  return named === undefined || named.split(",").some((specifier) => !/^\s*type\b/.test(specifier))
}

const availableLanguageUnitsFor = (context: ManifestContext, authority: "legacy" | "mono"): readonly { readonly path: string; readonly text: string }[] =>
  context.scans[authority].files
    .filter((file) => !file.unsafe && file.availability === "available" && effectiveIgnoreRule(authority, file.path) === null)
    .filter((file) => context.rootCensus.some((record) => record.root_ref === authority && record.path === file.path && record.classification === "matched"))
    .map((file) => ({ path: file.path, text: readSourceText(context, authority, file.path) }))
    .filter((file): file is { readonly path: string; readonly text: string } => file.text !== null)

const sourceClassName = (namespace: string | null, name: string): string => namespace === null ? name : `${namespace}\\${name}`
const languageClassesFor = (unit: { readonly path: string; readonly text: string }): readonly LanguageClass[] => {
  const classes = classMatches(unit.text)
  const namespace = namespaceOf(unit.text)
  const result: LanguageClass[] = []
  for (const entry of classes) {
    const end = classes.find((candidate) => candidate.offset > entry.offset)?.offset ?? unit.text.length
    const body = withoutComments(unit.text).slice(entry.offset, end)
    const methods = new Set(functionMatches(unit.text, entry.offset, end).map((method) => method.name))
    const properties = new Map<string, string>()
    const propertyPattern = /(?:(?:public|private|protected|readonly|static|final)\s+)*([A-Za-z_][A-Za-z0-9_\\]*)\s+\$([A-Za-z_][A-Za-z0-9_]*)/g
    for (const match of body.matchAll(propertyPattern)) {
      const type = match[1]
      const name = match[2]
      if (type !== undefined && name !== undefined && type !== "function") properties.set(name, type)
    }
    const tsPropertyPattern = /(?:(?:public|private|protected|readonly|static)\s+)*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([A-Za-z_][A-Za-z0-9_.$]*)/g
    for (const match of body.matchAll(tsPropertyPattern)) {
      const name = match[1]
      const type = match[2]
      if (name !== undefined && type !== undefined) properties.set(name, type)
    }
    const name = entry.name
    result.push({ path: unit.path, name, fqn: sourceClassName(namespace, name), methods, properties })
  }
  return result
}

const sourcePathForImport = (base: string, target: string, paths: ReadonlySet<string>): string | null => {
  const normalized = normalizedRelativePath(base, target)
  if (normalized === null) return null
  if (paths.has(normalized)) return normalized
  if (/\.(?:mjs|cjs|js)$/i.test(normalized)) {
    const sourceStem = normalized.replace(/\.(?:mjs|cjs|js)$/i, "")
    for (const extension of [".ts", ".tsx"]) if (paths.has(`${sourceStem}${extension}`)) return `${sourceStem}${extension}`
  }
  for (const suffix of [".php", ".ts", ".tsx", ".js", ".mjs", ".yaml", ".yml", ".json"]) if (paths.has(`${normalized}${suffix}`)) return `${normalized}${suffix}`
  for (const suffix of ["/index.php", "/index.ts", "/index.tsx", "/index.js"]) if (paths.has(`${normalized}${suffix}`)) return `${normalized}${suffix}`
  return null
}
const phpAliasReferenceFor = (source: string, alias: string): boolean => {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const reference = new RegExp([
    `\\bnew\\s+\\\\?${escaped}\\b`,
    `\\b${escaped}\\s*::`,
    `\\b(?:instanceof|extends|implements|catch)\\s+\\\\?${escaped}\\b`,
    `\\b${escaped}\\s+\\$[A-Za-z_][A-Za-z0-9_]*`,
    `\\)\\s*:\\s*\\\\?${escaped}\\b`,
  ].join("|"))
  return reference.test(source)
}

const authorityGraphFor = (context: ManifestContext, authority: "legacy" | "mono"): AuthorityGraph => {
  const languageUnits = availableLanguageUnitsFor(context, authority)
  const sourceTextByPath = new Map(languageUnits.map((unit) => [unit.path, unit.text]))
  const languagePaths = new Set(languageUnits.map((unit) => unit.path))
  const classesByPath = new Map<string, readonly LanguageClass[]>()
  const classByName = new Map<string, LanguageClass>()
  const aliasesByPath = new Map<string, ReadonlyMap<string, string>>()
  const functionsByPath = new Map<string, ReadonlySet<string>>()
  const phpAliasNamesByPath = new Map<string, ReadonlySet<string>>()
  for (const unit of languageUnits) {
    const classes = languageClassesFor(unit)
    classesByPath.set(unit.path, classes)
    for (const item of classes) {
      if (!classByName.has(item.fqn)) classByName.set(item.fqn, item)
      if (!classByName.has(item.name)) classByName.set(item.name, item)
    }
    functionsByPath.set(unit.path, new Set(functionMatches(unit.text, 0, unit.text.length).map((entry) => entry.name)))
    const phpAliasNames = new Set<string>()
    const phpUses = withoutComments(unit.text).matchAll(/^\s*use\s+(?!function\b|const\b)([A-Za-z_][A-Za-z0-9_\\]*)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?\s*;/gm)
    const aliases = new Map<string, string>()
    for (const match of phpUses) {
      const imported = match[1]
      if (imported === undefined) continue
      const alias = match[2] ?? imported.split("\\").at(-1) ?? imported
      aliases.set(alias, imported)
      phpAliasNames.add(alias)
    }
    aliasesByPath.set(unit.path, aliases)
    phpAliasNamesByPath.set(unit.path, phpAliasNames)
  }
  for (const unit of languageUnits) {
    const aliases = new Map(aliasesByPath.get(unit.path) ?? [])
    const tsImports = withoutComments(unit.text).matchAll(/\b(?:import|export)\s+(?!type\b)[^;\n]*?\sfrom\s*["']([^"']+)["']/g)
    for (const match of tsImports) {
      if (!runtimeImportClauseFor(match[0] ?? "")) continue
      const importPath = match[1]
      if (importPath === undefined) continue
      const importedPath = sourcePathForImport(unit.path, importPath, languagePaths)
      if (importedPath === null) continue
      for (const item of classesByPath.get(importedPath) ?? []) aliases.set(item.name, item.fqn)
    }
    aliasesByPath.set(unit.path, aliases)
  }
  const sourceImports = new Map<string, readonly string[]>()
  for (const unit of languageUnits) {
    const imports = new Set<string>()
    const aliases = aliasesByPath.get(unit.path) ?? new Map<string, string>()
    const phpAliases = phpAliasNamesByPath.get(unit.path) ?? new Set<string>()
    const source = withoutComments(unit.text)
    const executableSource = withoutLiterals(source.replace(/^\s*use\s+(?!function\b|const\b)[^;]+;\s*$/gm, ""))
    const tsImports = source.matchAll(/\b(?:import|export)\s+(?!type\b)[^;\n]*?\sfrom\s*["']([^"']+)["']/g)
    for (const [alias, target] of aliases) {
      if (!phpAliases.has(alias) || !phpAliasReferenceFor(executableSource, alias)) continue
      const imported = classByName.get(target)
      if (imported !== undefined && imported.path !== unit.path) imports.add(imported.path)
    }
    for (const match of tsImports) {
      if (!runtimeImportClauseFor(match[0] ?? "")) continue
      const importedPath = match[1] === undefined ? null : sourcePathForImport(unit.path, match[1], languagePaths)
      if (importedPath !== null) imports.add(importedPath)
    }
    const sideEffectImports = source.matchAll(/\bimport\s*["']([^"']+)["']|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g)
    for (const match of sideEffectImports) {
      const importedPath = sourcePathForImport(unit.path, match[1] ?? match[2] ?? "", languagePaths)
      if (importedPath !== null) imports.add(importedPath)
    }
    sourceImports.set(unit.path, [...imports].sort(compareByteOrder))
  }
  const configRoot = loaderConfigRoot(authority)
  const runtimeEntrySources = new Set<string>()
  const runtimeImporterBySource = new Map<string, string>()
  const runtimeEntryPending: Array<{ readonly path: string; readonly importer: string }> = languageUnits
    .filter((unit) => /\.(?:ts|tsx|js|mjs)$/i.test(unit.path))
    .filter((unit) => /^\s*export\s+default\s+Alchemy\.Stack\s*\(/m.test(withoutLiterals(withoutComments(unit.text))))
    .map((unit) => ({ path: unit.path, importer: unit.path }))
  for (const unit of languageUnits) {
    for (const path of runtimePackageEntryTargetsFor(context, authority, unit, languagePaths, sourceTextByPath)) {
      runtimeEntryPending.push({ path, importer: unit.path })
    }
  }
  while (runtimeEntryPending.length > 0) {
    const entry = runtimeEntryPending.pop()
    if (entry === undefined) continue
    const currentImporter = runtimeImporterBySource.get(entry.path)
    if (currentImporter === undefined || compareByteOrder(entry.importer, currentImporter) < 0) {
      runtimeImporterBySource.set(entry.path, entry.importer)
    }
    if (runtimeEntrySources.has(entry.path)) continue
    runtimeEntrySources.add(entry.path)
    for (const imported of sourceImports.get(entry.path) ?? []) {
      if (/\.(?:ts|tsx|js|mjs)$/i.test(imported) && !runtimeEntrySources.has(imported)) {
        runtimeEntryPending.push({ path: imported, importer: entry.path })
      }
    }
  }
  const loaderCandidates = languageUnits.filter((unit) => isLoaderConfigPath(unit.path, authority))
  const loaderPaths = new Set(loaderCandidates.map((unit) => unit.path))
  const resolveLoader = (path: string): string | null => {
    if (loaderPaths.has(path)) return path
    for (const suffix of [".yaml", ".yml", ".json"]) if (loaderPaths.has(`${path}${suffix}`)) return `${path}${suffix}`
    return null
  }
  const loaderNodes: LoaderNode[] = loaderCandidates.map((unit) => {
    const values = loaderValuesFor(unit.text)
    let invalid = values.invalid
    const imports: string[] = []
    for (const value of values.imports) {
      if (authority === "legacy" && value.startsWith("@")) continue
      if (authority === "legacy" && /^(?:\.\/)?parameters(?:_[A-Za-z0-9_.-]+)?\.ya?ml$/i.test(value)) continue
      const normalized = normalizedRelativePath(unit.path, value)
      const resolved = normalized === null || !normalized.startsWith(`${configRoot}/`) ? null : resolveLoader(normalized)
      if (resolved === null) {
        invalid = true
        continue
      }
      imports.push(resolved)
    }
    return {
      path: unit.path,
      imports,
      classes: values.classes,
      resources: values.resources,
      excludes: values.excludes,
      root: isLoaderRootPath(unit.path, authority),
      invalid,
    }
  })
  const reachableLoaders = new Set<string>()
  const languageUnitByPath = new Map(languageUnits.map((unit) => [unit.path, unit]))
  const cyclicLoaders = new Set<string>()
  const reachableSources = new Set<string>()
  const sourceProvenance = new Set<string>()
  const cyclicSourceProvenance = new Set<string>()
  const cyclicSources = new Set<string>()
  const importerBySource = new Map<string, string>()
  const loaderByPath = new Map(loaderNodes.map((node) => [node.path, node]))
  const loaderVisiting: string[] = []
  const loaderCycleTaint = new Set<string>()
  const loaderCommitted = new Set<string>()
  const loaderFailureTaint = new Set<string>()
  const loaderValid = new Set<string>()
  const sourceVisited = new Set<string>()
  const loaderVisited = new Set<string>()
  const sourceVisiting: string[] = []
  const markSource = (path: string, importer: string, cyclic: boolean): void => {
    if (!languageUnitByPath.has(path)) return
    reachableSources.add(path)
    if (cyclic) {
      cyclicSourceProvenance.add(path)
      cyclicSources.add(path)
    } else {
      sourceProvenance.add(path)
      if (!importerBySource.has(path)) importerBySource.set(path, importer)
    }
    visitSource(path, cyclic)
  }
  function visitSource(path: string, cyclic: boolean): void {
    if (sourceVisiting.includes(path) || (sourceVisited.has(path) && !cyclic)) return
    sourceVisiting.push(path)
    for (const imported of sourceImports.get(path) ?? []) markSource(imported, path, cyclic)
    sourceVisiting.pop()
    sourceVisited.add(path)
  }
  const markLoaderSources = (node: LoaderNode, path: string, cyclic: boolean): void => {
    const resolveClass = (name: string): LanguageClass | undefined => classByName.get(name) ?? classByName.get(name.replace(/^\\/, ""))
    for (const className of node.classes) {
      const item = resolveClass(className)
      if (item !== undefined) markSource(item.path, path, cyclic)
    }
    const excluded = node.excludes
      .flatMap((value) => expandLoaderPathPattern(value.replace(/\*.*$/, "")))
      .map((value) => normalizedRelativePath(node.path, value))
      .filter((value): value is string => value !== null)
    for (const resource of node.resources.flatMap((value) => expandLoaderPathPattern(value.replace(/\*.*$/, "")))) {
      const normalized = authority === "legacy" && resource.startsWith("@AppBundle/")
        ? `src/AppBundle/${resource.slice("@AppBundle/".length).replace(/\/$/, "")}`
        : normalizedRelativePath(node.path, resource)
      if (normalized === null || !loaderSourceRoots(authority).some((root) => normalized.startsWith(root))) continue
      for (const sourcePath of languagePaths) {
        if (!(sourcePath === normalized || sourcePath.startsWith(`${normalized}/`))) continue
        if (excluded.some((prefix) => sourcePath === prefix || sourcePath.startsWith(`${prefix}/`))) continue
        markSource(sourcePath, path, cyclic)
      }
    }
  }
  function visitLoader(path: string, inheritedCyclic = false): boolean {
    const cycleStart = loaderVisiting.indexOf(path)
    if (cycleStart >= 0) {
      for (const cyclePath of loaderVisiting.slice(cycleStart)) {
        cyclicLoaders.add(cyclePath)
        loaderCycleTaint.add(cyclePath)
        loaderFailureTaint.add(cyclePath)
      }
      cyclicLoaders.add(path)
      loaderCycleTaint.add(path)
      loaderFailureTaint.add(path)
      return false
    }
    const node = loaderByPath.get(path)
    if (node === undefined || node.invalid) {
      loaderFailureTaint.add(path)
      return false
    }
    const cyclic = inheritedCyclic || loaderCycleTaint.has(path)
    if (loaderVisited.has(path)) {
      if (cyclic || loaderFailureTaint.has(path)) {
        loaderFailureTaint.add(path)
        if (cyclic) for (const imported of node.imports) {
          const resolved = resolveLoader(imported)
          if (resolved !== null) visitLoader(resolved, true)
        }
        return false
      }
      return loaderValid.has(path)
    }
    loaderVisiting.push(path)
    let dependenciesValid = !cyclic
    for (const imported of node.imports) {
      const resolved = resolveLoader(imported)
      if (resolved === null || !visitLoader(resolved, cyclic)) dependenciesValid = false
    }
    const effectiveCyclic = cyclic || cyclicLoaders.has(path) || loaderCycleTaint.has(path)
    if (effectiveCyclic) {
      loaderCycleTaint.add(path)
      loaderFailureTaint.add(path)
      for (const imported of node.imports) {
        const resolved = resolveLoader(imported)
        if (resolved !== null) visitLoader(resolved, true)
      }
    } else if (dependenciesValid) loaderValid.add(path)
    else loaderFailureTaint.add(path)
    loaderVisiting.pop()
    loaderVisited.add(path)
    reachableLoaders.add(path)
    return loaderValid.has(path)
  }
  const commitLoader = (path: string): void => {
    if (loaderCommitted.has(path) || !loaderValid.has(path)) return
    loaderCommitted.add(path)
    const node = loaderByPath.get(path)
    if (node === undefined) return
    for (const imported of node.imports) {
      const resolved = resolveLoader(imported)
      if (resolved !== null) commitLoader(resolved)
    }
  }
  for (const node of loaderNodes) if (node.root && !node.invalid && visitLoader(node.path)) commitLoader(node.path)
  for (const node of loaderNodes) if (loaderCommitted.has(node.path)) markLoaderSources(node, node.path, false)
  if (authority === "legacy") {
    for (const unit of languageUnits) {
      if (
        unit.path.startsWith("src/AppBundle/Command/")
        && /\bclass\s+[A-Za-z_][A-Za-z0-9_]*\s+extends\s+(?:[A-Za-z_][A-Za-z0-9_\\]*\\)?Command\b/.test(withoutComments(unit.text))
        && /\bfunction\s+execute\s*\(/.test(withoutComments(unit.text))
      ) markSource(unit.path, unit.path, false)
    }
  }
  const cyclicOnlySources = new Set([...cyclicSourceProvenance].filter((path) => !sourceProvenance.has(path)))
  return {
    authority,
    loaderNodes,
    reachableLoaders,
    cyclicLoaders,
    reachableSources,
    cyclicSources,
    cyclicOnlySources,
    importerBySource,
    classesByPath,
    classByName,
    aliasesByPath,
    sourceImports,
    runtimeEntrySources,
    runtimeImporterBySource,
    functionsByPath,
    sourceTextByPath,
  }
}

const resolveClassForPath = (authority: AuthorityGraph, path: string, name: string): LanguageClass | undefined => {
  const aliases = authority.aliasesByPath.get(path)
  const local = authority.classesByPath.get(path)?.find((item) => item.name === name || item.fqn === name)
  if (local !== undefined) return local
  const alias = aliases?.get(name)
  if (alias !== undefined) return authority.classByName.get(alias)
  if (name.startsWith("\\") || name.includes("\\")) return authority.classByName.get(name) ?? authority.classByName.get(name.replace(/^\\/, ""))
  return undefined
}
const reachableClassFor = (authority: AuthorityGraph, item: LanguageClass | undefined): LanguageClass | undefined =>
  item !== undefined
    && (authority.reachableSources.has(item.path) || authority.runtimeEntrySources.has(item.path))
    && !authority.cyclicSources.has(item.path)
    && !authority.cyclicOnlySources.has(item.path)
    ? item
    : undefined
const importedBySources = (authority: AuthorityGraph, unit: SourceUnit, owner: string | null): string | null => {
  const resolved = owner === null ? undefined : resolveClassForPath(authority, unit.path, owner)
  const targetPath = resolved?.path ?? unit.path
  if (authority.runtimeEntrySources.has(targetPath)) {
    return authority.runtimeImporterBySource.get(targetPath) ?? targetPath
  }
  if (!authority.reachableSources.has(targetPath) || authority.cyclicSources.has(targetPath) || authority.cyclicOnlySources.has(targetPath)) return null
  return authority.importerBySource.get(targetPath) ?? null
}

const resolveEffectCall = (authority: AuthorityGraph, unit: SourceUnit, call: EffectCall, ownerClass?: LanguageClass, offsetBase = 0): { readonly symbol: string; readonly targetClass: LanguageClass } | null => {
  if (call.constructorCall) {
    const item = reachableClassFor(authority, resolveClassForPath(authority, unit.path, call.chain))
    return item === undefined ? null : { symbol: `${item.fqn}::__construct`, targetClass: item }
  }
  const receiver = call.receiver
  if (receiver === null) return null
  const segments = receiver.split(/->|::|\./).filter((segment) => segment.length > 0)
  const first = segments[0] ?? ""
  const localTypes = localReceiverTypesFor(unit, call.offset + offsetBase)
  const resolveNamed = (name: string): LanguageClass | undefined => {
    if (localTypes.has(name)) {
      const localType = localTypes.get(name)
      return localType === null || localType === undefined
        ? undefined
        : reachableClassFor(authority, resolveClassForPath(authority, unit.path, localType))
    }
    return reachableClassFor(authority, resolveClassForPath(authority, unit.path, name))
  }
  let item: LanguageClass | undefined
  let propertyIndex = 1
  if (first === "$this" || first === "this") {
    item = reachableClassFor(authority, ownerClass)
  } else if (first.startsWith("$")) {
    item = resolveNamed(first)
  } else {
    item = resolveNamed(first)
  }
  while (item !== undefined && propertyIndex < segments.length) {
    const property = item.properties.get(segments[propertyIndex] ?? "")
    if (property === undefined) return null
    item = reachableClassFor(authority, resolveClassForPath(authority, item.path, property))
    propertyIndex += 1
  }
  if (item === undefined || !item.methods.has(call.callable)) return null
  return { symbol: `${item.fqn}::${call.callable}`, targetClass: item }
}

const effectScopeForTarget = (
  authority: AuthorityGraph,
  targetClass: LanguageClass,
  methodName: string,
): { readonly unit: SourceUnit; readonly scope: EffectScope } | null => {
  const text = authority.sourceTextByPath.get(targetClass.path)
  if (text === undefined) return null
  const classes = classMatches(text)
  const classIndex = classes.findIndex((entry) => entry.name === targetClass.name)
  const classEntry = classes[classIndex]
  if (classEntry === undefined) return null
  const classEnd = classes[classIndex + 1]?.offset ?? text.length
  const method = functionMatches(text, classEntry.offset, classEnd).find((entry) => entry.name === methodName)
  if (method === undefined) return null
  const methodScope = methodScopeFor(text, method.offset, classEnd)
  if (methodScope === null) return null
  return {
    unit: { authority: authority.authority, path: targetClass.path, text, sourceRefId: "", sourceRefIds: [] },
    scope: { owner: targetClass, start: methodScope.start, end: methodScope.end },
  }
}
const commandDetails = (unit: SourceUnit, authority: AuthorityGraph, owner: string | null, method: string | null, reasons: string[], scope?: EffectScope): CommandWriteDetails => {
  const evidence = effectEvidence(unit, authority, scope)
  const methodEffect = method === null ? null : effectClassForCallable(method)
  const effectClasses = methodEffect === null || evidence.effects.includes(methodEffect) ? evidence.effects : sortUnique([...evidence.effects, methodEffect]) as EffectClass[]
  const commandName = commandNameFor(unit.text, reasons)
  const symbolRaw = owner === null ? method : method === null ? owner : `${owner}::${method}`
  const symbolRef = normalizeSafe(symbolRaw, "symbol", reasons)
  return {
    entry_kind: entryKindForPath(unit.path),
    owner_ref: owner,
    command_name: commandName,
    symbol_ref: symbolRef,
    effect_classes: effectClasses,
    target_refs: evidence.targets.map((target) => normalizeSafe(target, "field", reasons)).filter((value): value is string => value !== null),
    write_contract_ref: contractRefFor(unit.text, reasons),
  }
}

const commandRow = (context: ManifestContext, unit: SourceUnit, ordinal: number, authority: AuthorityGraph, owner: string | null, method: string | null, scope?: EffectScope): ParsedRow => {
  const reasons: string[] = []
  const details = commandDetails(unit, authority, owner, method, reasons, scope)
  if (details.effect_classes.includes("unknown")) reasons.push("UNKNOWN_EFFECT")
  const importerPath = importedBySources(authority, unit, owner)
  const imported = importerPath !== null
  const dead = !imported && details.entry_kind !== "unknown"
  if (dead) reasons.push("DEAD_UNIMPORTED_SOURCE")
  const status: InventoryRow["status"] = reasons.includes("UNSAFE_SOURCE") || reasons.includes("UNKNOWN_EFFECT") ? "unresolved" : dead ? "dead_unimported" : "covered"
  const declarationKind = details.entry_kind
  const declaration = declarationId(unit.authority, unit.authority, unit.path, declarationKind, ordinal)
  const signature = canonicalJson(["command_write", details.owner_ref, details.entry_kind, details.command_name, details.symbol_ref, details.effect_classes, details.target_refs])
  const declarationOffset = scope?.start ?? Math.max(0, unit.text.indexOf(ownerShortName(owner) ?? ""))
  const sourceRefId = sourceRefFor(context, unit.authority, unit.authority === "legacy" ? "legacy_command_write_authority" : "mono_command_write_authority", unit.path, lineAt(unit.text, declarationOffset), lineAt(unit.text, declarationOffset), details.symbol_ref)
  const rowIdentity = rowId("command_write", declaration, signature)
  const reasonCodes = sortUnique(reasons)
  return {
    path: unit.path,
    sourceRefIds: [sourceRefId],
    ownerRef: owner,
    imported,
    importerPath,
    row: {
      row_id: rowIdentity,
      declaration_id: declaration,
      inventory_kind: "command_write",
      authority_line: unit.authority,
      canonical_key: signature,
      signature,
      status,
      observation_kinds: ["static_source"],
      source_ref_ids: [sourceRefId],
      revision_ref_ids: [context.scans[unit.authority].revisionRefId],
      runtime_observation_ref_ids: [],
      coverage_ref_ids: [],
      accepted_intent_ref_ids: [],
      duplicate_group_id: null,
      mismatch: mismatch(status === "unresolved" ? "unresolved" : status === "dead_unimported" ? "dead_unimported" : "none", [], reasonCodes[0] ?? null),
      reason_codes: reasonCodes,
      related_row_ids: [],
      details,
    },
  }
}

const parseCommandUnits = (context: ManifestContext, authority: "legacy" | "mono"): { readonly parsed: readonly ParsedRow[]; readonly failures: readonly C2CollectionFailure[] } => {
  const familyId = authority === "legacy" ? C2_FAMILY_IDS.legacyCommands : C2_FAMILY_IDS.monoCommands
  const role = authority === "legacy" ? "legacy_command_write_authority" : "mono_command_write_authority"
  const source = sourceUnits(context, authority, familyId, role)
  const authorityGraph = authorityGraphFor(context, authority)
  const parsed: ParsedRow[] = []
  let ordinal = 0
  const hasPositiveEffect = (effects: readonly EffectClass[]): boolean => effects.some((effect) => effect !== "read_only" && effect !== "unknown")
  for (const unit of source.units) {
    const classes = classMatches(unit.text)
    const ranges = classes.map((entry, index) => ({ entry, end: classes[index + 1]?.offset ?? unit.text.length }))
    if (ranges.length === 0) {
      const anchor = commandDeclarationAnchorFor(unit.text, null)
      const evidence = effectEvidence(unit, authorityGraph)
      if (anchor || hasPositiveEffect(evidence.effects)) parsed.push(commandRow(context, unit, ordinal++, authorityGraph, null, null))
      continue
    }
    for (const range of ranges) {
      const reasons: string[] = []
      const owner = classOwner(unit.text, range.entry.name, reasons)
      const ownerClass = authorityGraph.classesByPath.get(unit.path)?.find((item) => item.name === range.entry.name)
      const classScope: EffectScope = { owner: ownerClass, start: range.entry.offset, end: range.end }
      const commandAnchor = commandDeclarationAnchorFor(unit.text.slice(range.entry.offset, range.end), range.entry.name) || commandDeclarationAnchorFor(unit.text, range.entry.name)
      const methods = functionMatches(unit.text, range.entry.offset, range.end)
        .map((method) => {
          const scope = methodScopeFor(unit.text, method.offset, range.end)
          return scope === null ? null : { ...scope, name: method.name }
        })
        .filter((method): method is MethodScope => method !== null)
      if (commandAnchor) {
        const selected = methods.find((method) => /^(?:__invoke|handle|execute|run|process)$/i.test(method.name)) ?? methods[0]
        const selectedScope: EffectScope = selected === undefined ? classScope : { owner: ownerClass, start: selected.start, end: selected.end }
        const selectedMethod = selected === undefined ? null : normalizeSafe(selected.name, "symbol", reasons)
        parsed.push(commandRow(context, unit, ordinal++, authorityGraph, owner, selectedMethod, selectedScope))
        continue
      }
      if (methods.length > 0) {
        for (const methodScope of methods) {
          const evidence = effectEvidence(unit, authorityGraph, { owner: ownerClass, start: methodScope.start, end: methodScope.end })
          const methodEffect = effectClassForCallable(methodScope.name)
          if (!hasPositiveEffect(evidence.effects) && (methodEffect === null || methodEffect === "read_only")) continue
          parsed.push(commandRow(context, unit, ordinal++, authorityGraph, owner, normalizeSafe(methodScope.name, "symbol", reasons), { owner: ownerClass, start: methodScope.start, end: methodScope.end }))
        }
      } else {
        const evidence = effectEvidence(unit, authorityGraph, classScope)
        if (hasPositiveEffect(evidence.effects)) parsed.push(commandRow(context, unit, ordinal++, authorityGraph, owner, null, classScope))
      }
    }
  }
  for (const [targetIndex, target] of [...parsed].entries()) {
    if (!target.imported || target.importerPath === null) continue
    const importerUnit = source.units.find((candidate) => candidate.path === target.importerPath)
    if (importerUnit === undefined || !isLoaderConfigPath(importerUnit.path, authority)) continue
    const details = target.row.details as CommandWriteDetails
    const importerRef = sourceRefFor(
      context,
      authority,
      role,
      importerUnit.path,
      1,
      Math.max(1, importerUnit.text.split("\n").length),
      details.symbol_ref,
    )
    const sourceRefIds = sortUnique([...target.sourceRefIds, importerRef])
    parsed[targetIndex] = {
      ...target,
      sourceRefIds,
      row: { ...target.row, source_ref_ids: sourceRefIds },
    }
  }
  return { parsed, failures: [...source.failures] }
}

const applyDuplicateGroups = (rows: InventoryRow[]): void => {
  const grouped = new Map<string, InventoryRow[]>()
  for (const row of rows) {
    const key = `${row.authority_line}\u0000${row.inventory_kind}\u0000${row.canonical_key}`
    const group = grouped.get(key)
    if (group === undefined) grouped.set(key, [row])
    else group.push(row)
  }
  for (const group of grouped.values()) {
    if (group.length < 2) continue
    const first = group[0]
    if (first === undefined) continue
    const groupId = duplicateGroupId(first.authority_line, first.inventory_kind, first.canonical_key)
    for (const row of group) {
      const index = rows.indexOf(row)
      rows[index] = { ...row, status: "duplicate", duplicate_group_id: groupId, mismatch: mismatch("duplicate", group.filter((candidate) => candidate.row_id !== row.row_id).map((candidate) => candidate.row_id), "DUPLICATE_CANONICAL_IDENTITY"), reason_codes: sortUnique([...row.reason_codes, "DUPLICATE_CANONICAL_IDENTITY"]) }
    }
  }
}

const makeEnvelope = (context: ManifestContext, inventoryKind: InventoryEnvelope["inventory_kind"], authority: "legacy" | "mono", rows: readonly InventoryRow[], links: readonly InventoryLink[], sourceManifestSha256: string, observations: readonly InventoryObservation[] = []): InventoryEnvelope => {
  const sortedRows = [...rows].sort((left, right) => compareByteOrder(left.row_id, right.row_id) || compareByteOrder(left.canonical_key, right.canonical_key))
  const rowIds = sortedRows.map((row) => row.row_id)
  const edges = sortedRows.flatMap((row) => {
    if (inventoryKind !== "command_write") {
      return [{ edge_id: edgeId("authority_input", row.source_ref_ids, [row.row_id]), edge_type: "authority_input" as const, from_ref_ids: row.source_ref_ids, to_row_ids: [row.row_id], derivation: "E-C2-SOURCE-PARSE" }]
    }
    const loaderRefs = row.source_ref_ids.filter((sourceRefId) => {
      const source = context.sourcePathById.get(sourceRefId)
      return source?.rootRef === authority && isLoaderConfigPath(source.path, authority)
    })
    const declarationRefs = row.source_ref_ids.filter((sourceRefId) => !loaderRefs.includes(sourceRefId))
    return [
      ...(declarationRefs.length === 0 ? [] : [{ edge_id: edgeId("authority_input", declarationRefs, [row.row_id]), edge_type: "authority_input" as const, from_ref_ids: declarationRefs, to_row_ids: [row.row_id], derivation: "E-C2-SOURCE-PARSE" }]),
      ...(loaderRefs.length === 0 ? [] : [{ edge_id: edgeId("loader_import", loaderRefs, [row.row_id]), edge_type: "authority_input" as const, from_ref_ids: loaderRefs, to_row_ids: [row.row_id], derivation: "E-C2-LOADER-IMPORT" }]),
    ]
  })
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    schema_version: "functional-parity-inventory/v1",
    inventory_kind: inventoryKind,
    authority_line: authority,
    source_manifest_sha256: sourceManifestSha256,
    revision_ref_ids: [context.scans[authority].revisionRefId],
    observation_kinds: ["static_source"],
    rows: sortedRows,
    links: links.filter((link) => rowIds.includes(link.from_row_id) && rowIds.includes(link.to_row_id)).sort((left, right) => compareByteOrder(left.relation_id, right.relation_id)),
    observations: [...observations].sort((left, right) => compareByteOrder(left.observation_id, right.observation_id)),
    derivation_edges: edges.sort((left, right) => compareByteOrder(left.edge_id, right.edge_id)),
  }
}

const commandLinks = (parsed: readonly ParsedRow[]): readonly InventoryLink[] => {
  const byRowId = new Map(parsed.map((entry) => [entry.row.row_id, entry]))
  const links: InventoryLink[] = []
  for (const target of parsed) {
    if (!target.imported || target.ownerRef === null || target.importerPath === null) continue
    const importer = parsed.find((candidate) => candidate.path === target.importerPath)
    if (importer === undefined || importer.path === target.path || !byRowId.has(importer.row.row_id)) continue
    links.push({ relation_id: relationId("imports", importer.row.row_id, target.row.row_id, [...importer.sourceRefIds, ...target.sourceRefIds]), relation_kind: "imports", from_row_id: importer.row.row_id, to_row_id: target.row.row_id, source_ref_ids: sortUnique([...importer.sourceRefIds, ...target.sourceRefIds]) })
  }
  return [...new Map(links.map((link) => [link.relation_id, link])).values()]
}

const reconcilePair = (left: InventoryEnvelope, right: InventoryEnvelope): { readonly left: InventoryEnvelope; readonly right: InventoryEnvelope; readonly mismatches: readonly { readonly kind: Exclude<Mismatch["kind"], "none">; readonly row_ids: readonly string[]; readonly disposition: "none"; readonly accepted_intent_ref_ids: readonly string[] }[]; readonly links: readonly InventoryLink[] } => {
  const leftRows = left.rows.map((row) => row)
  const rightRows = right.rows.map((row) => row)
  const rightBySignature = new Map(rightRows.map((row) => [row.signature, row]))
  const leftBySignature = new Map(leftRows.map((row) => [row.signature, row]))
  const mismatches: Array<{ readonly kind: Exclude<Mismatch["kind"], "none">; readonly row_ids: readonly string[]; readonly disposition: "none"; readonly accepted_intent_ref_ids: readonly string[] }> = []
  const links: InventoryLink[] = []
  for (const row of leftRows) {
    if (["unresolved", "duplicate", "dead_unimported", "absent"].includes(row.status)) continue
    const counterpart = rightBySignature.get(row.signature)
    if (counterpart === undefined) {
      const index = leftRows.findIndex((candidate) => candidate.row_id === row.row_id)
      leftRows[index] = { ...row, status: "missing", mismatch: mismatch("missing", [], "MISSING_COUNTERPART"), reason_codes: sortUnique([...row.reason_codes, "MISSING_COUNTERPART"]) }
      mismatches.push({ kind: "missing", row_ids: [row.row_id], disposition: "none", accepted_intent_ref_ids: [] })
      continue
    }
    const index = leftRows.findIndex((candidate) => candidate.row_id === row.row_id)
    leftRows[index] = { ...row, mismatch: mismatch("none", [counterpart.row_id], null) }
    const rightIndex = rightRows.findIndex((candidate) => candidate.row_id === counterpart.row_id)
    if (rightIndex >= 0 && rightRows[rightIndex] !== undefined && !["unresolved", "duplicate", "dead_unimported", "absent"].includes(rightRows[rightIndex]?.status ?? "unresolved")) rightRows[rightIndex] = { ...rightRows[rightIndex] as InventoryRow, mismatch: mismatch("none", [row.row_id], null) }
    links.push({ relation_id: relationId("matches", row.row_id, counterpart.row_id, [...row.source_ref_ids, ...counterpart.source_ref_ids]), relation_kind: "matches", from_row_id: row.row_id, to_row_id: counterpart.row_id, source_ref_ids: sortUnique([...row.source_ref_ids, ...counterpart.source_ref_ids]) })
  }
  for (const row of rightRows) {
    if (["unresolved", "duplicate", "dead_unimported", "absent"].includes(row.status) || leftBySignature.has(row.signature)) continue
    const index = rightRows.findIndex((candidate) => candidate.row_id === row.row_id)
    rightRows[index] = { ...row, status: "extra", mismatch: mismatch("extra", [], "EXTRA_COUNTERPART"), reason_codes: sortUnique([...row.reason_codes, "EXTRA_COUNTERPART"]) }
    mismatches.push({ kind: "extra", row_ids: [row.row_id], disposition: "none", accepted_intent_ref_ids: [] })
  }
  return { left: { ...left, rows: leftRows.sort((a, b) => compareByteOrder(a.row_id, b.row_id)) }, right: { ...right, rows: rightRows.sort((a, b) => compareByteOrder(a.row_id, b.row_id)) }, mismatches, links }
}

const mergeC2Envelopes = (left: InventoryEnvelope, right: InventoryEnvelope, sourceManifestSha256: string): InventoryEnvelope => ({
  ...left,
  authority_line: "cross_line",
  source_manifest_sha256: sourceManifestSha256,
  revision_ref_ids: sortUnique([...left.revision_ref_ids, ...right.revision_ref_ids]),
  observation_kinds: sortUnique([...left.observation_kinds, ...right.observation_kinds]) as InventoryEnvelope["observation_kinds"],
  rows: [...left.rows, ...right.rows].sort((a, b) => compareByteOrder(a.row_id, b.row_id) || compareByteOrder(a.canonical_key, b.canonical_key)),
  links: [...left.links, ...right.links].filter((link, index, links) => links.findIndex((candidate) => candidate.relation_id === link.relation_id) === index).sort((a, b) => compareByteOrder(a.relation_id, b.relation_id)),
  observations: [...left.observations, ...right.observations].filter((observation, index, observations) => observations.findIndex((candidate) => candidate.observation_id === observation.observation_id) === index).sort((a, b) => compareByteOrder(a.observation_id, b.observation_id)),
  derivation_edges: [...left.derivation_edges, ...right.derivation_edges].filter((edge, index, edges) => edges.findIndex((candidate) => candidate.edge_id === edge.edge_id) === index).sort((a, b) => compareByteOrder(a.edge_id, b.edge_id)),
})

const commandCollection = (context: ManifestContext, sourceManifestSha256: string): { readonly inventories: readonly [InventoryEnvelope, InventoryEnvelope]; readonly failures: readonly C2CollectionFailure[]; readonly rows: readonly InventoryRow[] } => {
  const legacy = parseCommandUnits(context, "legacy")
  const mono = parseCommandUnits(context, "mono")
  const legacyRows = legacy.parsed.map((entry) => entry.row)
  const monoRows = mono.parsed.map((entry) => entry.row)
  applyDuplicateGroups(legacyRows)
  applyDuplicateGroups(monoRows)
  const legacyEnvelope = makeEnvelope(context, "command_write", "legacy", legacyRows, commandLinks(legacy.parsed), sourceManifestSha256)
  const monoEnvelope = makeEnvelope(context, "command_write", "mono", monoRows, commandLinks(mono.parsed), sourceManifestSha256)
  const reconciled = reconcilePair(legacyEnvelope, monoEnvelope)
  const failures: C2CollectionFailure[] = [...legacy.failures, ...mono.failures]
  for (const row of [...reconciled.left.rows, ...reconciled.right.rows]) {
    if (row.reason_codes.includes("UNSAFE_SOURCE")) failures.push({ status: "source_unavailable", reasonCode: "UNSAFE_SOURCE", rowIds: [row.row_id], sourceRefIds: row.source_ref_ids })
    else if (row.reason_codes.includes("UNKNOWN_EFFECT")) failures.push({ status: "unresolved", reasonCode: "UNKNOWN_EFFECT", rowIds: [row.row_id], sourceRefIds: row.source_ref_ids })
    else if (row.status === "dead_unimported") failures.push({ status: "gaps_found", reasonCode: "DEAD_UNIMPORTED_SOURCE", rowIds: [row.row_id], sourceRefIds: row.source_ref_ids })
    else if (row.status === "missing") failures.push({ status: "gaps_found", reasonCode: "MISSING_COUNTERPART", rowIds: [row.row_id], sourceRefIds: row.source_ref_ids })
    else if (row.status === "extra") failures.push({ status: "gaps_found", reasonCode: "EXTRA_COUNTERPART", rowIds: [row.row_id], sourceRefIds: row.source_ref_ids })
    else if (row.status === "duplicate") failures.push({ status: "gaps_found", reasonCode: "DUPLICATE_CANONICAL_IDENTITY", rowIds: [row.row_id], sourceRefIds: row.source_ref_ids })
  }
  return { inventories: [{ ...reconciled.left, links: [...reconciled.left.links, ...reconciled.links] }, { ...reconciled.right, links: [...reconciled.right.links, ...reconciled.links] }], failures, rows: [...reconciled.left.rows, ...reconciled.right.rows] }
}

interface ScheduleTrigger {
  readonly triggerKind: ScheduleBackgroundDetails["trigger_kind"]
  readonly triggerIdentity: string | null
  readonly expression: string | null
  readonly ownerRef: string | null
  readonly handlerRef: string | null
  readonly enabled: boolean | null
  readonly runtimeRegistered: boolean | null
  readonly line: number
  readonly reasons: readonly string[]
}


const cronAliases = new Set(["@yearly", "@annually", "@monthly", "@weekly", "@daily", "@midnight", "@hourly"])
const cronMonthNames = new Set(["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"])
const cronWeekdayNames = new Set(["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"])

const cronFieldBounds = (fieldCount: number, fieldIndex: number): readonly [number, number] | null => {
  const boundsByCount: Record<number, readonly (readonly [number, number])[]> = {
    5: [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]],
    6: [[0, 59], [0, 59], [0, 23], [1, 31], [1, 12], [0, 7]],
    7: [[0, 59], [0, 59], [0, 23], [1, 31], [1, 12], [0, 7], [1970, 9999]],
  }
  return boundsByCount[fieldCount]?.[fieldIndex] ?? null
}

const cronFieldTokenValid = (token: string, fieldIndex: number, fieldCount: number): boolean => {
  const parts = token.split("/")
  const base = parts[0] ?? ""
  const step = parts[1]
  if (parts.length > 2 || (step !== undefined && (!/^\d{1,4}$/.test(step) || Number(step) < 1))) return false
  const bounds = cronFieldBounds(fieldCount, fieldIndex)
  if (bounds === null) return false
  const names = fieldCount === 5
    ? fieldIndex === 3 ? cronMonthNames : fieldIndex === 4 ? cronWeekdayNames : null
    : fieldCount === 6
      ? fieldIndex === 4 ? cronMonthNames : fieldIndex === 5 ? cronWeekdayNames : null
      : fieldIndex === 4 ? cronMonthNames : fieldIndex === 5 ? cronWeekdayNames : null
  if (base === "*") return true
  const range = base.split("-")
  if (range.length > 2 || range.some((value) => value.length === 0)) return false
  const values = range.map((value) => {
    if (/^\d{1,4}$/.test(value)) return Number(value)
    return names?.has(value.toUpperCase()) === true ? value.toUpperCase() : null
  })
  if (values.some((value) => value === null)) return false
  if (typeof values[0] === "number" && (values[0] < bounds[0] || values[0] > bounds[1])) return false
  if (typeof values[1] === "number" && (values[1] < bounds[0] || values[1] > bounds[1])) return false
  if (typeof values[0] === "number" && typeof values[1] === "number" && values[0] > values[1]) return false
  return true
}

const cronExpressionValid = (value: string): boolean => {
  const normalized = value.trim().normalize("NFC")
  if (cronAliases.has(normalized.toLowerCase())) return true
  const fields = normalized.split(/\s+/)
  if (cronFieldBounds(fields.length, 0) === null) return false
  return fields.every((field, index) => field.length > 0 && field.split(",").every((token) => cronFieldTokenValid(token, index, fields.length)))
}

const opaqueScheduleValue = (value: string): boolean => {
  if (value.length < 24) return false
  if (/^[a-f0-9]{32,}$/i.test(value)) return true
  let classes = 0
  if (/[a-z]/.test(value)) classes += 1
  if (/[A-Z]/.test(value)) classes += 1
  if (/[0-9]/.test(value)) classes += 1
  if (/[^A-Za-z0-9_.:-]/.test(value)) classes += 1
  return classes >= 3
}

const scheduleIdentityFor = (raw: string | null, reasons: string[]): string | null => {
  const value = raw?.trim().normalize("NFC") ?? ""
  if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(value)) {
    reasons.push("SCHEDULE_IDENTITY_UNRESOLVED")
    return null
  }
  if (opaqueScheduleValue(value) || /(?:password|passwd|secret|token|credential|api[_-]?key|authorization)/i.test(value)) {
    reasons.push("SCHEDULE_IDENTITY_UNRESOLVED", "UNSAFE_SOURCE")
    return null
  }
  return value
}

const cronExpressionFor = (value: string | null, reasons: string[]): string | null => {
  if (value === null) {
    reasons.push("SCHEDULE_EXPRESSION_UNRESOLVED")
    return null
  }
  const normalized = value.trim().normalize("NFC")
  if (!cronExpressionValid(normalized) || sanitizeScalar(normalized, "schedule_expression") === null) {
    reasons.push("SCHEDULE_EXPRESSION_UNRESOLVED", "UNSAFE_SOURCE")
    return null
  }
  return normalized
}

interface YamlScheduleDeclaration {
  readonly expression: string | null
  readonly handler: string | null
  readonly offset: number
}

const yamlScheduleDeclarationsFor = (source: string, path: string): readonly YamlScheduleDeclaration[] => {
  const declarations: YamlScheduleDeclaration[] = []
  const direct = (value: unknown): YamlScheduleDeclaration | null => {
    const pairs = loaderYamlPairs(value)
    const cronPair = pairs.find((pair) => loaderYamlKey(pair.key) === "cron")
    if (cronPair === undefined) return null
    const handlerPair = pairs.find((pair) => ["handler", "command", "class"].includes(loaderYamlKey(pair.key) ?? ""))
    return {
      expression: loaderYamlScalar(cronPair.value),
      handler: handlerPair === undefined ? null : loaderYamlScalar(handlerPair.value),
      offset: cronPair.range?.[0] ?? 0,
    }
  }
  const collectScheduleContainer = (value: unknown): void => {
    const node = loaderYamlNode(value)
    if (node?.items === undefined) return
    for (const item of node.items) {
      const directItem = direct(item)
      if (directItem !== null) declarations.push(directItem)
      else for (const pair of loaderYamlPairs(item)) {
        const nested = direct(pair.value)
        if (nested !== null) declarations.push(nested)
      }
    }
  }
  try {
    const document = parseDocument(source, { prettyErrors: false })
    if (document.errors.length > 0) return declarations
    for (const pair of loaderYamlPairs(document.contents)) {
      const key = loaderYamlKey(pair.key)
      if (key === "on") {
        for (const nested of loaderYamlPairs(pair.value)) {
          if (loaderYamlKey(nested.key) === "schedule") collectScheduleContainer(nested.value)
        }
      } else if (key === "schedule" || key === "schedules" || key === "triggers") {
        collectScheduleContainer(pair.value)
      } else if (/(^|\/)(?:scheduler|schedules?|triggers)\.ya?ml$/i.test(path)) {
        const declaration = direct(pair.value)
        if (declaration !== null) declarations.push(declaration)
      }
    }
  } catch {
    return declarations
  }
  return declarations
}

const schedulePathReachable = (authority: AuthorityGraph, entryPath: string, targetPath: string): boolean => {
  const noncyclicSource = (path: string): boolean =>
    authority.reachableSources.has(path) && !authority.cyclicSources.has(path) && !authority.cyclicOnlySources.has(path)
  if (/\.(?:ts|tsx|js|mjs)$/i.test(entryPath)) {
    return authority.runtimeEntrySources.has(entryPath) && authority.runtimeEntrySources.has(targetPath)
  }
  if (authority.authority === "legacy" && entryPath.startsWith("app/config/")) return noncyclicSource(targetPath)
  if (/\.(?:ya?ml|json)$/i.test(entryPath)) {
    return authority.reachableLoaders.has(entryPath) && noncyclicSource(targetPath)
  }
  return noncyclicSource(entryPath) && noncyclicSource(targetPath)
}

const scheduleHandlerFor = (raw: string | null, reasons: string[], authority: AuthorityGraph, unit: SourceUnit): string | null => {
  const value = raw?.trim() ?? ""
  if (!/^(?:[A-Za-z_$][A-Za-z0-9_$]*)(?:(?:\\|::|\.)[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(value)) {
    reasons.push("SCHEDULE_HANDLER_UNRESOLVED")
    return null
  }
  const normalized = normalizeSafe(value, "handler_ref", reasons)
  if (normalized === null) return null
  const target = resolveClassForPath(authority, unit.path, normalized)
  if (target !== undefined && schedulePathReachable(authority, unit.path, target.path)) return normalized
  if (authority.functionsByPath.get(unit.path)?.has(normalized) && schedulePathReachable(authority, unit.path, unit.path)) return normalized
  reasons.push("SCHEDULE_HANDLER_UNRESOLVED")
  return normalized
}

const scheduleTriggersFor = (unit: SourceUnit, authority: AuthorityGraph): readonly ScheduleTrigger[] => {
  const code = withoutComments(unit.text)
  const structure = withoutLiterals(code)
  const triggers: ScheduleTrigger[] = []
  const owner = classMatches(structure)[0]?.name ?? null
  const ownerReasons: string[] = []
  const ownerRef = owner === null ? null : classOwner(structure, owner, ownerReasons)
  const enabled = /\b(?:disabled|enabled)\s*[:=]\s*(?:true|false)/i.test(structure) ? !/\bdisabled\s*[:=]\s*true|\benabled\s*[:=]\s*false/i.test(structure) : true
  for (const call of literalCallsFor(code, "schedule")) {
    const reasons: string[] = [...ownerReasons]
    const triggerIdentity = scheduleIdentityFor(call.args[0] ?? null, reasons)
    const expression = cronExpressionFor(call.args[1] ?? null, reasons)
    const handlerRef = call.rawArgs.length >= 3 ? scheduleHandlerFor(call.rawArgs[2] ?? null, reasons, authority, unit) : ownerRef === null ? null : scheduleHandlerFor(ownerRef, reasons, authority, unit)
    if (call.rawArgs.length < 2 || call.rawArgs.length > 3 || call.args[0] === null || call.args[1] === null) reasons.push("SCHEDULE_PARSE_INCOMPLETE")
    const runtimeRegistered = handlerRef !== null && !reasons.includes("SCHEDULE_HANDLER_UNRESOLVED")
    if (!runtimeRegistered) reasons.push("SCHEDULE_REGISTRATION_UNRESOLVED")
    triggers.push({ triggerKind: "cron", triggerIdentity, expression, ownerRef, handlerRef, enabled, runtimeRegistered, line: lineAt(unit.text, call.offset), reasons })
  }
  if (/\.(?:ya?ml)$/i.test(unit.path)) {
    for (const declaration of yamlScheduleDeclarationsFor(code, unit.path)) {
      const reasons: string[] = [...ownerReasons]
      const expression = cronExpressionFor(declaration.expression, reasons)
      const workflowSchedule = /\/\.github\/workflows\//.test(`/${unit.path}/`) && declaration.handler === null
      const handlerRef = workflowSchedule ? null : scheduleHandlerFor(declaration.handler, reasons, authority, unit)
      const triggerIdentity = normalizeSafe(`${unit.path}:cron`, "source_path", reasons)
      const runtimeRegistered = workflowSchedule || (handlerRef !== null && !reasons.includes("SCHEDULE_HANDLER_UNRESOLVED"))
      if (!runtimeRegistered) reasons.push("SCHEDULE_REGISTRATION_UNRESOLVED")
      triggers.push({ triggerKind: "cron", triggerIdentity, expression, ownerRef, handlerRef, enabled, runtimeRegistered, line: lineAt(unit.text, declaration.offset), reasons })
    }
  }
  if (/^\s*workflow_dispatch\s*:/im.test(structure)) {
    const offset = structure.search(/^\s*workflow_dispatch\s*:/im)
    triggers.push({ triggerKind: "workflow_dispatch", triggerIdentity: normalizeSafe(unit.path, "source_path", []), expression: null, ownerRef, handlerRef: ownerRef, enabled, runtimeRegistered: true, line: lineAt(unit.text, Math.max(0, offset)), reasons: ownerReasons })
  }
  const runtimeRegistered = /\b(?:register|registry|dispatch|scheduler)\b/i.test(structure) ? true : null
  if (/\b(?:queue|consume|MessageHandler|QueueConsumer)\b/i.test(structure)) {
    const offset = structure.search(/\b(?:queue|consume|MessageHandler|QueueConsumer)\b/i)
    triggers.push({ triggerKind: "queue", triggerIdentity: normalizeSafe(`${unit.path}:queue`, "field", []), expression: null, ownerRef, handlerRef: ownerRef, enabled, runtimeRegistered, line: lineAt(unit.text, Math.max(0, offset)), reasons: ownerReasons })
  }
  if (/EventSubscriber|EventListener|subscribe\s*\(/i.test(structure) || /\/EventSubscriber\//i.test(unit.path)) {
    const offset = structure.search(/EventSubscriber|EventListener|subscribe\s*\(/i)
    triggers.push({ triggerKind: "event", triggerIdentity: normalizeSafe(`${unit.path}:event`, "field", []), expression: null, ownerRef, handlerRef: ownerRef, enabled, runtimeRegistered, line: lineAt(unit.text, Math.max(0, offset)), reasons: ownerReasons })
  }
  if (/\/Command\//i.test(unit.path) && classMatches(structure).length > 0) triggers.push({ triggerKind: "manual", triggerIdentity: ownerRef, expression: null, ownerRef, handlerRef: ownerRef, enabled, runtimeRegistered, line: lineAt(unit.text, classMatches(structure)[0]?.offset ?? 0), reasons: ownerReasons })
  if (/\b(?:startup|onStartup|kernel\.boot|on_boot)\b/i.test(structure)) {
    const offset = structure.search(/\b(?:startup|onStartup|kernel\.boot|on_boot)\b/i)
    triggers.push({ triggerKind: "startup", triggerIdentity: normalizeSafe(`${unit.path}:startup`, "field", []), expression: null, ownerRef, handlerRef: ownerRef, enabled, runtimeRegistered, line: lineAt(unit.text, Math.max(0, offset)), reasons: ownerReasons })
  }
  if (/\b(?:webhook|handleRequest)\b/i.test(structure)) {
    const offset = structure.search(/\b(?:webhook|handleRequest)\b/i)
    triggers.push({ triggerKind: "webhook", triggerIdentity: normalizeSafe(`${unit.path}:webhook`, "field", []), expression: null, ownerRef, handlerRef: ownerRef, enabled, runtimeRegistered, line: lineAt(unit.text, Math.max(0, offset)), reasons: ownerReasons })
  }
  return triggers
}
const scheduleRow = (context: ManifestContext, unit: SourceUnit, ordinal: number, trigger: ScheduleTrigger, role: string): ParsedRow => {
  const reasons = [...trigger.reasons]
  if (trigger.triggerIdentity === null && trigger.triggerKind !== "unknown") reasons.push("SCHEDULE_IDENTITY_UNRESOLVED")
  const status: InventoryRow["status"] = reasons.length > 0 ? "unresolved" : "covered"
  const details: ScheduleBackgroundDetails = {
    trigger_kind: trigger.triggerKind,
    trigger_identity: trigger.triggerIdentity,
    schedule_expression: trigger.expression,
    owner_ref: trigger.ownerRef,
    handler_ref: trigger.handlerRef,
    enabled: trigger.enabled,
    repository_owned: true,
    runtime_registered: trigger.runtimeRegistered,
  }
  const declaration = declarationId(unit.authority, unit.authority, unit.path, "schedule_background", ordinal)
  const signature = canonicalJson(["schedule_background", details.trigger_kind, details.trigger_identity, details.owner_ref, details.handler_ref, details.schedule_expression])
  const sourceRefId = sourceRefFor(context, unit.authority, role, unit.path, trigger.line, trigger.line, details.handler_ref)
  return {
    path: unit.path,
    sourceRefIds: [sourceRefId],
    ownerRef: details.owner_ref,
    imported: true,
    importerPath: null,
    row: {
      row_id: rowId("schedule_background", declaration, signature),
      declaration_id: declaration,
      inventory_kind: "schedule_background",
      authority_line: unit.authority,
      canonical_key: signature,
      signature,
      status,
      observation_kinds: ["static_source"],
      source_ref_ids: [sourceRefId],
      revision_ref_ids: [context.scans[unit.authority].revisionRefId],
      runtime_observation_ref_ids: [],
      coverage_ref_ids: [],
      accepted_intent_ref_ids: [],
      duplicate_group_id: null,
      mismatch: mismatch(status === "unresolved" ? "unresolved" : "none", [], sortUnique(reasons)[0] ?? null),
      reason_codes: sortUnique(reasons),
      related_row_ids: [],
      details,
    },
  }
}

const absentScheduleRow = (context: ManifestContext, authority: "legacy" | "mono", familyId: string, role: string): ParsedRow => {
  const sourceRefId = absentSource(context, authority, familyId, role)
  const details: ScheduleBackgroundDetails = { trigger_kind: "cron", trigger_identity: null, schedule_expression: null, owner_ref: null, handler_ref: null, enabled: null, repository_owned: true, runtime_registered: null }
  const signature = canonicalJson(["schedule_background", "cron", null, null, null, null])
  const declaration = declarationId(authority, authority, familyId, "absent_schedule_family", 0)
  return {
    path: familyId,
    sourceRefIds: [sourceRefId],
    ownerRef: null,
    imported: true,
    importerPath: null,
    row: {
      row_id: rowId("schedule_background", declaration, signature),
      declaration_id: declaration,
      inventory_kind: "schedule_background",
      authority_line: authority,
      canonical_key: signature,
      signature,
      status: "absent",
      observation_kinds: ["static_source"],
      source_ref_ids: [sourceRefId],
      revision_ref_ids: [context.scans[authority].revisionRefId],
      runtime_observation_ref_ids: [],
      coverage_ref_ids: [],
      accepted_intent_ref_ids: [],
      duplicate_group_id: null,
      mismatch: mismatch("absent", [], "ABSENT_SCHEDULE"),
      reason_codes: ["ABSENT_SCHEDULE"],
      related_row_ids: [],
      details,
    },
  }
}

const parseSchedules = (context: ManifestContext, authority: "legacy" | "mono"): { readonly parsed: readonly ParsedRow[]; readonly failures: readonly C2CollectionFailure[] } => {
  const familyId = authority === "legacy" ? C2_FAMILY_IDS.legacySchedules : C2_FAMILY_IDS.monoSchedules
  const role = authority === "legacy" ? "legacy_schedule_authority" : "mono_schedule_authority"
  const source = sourceUnits(context, authority, familyId, role)
  const authorityGraph = authorityGraphFor(context, authority)
  const parsed: ParsedRow[] = []
  let ordinal = 0
  let hasPositiveTrigger = false
  for (const unit of source.units) {
    const triggers = scheduleTriggersFor(unit, authorityGraph)
    if (triggers.length > 0) hasPositiveTrigger = true
    for (const trigger of triggers) parsed.push(scheduleRow(context, unit, ordinal++, trigger, role))
  }
  if (!hasPositiveTrigger) parsed.push(absentScheduleRow(context, authority, familyId, role))
  return { parsed, failures: source.failures }
}

const scheduleCollection = (context: ManifestContext, sourceManifestSha256: string): { readonly inventories: readonly [InventoryEnvelope, InventoryEnvelope]; readonly failures: readonly C2CollectionFailure[]; readonly rows: readonly InventoryRow[] } => {
  const legacy = parseSchedules(context, "legacy")
  const mono = parseSchedules(context, "mono")
  const legacyRows = legacy.parsed.map((entry) => entry.row)
  const monoRows = mono.parsed.map((entry) => entry.row)
  applyDuplicateGroups(legacyRows)
  applyDuplicateGroups(monoRows)
  const legacyObservations = legacyRows.filter((row) => row.status === "absent").map((row) => ({ observation_id: observationId("static_source", row.source_ref_ids, sha256("absent-schedule")), observation_kind: "static_source" as const, source_ref_ids: row.source_ref_ids, value_digest: sha256("absent-schedule"), normative: false as const, label: "absent_schedule_family", count: 0 }))
  const monoObservations = monoRows.filter((row) => row.status === "absent").map((row) => ({ observation_id: observationId("static_source", row.source_ref_ids, sha256("absent-schedule")), observation_kind: "static_source" as const, source_ref_ids: row.source_ref_ids, value_digest: sha256("absent-schedule"), normative: false as const, label: "absent_schedule_family", count: 0 }))
  const legacyEnvelope = makeEnvelope(context, "schedule_background", "legacy", legacyRows, [], sourceManifestSha256, legacyObservations)
  const monoEnvelope = makeEnvelope(context, "schedule_background", "mono", monoRows, [], sourceManifestSha256, monoObservations)
  const reconciled = reconcilePair(legacyEnvelope, monoEnvelope)
  const failures: C2CollectionFailure[] = [...legacy.failures, ...mono.failures]
  for (const row of [...reconciled.left.rows, ...reconciled.right.rows]) {
    if (row.reason_codes.includes("ABSENT_SCHEDULE")) failures.push({ status: "gaps_found", reasonCode: "ABSENT_SCHEDULE", rowIds: [row.row_id], sourceRefIds: row.source_ref_ids })
    else if (row.status === "unresolved") failures.push({ status: "unresolved", reasonCode: row.reason_codes[0] ?? "SCHEDULE_PARSE_INCOMPLETE", rowIds: [row.row_id], sourceRefIds: row.source_ref_ids })
    else if (row.status === "duplicate") failures.push({ status: "gaps_found", reasonCode: "DUPLICATE_CANONICAL_IDENTITY", rowIds: [row.row_id], sourceRefIds: row.source_ref_ids })
  }
  return { inventories: [reconciled.left, reconciled.right], failures, rows: [...reconciled.left.rows, ...reconciled.right.rows] }
}
const providerFromText = (text: string): string | null => {
  const patterns: readonly [RegExp, string][] = [
    [/\b(?:Google|GoogleClient|GoogleApis?|GoogleAdapter|GoogleService)\b/i, "google"],
    [/\bSlack(?:Client|Webhook|Adapter|Service)?\b/i, "slack"],
    [/\b(?:Mailer|MailerClient|MailerAdapter|MailerService|Mailgun|Smtp)\b/i, "mailer"],
    [/\b(?:Sms|SmsClient|SmsSender|SmsGateway|SmsAdapter|Twilio)\b/i, "sms"],
    [/\bGatewayAPI(?:Client|Adapter|Service)?\b/i, "gatewayapi"],
    [/\bStripe(?:Client|Adapter|Service)?\b/i, "stripe"],
    [/\b(?:Aws|S3Client)\b/i, "aws"],
    [/\b(?:Github|GitHub)(?:Client|Adapter|Service)?\b/i, "github"],
    [/\b(?:OpenAI|Anthropic)(?:Client|Adapter|Service)?\b/i, "ai"],
  ]
  for (const [pattern, provider] of patterns) if (pattern.test(text)) return provider
  return null
}

const integrationAdapterPattern = /\b(?:HttpClient|GuzzleHttp|HttpAdapter|RestClient|Axios|CurlClient|WebhookClient|Transport|RequestInit|executeFetch)\b/i

const secretShapedEndpointSegment = (segment: string): boolean => {
  if (segment.length < 20 || /^[a-f0-9]{32,}$/i.test(segment)) return false
  let classes = 0
  if (/[a-z]/.test(segment)) classes += 1
  if (/[A-Z]/.test(segment)) classes += 1
  if (/[0-9]/.test(segment)) classes += 1
  return classes >= 3 || (classes >= 2 && segment.length >= 24)
}

const safeEndpoint = (raw: string, reasons: string[]): string | null => {
  try {
    const url = new URL(raw)
    const credentialPath = /\/services\/[^/]{4,}\/[^/]{4,}\/[^/]{8,}(?:\/|$)/i.test(url.pathname)
    const secretHost = url.hostname.split(".").some((segment) => secretShapedEndpointSegment(segment))
    const secretPath = url.pathname.split("/").some((segment) => secretShapedEndpointSegment(segment))
    if (url.username.length > 0 || url.password.length > 0 || credentialPath || secretHost || secretPath || /(?:^|[?&])(token|secret|password|key|authorization)=/i.test(url.search)) {
      reasons.push("UNSAFE_SOURCE")
      return null
    }
    url.search = ""
    url.hash = ""
    return normalizeSafe(url.toString().replace(/\/$/, ""), "endpoint_ref", reasons)
  } catch {
    reasons.push("UNKNOWN_INTEGRATION")
    return null
  }
}

const protocolFor = (endpoint: string | null, text: string): string | null => {
  if (endpoint !== null) {
    try { return new URL(endpoint).protocol.replace(":", "") } catch { return null }
  }
  if (/\b(?:smtp|mailer|mail)\b/i.test(text)) return "smtp"
  if (/\b(?:sms|twilio|gatewayapi)\b/i.test(text)) return "sms"
  if (/\b(?:slack|google|github|stripe|s3client|openai|anthropic)\b/i.test(text)) return "https"
  if (/\b(?:grpc|protobuf)\b/i.test(text)) return "grpc"
  if (/\b(?:fetch|curl|https?|amqp|websocket)\b/i.test(text)) return "http"
  return null
}
const credentialSlotFor = (raw: string | null, reasons: string[]): string | null => {
  const value = raw?.trim().normalize("NFC") ?? ""
  const slotPattern = /^(?:env|secret|credential|vault)(?:[.:/])[A-Za-z][A-Za-z0-9_.-]{0,127}$/i
  const envPattern = /^[A-Z][A-Z0-9_]{1,127}$/
  if (!slotPattern.test(value) && !envPattern.test(value)) {
    reasons.push("CREDENTIAL_SLOT_UNRESOLVED", "UNSAFE_SOURCE")
    return null
  }
  if (opaqueScheduleValue(value) || unsafeScalarReason(value, "field") !== null) {
    reasons.push("CREDENTIAL_SLOT_UNRESOLVED", "UNSAFE_SOURCE")
    return null
  }
  return normalizeSafe(value, "credential_slot_ref", reasons)
}

const productionIntegrationSource = (path: string): boolean =>
  !/(?:^|\/)(?:test|tests|e2e|fixtures)(?:\/|$)|\.(?:test|spec)\.[^/]+$/i.test(path)
const integrationCallPattern = /\b(?:fetch|curl_exec|curl_init|request|publish|send|post|put|delete|HttpClient|GuzzleHttp|Mailer|Slack|Google|Twilio|Smtp|Sms|GatewayAPI|Webhook)\b\s*(?:\(|->|\.)/g
const integrationCallsFor = (unit: SourceUnit, authority: AuthorityGraph): readonly IntegrationCall[] => {
  const calls: IntegrationCall[] = []
  const seen = new Set<number>()
  const stripped = withoutComments(unit.text)
  const structure = withoutLiterals(stripped)
  const classes = classMatches(structure)
  const effectCalls = effectCallExpressionsFor(unit.text)
  const ownerClassForOffset = (offset: number): LanguageClass | undefined => {
    const index = classes.findIndex((entry, classIndex) => offset >= entry.offset && offset < (classes[classIndex + 1]?.offset ?? structure.length))
    const name = index < 0 ? null : classes[index]?.name ?? null
    return name === null ? undefined : authority.classesByPath.get(unit.path)?.find((item) => item.name === name)
  }
  const defaultOwnerName = classes[0]?.name ?? null
  const defaultOwnerReasons: string[] = []
  const defaultOwnerRef = defaultOwnerName === null ? null : classOwner(structure, defaultOwnerName, defaultOwnerReasons)
  const importerFor = (ownerRef: string | null): { readonly imported: boolean; readonly importerPath: string | null } => {
    const importerPath = importedBySources(authority, unit, ownerRef)
    return { imported: importerPath !== null, importerPath }
  }
  const callPattern = new RegExp(integrationCallPattern.source, integrationCallPattern.flags)
  for (const match of structure.matchAll(callPattern)) {
    if (match.index === undefined) continue
    const callableName = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(match[0] ?? "")?.[1] ?? null
    const declarationName = callableName !== null
      && (
        /\bfunction\s*(?:&\s*)?$/.test(structure.slice(Math.max(0, match.index - 32), match.index))
        || new RegExp(`^${callableName}\\s*\\([^)]*\\)\\s*(?::[^{}]+)?\\s*\\{`).test(structure.slice(match.index))
      )
      ? callableName
      : null
    const effectCall = effectCalls.find((call) => match.index !== undefined && match.index >= call.offset && match.index <= call.offset + call.chain.length)
    if (declarationName === null && (effectCall === undefined || callableName !== effectCall.callable)) continue
    const callOffset = effectCall?.offset ?? match.index
    if (seen.has(callOffset)) continue
    seen.add(callOffset)
    const ownerClass = ownerClassForOffset(callOffset)
    const ownerRef = ownerClass?.fqn ?? null
    const { imported, importerPath } = importerFor(ownerRef)
    const ownerIndex = classes.findIndex((entry, classIndex) => callOffset >= entry.offset && callOffset < (classes[classIndex + 1]?.offset ?? structure.length))
    const functionContext = functionContextFor(unit.text, callOffset)
    const contextStart = functionContext?.bodyStart === undefined ? ownerIndex < 0 ? 0 : classes[ownerIndex]?.offset ?? 0 : functionContext.bodyStart + 1
    const contextEnd = functionContext?.bodyEnd ?? (ownerIndex < 0 ? stripped.length : classes[ownerIndex + 1]?.offset ?? stripped.length)
    const contextText = stripped.slice(contextStart, contextEnd)
    const contextStructure = structure.slice(contextStart, contextEnd)
    const reasons: string[] = []
    const resolvedCall = effectCall === undefined ? null : resolveEffectCall(authority, unit, effectCall, ownerClass)
    const adapterEvidence = integrationAdapterPattern.test(contextStructure) || integrationAdapterPattern.test(resolvedCall?.symbol ?? "")
    const namedProviderRef = providerFromText(resolvedCall?.symbol ?? "")
      ?? providerFromText(ownerRef ?? "")
      ?? providerFromText(contextStructure)
    const literalCall = callableName === null
      ? undefined
      : literalCallsFor(unit.text, callableName).find((candidate) =>
        candidate.offset >= callOffset && candidate.offset <= callOffset + (effectCall?.chain.length ?? callableName.length),
      )
    const endpointMatch = /https?:\/\/[^\s"'`),}]+/i.exec(literalCall?.rawArgs.join(",") ?? "")
    const endpointRef = endpointMatch?.[0] === undefined ? null : safeEndpoint(endpointMatch[0], reasons)
    const protocol = protocolFor(endpointRef, `${contextStructure} ${callableName ?? ""} ${resolvedCall?.symbol ?? ""} ${namedProviderRef ?? ""}`)
      ?? (adapterEvidence ? "http" : null)
    const transportEvidence = adapterEvidence || /^(?:fetch|curl_exec|curl_init)$/i.test(callableName ?? "")
    const positiveAnchor = endpointMatch !== null || namedProviderRef !== null || transportEvidence || protocol !== null
    if (!positiveAnchor) continue
    if (protocol === null) reasons.push("UNKNOWN_INTEGRATION")
    const credentialMatch = /\b(?:getenv|env|secret|credential|apiKey|api_key)\s*\(\s*["']([A-Za-z0-9_.:-]+)["']/i.exec(contextText)
    const credentialSlotRef = credentialMatch?.[1] === undefined ? null : credentialSlotFor(credentialMatch[1], reasons)
    const effectClasses: EffectClass[] = resolvedCall === null ? ["unknown"] : ["outbound"]
    const direction: ExternalIntegrationDetails["direction"] = /\b(?:webhook|handleRequest|onRequest|incoming|inbound)\b/i.test(contextStructure) ? "inbound" : "outbound"
    const callSiteContext = functionContextFor(unit.text, callOffset, true)
    const callSiteName = declarationName ?? callSiteContext?.name ?? callableName
    const callSiteRef = callSiteName === null
      ? null
      : ownerRef === null
        ? `${unit.path}#${callSiteName}`
        : `${ownerRef}::${callSiteName}`
    const safeSymbol = normalizeSafe(callSiteRef, "symbol", reasons)
    if (safeSymbol === null) reasons.push("INTEGRATION_CALLSITE_UNRESOLVED")
    const providerRef = namedProviderRef ?? (transportEvidence
      ? normalizeSafe(resolvedCall?.symbol ?? safeSymbol, "symbol", reasons)
      : null)
    if (providerRef === null) reasons.push("UNKNOWN_INTEGRATION")
    calls.push({ authority: unit.authority, path: unit.path, sourceRefId: unit.sourceRefId, ownerRef, symbolRef: safeSymbol, providerRef, direction, protocol, endpointRef, credentialSlotRef, effectClasses, reasonCodes: sortUnique(reasons), imported, importerPath, line: lineAt(unit.text, callOffset) })
  }
  if (calls.length > 0) {
    const specificity = (call: IntegrationCall): number =>
      (call.effectClasses.includes("outbound") ? 1 : 0)
      + (call.protocol === null ? 0 : 1)
      + (call.endpointRef === null ? 0 : 1)
      + (call.credentialSlotRef === null ? 0 : 1)
    const selected = calls.filter((call, index) =>
      !calls.some((candidate, candidateIndex) =>
        candidateIndex !== index
        && candidate.path === call.path
        && candidate.symbolRef === call.symbolRef
        && candidate.providerRef === call.providerRef
        && candidate.direction === call.direction
        && specificity(candidate) > specificity(call),
      ),
    )
    const identities = new Set<string>()
    return selected.filter((call) => {
      if (call.reasonCodes.length > 0) return true
      const identity = canonicalJson([
        call.providerRef,
        call.direction,
        call.protocol,
        call.endpointRef,
        call.credentialSlotRef,
        call.symbolRef,
      ])
      if (identities.has(identity)) return false
      identities.add(identity)
      return true
    })
  }
  const declarationProvider = providerFromText(defaultOwnerRef ?? "")
  const declarationMatch = /\b(fetch|request|publish|send|post|put|delete)\s*\([^)]*\)\s*(?::[^{}]+)?\s*\{/.exec(structure)
  if (declarationProvider !== null && declarationMatch?.[1] !== undefined) {
    const { imported, importerPath } = importerFor(defaultOwnerRef)
    const reasons: string[] = [...(defaultOwnerRef === null ? ["UNKNOWN_INTEGRATION"] : []), ...defaultOwnerReasons]
    const symbolRef = normalizeSafe(defaultOwnerRef === null ? `${unit.path}#${declarationMatch[1]}` : `${defaultOwnerRef}::${declarationMatch[1]}`, "symbol", reasons)
    if (symbolRef === null) reasons.push("INTEGRATION_CALLSITE_UNRESOLVED")
    calls.push({ authority: unit.authority, path: unit.path, sourceRefId: unit.sourceRefId, ownerRef: defaultOwnerRef, symbolRef, providerRef: normalizeSafe(declarationProvider, "field", reasons), direction: "outbound", protocol: protocolFor(null, structure), endpointRef: null, credentialSlotRef: null, effectClasses: ["unknown"], reasonCodes: sortUnique(reasons), imported, importerPath, line: lineAt(unit.text, declarationMatch.index) })
  }
  return calls
}
const integrationRow = (context: ManifestContext, call: IntegrationCall, ordinal: number, role: string): ParsedRow => {
  const details: ExternalIntegrationDetails = { provider_ref: call.providerRef, direction: call.direction, protocol: call.protocol, endpoint_ref: call.endpointRef, credential_slot_ref: call.credentialSlotRef, call_site_ref: call.symbolRef, contract_ref: null, effect_classes: call.effectClasses }
  const reasons = [...call.reasonCodes]
  const status: InventoryRow["status"] = reasons.includes("UNSAFE_SOURCE") || reasons.includes("UNKNOWN_INTEGRATION") || reasons.includes("INTEGRATION_CALLSITE_UNRESOLVED") ? "unresolved" : !call.imported ? "dead_unimported" : "covered"
  if (status === "dead_unimported") reasons.push("DEAD_UNIMPORTED_SOURCE")
  const declaration = declarationId(call.authority, call.authority, call.path, "external_integration", ordinal)
  const sourceRefId = sourceRefFor(context, call.authority, role, call.path, call.line, call.line, details.call_site_ref)
  const signature = canonicalJson(["external_integration", details.provider_ref, details.direction, details.protocol, details.endpoint_ref, details.credential_slot_ref, details.call_site_ref])
  return {
    path: call.path,
    sourceRefIds: [sourceRefId],
    ownerRef: call.ownerRef,
    imported: call.imported,
    importerPath: call.importerPath,
    row: {
      row_id: rowId("external_integration", declaration, signature),
      declaration_id: declaration,
      inventory_kind: "external_integration",
      authority_line: call.authority,
      canonical_key: signature,
      signature,
      status,
      observation_kinds: ["static_source"],
      source_ref_ids: [sourceRefId],
      revision_ref_ids: [context.scans[call.authority].revisionRefId],
      runtime_observation_ref_ids: [],
      coverage_ref_ids: [],
      accepted_intent_ref_ids: [],
      duplicate_group_id: null,
      mismatch: mismatch(status === "unresolved" ? "unresolved" : status === "dead_unimported" ? "dead_unimported" : "none", [], reasons[0] ?? null),
      reason_codes: sortUnique(reasons),
      related_row_ids: [],
      details,
    },
  }
}

const parseIntegrations = (context: ManifestContext, authority: "legacy" | "mono"): { readonly parsed: readonly ParsedRow[]; readonly calls: readonly IntegrationCall[]; readonly failures: readonly C2CollectionFailure[] } => {
  const familyId = authority === "legacy" ? C2_FAMILY_IDS.legacyIntegrations : C2_FAMILY_IDS.monoIntegrations
  const role = authority === "legacy" ? "legacy_integration_authority" : "mono_integration_authority"
  const source = sourceUnits(context, authority, familyId, role)
  const units = source.units.filter((unit) => productionIntegrationSource(unit.path))
  const authorityGraph = authorityGraphFor(context, authority)
  const parsed: ParsedRow[] = []
  const calls: IntegrationCall[] = []
  let ordinal = 0
  for (const unit of units) {
    const found = integrationCallsFor(unit, authorityGraph)
    for (const call of found) {
      calls.push(call)
      parsed.push(integrationRow(context, call, ordinal++, role))
    }
  }
  return { parsed, calls, failures: source.failures }
}

const integrationLinks = (parsed: readonly ParsedRow[]): readonly InventoryLink[] => {
  const links: InventoryLink[] = []
  for (const target of parsed) {
    if (!target.imported || target.importerPath === null || target.ownerRef === null) continue
    const importer = parsed.find((candidate) => candidate.path === target.importerPath)
    if (importer === undefined || importer.path === target.path) continue
    links.push({ relation_id: relationId("imports", importer.row.row_id, target.row.row_id, [...importer.sourceRefIds, ...target.sourceRefIds]), relation_kind: "imports", from_row_id: importer.row.row_id, to_row_id: target.row.row_id, source_ref_ids: sortUnique([...importer.sourceRefIds, ...target.sourceRefIds]) })
  }
  return [...new Map(links.map((link) => [link.relation_id, link])).values()]
}

const integrationCollection = (context: ManifestContext, sourceManifestSha256: string): { readonly inventories: readonly [InventoryEnvelope, InventoryEnvelope]; readonly parsed: readonly [readonly ParsedRow[], readonly ParsedRow[]]; readonly failures: readonly C2CollectionFailure[]; readonly rows: readonly InventoryRow[]; readonly calls: readonly IntegrationCall[] } => {
  const legacy = parseIntegrations(context, "legacy")
  const mono = parseIntegrations(context, "mono")
  const legacyRows = legacy.parsed.map((entry) => entry.row)
  const monoRows = mono.parsed.map((entry) => entry.row)
  applyDuplicateGroups(legacyRows)
  applyDuplicateGroups(monoRows)
  const legacyEnvelope = makeEnvelope(context, "external_integration", "legacy", legacyRows, integrationLinks(legacy.parsed), sourceManifestSha256)
  const monoEnvelope = makeEnvelope(context, "external_integration", "mono", monoRows, integrationLinks(mono.parsed), sourceManifestSha256)
  const reconciled = reconcilePair(legacyEnvelope, monoEnvelope)
  const failures: C2CollectionFailure[] = [...legacy.failures, ...mono.failures]
  for (const row of [...reconciled.left.rows, ...reconciled.right.rows]) {
    if (row.reason_codes.includes("UNSAFE_SOURCE")) failures.push({ status: "source_unavailable", reasonCode: "UNSAFE_SOURCE", rowIds: [row.row_id], sourceRefIds: row.source_ref_ids })
    else if (row.status === "duplicate") continue
    else if (row.reason_codes.includes("UNKNOWN_INTEGRATION")) failures.push({ status: "unresolved", reasonCode: "UNKNOWN_INTEGRATION", rowIds: [row.row_id], sourceRefIds: row.source_ref_ids })
    else if (row.status === "dead_unimported") failures.push({ status: "gaps_found", reasonCode: "DEAD_UNIMPORTED_SOURCE", rowIds: [row.row_id], sourceRefIds: row.source_ref_ids })
    else if (row.status === "missing") failures.push({ status: "gaps_found", reasonCode: "MISSING_COUNTERPART", rowIds: [row.row_id], sourceRefIds: row.source_ref_ids })
    else if (row.status === "extra") failures.push({ status: "gaps_found", reasonCode: "EXTRA_COUNTERPART", rowIds: [row.row_id], sourceRefIds: row.source_ref_ids })
  }
  return { inventories: [reconciled.left, reconciled.right], parsed: [legacy.parsed, mono.parsed], failures, rows: [...reconciled.left.rows, ...reconciled.right.rows], calls: [...legacy.calls, ...mono.calls] }
}

export const applyAcceptedAbsent = (inventory: InventoryEnvelope, acceptedIntentRefIds: readonly string[]): InventoryEnvelope => {
  const refs = sortUnique(acceptedIntentRefIds.filter((value) => value.startsWith("intent://")))
  if (refs.length === 0) return inventory
  return {
    ...inventory,
    rows: inventory.rows.map((row) => row.status !== "absent" || row.mismatch.kind !== "absent" ? row : { ...row, status: "accounted", accepted_intent_ref_ids: refs, mismatch: { ...row.mismatch, disposition: "accepted_absent", accepted_intent_ref_ids: refs } }),
  }
}

const failureRows = (inventories: readonly InventoryEnvelope[], existing: readonly C2CollectionFailure[]): readonly C2CollectionFailure[] => {
  const failures = [...existing]
  for (const inventory of inventories) {
    for (const row of inventory.rows) {
      if (row.status === "absent" && row.reason_codes.includes("ABSENT_SCHEDULE") && !failures.some((failure) => failure.reasonCode === "ABSENT_SCHEDULE" && failure.rowIds.includes(row.row_id))) failures.push({ status: "gaps_found", reasonCode: "ABSENT_SCHEDULE", rowIds: [row.row_id], sourceRefIds: row.source_ref_ids })
    }
  }
  return failures
}

export const collectC2 = (context: ManifestContext, sourceManifestSha256: string): C2Collection => {
  const commands = commandCollection(context, sourceManifestSha256)
  const schedules = scheduleCollection(context, sourceManifestSha256)
  const integrations = integrationCollection(context, sourceManifestSha256)
  const commandWrites = mergeC2Envelopes(commands.inventories[0], commands.inventories[1], sourceManifestSha256)
  const scheduleWorkflows = mergeC2Envelopes(schedules.inventories[0], schedules.inventories[1], sourceManifestSha256)
  const externalIntegrations = mergeC2Envelopes(integrations.inventories[0], integrations.inventories[1], sourceManifestSha256)
  const failures = failureRows([commandWrites, scheduleWorkflows, externalIntegrations], [...commands.failures, ...schedules.failures, ...integrations.failures])
  return { commandWrites, schedules: scheduleWorkflows, integrations: externalIntegrations, failures, rows: [...commandWrites.rows, ...scheduleWorkflows.rows, ...externalIntegrations.rows] }
}

export const collectC2ByAuthority = (context: ManifestContext, sourceManifestSha256: string): { readonly legacy: readonly InventoryEnvelope[]; readonly mono: readonly InventoryEnvelope[]; readonly failures: readonly C2CollectionFailure[] } => {
  const commands = commandCollection(context, sourceManifestSha256)
  const schedules = scheduleCollection(context, sourceManifestSha256)
  const integrations = integrationCollection(context, sourceManifestSha256)
  return { legacy: [commands.inventories[0], schedules.inventories[0], integrations.inventories[0]], mono: [commands.inventories[1], schedules.inventories[1], integrations.inventories[1]], failures: [...commands.failures, ...schedules.failures, ...integrations.failures] }
}
