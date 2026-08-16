import { execFileSync } from "node:child_process"
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve, sep } from "node:path"
import { Effect, Schema } from "effect"
import { canonicalJson, compareByteOrder, sha256 } from "./canonical.js"
import { createManifestContextFromSnapshots, effectiveIgnoreRule, isUnsafeSourcePath, matchesLiteralPattern, SOURCE_FAMILIES, unsafeSourceScalarReason, type RootScanSnapshot } from "./source-manifest.js"
import type { ManifestContext, ScanFile } from "./source-manifest.js"

export class ParityRuntimeError extends Schema.TaggedError<ParityRuntimeError>()(
  "ParityRuntimeError",
  {
    operation: Schema.String,
    path: Schema.String,
    message: Schema.String,
  },
) {}

const isMissingPath = (path: string): boolean => {
  try {
    lstatSync(path)
    return false
  } catch (cause) {
    if (cause !== null && typeof cause === "object" && "code" in cause && cause.code === "ENOENT") return true
    throw cause
  }
}

const assertNoSymlinkPath = (path: string): void => {
  let current = resolve(path)
  while (true) {
    try {
      const stats = lstatSync(current)
      if (stats.isSymbolicLink()) throw new Error(`symbolic link is not an allowed path component: ${current}`)
    } catch (cause) {
      if (cause !== null && typeof cause === "object" && "code" in cause && cause.code === "ENOENT") {
        const parent = dirname(current)
        if (parent === current) return
        current = parent
        continue
      }
      throw cause
    }
    const parent = dirname(current)
    if (parent === current) return
    current = parent
  }
}


const assertWithinRoot = (root: string, target: string): void => {
  const resolvedRoot = resolve(root)
  const resolvedTarget = resolve(target)
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${sep}`)) throw new Error(`path escapes selected root: ${target}`)
}

const listRegularFiles = (rootPath: string, prefix = ""): string[] => {
  const absolute = prefix.length === 0 ? rootPath : join(rootPath, prefix)
  const entries = readdirSync(absolute, { withFileTypes: true })
  const paths: string[] = []
  for (const entry of entries) {
    const child = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) paths.push(...listRegularFiles(rootPath, child))
    else if (entry.isFile()) paths.push(child.split(sep).join("/"))
    else if (entry.isSymbolicLink()) throw new Error(`source file is a symbolic link: ${join(rootPath, child)}`)
  }
  return paths.sort(compareByteOrder)
}

interface GitState {
  readonly revision: string
  readonly trackedPaths: ReadonlySet<string>
  readonly relevantWorkingPaths: readonly string[]
}

const MAX_GIT_METADATA_BYTES = 64 * 1024 * 1024

const gitState = (rootPath: string, rootRef: "legacy" | "mono"): GitState | null => {
  let revision: string
  try {
    revision = execFileSync("git", ["-C", rootPath, "rev-parse", "HEAD"], { encoding: "utf8", maxBuffer: MAX_GIT_METADATA_BYTES, stdio: ["ignore", "pipe", "ignore"] }).trim()
  } catch {
    return null
  }
  if (!/^[0-9a-f]{40}$/.test(revision)) return null
  const dirty = execFileSync("git", ["-C", rootPath, "status", "--porcelain=v1", "--untracked-files=all"], { encoding: "utf8", maxBuffer: MAX_GIT_METADATA_BYTES, stdio: ["ignore", "pipe", "ignore"] }).trim()
  const dirtyEntries = dirty.split("\n").filter((entry) => {
    const path = entry.slice(3).trim().replace(/^"|"$/g, "")
    return path.length > 0 && !path.startsWith("evidence/functional-parity/")
  })
  if (dirtyEntries.length > 0) throw new Error(`selected source root is dirty: ${rootPath}`)
  const ignored = execFileSync("git", ["-C", rootPath, "ls-files", "--others", "--ignored", "--exclude-standard", "-z"], { encoding: "utf8", maxBuffer: MAX_GIT_METADATA_BYTES, stdio: ["ignore", "pipe", "ignore"] }).split("\0").filter((path) => path.length > 0)
  const authorityPath = (path: string): boolean => SOURCE_FAMILIES.some((family) => family.authority_line === rootRef && family.patterns.some((pattern) => matchesLiteralPattern(path, pattern)))
  const ignoredAuthority = ignored.filter(authorityPath)
  if (ignoredAuthority.length > 0) throw new Error(`selected source root contains ignored authority paths: ${ignoredAuthority.length}`)
  const unsafeIgnored = ignored.filter((path) => isUnsafeSourcePath(path) && effectiveIgnoreRule(rootRef, path) === null)
  if (unsafeIgnored.length > 0) throw new Error(`selected source root contains ignored sensitive paths: ${unsafeIgnored.length}`)
  const tracked = execFileSync("git", ["-C", rootPath, "ls-tree", "-r", "--name-only", "-z", revision], { encoding: "utf8", maxBuffer: MAX_GIT_METADATA_BYTES, stdio: ["ignore", "pipe", "ignore"] }).split("\0").filter((path) => path.length > 0)
  const relevantWorkingPaths = ignored.filter((path) => authorityPath(path) || isUnsafeSourcePath(path))
  return { revision, trackedPaths: new Set(tracked), relevantWorkingPaths }
}

const MAX_GIT_BLOB_BYTES = 16 * 1024 * 1024

const gitBlob = (rootPath: string, revision: string, path: string): Buffer => {
  const objectRef = `${revision}:${path}`
  const sizeText = execFileSync("git", ["-C", rootPath, "cat-file", "-s", objectRef], { encoding: "utf8", maxBuffer: 1024, stdio: ["ignore", "pipe", "ignore"] }).trim()
  const size = Number(sizeText)
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_GIT_BLOB_BYTES) throw new Error(`tracked source blob exceeds bounded read limit: ${path}`)
  return execFileSync("git", ["-C", rootPath, "show", objectRef], { maxBuffer: size + 1024, stdio: ["ignore", "pipe", "ignore"] })
}
const redactedSourcePath = (path: string): { readonly path: string; readonly unsafe: boolean } => {
  const unsafe = isUnsafeSourcePath(path) || unsafeSourceScalarReason(path, "source_path") !== null
  return unsafe ? { path: "unsafe-source-redacted", unsafe: true } : { path, unsafe: false }
}

const scanRoot = (rootPath: string, rootRef: "legacy" | "mono"): RootScanSnapshot => {
  assertNoSymlinkPath(rootPath)
  const before = gitState(rootPath, rootRef)
  const paths = before === null
    ? listRegularFiles(rootPath)
    : Array.from(new Set([...before.trackedPaths, ...before.relevantWorkingPaths])).sort(compareByteOrder)
  if (paths.some((path) => redactedSourcePath(path).unsafe)) throw new Error("unsafe source metadata encountered before manifest construction")
  const files: ScanFile[] = paths.map((path) => {
    const absolutePath = join(rootPath, path)
    const tracked = before?.trackedPaths.has(path) === true
    const safePath = redactedSourcePath(path)
    if (!tracked) assertNoSymlinkPath(absolutePath)
    if (safePath.unsafe) return { path: safePath.path, absolutePath: join(rootPath, safePath.path), bytes: null, byteLength: null, digest: null, availability: "unavailable", unsafe: true }
    try {
      const bytes = tracked ? gitBlob(rootPath, before.revision, path) : readFileSync(absolutePath)
      return { path: safePath.path, absolutePath, bytes, byteLength: bytes.byteLength, digest: sha256(bytes), availability: "available", unsafe: false }
    } catch {
      return { path: safePath.path, absolutePath, bytes: null, byteLength: null, digest: null, availability: "unavailable", unsafe: false }
    }
  })
  const after = gitState(rootPath, rootRef)
  if (before !== null && (after === null || before.revision !== after.revision)) throw new Error(`selected source root changed during scan: ${rootPath}`)
  const fallbackDigest = sha256(canonicalJson(files.map((file) => ({ path: file.path, byte_length: file.byteLength, sha256: file.digest, availability: file.availability }))))
  const revision = before === null
    ? { revision_kind: "file_set_digest" as const, revision: fallbackDigest }
    : { revision_kind: "git_commit" as const, revision: before.revision }
  const revisionRefId = `rev-${rootRef}-${revision.revision}`
  return {
    rootRef,
    authorityLine: rootRef,
    rootPath,
    files,
    revision: { revision_ref_id: revisionRefId, repository_ref: rootRef, ...revision, immutable: true },
    revisionRefId,
  }
}

export const scanRootEffect = (rootPath: string, rootRef: "legacy" | "mono"): Effect.Effect<RootScanSnapshot, ParityRuntimeError> =>
  Effect.try({
    try: () => scanRoot(rootPath, rootRef),
    catch: (cause) => new ParityRuntimeError({ operation: "scan_root", path: rootPath, message: cause instanceof Error ? cause.message : "source root is unavailable" }),
  })

export const createManifestContextEffect = (legacyRoot: string, monoRoot: string): Effect.Effect<ManifestContext, ParityRuntimeError> =>
  Effect.gen(function* () {
    const legacy = yield* scanRootEffect(legacyRoot, "legacy")
    const mono = yield* scanRootEffect(monoRoot, "mono")
    return createManifestContextFromSnapshots(legacy, mono)
  })

export const readProjectionEffect = (root: string, projectionDirectory: string, name: string): Effect.Effect<string | null, ParityRuntimeError> =>
  Effect.try({
    try: () => {
      const path = join(root, projectionDirectory, name)
      assertWithinRoot(root, path)
      assertNoSymlinkPath(path)
      return isMissingPath(path) ? null : readFileSync(path, "utf8")
    },
    catch: (cause) => new ParityRuntimeError({ operation: "read_projection", path: join(root, projectionDirectory, name), message: cause instanceof Error ? cause.message : "projection is unavailable" }),
  })

const RENAME_EXCHANGE_SCRIPT = `import { dlopen, FFIType } from "bun:ffi"
const source = process.argv[1]
const target = process.argv[2]
if (source === undefined || target === undefined) process.exit(2)
const libc = dlopen("libc.so.6", { renameat2: { args: [FFIType.c_int, FFIType.cstring, FFIType.c_int, FFIType.cstring, FFIType.c_uint], returns: FFIType.c_int } })
const result = libc.symbols.renameat2(-100, Buffer.from(source + String.fromCharCode(0)), -100, Buffer.from(target + String.fromCharCode(0)), 2)
if (result !== 0) process.exit(1)`

const exchangeDirectories = (staging: string, directory: string): void => {
  if (process.platform !== "linux") throw new Error("atomic projection exchange is unavailable on this platform")
  execFileSync(process.execPath, ["-e", RENAME_EXCHANGE_SCRIPT, staging, directory], { stdio: "ignore" })
}

const copyExistingProjectionEntries = (directory: string, staging: string, names: readonly string[]): void => {
  const promoted = new Set(names)
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (promoted.has(entry.name)) continue
    const source = join(directory, entry.name)
    assertNoSymlinkPath(source)
    if (!entry.isFile()) throw new Error(`unsupported projection entry: ${source}`)
    writeFileSync(join(staging, entry.name), readFileSync(source), { flag: "wx" })
  }
}

export const writeProjectionSetEffect = (root: string, projectionDirectory: string, projections: Readonly<Record<string, string>>, names: readonly string[]): Effect.Effect<void, ParityRuntimeError> =>
  Effect.try({
    try: () => {
      assertNoSymlinkPath(root)
      const directory = join(root, projectionDirectory)
      assertWithinRoot(root, directory)
      const parent = dirname(directory)
      assertWithinRoot(root, parent)
      assertNoSymlinkPath(parent)
      if (isMissingPath(parent)) mkdirSync(parent, { recursive: true })
      if (!isMissingPath(directory)) {
        assertNoSymlinkPath(directory)
        if (!lstatSync(directory).isDirectory()) throw new Error(`projection target is not a directory: ${directory}`)
      }
      const staging = mkdtempSync(join(root, ".functional-parity-staging-"))
      assertNoSymlinkPath(staging)
      try {
        if (!isMissingPath(directory)) copyExistingProjectionEntries(directory, staging, names)
        for (const name of names) {
          const contents = projections[name]
          if (contents === undefined) throw new Error(`missing projection payload: ${name}`)
          const target = join(staging, name)
          assertWithinRoot(root, target)
          assertNoSymlinkPath(target)
          writeFileSync(target, contents, { encoding: "utf8", flag: "wx" })
        }
        if (isMissingPath(directory)) renameSync(staging, directory)
        else {
          exchangeDirectories(staging, directory)
          rmSync(staging, { recursive: true, force: true })
        }
      } catch (cause) {
        if (!isMissingPath(staging)) rmSync(staging, { recursive: true, force: true })
        throw cause
      }
    },
    catch: (cause) => new ParityRuntimeError({ operation: "write_projection", path: join(root, projectionDirectory), message: cause instanceof Error ? cause.message : "projection write failed" }),
  })
