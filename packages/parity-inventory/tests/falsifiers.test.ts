import { Effect } from "effect"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { validateReport } from "../src/schema.js"
import { isUnsafeSourcePath, sanitizeScalar, unsafeScalarReason, unsafeSourceScalarReason } from "../src/source-manifest.js"
import { run, type FalsifierId } from "../src/runner.js"
import { scanRootEffect } from "../src/runtime.js"

const falsifiers: readonly FalsifierId[] = [
  "F0_deterministic_replay",
  "F1_missing_required_source",
  "F2_source_hash_drift",
  "F3_duplicate_legacy_route",
  "F4_dead_unimported_source",
  "F5_missing_counterpart",
  "F6_extra_counterpart",
  "F7_method_path_mismatch",
]

describe("C0 fixture falsifiers", () => {
  for (const falsifierId of falsifiers) {
    test(`${falsifierId} uses the frozen synthetic fixture tree`, async () => {
      const result = await Effect.runPromise(run({
        root: `/tmp/functional-parity-missing-${falsifierId}`,
        legacyRoot: `/tmp/functional-parity-missing-legacy-${falsifierId}`,
        mode: "fixture_injection",
        falsifierId,
      }))
      expect(result.exitCode).toBe(13)
      expect(result.report.status).toBe("falsifier_passed")
      expect(result.report.falsifier_id).toBe(falsifierId)
    })
  }

  test("F8 remains fail-closed until a later capsule", async () => {
    const result = await Effect.runPromise(run({ root: ".", legacyRoot: ".", mode: "fixture_injection", falsifierId: "F8_openapi_stale" }))
    expect(result.exitCode).toBe(12)
    expect(result.report.exit_code).toBe(12)
    expect(result.report.status).toBe("command_error")
    expect(result.report.failures.map((failure) => failure.reason_code)).toContain("C0_FALSIFIER_NOT_IMPLEMENTED")
  })
})
const gitFixture = (): string => {
  const root = mkdtempSync("/tmp/functional-parity-git-")
  execFileSync("git", ["-C", root, "init", "-q"])
  execFileSync("git", ["-C", root, "config", "user.email", "parity@example.invalid"])
  execFileSync("git", ["-C", root, "config", "user.name", "parity-test"])
  return root
}

const putFixture = (root: string, path: string, text: string): void => {
  const target = join(root, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, text, "utf8")
}
const cliReport = (root: string, legacyRoot: string, mode: "diff" | "write" = "diff"): { readonly status: number | null; readonly report: Record<string, unknown>; readonly output: string } => {
  const process = spawnSync("bun", ["run", "src/main.ts", "--root", root, "--legacy-root", legacyRoot, "--mode", mode], { cwd: join(import.meta.dir, ".."), encoding: "utf8" })
  const output = process.stdout
  return { status: process.status, report: JSON.parse(output) as Record<string, unknown>, output }
}
const putParityBaseline = (legacyRoot: string, monoRoot: string, legacyRouting: string): void => {
  putFixture(legacyRoot, "app/config/routing.yml", legacyRouting)
  putFixture(legacyRoot, "src/AppBundle/Controller/Api/FixtureController.php", "<?php\nfinal class FixtureApi {}\n")
  putFixture(legacyRoot, "src/AppBundle/Controller/FixtureController.php", "<?php\nfinal class FixtureController {}\n")
  putFixture(legacyRoot, "src/AppBundle/Service/Fixture.php", "<?php\nfinal class FixtureService {}\n")
  putFixture(monoRoot, "apps/server/config/routes.yaml", "fixture:\n    resource: ../src/App/Fixture/Controller/FixtureController.php\n    path: /safe\n    methods: [GET]\n")
  putFixture(monoRoot, "apps/server/src/App/Api/Resource/Fixture.php", "<?php\nfinal class FixtureResource {}\n")
  putFixture(monoRoot, "apps/server/src/App/Fixture/Controller/FixtureController.php", "<?php\nfinal class FixtureController {}\n")
  putFixture(monoRoot, "apps/server/src/App/Controller/FixtureController.php", "<?php\nfinal class FixtureController2 {}\n")
  putFixture(monoRoot, "apps/server/src/App/Infrastructure/Fixture.php", "<?php\nfinal class FixtureInfrastructure {}\n")
  putFixture(monoRoot, "apps/homepage/src/routes/home.tsx", "export default function Home(){return null}\n")
  putFixture(monoRoot, "apps/server/tools/security-h3/0015/generate.ts", "export const fixture = true\n")
}


test("unsafe parsed scalars produce identical blocked receipts", () => {
  const roots = [mkdtempSync("/tmp/functional-parity-scalar-a-"), mkdtempSync("/tmp/functional-parity-scalar-b-")]
  const routes = [
    "first:\n  path: /safe/:token\n  defaults: { _controller: :sk_live_51Ab9xY7qP4wR8tU2nM6kL9zC3 }\n  methods: [GET]\nsecond:\n  path: /safe\n  defaults: { _controller: alice@university.no }\n  methods: [GET]\n",
    "second:\n  path: /safe\n  defaults: { _controller: alice@university.no }\n  methods: [GET]\nfirst:\n  path: /safe/:token\n  defaults: { _controller: :sk_live_51Ab9xY7qP4wR8tU2nM6kL9zC3 }\n  methods: [GET]\n",
  ]
  try {
    const outputs: string[] = []
    for (const [index, root] of roots.entries()) {
      const legacyRoot = join(root, "legacy")
      const monoRoot = join(root, "mono")
      putParityBaseline(legacyRoot, monoRoot, routes[index] ?? routes[0] ?? "")
      const receipt = cliReport(monoRoot, legacyRoot, "write")
      expect(receipt.status).toBe(6)
      expect(validateReport(receipt.report)).toBe(true)
      expect(receipt.report).toMatchObject({ status: "source_unavailable", exit_code: 6, source_manifest_sha256: null, inventory_artifact_sha256: {}, projection_write: { status: "blocked", target_ref: null } })
      expect(receipt.output).not.toContain("sk_live_")
      expect(receipt.output).not.toContain("university.no")
      outputs.push(receipt.output)
    }
    expect(outputs[0]).toBe(outputs[1])
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  }
})

test("fixture injection ignores poisoned authority-root paths", async () => {
  const directory = mkdtempSync("/tmp/functional-parity-poison-")
  const poisonRoot = join(directory, "authority-file")
  writeFileSync(poisonRoot, "sk_live_51Ab9xY7qP4wR8tU2nM6kL9zC3\n", "utf8")
  try {
    const result = await Effect.runPromise(run({ root: poisonRoot, legacyRoot: poisonRoot, mode: "fixture_injection", falsifierId: "F0_deterministic_replay" }))
    expect(result.exitCode).toBe(13)
    expect(result.report.status).toBe("falsifier_passed")
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
test("runtime abort receipts remain schema-valid and non-promotable", () => {
  const unsafe = mkdtempSync("/tmp/functional-parity-receipt-unsafe-")
  const dirty = gitFixture()
  const symlink = mkdtempSync("/tmp/functional-parity-receipt-symlink-")
  const roots: readonly [string, number][] = [[unsafe, 6], [dirty, 7], [symlink, 6]]
  try {
    putFixture(unsafe, "src/user@university.no.php", "<?php\n")
    putFixture(dirty, "safe.txt", "before\n")
    execFileSync("git", ["-C", dirty, "add", "."])
    execFileSync("git", ["-C", dirty, "commit", "-qm", "fixture"])
    writeFileSync(join(dirty, "safe.txt"), "after\n", "utf8")
    mkdirSync(join(symlink, "target"), { recursive: true })
    symlinkSync(join(symlink, "target"), join(symlink, "link"))
    for (const [root, expectedExit] of roots) {
      const receipt = cliReport(root, root)
      expect(receipt.report.status).toBe(expectedExit === 7 ? "source_hash_drift" : "source_unavailable")
      expect(validateReport(receipt.report)).toBe(true)
      expect(receipt.report).toMatchObject({
        exit_code: expectedExit,
        source_manifest_sha256: null,
        inventory_artifact_sha256: {},
        projection_write: { status: "blocked", target_ref: null },
      })
      const verification = receipt.report.verification as Record<string, unknown>
      expect(verification.schema_validation).toBe(false)
      expect(verification.cross_reference_validation).toBe(false)
      expect(verification.deterministic_diff).toBe("different")
      expect(receipt.output).not.toContain("user@university.no")
    }
  } finally {
    for (const [root] of roots) rmSync(root, { recursive: true, force: true })
  }
})



describe("C0 source traversal safety", () => {
  test("reads captured Git paths with non-ASCII names", async () => {
    const root = gitFixture()
    try {
      const path = "apps/server/src/App/Foo/Controller/TorPekerPåTekst1.png"
      putFixture(root, path, "fixture-bytes\n")
      execFileSync("git", ["-C", root, "add", "."])
      execFileSync("git", ["-C", root, "commit", "-qm", "fixture"])
      const snapshot = await Effect.runPromise(scanRootEffect(root, "mono"))
      const nonAscii = snapshot.files.find((file) => file.path === path)
      expect(new TextDecoder().decode(nonAscii?.bytes ?? new Uint8Array())).toContain("fixture-bytes")
      expect(nonAscii?.unsafe).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  test("rejects unsafe PII paths before manifest construction", async () => {
    const root = gitFixture()
    const piiPath = "apps/server/src/App/Foo/Controller/user@university.no.php"
    try {
      putFixture(root, piiPath, "<?php\nfinal class User {}\n")
      execFileSync("git", ["-C", root, "add", "."])
      execFileSync("git", ["-C", root, "commit", "-qm", "fixture"])
      await expect(Effect.runPromise(scanRootEffect(root, "mono"))).rejects.toMatchObject({
        operation: "scan_root",
        message: expect.stringContaining("unsafe source metadata"),
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  test("uses value-independent failure for differing unsafe scalars", async () => {
    const roots = [gitFixture(), gitFixture()]
    const unsafePaths = ["apps/server/src/App/Foo/Controller/user@university.no.php", "apps/server/src/App/Foo/Controller/other@university.no.php"]
    try {
      const failures: Array<{ readonly operation: string; readonly message: string }> = []
      for (const [index, root] of roots.entries()) {
        putFixture(root, unsafePaths[index] ?? unsafePaths[0], "<?php\nfinal class User {}\n")
        execFileSync("git", ["-C", root, "add", "."])
        execFileSync("git", ["-C", root, "commit", "-qm", "fixture"])
        try {
          await Effect.runPromise(scanRootEffect(root, "mono"))
        } catch (error) {
          failures.push({ operation: (error as { operation?: string }).operation ?? "", message: (error as Error).message })
        }
      }
      expect(failures).toHaveLength(2)
      expect(failures[0]).toEqual(failures[1])
      expect(failures[0]?.message).toBe("unsafe source metadata encountered before manifest construction")
      expect(JSON.stringify(failures)).not.toContain("user@university.no")
      expect(JSON.stringify(failures)).not.toContain("other@university.no")
    } finally {
      for (const root of roots) rmSync(root, { recursive: true, force: true })
    }
  })

  test("rejects nested tracked unsafe paths before manifest construction", async () => {
    const root = gitFixture()
    try {
      putFixture(root, "src/AppBundle/Controller/Safe.php", "<?php\nfinal class Safe {}\n")
      putFixture(root, "src/AppBundle/Controller/logs/Token.php", "<?php\n$token = 'fixture';\n")
      execFileSync("git", ["-C", root, "add", "."])
      execFileSync("git", ["-C", root, "commit", "-qm", "fixture"])
      await expect(Effect.runPromise(scanRootEffect(root, "legacy"))).rejects.toMatchObject({ operation: "scan_root" })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("rejects every ignored parseable authority file", async () => {
    const root = gitFixture()
    try {
      putFixture(root, ".gitignore", "app/config/routing.yml\\n")
      putFixture(root, "app/config/routing.yml", "home:\\n  path: /home\\n")
      execFileSync("git", ["-C", root, "add", ".gitignore"])
      execFileSync("git", ["-C", root, "commit", "-qm", "fixture"])
      await expect(Effect.runPromise(scanRootEffect(root, "legacy"))).rejects.toMatchObject({ operation: "scan_root" })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("rejects unsafe files in non-Git roots before manifest construction", async () => {
    const root = mkdtempSync("/tmp/functional-parity-tree-")
    try {
      putFixture(root, "var/logs/app.log", "fixture\n")
      await expect(Effect.runPromise(scanRootEffect(root, "mono"))).rejects.toMatchObject({ operation: "scan_root" })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  test("CLI write returns fixed unsafe report without projection artifacts", () => {
    const roots = [gitFixture(), gitFixture()]
    const unsafePaths = ["apps/server/src/App/Foo/Controller/user@university.no.php", "apps/server/src/App/Foo/Controller/other@university.no.php"]
    try {
      const reports: string[] = []
      for (const [index, root] of roots.entries()) {
        putFixture(root, unsafePaths[index] ?? unsafePaths[0], "<?php\nfinal class User {}\n")
        execFileSync("git", ["-C", root, "add", "."])
        execFileSync("git", ["-C", root, "commit", "-qm", "fixture"])
        const cli = spawnSync("bun", ["run", "src/main.ts", "--root", root, "--legacy-root", root, "--mode", "write"], {
          cwd: join(import.meta.dir, ".."),
          encoding: "utf8",
        })
        expect(cli.status).toBe(6)
        expect(cli.stderr).not.toContain("user@university.no")
        expect(cli.stderr).not.toContain("other@university.no")
        reports.push(cli.stdout)
      }
      expect(reports[0]).toBe(reports[1])
      const report = JSON.parse(reports[0] ?? "{}") as Record<string, unknown>
      expect(report.status).toBe("source_unavailable")
      expect(report.projection_write).toEqual({ status: "blocked", target_ref: null })
      expect(report.source_manifest_sha256).toBeNull()
      expect(report.inventory_artifact_sha256).toEqual({})
      expect(report.verification).toMatchObject({ schema_validation: false, cross_reference_validation: false })
      expect(reports.join("\n")).not.toContain("user@university.no")
      expect(reports.join("\n")).not.toContain("other@university.no")
    } finally {
      for (const root of roots) rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("source safety boundary", () => {

  test("blocks only unsafe path classes before hashing", () => {
    for (const path of [".env", ".env.local", "config/credentials.json", "keys/server.pem", "var/backups/db.sql", "var/logs/app.log", "payloads/request.ndjson", "apps/server/config/jwt/private.pem", "apps/server/config/jwt/public.pem", "apps/homepage/.env.example", "apps/dashboard/.env.example", "apps/server/.env.test", "apps/server/.env.staging", "app/Resources/assets/js/ckeditor/skins/bootstrapck/npm-debug.log"]) {
      expect(isUnsafeSourcePath(path)).toBe(true)
    }
  })

  test("keeps authority source paths hashable", () => {
    for (const path of [
      "app/config/routing.yml",
      "composer.lock",
      "tests/AppBundle/Service/CompanyEmailMakerTest.php",
      "tests/AppBundle/Controller/TeamInterestControllerTest.php",
      "src/AppBundle/Controller/AccessRuleController.php",
      "apps/server/src/App/Interview/Infrastructure/Subscriber/InterviewSubscriber.php",
      "apps/server/tests/AppBundle/Api/AdminUserWriteApiTest.php",
      "apps/homepage/src/routes/_home.team.bergen.styret.tsx",
      "apps/server/tools/security-h3/0015/generate.ts",
    ]) {
      expect(isUnsafeSourcePath(path)).toBe(false)
    }
  })
  test("keeps real-tree-shaped hashed assets hashable", async () => {
    const root = gitFixture()
    const hashedAsset = "apps/server/src/App/Content/Controller/Asset_9f2A7c4E1dB8cF0a7E3d9C5b1A6f2D8e4.png"
    try {
      putFixture(root, hashedAsset, "fixture-bytes\n")
      execFileSync("git", ["-C", root, "add", "."])
      execFileSync("git", ["-C", root, "commit", "-qm", "fixture"])
      const snapshot = await Effect.runPromise(scanRootEffect(root, "mono"))
      const asset = snapshot.files.find((file) => file.path === hashedAsset)
      expect(asset?.availability).toBe("available")
      expect(asset?.unsafe).toBe(false)
      expect(unsafeSourceScalarReason(hashedAsset, "path")).toBeNull()
      expect(unsafeSourceScalarReason("Asset_9f2A7c4E1dB8cF0a7E3d9C5b1A6f2D8e4", "symbol")).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  test("blocks credential-bearing owner symbols before source IDs", () => {
    for (const symbol of [
      "sk_live_51Ab9xY7qP4wR8tU2nM6kL9zC3Controller",
      "ghp_51Ab9xY7qP4wR8tU2nM6kL9zC3",
      "[github_token_redacted]",
      "Ab9xY7qP4wR8tU2nM6kL9zC3vB5sD7fH1Controller",
      "App\\Content\\Ab9xY7qP4wR8tU2nM6kL9zC3vB5sD7fH1Controller::index",
    ]) {
      expect(unsafeSourceScalarReason(symbol, "symbol")).toBe("UNSAFE_SOURCE")
    }
    expect(unsafeSourceScalarReason("App\\Content\\Controller\\HomeController::index", "symbol")).toBeNull()
  })
  test("blocks standard credential formats in every emitted scalar", () => {
    for (const [value, field] of [
      ["sk_live_51Ab9xY7qP4wR8tU2nM6kL9zC3", "_controller"],
      ["ghp_51Ab9xY7qP4wR8tU2nM6kL9zC3", "route_name"],
      ["AKIA1234567890ABCDEF", "resource"],
      ["xoxb-12345678-1234567890", "controller"],
      ["AIzaSyA1234567890abcdefghijkl", "route_name"],
      ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.Ab9xY7qP4wR8tU2nM6kL9zC3vB5sD7fH1", "_controller"],
      ["Authorization: Bearer Ab9xY7qP4wR8tU2nM6kL9zC3", "resource"],
      ["Basic YTpi", "controller"],
      ["Bearer abc.def~ghi", "route_name"],
      ["[github_token_redacted]", "controller"],
      ["svc:token=REAL_SECRET", "_controller"],
    ] as const) {
      expect(unsafeScalarReason(value, field)).toBe("UNSAFE_SOURCE")
      expect(sanitizeScalar(value, field)).toBeNull()
    }
    expect(unsafeScalarReason("AppBundle:Token:index", "controller")).toBeNull()
    expect(unsafeScalarReason(":sk_live_51Ab9xY7qP4wR8tU2nM6kL9zC3", "_controller")).toBe("UNSAFE_SOURCE")
    expect(sanitizeScalar(":sk_live_51Ab9xY7qP4wR8tU2nM6kL9zC3", "_controller")).toBeNull()
    expect(unsafeSourceScalarReason("apps/server/src/App/Token/Issuer.php", "source_path")).toBeNull()
    expect(unsafeSourceScalarReason("src/token=REAL_SECRET.php", "source_path")).toBe("UNSAFE_SOURCE")
    expect(unsafeSourceScalarReason("password-reset.spec.ts", "source_path")).toBeNull()
    expect(unsafeScalarReason("reset_password", "route_name")).toBeNull()
    expect(unsafeScalarReason("forgot_password", "route_name")).toBeNull()
    expect(unsafeScalarReason("profile_edit_password", "route_name")).toBeNull()
    expect(unsafeScalarReason("token", undefined)).toBeNull()
    expect(sanitizeScalar("token")).toBe("token")
  })

  test("blocks unsafe controller tokens before write promotion", async () => {
    const root = mkdtempSync("/tmp/functional-parity-controller-token-")
    const legacyRoot = join(root, "legacy")
    const monoRoot = join(root, "mono")
    try {
      putFixture(legacyRoot, "app/config/routing.yml", "unsafe_controller:\n  path: /safe\n  defaults: { _controller: sk_live_51Ab9xY7qP4wR8tU2nM6kL9zC3 }\n  methods: [GET]\nunsafe_resource:\n  resource: ghp_51Ab9xY7qP4wR8tU2nM6kL9zC3\n  path: /resource\n  methods: [GET]\nunsafe_assignment:\n  path: /assignment\n  defaults: { _controller: \"svc:token=REAL_SECRET\" }\n  methods: [GET]\nunsafe_basic:\n  path: /basic\n  defaults: { _controller: \"Basic YTpi\" }\n  methods: [GET]\nunsafe_bearer_resource:\n  resource: \"Bearer abc.def~ghi\"\n  path: /bearer\n  methods: [GET]\n\"Bearer abc.def~ghi\":\n  path: /bearer-name\n  methods: [GET]\nunsafe_jwt_controller:\n  path: /jwt\n  defaults: { _controller: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.Ab9xY7qP4wR8tU2nM6kL9zC3vB5sD7fH1 }\n  methods: [GET]\neyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.Ab9xY7qP4wR8tU2nM6kL9zC3vB5sD7fH1:\n  path: /jwt-name\n  methods: [GET]\n")
      putFixture(monoRoot, "apps/server/config/routes.yaml", "safe:\n  resource: ../src/App/Fixture/Controller/FixtureController.php\n  path: /safe\n  methods: [GET]\n")
      await expect(Effect.runPromise(run({ root: monoRoot, legacyRoot, mode: "write" }))).rejects.toMatchObject({
        operation: "unsafe_source",
        message: expect.stringContaining("unsafe source metadata"),
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("blocks YAML and PHP opaque methods before report promotion", () => {
    const cases = [
      {
        routing: "unsafe_yaml:\n  path: /unsafe-yaml\n  methods: [OpaqueCredentialMethod]\n",
        controller: "<?php\nfinal class FixtureController {}\n",
        needle: "OpaqueCredentialMethod",
      },
      {
        routing: "safe:\n  path: /safe\n  methods: [GET]\n",
        controller: "<?php\n/** @Route(path=\"/unsafe-php\", methods={\"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.Ab9xY7qP4wR8tU2nM6kL9zC3vB5sD7fH1\"}) */\nfinal class FixtureController {}\n",
        needle: "eyJhbGciOiJIUzI1NiJ9",
      },
      {
        routing: "safe:\n  path: /safe\n  methods: [GET]\n",
        controller: "<?php\n/** @Route(path=\"/unsafe-php\", methods={\"GET]Bearer Ab9xY7qP4wR8tU2nM6kL9zC3\"}) */\nfinal class FixtureController {}\n",
        needle: "GET]Bearer",
      },
    ] as const
    const roots = cases.map(() => mkdtempSync("/tmp/functional-parity-method-"))
    try {
      for (const [index, root] of roots.entries()) {
        const legacyRoot = join(root, "legacy")
        const monoRoot = join(root, "mono")
        const fixture = cases[index] ?? cases[0]
        putParityBaseline(legacyRoot, monoRoot, fixture.routing)
        putFixture(legacyRoot, "src/AppBundle/Controller/MethodController.php", fixture.controller)
        const receipt = cliReport(monoRoot, legacyRoot, "write")
        expect(receipt.status).toBe(6)
        expect(receipt.report).toMatchObject({
          status: "source_unavailable",
          exit_code: 6,
          source_manifest_sha256: null,
          inventory_artifact_sha256: {},
          projection_write: { status: "blocked", target_ref: null },
          verification: { schema_validation: false, cross_reference_validation: false },
        })
        expect(receipt.output).not.toContain(fixture.needle)
      }
    } finally {
      for (const root of roots) rmSync(root, { recursive: true, force: true })
    }
  })
  test("blocks namespaced opaque controller owners before report promotion", () => {
    const root = mkdtempSync("/tmp/functional-parity-namespaced-owner-")
    const legacyRoot = join(root, "legacy")
    const monoRoot = join(root, "mono")
    const token = "Ab9xY7qP4wR8tU2nM6kL9zC3vB5sD7fH1"
    try {
      putParityBaseline(legacyRoot, monoRoot, "safe:\n  path: /safe\n  methods: [GET]\n")
      putFixture(legacyRoot, "src/AppBundle/Controller/OpaqueController.php", `<?php\nnamespace App\\Content;\nfinal class ${token}Controller { /** @Route(path="/safe", methods={"GET"}) */ public function index(): void {} }\n`)
      const receipt = cliReport(monoRoot, legacyRoot, "write")
      expect(receipt.status).toBe(6)
      expect(receipt.report).toMatchObject({
        status: "source_unavailable",
        exit_code: 6,
        source_manifest_sha256: null,
        inventory_artifact_sha256: {},
        projection_write: { status: "blocked", target_ref: null },
      })
      expect(receipt.output).not.toContain(token)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  test("rejects decoy and duplicate PHP method fields", () => {
    const root = mkdtempSync("/tmp/functional-parity-method-duplicate-")
    const legacyRoot = join(root, "legacy")
    const monoRoot = join(root, "mono")
    const token = "Bearer abc.def~ghi"
    try {
      putParityBaseline(legacyRoot, monoRoot, "safe:\n  path: /safe\n  methods: [GET]\n")
      putFixture(monoRoot, "apps/server/src/App/Fixture/Controller/MethodController.php", `<?php\nfinal class MethodController { #[Route(path: "/decoy", name: "methods: [GET],", /* methods: ["GET"], [ */ methods: ["${token}"], methods: ["GET"])] public function index(): void {} }\n`)
      const receipt = cliReport(monoRoot, legacyRoot, "write")
      expect(receipt.status).toBe(6)
      expect(receipt.report).toMatchObject({ status: "source_unavailable", exit_code: 6, source_manifest_sha256: null, inventory_artifact_sha256: {}, projection_write: { status: "blocked", target_ref: null } })
      expect(receipt.output).not.toContain(token)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  test("rejects PHP trivia between method key and value", () => {
    const root = mkdtempSync("/tmp/functional-parity-method-trivia-")
    const legacyRoot = join(root, "legacy")
    const monoRoot = join(root, "mono")
    const token = "Bearer abc.def~ghi"
    try {
      putParityBaseline(legacyRoot, monoRoot, "safe:\n  path: /safe\n  methods: [GET]\n")
      putFixture(monoRoot, "apps/server/src/App/Fixture/Controller/MethodTriviaController.php", `<?php\nfinal class MethodTriviaController { #[Route(path: "/opaque", name: "opaque", methods /* field trivia */ : /* value trivia */ ["${token}"])] public function index(): void {} }\n`)
      const receipt = cliReport(monoRoot, legacyRoot, "write")
      expect(receipt.status).toBe(6)
      expect(receipt.report).toMatchObject({ status: "source_unavailable", exit_code: 6, source_manifest_sha256: null, inventory_artifact_sha256: {}, projection_write: { status: "blocked", target_ref: null } })
      expect(receipt.output).not.toContain(token)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  test("rejects bare-CR PHP method trivia", () => {
    for (const [label, trivia] of [["slash", "// trivia\r"], ["hash", "# trivia\r"]] as const) {
      const root = mkdtempSync(`/tmp/functional-parity-method-cr-${label}-`)
      const legacyRoot = join(root, "legacy")
      const monoRoot = join(root, "mono")
      const token = "Bearer abc.def~ghi"
      try {
        putParityBaseline(legacyRoot, monoRoot, "safe:\n  path: /safe\n  methods: [GET]\n")
        putFixture(monoRoot, `apps/server/src/App/Fixture/Controller/MethodCr${label}.php`, `<?php\nfinal class MethodCr${label} { #[Route(path: "/opaque", name: "opaque", methods ${trivia}: ["${token}"])] public function index(): void {} }\n`)
        const receipt = cliReport(monoRoot, legacyRoot, "write")
        expect(receipt.status).toBe(6)
        expect(receipt.report).toMatchObject({ status: "source_unavailable", exit_code: 6, source_manifest_sha256: null, inventory_artifact_sha256: {}, projection_write: { status: "blocked", target_ref: null } })
        expect(receipt.output).not.toContain(token)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  })


  test("blocks actual sensitive scalars but keeps semantic placeholders", () => {
    for (const [value, field] of [
      ["https://example.invalid/callback?token={token}", "path"],
      ["email", undefined],
      ["token", undefined],
      ["{token}", "token"],
      ["alice@university.no", undefined],
      ["+47 912 34 567", undefined],
      ["Ab9!xY7#qP4$wR8%tU2&nM6@kL9*zC3", "secret"],
    ] as const) {
      if (value === "alice@university.no" || value.startsWith("+47") || field === "secret" || field === "token") expect(unsafeScalarReason(value, field)).toBe("UNSAFE_SOURCE")
      else expect(sanitizeScalar(value, field)).toBe(value)
    }
  })
  test("allows route placeholders but blocks literal route PII and credentials", () => {
    expect(unsafeScalarReason("/reset/{token}", "path")).toBeNull()
    for (const value of ["/reset?token=REAL_SECRET", "/contact/alice@university.no", "/call/+47 912 34 567"]) {
      expect(unsafeScalarReason(value, "path")).toBe("UNSAFE_SOURCE")
      expect(sanitizeScalar(value, "path")).toBeNull()
    }
  })
  test("blocks exact credential, phone, entropy, and controller payloads", async () => {
    for (const value of ["/contact/user@university.no", "/call/+4791234567", "/reset/Ab9xY7qP4wR8tU2nM6kL9zC3vB5sD7fH1", "/reset/0123456789abcdef0123456789abcdef", "/oauth?client_secret=REAL_SECRET"]) {
      expect(unsafeScalarReason(value, "path")).toBe("UNSAFE_SOURCE")
      expect(sanitizeScalar(value, "path")).toBeNull()
    }
    expect(unsafeScalarReason("/assets/0123456789abcdef0123456789abcdef", "path")).toBeNull()
    expect(unsafeScalarReason("/reset/{token}", "path")).toBeNull()
    expect(unsafeScalarReason("/reset/<token>", "path")).toBeNull()
    expect(unsafeScalarReason("/reset/:token", "path")).toBeNull()
    const root = mkdtempSync("/tmp/functional-parity-controller-")
    const legacyRoot = join(root, "legacy")
    const monoRoot = join(root, "mono")
    try {
      putFixture(legacyRoot, "app/config/routing.yml", "one:\n  path: /safe\n  defaults: { _controller: alice@university.no }\n  methods: [GET]\ntwo:\n  path: /safe\n  defaults: { _controller: alice@university.no }\n  methods: [GET]\n")
      putFixture(monoRoot, "apps/server/config/routes.yaml", "safe:\n  resource: ../src/App/Fixture/Controller/FixtureController.php\n  path: /safe\n  methods: [GET]\n")
      await expect(Effect.runPromise(run({ root: monoRoot, legacyRoot, mode: "write" }))).rejects.toMatchObject({
        operation: "unsafe_source",
        message: expect.stringContaining("unsafe source metadata"),
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  test("blocks projection writes for unsafe route scalars", async () => {
    const root = mkdtempSync("/tmp/functional-parity-route-")
    const legacyRoot = join(root, "legacy")
    const monoRoot = join(root, "mono")
    try {
      putFixture(legacyRoot, "app/config/routing.yml", "unsafe:\n  path: /reset?token=REAL_SECRET\n  defaults: { _controller: AppBundle:Fixture:index }\n  methods: [GET]\n")
      putFixture(monoRoot, "apps/server/config/routes.yaml", "safe:\n  resource: ../src/App/Fixture/Controller/FixtureController.php\n  path: /safe\n  methods: [GET]\n")
      await expect(Effect.runPromise(run({ root: monoRoot, legacyRoot, mode: "write" }))).rejects.toMatchObject({
        operation: "unsafe_source",
        message: expect.stringContaining("unsafe source metadata"),
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  test("blocks composed route PII before receipt promotion", () => {
    const root = mkdtempSync("/tmp/functional-parity-composed-pii-")
    const legacyRoot = join(root, "legacy")
    const monoRoot = join(root, "mono")
    const hex = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4"
    try {
      putParityBaseline(legacyRoot, monoRoot, `unsafe_email:\n  path: /notify/user@example.invalid/alice@university.no\n  methods: [GET]\nunsafe_phone:\n  path: /call/+4791234567/${hex}\n  methods: [GET]\n`)
      const receipt = cliReport(monoRoot, legacyRoot, "write")
      expect(receipt.status).toBe(6)
      expect(receipt.report).toMatchObject({
        status: "source_unavailable",
        exit_code: 6,
        source_manifest_sha256: null,
        inventory_artifact_sha256: {},
        projection_write: { status: "blocked", target_ref: null },
      })
      expect(receipt.output).not.toContain("alice@university.no")
      expect(receipt.output).not.toContain("+4791234567")
      expect(receipt.output).not.toContain(hex)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
