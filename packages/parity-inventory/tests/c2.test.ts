import { Effect } from "effect"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { applyAcceptedAbsent, collectC2 } from "../src/effects.js"
import { collectRoutes } from "../src/routes.js"
import { acceptedIntentRevisionRefId } from "../src/coverage.js"
import { canonicalJson, sha256 } from "../src/canonical.js"
import { SOURCE_FAMILIES, matchesLiteralPattern, sourceFamilyMatchedPaths } from "../src/source-manifest.js"
import { COMMITTED_PROJECTIONS, PROJECTION_DIRECTORY, run, runTrustedFixtureTerminalCycle } from "../src/runner.js"
import { canonicalRuntimeEvidenceBytes, makeRuntimeEvidenceReceipt, makeRuntimeEvidenceRegister } from "../src/runtime-evidence.js"
import { createManifestContextFromSnapshots } from "../src/source-manifest.js"
import { scanRootEffect } from "../src/runtime.js"
import { validateInventory } from "../src/schema.js"
import type { InventoryRow } from "../src/types.js"
const REPO_ROOT = join(import.meta.dir, "../../..")


const put = (root: string, path: string, contents: string): void => {
  const target = join(root, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, contents, "utf8")
}

const contextFor = async (legacyRoot: string, monoRoot: string) => {
  const legacy = await Effect.runPromise(scanRootEffect(legacyRoot, "legacy"))
  const mono = await Effect.runPromise(scanRootEffect(monoRoot, "mono"))
  return createManifestContextFromSnapshots(legacy, mono)
}
const runWithIntentAuthority = async (root: string, legacyRoot: string, mode: "diff" | "write") => {
  const legacy = await Effect.runPromise(scanRootEffect(legacyRoot, "legacy"))
  const mono = await Effect.runPromise(scanRootEffect(root, "mono"))
  const context = createManifestContextFromSnapshots(legacy, mono)
  const selectedRevisionRefIds = [legacy.revisionRefId, acceptedIntentRevisionRefId(context)].sort()
  const intentPayload = {
    intent_ref_id: "intent://c2-test-authority",
    intent_revision: "c2-test-authority-v1",
    selected_revision_ref_ids: selectedRevisionRefIds,
    source_ref_ids: [],
    purpose: "coverage" as const,
    disposition: null,
    row_ids: [],
    canonical_signatures: [],
    inventory_kinds: [],
    journey_ref_ids: ["intent://c2-test-journey"],
  }
  const journeyPayload = {
    journey_ref_id: "intent://c2-test-journey",
    journey_key: "c2-test-authority-journey",
    intent_ref_id: "intent://c2-test-authority",
    journey_revision: "c2-test-authority-journey-v1",
    selected_revision_ref_ids: selectedRevisionRefIds,
    source_ref_ids: [],
    steps: [],
    coverage_scope: "accepted_non_user_facing" as const,
  }
  const register = {
    schema_version: "functional-parity-accepted-intent/v1" as const,
    intents: [{ ...intentPayload, intent_digest: sha256(canonicalJson(intentPayload)) }],
    journeys: [{ ...journeyPayload, journey_digest: sha256(canonicalJson(journeyPayload)) }],
  }
  const authority = mkdtempSync("/tmp/parity-c2-intent-authority-")
  const path = join(authority, "accepted-intent.json")
  writeFileSync(path, canonicalJson(register), "utf8")
  execFileSync("git", ["-C", authority, "init", "-q"])
  execFileSync("git", ["-C", authority, "config", "user.email", "parity@example.invalid"])
  execFileSync("git", ["-C", authority, "config", "user.name", "parity-test"])
  execFileSync("git", ["-C", authority, "add", "--", "accepted-intent.json"])
  execFileSync("git", ["-C", authority, "commit", "-qm", "intent-authority"])
  const evidenceAuthority = mkdtempSync("/tmp/parity-c2-evidence-authority-")
  const evidencePath = join(evidenceAuthority, "runtime-evidence.json")
  const receipt = makeRuntimeEvidenceReceipt({
    journey_ref_id: "intent://c2-test-journey",
    step_ids: ["c2-test-step"],
    legacy_revision_ref_id: legacy.revisionRefId,
    mono_revision_ref_id: acceptedIntentRevisionRefId(context),
    runner_source_ref_ids: [`src-${"0".repeat(64)}`],
    runner_digest: sha256("c2-test-runner-input"),
    fixture_digest: sha256("c2-test-fixture-input"),
    environment_kind: "ci_non_production",
    exit_code: 0,
    result: "passed",
    artifact_digest: sha256("c2-test-artifact"),
  })
  writeFileSync(evidencePath, canonicalRuntimeEvidenceBytes(makeRuntimeEvidenceRegister([receipt])), "utf8")
  execFileSync("git", ["-C", evidenceAuthority, "init", "-q"])
  execFileSync("git", ["-C", evidenceAuthority, "config", "user.email", "parity@example.invalid"])
  execFileSync("git", ["-C", evidenceAuthority, "config", "user.name", "parity-test"])
  execFileSync("git", ["-C", evidenceAuthority, "add", "--", "runtime-evidence.json"])
  execFileSync("git", ["-C", evidenceAuthority, "commit", "-qm", "runtime-evidence-authority"])
  try {
    return await Effect.runPromise(run({ root, legacyRoot, intentRegisterPath: path, evidenceRegisterPath: evidencePath, mode }))
  } finally {
    rmSync(authority, { recursive: true, force: true })
    rmSync(evidenceAuthority, { recursive: true, force: true })
  }
}

test("terminal pipeline reaches write14 then fresh post-commit diff0 with stable bytes", async () => {
  const cycle = await Effect.runPromise(runTrustedFixtureTerminalCycle())
  expect(cycle.writeReport).toMatchObject({
    status: "projection_written",
    exit_code: 14,
    projection_write: { status: "written", target_ref: PROJECTION_DIRECTORY },
    verification: { deterministic_diff: "not_run", forbidden_states_empty: true },
  })
  expect(cycle.idempotentWriteReport).toMatchObject({
    status: "projection_written",
    exit_code: 14,
    projection_write: { status: "written", target_ref: PROJECTION_DIRECTORY },
    verification: { schema_validation: true, deterministic_diff: "not_run", forbidden_states_empty: true },
  })
  expect(cycle.diffReport).toMatchObject({
    status: "zero_gap",
    exit_code: 0,
    projection_write: { status: "not_requested", target_ref: null },
    verification: { deterministic_diff: "equal", forbidden_states_empty: true },
  })
  for (const staleReport of [cycle.missingDiffReport, cycle.differentDiffReport]) {
    expect(staleReport).toMatchObject({
      status: "stale",
      exit_code: 5,
      verification: { schema_validation: true, deterministic_diff: "different" },
      failures: expect.arrayContaining([expect.objectContaining({ status: "stale", reason_code: "STALE_ARTIFACT" })]),
    })
  }
  expect(cycle.projectionEntries).toEqual([...COMMITTED_PROJECTIONS].sort())
  expect(Object.keys(cycle.projectionBytes).sort()).toEqual([...COMMITTED_PROJECTIONS].sort())
  expect(cycle.diffReport.source_manifest_sha256).toBe(cycle.writeReport.source_manifest_sha256)
  expect(cycle.diffReport.inventory_artifact_sha256).toEqual(cycle.writeReport.inventory_artifact_sha256)
})


test("F13 retains an unknown effect with causal row and source attribution", async () => {
  const result = await Effect.runPromise(run({ root: ".", legacyRoot: ".", mode: "fixture_injection", falsifierId: "F13_unknown_effect" }))
  expect(result.exitCode).toBe(13)
  expect(result.report.status).toBe("falsifier_passed")
  expect(result.report.failures).toEqual(expect.arrayContaining([expect.objectContaining({ reason_code: "UNKNOWN_EFFECT", status: "unresolved", row_ids: expect.any(Array), source_ref_ids: expect.any(Array) })]))
  expect(result.artifacts?.commandWrites.rows.some((row) => row.authority_line === "mono" && "command_name" in row.details && row.details.command_name === "fixture:send" && row.reason_codes.includes("UNKNOWN_EFFECT") && row.status === "unresolved" && row.source_ref_ids.length > 0)).toBe(true)
  const target = result.artifacts?.commandWrites.rows.find((row) => row.authority_line === "mono" && "command_name" in row.details && row.details.command_name === "fixture:send")
  expect(target).toBeDefined()
  if (target === undefined) throw new Error("F13 causal target missing")
  const causal = result.report.failures.find((failure) => failure.reason_code === "UNKNOWN_EFFECT" && failure.row_ids.includes(target.row_id))
  expect(causal?.row_ids).toEqual([target.row_id])
})

test("F14 leaves absent schedules unaccounted until an accepted_absent intent is supplied", async () => {
  const result = await Effect.runPromise(run({ root: ".", legacyRoot: ".", mode: "fixture_injection", falsifierId: "F14_absent_schedule" }))
  expect(result.exitCode).toBe(13)
  expect(result.report.status).toBe("falsifier_passed")
  const absent = result.artifacts?.scheduledBackgroundWorkflows.rows.find((row) => row.status === "absent")
  expect(absent).toBeDefined()
  if (absent === undefined || result.artifacts === undefined) throw new Error("absent schedule row missing")
  expect(result.artifacts.scheduledBackgroundWorkflows.rows.filter((row) => row.authority_line === "mono")).toEqual([absent])
  expect(absent.mismatch).toMatchObject({ kind: "absent", disposition: "none", accepted_intent_ref_ids: [] })
  const causal = result.report.failures.find((failure) => failure.reason_code === "ABSENT_SCHEDULE" && failure.row_ids.includes(absent.row_id))
  expect(causal?.row_ids).toEqual([absent.row_id])
  expect(validateInventory(result.artifacts.scheduledBackgroundWorkflows)).toBe(true)
  const accounted = applyAcceptedAbsent(result.artifacts.scheduledBackgroundWorkflows, ["intent://fixture/absent-schedule"])
  const accepted = accounted.rows.find((row) => row.row_id === absent.row_id)
  expect(accepted).toMatchObject({ status: "accounted", mismatch: { kind: "absent", disposition: "accepted_absent", accepted_intent_ref_ids: ["intent://fixture/absent-schedule"] } })
  expect(validateInventory(accounted)).toBe(true)
})
test("multiline PHPDoc routes ignore continuation stars but reject malformed tails", async () => {
  const legacyRoot = mkdtempSync("/tmp/parity-c2-route-docblock-legacy-")
  const monoRoot = mkdtempSync("/tmp/parity-c2-route-docblock-mono-")
  try {
    put(legacyRoot, "src/AppBundle/Controller/DocblockController.php", `<?php
namespace AppBundle\\Controller;
/**
 * @Route(
 *   "/doc-safe",
 *   name="doc_safe",
 *   methods={"GET", "POST"}
 * )
 */
final class DocblockController {}
/**
 * @Route(
 *   "/doc-malformed",
 *   name="doc_malformed",
 *   methods={"GET"} trailing
 * )
 */
final class MalformedDocblockController {}
`)
    const context = await contextFor(legacyRoot, monoRoot)
    const routes = collectRoutes(context, sha256("route-docblock-c2"))
    const safe = routes.legacy.rows.find((row) => "route_name" in row.details && row.details.route_name === "doc_safe")
    const malformed = routes.legacy.rows.find((row) => "route_name" in row.details && row.details.route_name === "doc_malformed")
    expect(safe).toMatchObject({ details: { path_template: "/doc-safe", methods_declared: ["GET", "POST"] } })
    expect(safe?.reason_codes).not.toContain("UNSAFE_SOURCE")
    expect(malformed?.reason_codes).toContain("UNSAFE_SOURCE")
  } finally {
    rmSync(legacyRoot, { recursive: true, force: true })
    rmSync(monoRoot, { recursive: true, force: true })
  }
})
test("optional route names stay nullable without false source parse failures", async () => {
  const legacyRoot = mkdtempSync("/tmp/parity-c2-route-optional-name-legacy-")
  const monoRoot = mkdtempSync("/tmp/parity-c2-route-optional-name-mono-")
  try {
    put(legacyRoot, "app/config/routing.yml", `controllers:
  resource: "@AppBundle/Controller/"
  type: annotation
`)
    put(legacyRoot, "src/AppBundle/Controller/AssistantController.php", `<?php
namespace AppBundle\\Controller;
final class AssistantController
{
    /**
     * @Route("/assistant")
     */
    public function indexAction(): void {}
}
`)
    put(legacyRoot, "src/AppBundle/Controller/Api/PartyController.php", `<?php
namespace AppBundle\\Controller\\Api;
final class PartyController
{
    /**
     * @Route("api/party", methods={"GET"})
     */
    public function indexAction(): void {}
}
`)
    put(legacyRoot, "src/AppBundle/Controller/Api/AccountController.php", `<?php
namespace AppBundle\\Controller\\Api;
final class AccountController
{
    /**
     * @Route(path="api/account", methods={"GET"})
     */
    public function indexAction(): void {}
}
`)
    put(legacyRoot, "src/AppBundle/Controller/MalformedController.php", `<?php
namespace AppBundle\\Controller;
final class MalformedController
{
    /**
     * @Route(name="missing_path")
     */
    public function indexAction(): void {}
}
`)
    put(monoRoot, "apps/server/config/routes.yaml", `controllers:
  resource: ../src/App/Controller/
  type: attribute
`)
    put(monoRoot, "apps/server/src/App/Controller/AssistantController.php", `<?php
namespace App\\Controller;
use Symfony\\Component\\Routing\\Attribute\\Route;
final class AssistantController
{
    #[Route('/assistant')]
    public function indexAction(): void {}
}
`)
    put(monoRoot, "apps/server/src/App/Controller/MalformedController.php", `<?php
namespace App\\Controller;
use Symfony\\Component\\Routing\\Attribute\\Route;
final class MalformedController
{
    #[Route(name: 'missing_path')]
    public function indexAction(): void {}
}
`)
    const context = await contextFor(legacyRoot, monoRoot)
    const routes = collectRoutes(context, sha256("route-optional-name-c2"), undefined, true)
    const legacyRows = routes.legacy.rows.filter((row) => row.details.declaration_kind === "controller_annotation")
    const monoRows = routes.mono.rows.filter((row) => row.details.declaration_kind === "controller_attribute")
    const targetRows = [...legacyRows, ...monoRows].filter((row) => JSON.stringify(row.details).match(/(Party|Account|Assistant)Controller/))
    const parseFailures = [...legacyRows, ...monoRows].filter((row) => row.reason_codes.includes("SOURCE_PARSE_ERROR"))
    const unresolved = [...legacyRows, ...monoRows].filter((row) => row.status === "unresolved")
    expect(legacyRows).toHaveLength(4)
    expect(monoRows).toHaveLength(2)
    expect(targetRows).toHaveLength(4)
    expect(targetRows.every((row) => row.status === "covered")).toBe(true)
    expect(targetRows.every((row) => !row.reason_codes.includes("SOURCE_PARSE_ERROR"))).toBe(true)
    expect(parseFailures).toHaveLength(2)
    expect(unresolved).toHaveLength(2)
    expect(unresolved.every((row) => row.reason_codes.includes("SOURCE_PARSE_ERROR"))).toBe(true)
    const sourceFor = (row: (typeof legacyRows)[number], path: string) =>
      row.source_ref_ids
        .map((sourceRefId) => context.sources.find((source) => source.source_id === sourceRefId))
        .find((source) => source?.path === path)
    const legacyAssistant = legacyRows.find((row) => "controller_ref" in row.details && row.details.controller_ref?.includes("AssistantController"))
    const monoAssistant = monoRows.find((row) => "owner_ref" in row.details && row.details.owner_ref?.includes("AssistantController"))
    expect(sourceFor(legacyAssistant!, "src/AppBundle/Controller/AssistantController.php")).toMatchObject({ line_start: 6, line_end: 6, symbol: "AppBundle\\Controller\\AssistantController::indexAction" })
    expect(sourceFor(monoAssistant!, "apps/server/src/App/Controller/AssistantController.php")).toMatchObject({ line_start: 6, line_end: 6, symbol: "App\\Controller\\AssistantController::indexAction" })
  } finally {
    rmSync(legacyRoot, { recursive: true, force: true })
    rmSync(monoRoot, { recursive: true, force: true })
  }
})

test("package runtime roots ignore type exports and non-runtime script arguments", async () => {
  const legacyRoot = mkdtempSync("/tmp/parity-c2-package-root-legacy-")
  const monoRoot = mkdtempSync("/tmp/parity-c2-package-root-mono-")
  try {
    const scheduleSource = (identity: string, handler: string): string => `export function ${handler}(): void {}\nschedule("${identity}", "0 0 * * *", ${handler})\n`
    put(monoRoot, "package.json", JSON.stringify({
      scripts: {
        runtime: "bun infra/runtime.ts",
        echo_decoy: "echo infra/echo.ts",
        lint_decoy: "eslint infra/lint.ts",
        quoted_separator_decoy: "echo \"x; bun infra/quoted.ts\"",
        node_check_decoy: "node --check infra/node-check.ts",
        newline_decoy: "bun infra/newline.ts\nnode infra/newline-followup.ts",
        empty_word_decoy: "node '' infra/empty-word.ts",
        leading_dash_decoy: "node -infra/leading-dash.ts",
      },
      exports: {
        ".": {
          types: "./infra/types.ts",
          default: "./infra/runtime.ts",
        },
      },
    }))
    put(monoRoot, "infra/runtime.ts", scheduleSource("runtime_schedule", "RuntimeHandler"))
    put(monoRoot, "infra/types.ts", scheduleSource("types_schedule", "TypesHandler"))
    put(monoRoot, "infra/echo.ts", scheduleSource("echo_schedule", "EchoHandler"))
    put(monoRoot, "infra/lint.ts", scheduleSource("lint_schedule", "LintHandler"))
    put(monoRoot, "infra/quoted.ts", scheduleSource("quoted_schedule", "QuotedHandler"))
    put(monoRoot, "infra/node-check.ts", scheduleSource("node_check_schedule", "NodeCheckHandler"))
    put(monoRoot, "infra/newline.ts", scheduleSource("newline_schedule", "NewlineHandler"))
    put(monoRoot, "infra/newline-followup.ts", scheduleSource("newline_followup_schedule", "NewlineFollowupHandler"))
    put(monoRoot, "infra/empty-word.ts", scheduleSource("empty_word_schedule", "EmptyWordHandler"))
    put(monoRoot, "infra/leading-dash.ts", scheduleSource("leading_dash_schedule", "LeadingDashHandler"))
    put(monoRoot, "packages/sdk/package.json", JSON.stringify({
      exports: { ".": { types: "./dist/client.d.ts", default: "./dist/client.js" } },
    }))
    put(monoRoot, "packages/sdk/tsconfig.json", JSON.stringify({
      compilerOptions: { outDir: "dist" },
      include: ["src"],
    }))
    put(monoRoot, "packages/sdk/src/client.ts", "import { sendSms } from './domain.js'\nexport class MailerAdapter { send(): void { sendSms() } }\n")
    put(monoRoot, "packages/sdk/src/domain.ts", "export function sendSms(): void { fetch('https://sms.example.test/send') }\n")
    const context = await contextFor(legacyRoot, monoRoot)
    expect(context.rootCensus.find((row) => row.root_ref === "mono" && row.path === "packages/sdk/package.json")?.classification).toBe("matched")
    expect(context.rootCensus.find((row) => row.root_ref === "mono" && row.path === "packages/sdk/tsconfig.json")?.classification).toBe("matched")
    const c2 = collectC2(context, sha256("package-runtime-root-c2"))
    const schedules = c2.schedules.rows.filter((row) => row.authority_line === "mono" && row.details.trigger_kind === "cron")
    const byIdentity = (identity: string) => schedules.find((row) => row.details.trigger_identity === identity)
    expect(byIdentity("runtime_schedule")).toMatchObject({ details: { runtime_registered: true } })
    for (const identity of ["types_schedule", "echo_schedule", "lint_schedule", "quoted_schedule", "node_check_schedule", "newline_schedule", "newline_followup_schedule", "empty_word_schedule", "leading_dash_schedule"]) {
      expect(byIdentity(identity)).toMatchObject({ status: "unresolved", reason_codes: expect.arrayContaining(["SCHEDULE_HANDLER_UNRESOLVED"]) })
    }
    const client = c2.integrations.rows.find((row) =>
      row.source_ref_ids.some((ref) => context.sourcePathById.get(ref)?.path === "packages/sdk/src/client.ts"),
    )
    const domain = c2.integrations.rows.find((row) =>
      row.source_ref_ids.some((ref) => context.sourcePathById.get(ref)?.path === "packages/sdk/src/domain.ts"),
    )
    expect(domain?.reason_codes).not.toContain("DEAD_UNIMPORTED_SOURCE")
    expect(client?.reason_codes).not.toContain("DEAD_UNIMPORTED_SOURCE")
  } finally {
    rmSync(legacyRoot, { recursive: true, force: true })
    rmSync(monoRoot, { recursive: true, force: true })
  }
})
test("typed constructor assignments authorize external effect receivers", async () => {
  const legacyRoot = mkdtempSync("/tmp/parity-c2-constructor-receiver-legacy-")
  const monoRoot = mkdtempSync("/tmp/parity-c2-constructor-receiver-mono-")
  try {
    put(monoRoot, "apps/server/config/services.yaml", "services:\n  App\\Fixture\\Workflow: ~\n")
    put(monoRoot, "apps/server/src/App/Infrastructure/Command/Workflow.php", "<?php\nnamespace App\\Fixture;\nfinal class Workflow { private $em; private $mailer; private $smsSender; public function __construct(EntityManagerInterface $em, Mailer $mailer, SmsSenderInterface $smsSender) { $this->em = $em; $this->mailer = $mailer; $this->smsSender = $smsSender; } public function __invoke(): void { $this->mailer->send($message); $this->em->persist($entity); $this->em->flush(); $this->smsSender->send($sms); } }\n")
    const context = await contextFor(legacyRoot, monoRoot)
    const row = collectC2(context, sha256("constructor-receiver-c2")).commandWrites.rows.find((candidate) =>
      "owner_ref" in candidate.details && candidate.details.owner_ref === "App\\Fixture\\Workflow",
    )
    expect(row?.reason_codes).not.toContain("UNKNOWN_EFFECT")
    expect(row?.details).toMatchObject({ effect_classes: ["durable_write", "outbound"] })
  } finally {
    rmSync(legacyRoot, { recursive: true, force: true })
    rmSync(monoRoot, { recursive: true, force: true })
  }
})


test("write projection gate blocks unresolved C2 effects", async () => {
  const legacyRoot = mkdtempSync("/tmp/parity-c2-write-gate-legacy-")
  const monoRoot = mkdtempSync("/tmp/parity-c2-write-gate-mono-")
  try {
    put(monoRoot, "apps/server/src/App/Infrastructure/Command/UnknownCommand.php", "<?php\nnamespace App\\Fixture;\nfinal class UnknownCommand { public function __invoke(): void { $result = $this->delegate->perform(); } }\n")
    const result = await runWithIntentAuthority(monoRoot, legacyRoot, "write")
    expect(result.report.projection_write.status).toBe("blocked")
    expect(result.report.failures).toEqual(expect.arrayContaining([expect.objectContaining({ reason_code: "UNKNOWN_EFFECT", status: "unresolved" })]))
  } finally {
    rmSync(legacyRoot, { recursive: true, force: true })
    rmSync(monoRoot, { recursive: true, force: true })
  }
})

test("effect resolution rejects local receiver shadowing and resolves aliased multi-hop properties", async () => {
  const legacyRoot = mkdtempSync("/tmp/parity-c2-receiver-legacy-")
  const monoRoot = mkdtempSync("/tmp/parity-c2-receiver-mono-")
  try {
    put(monoRoot, "apps/server/src/App/Infrastructure/Command/ShadowCommand.php", "<?php\nnamespace App\\Fixture\\Infrastructure\\Command;\nfinal class ShadowCommand { private object $repo; public function __invoke(): void { $repo = null; $repo->save(); } }\n")
    put(monoRoot, "apps/server/src/App/Infrastructure/Command/MultiCommand.php", "<?php\nnamespace App\\Fixture\\Infrastructure\\Command;\nuse App\\Fixture\\Infrastructure\\Repository\\AliasRepo as Repo;\nfinal class MultiCommand { private Repo $repo; public function __invoke(): void { $this->repo->nested->save(); } }\n")
    put(monoRoot, "apps/server/src/App/Infrastructure/Repository/AliasRepo.php", "<?php\nnamespace App\\Fixture\\Infrastructure\\Repository;\nuse App\\Fixture\\Infrastructure\\Repository\\LeafRepo as Child;\nfinal class AliasRepo { private Child $nested; }\n")
    put(monoRoot, "apps/server/src/App/Infrastructure/Repository/LeafRepo.php", "<?php\nnamespace App\\Fixture\\Infrastructure\\Repository;\nfinal class LeafRepo { public function save(): void {} }\n")
    put(monoRoot, "apps/server/src/App/Infrastructure/Service/ApplicationManager.php", "<?php\nnamespace App\\Fixture\\Infrastructure\\Service;\nuse App\\Fixture\\Infrastructure\\Repository\\LeafRepo;\nfinal class ApplicationManager { private LeafRepo $repo; public function approve(): void { $this->repo->save(); } }\n")
    put(monoRoot, "apps/server/src/App/Infrastructure/Command/ApprovalCommand.php", "<?php\nnamespace App\\Fixture\\Infrastructure\\Command;\nuse App\\Fixture\\Infrastructure\\Service\\ApplicationManager;\nfinal class ApprovalCommand { private ApplicationManager $manager; public function __invoke(): void { $this->manager->approve(); } }\n")
    put(monoRoot, "apps/server/config/services.yaml", "services:\n  App\\Fixture\\Infrastructure\\Command\\ShadowCommand: ~\n  App\\Fixture\\Infrastructure\\Command\\MultiCommand: ~\n  App\\Fixture\\Infrastructure\\Command\\ApprovalCommand: ~\n  App\\Fixture\\Infrastructure\\Repository\\AliasRepo: ~\n  App\\Fixture\\Infrastructure\\Repository\\LeafRepo: ~\n  App\\Fixture\\Infrastructure\\Service\\ApplicationManager: ~\n")
    const context = await contextFor(legacyRoot, monoRoot)
    const c2 = collectC2(context, sha256("receiver-resolution-c2"))
    const commandRows = c2.commandWrites.rows.filter((row) => row.authority_line === "mono" && row.inventory_kind === "command_write")
    const shadow = commandRows.find((row) => "owner_ref" in row.details && row.details.owner_ref === "App\\Fixture\\Infrastructure\\Command\\ShadowCommand")
    const multi = commandRows.find((row) => "owner_ref" in row.details && row.details.owner_ref === "App\\Fixture\\Infrastructure\\Command\\MultiCommand")
    const approval = commandRows.find((row) => "owner_ref" in row.details && row.details.owner_ref === "App\\Fixture\\Infrastructure\\Command\\ApprovalCommand")
    expect(shadow).toMatchObject({ status: "unresolved", reason_codes: expect.arrayContaining(["UNKNOWN_EFFECT"]) })
    expect(multi?.status).not.toBe("unresolved")
    expect(multi?.reason_codes).not.toContain("UNKNOWN_EFFECT")
    expect(multi?.details).toMatchObject({ effect_classes: ["durable_write"], target_refs: ["App\\Fixture\\Infrastructure\\Repository\\LeafRepo::save"] })
    expect(approval?.status).not.toBe("unresolved")
    expect(approval?.details).toMatchObject({
      effect_classes: ["durable_write"],
      target_refs: [
        "App\\Fixture\\Infrastructure\\Repository\\LeafRepo::save",
        "App\\Fixture\\Infrastructure\\Service\\ApplicationManager::approve",
      ],
    })
  } finally {
    rmSync(legacyRoot, { recursive: true, force: true })
    rmSync(monoRoot, { recursive: true, force: true })
  }
})
test("unqualified property types use the declaring namespace and never global short names", async () => {
  const legacyRoot = mkdtempSync("/tmp/parity-c2-namespace-legacy-")
  const monoRoot = mkdtempSync("/tmp/parity-c2-namespace-mono-")
  try {
    put(monoRoot, "apps/server/src/App/Infrastructure/Command/SharedRepo.php", "<?php\nnamespace App\\Fixture\\Infrastructure\\Command;\nfinal class SharedRepo { public function save(): void {} }\n")
    put(monoRoot, "apps/server/src/App/Infrastructure/Command/OtherSharedRepo.php", "<?php\nnamespace App\\Fixture\\Infrastructure\\Other;\nfinal class SharedRepo { public function save(): void {} }\n")
    put(monoRoot, "apps/server/src/App/Infrastructure/Command/NamespaceCommand.php", "<?php\nnamespace App\\Fixture\\Infrastructure\\Command;\nfinal class NamespaceCommand { private SharedRepo $repo; public function __invoke(): void { $this->repo->save(); } }\n")
    put(monoRoot, "apps/server/src/App/Infrastructure/Command/AmbiguousCommand.php", "<?php\nnamespace App\\Fixture\\Infrastructure\\Ambiguous;\nfinal class AmbiguousCommand { private SharedRepo $repo; public function __invoke(): void { $this->repo->save(); } }\n")
    put(
      monoRoot,
      "apps/server/config/services.yaml",
      "services:\n  App\\Fixture\\Infrastructure\\Command\\SharedRepo: ~\n  App\\Fixture\\Infrastructure\\Other\\SharedRepo: ~\n  App\\Fixture\\Infrastructure\\Command\\NamespaceCommand: ~\n  App\\Fixture\\Infrastructure\\Ambiguous\\AmbiguousCommand: ~\n",
    )
    const context = await contextFor(legacyRoot, monoRoot)
    const c2 = collectC2(context, sha256("namespace-resolution-c2"))
    const commandRows = c2.commandWrites.rows.filter((row) => row.authority_line === "mono")
    const namespaceRow = commandRows.find(
      (row) => "owner_ref" in row.details && row.details.owner_ref === "App\\Fixture\\Infrastructure\\Command\\NamespaceCommand",
    )
    const ambiguousRow = commandRows.find(
      (row) => "owner_ref" in row.details && row.details.owner_ref === "App\\Fixture\\Infrastructure\\Ambiguous\\AmbiguousCommand",
    )
    expect(namespaceRow).toBeDefined()
    expect(namespaceRow?.status).not.toBe("unresolved")
    expect(namespaceRow?.reason_codes).not.toContain("UNKNOWN_EFFECT")
    expect(namespaceRow?.details).toMatchObject({
      target_refs: ["App\\Fixture\\Infrastructure\\Command\\SharedRepo::save"],
    })
    expect(ambiguousRow).toBeDefined()
    expect(ambiguousRow?.details).toMatchObject({ target_refs: [] })
    expect(ambiguousRow?.reason_codes).not.toContain("UNKNOWN_EFFECT")
  } finally {
    rmSync(legacyRoot, { recursive: true, force: true })
    rmSync(monoRoot, { recursive: true, force: true })
  }
})
test("entity property mutators stay out of command writes without external effects", async () => {
  const legacyRoot = mkdtempSync("/tmp/parity-c2-entity-mutator-legacy-")
  const monoRoot = mkdtempSync("/tmp/parity-c2-entity-mutator-mono-")
  try {
    put(legacyRoot, "src/AppBundle/Entity/User.php", `<?php
namespace AppBundle\\Entity;
final class User {
    private $password;
    private $roles;
    private $user;
    public function setPassword($password): void { $this->password = $password; }
    public function setRoles(array $roles): void { $this->roles = $roles; }
    public function setUser($user): void { $this->user = $user; }
}`)
    put(monoRoot, "apps/server/src/App/Identity/Infrastructure/Entity/User.php", `<?php
namespace App\\Identity\\Infrastructure\\Entity;
final class User {
    private $password;
    private $roles;
    private $user;
    public function setPassword($password): void { $this->password = $password; }
    public function setRoles(array $roles): void { $this->roles = $roles; }
    public function setUser($user): void { $this->user = $user; }
}`)
    put(legacyRoot, "src/AppBundle/Entity/ExternallyPersistedUser.php", `<?php
namespace AppBundle\\Entity;
final class ExternallyPersistedUser {
    private $em;
    public function setUser($user): void { $this->em->persist($user); }
}`)
    const context = await contextFor(legacyRoot, monoRoot)
    const c2 = collectC2(context, sha256("entity-mutator-c2"))
    const entityRows = c2.commandWrites.rows.filter((row) =>
      row.source_ref_ids.some((ref) => /(?:^|\/)Entity\//.test(context.sourcePathById.get(ref)?.path ?? "")),
    )
    const symbolRefFor = (row: InventoryRow): string | null => "symbol_ref" in row.details ? row.details.symbol_ref : null
    expect(entityRows.some((row) => symbolRefFor(row)?.endsWith("\\User::setPassword") === true)).toBe(false)
    expect(entityRows.some((row) => symbolRefFor(row)?.endsWith("\\User::setRoles") === true)).toBe(false)
    expect(entityRows.some((row) => symbolRefFor(row)?.endsWith("\\User::setUser") === true)).toBe(false)
    expect(entityRows.find((row) => symbolRefFor(row)?.endsWith("ExternallyPersistedUser::setUser") === true)).toMatchObject({
      details: { effect_classes: expect.arrayContaining(["durable_write"]) },
    })
  } finally {
    rmSync(legacyRoot, { recursive: true, force: true })
    rmSync(monoRoot, { recursive: true, force: true })
  }
})
test("command target aliases require matching bounded-context path roles", async () => {
  const legacyRoot = mkdtempSync("/tmp/parity-c2-target-role-legacy-")
  const monoRoot = mkdtempSync("/tmp/parity-c2-target-role-mono-")
  try {
    put(legacyRoot, "app/config/services.yml", `services:
  application_manager:
    class: AppBundle\\Service\\ApplicationManager
  interview_manager:
    class: AppBundle\\Service\\InterviewManager
  profile:
    class: AppBundle\\Entity\\Profile
  mixed_profile:
    class: AppBundle\\Entity\\MixedProfile
`)
    put(monoRoot, "apps/server/config/services.yaml", `services:
  application_manager:
    class: App\\Identity\\Infrastructure\\ApplicationManager
  interview_manager:
    class: App\\Identity\\Infrastructure\\InterviewManager
  profile:
    class: App\\Identity\\Infrastructure\\Entity\\Profile
  mixed_profile:
    class: App\\Identity\\Infrastructure\\Repository\\MixedProfile
`)
    put(legacyRoot, "src/AppBundle/Entity/Profile.php", "<?php\nnamespace AppBundle\\Entity;\nfinal class Profile { public function setUser($user): void {} }\n")
    put(legacyRoot, "src/AppBundle/Entity/MixedProfile.php", "<?php\nnamespace AppBundle\\Entity;\nfinal class MixedProfile { public function setUser($user): void {} }\n")
    put(legacyRoot, "src/AppBundle/Service/ApplicationManager.php", "<?php\nnamespace AppBundle\\Service;\nuse AppBundle\\Entity\\Profile;\nfinal class ApplicationManager { private Profile $profile; public function mutate(): void { $this->profile->setUser($this); } }\n")
    put(legacyRoot, "src/AppBundle/Service/InterviewManager.php", "<?php\nnamespace AppBundle\\Service;\nuse AppBundle\\Entity\\MixedProfile;\nfinal class InterviewManager { private MixedProfile $profile; public function mutate(): void { $this->profile->setUser($this); } }\n")
    put(monoRoot, "apps/server/src/App/Identity/Infrastructure/Entity/Profile.php", "<?php\nnamespace App\\Identity\\Infrastructure\\Entity;\nfinal class Profile { public function setUser($user): void {} }\n")
    put(monoRoot, "apps/server/src/App/Identity/Infrastructure/Repository/MixedProfile.php", "<?php\nnamespace App\\Identity\\Infrastructure\\Repository;\nfinal class MixedProfile { public function setUser($user): void {} }\n")
    put(monoRoot, "apps/server/src/App/Identity/Infrastructure/ApplicationManager.php", "<?php\nnamespace App\\Identity\\Infrastructure;\nuse App\\Identity\\Infrastructure\\Entity\\Profile;\nfinal class ApplicationManager { private Profile $profile; public function mutate(): void { $this->profile->setUser($this); } }\n")
    put(monoRoot, "apps/server/src/App/Identity/Infrastructure/InterviewManager.php", "<?php\nnamespace App\\Identity\\Infrastructure;\nuse App\\Identity\\Infrastructure\\Repository\\MixedProfile;\nfinal class InterviewManager { private MixedProfile $profile; public function mutate(): void { $this->profile->setUser($this); } }\n")
    const context = await contextFor(legacyRoot, monoRoot)
    const c2 = collectC2(context, sha256("target-role-c2"))
    const rows = c2.commandWrites.rows
    const rowFor = (authority: "legacy" | "mono", owner: string) => rows.find((row) =>
      row.authority_line === authority && "owner_ref" in row.details && row.details.owner_ref === owner,
    )
    const profileLegacy = rowFor("legacy", "AppBundle\\Service\\ApplicationManager")
    const profileMono = rowFor("mono", "App\\Identity\\Infrastructure\\ApplicationManager")
    const mixedLegacy = rowFor("legacy", "AppBundle\\Service\\InterviewManager")
    const mixedMono = rowFor("mono", "App\\Identity\\Infrastructure\\InterviewManager")
    expect(profileLegacy).toMatchObject({ status: "covered", details: { target_refs: ["AppBundle\\Entity\\Profile::setUser"] } })
    expect(profileMono).toMatchObject({ status: "covered", details: { target_refs: ["App\\Identity\\Infrastructure\\Entity\\Profile::setUser"] } })
    expect(c2.commandWrites.links.some((link) =>
      link.relation_kind === "matches" && link.from_row_id === profileLegacy?.row_id && link.to_row_id === profileMono?.row_id,
    )).toBe(true)
    expect(mixedLegacy?.status).toBe("missing")
    expect(mixedMono?.status).toBe("extra")
  } finally {
    rmSync(legacyRoot, { recursive: true, force: true })
    rmSync(monoRoot, { recursive: true, force: true })
  }
})


test("resolved outbound adapters need no inline URL and Sms setters are not integration calls", async () => {
  const legacyRoot = mkdtempSync("/tmp/parity-c2-outbound-legacy-")
  const monoRoot = mkdtempSync("/tmp/parity-c2-outbound-mono-")
  try {
    put(monoRoot, "apps/server/src/App/Infrastructure/Service/Mailer.php", "<?php\nnamespace App\\Fixture\\Infrastructure\\Service;\nfinal class Mailer { public function send(): void {} }\n")
    put(monoRoot, "apps/server/src/App/Infrastructure/Service/SmsSender.php", "<?php\nnamespace App\\Fixture\\Infrastructure\\Service;\nfinal class SmsSender { public function send(): void {} }\n")
    put(monoRoot, "apps/server/src/App/Infrastructure/Service/Sms.php", "<?php\nnamespace App\\Fixture\\Infrastructure\\Service;\nfinal class Sms { public function setMessage(): void {} public function setSender(): void {} public function setRecipients(): void {} }\n")
    put(monoRoot, "apps/server/src/App/Infrastructure/Command/NotifyCommand.php", "<?php\nnamespace App\\Fixture\\Infrastructure\\Command;\nuse App\\Fixture\\Infrastructure\\Service\\Mailer;\nuse App\\Fixture\\Infrastructure\\Service\\SmsSender;\nfinal class NotifyCommand { private Mailer $mailer; private SmsSender $smsSender; public function __invoke(): void { $this->mailer->send(); $this->smsSender->send(); $unrelated = 'https://api.example.test/v1/unrelated'; } }\n")
    put(monoRoot, "apps/server/src/App/Infrastructure/Command/DuplicateCommand.php", "<?php\nnamespace App\\Fixture\\Infrastructure\\Command;\nuse App\\Fixture\\Infrastructure\\Service\\Mailer;\nfinal class DuplicateCommand { private Mailer $mailer; public function __invoke(): void { $this->mailer->send(); $this->mailer->send(); } }\n")
    put(monoRoot, "apps/server/src/App/Infrastructure/Service/InterviewManager.php", "<?php\nnamespace App\\Fixture\\Infrastructure\\Service;\nfinal class InterviewManager { private Sms $sms; public function configure(): void { $this->sms->setMessage(); $this->sms->setSender(); $this->sms->setRecipients(); } }\n")
    put(monoRoot, "apps/server/config/services.yaml", "services:\n  App\\Fixture\\Infrastructure\\Command\\NotifyCommand: ~\n  App\\Fixture\\Infrastructure\\Command\\DuplicateCommand: ~\n  App\\Fixture\\Infrastructure\\Service\\Mailer: ~\n  App\\Fixture\\Infrastructure\\Service\\SmsSender: ~\n  App\\Fixture\\Infrastructure\\Service\\Sms: ~\n  App\\Fixture\\Infrastructure\\Service\\InterviewManager: ~\n")
    const context = await contextFor(legacyRoot, monoRoot)
    const c2 = collectC2(context, sha256("resolved-outbound-c2"))
    const notify = c2.commandWrites.rows.find(
      (row) => "owner_ref" in row.details && row.details.owner_ref === "App\\Fixture\\Infrastructure\\Command\\NotifyCommand",
    )
    expect(notify?.reason_codes).not.toContain("UNKNOWN_EFFECT")
    expect(notify?.details).toMatchObject({
      effect_classes: ["outbound"],
      target_refs: [
        "App\\Fixture\\Infrastructure\\Service\\Mailer::send",
        "App\\Fixture\\Infrastructure\\Service\\SmsSender::send",
      ],
    })
    const integrationPaths = c2.integrations.rows.map(
      (row) => context.sourcePathById.get(row.source_ref_ids[0] ?? "")?.path,
    )
    expect(integrationPaths).not.toContain("apps/server/src/App/Infrastructure/Service/InterviewManager.php")
    expect(integrationPaths).not.toContain("apps/server/src/App/Infrastructure/Service/Sms.php")
    expect(integrationPaths).toContain("apps/server/src/App/Infrastructure/Command/NotifyCommand.php")
    expect(
      c2.integrations.rows
        .filter((row) => context.sourcePathById.get(row.source_ref_ids[0] ?? "")?.path === "apps/server/src/App/Infrastructure/Command/NotifyCommand.php")
        .map((row) => "call_site_ref" in row.details ? row.details.call_site_ref : null),
    ).toEqual([
      "App\\Fixture\\Infrastructure\\Command\\NotifyCommand::__invoke",
      "App\\Fixture\\Infrastructure\\Command\\NotifyCommand::__invoke",
    ])
    expect(
      c2.integrations.rows
        .filter((row) => context.sourcePathById.get(row.source_ref_ids[0] ?? "")?.path === "apps/server/src/App/Infrastructure/Command/NotifyCommand.php")
        .every((row) => "endpoint_ref" in row.details && row.details.endpoint_ref === null),
    ).toBe(true)
    const duplicateRows = c2.integrations.rows.filter(
      (row) =>
        context.sourcePathById.get(row.source_ref_ids[0] ?? "")?.path ===
        "apps/server/src/App/Infrastructure/Command/DuplicateCommand.php",
    )
    expect(duplicateRows).toHaveLength(1)
    expect(duplicateRows[0]?.status).toBe("extra")
    expect(
      c2.failures.some(
        (failure) =>
          failure.reasonCode === "UNKNOWN_INTEGRATION" &&
          duplicateRows.some((row) => failure.rowIds.includes(row.row_id)),
      ),
    ).toBe(false)
  } finally {
    rmSync(legacyRoot, { recursive: true, force: true })
    rmSync(monoRoot, { recursive: true, force: true })
  }
})


test("typed fixture-injected integrations redact credentials and raw payloads", async () => {
  const result = await Effect.runPromise(run({
    root: ".",
    legacyRoot: ".",
    mode: "fixture_injection",
    falsifierId: "F15_secret_or_pii_input",
  }))
  expect(result.exitCode).toBe(13)
  expect(result.report.status).toBe("falsifier_passed")
  const integrations = result.artifacts?.externalIntegrations
  if (integrations === undefined) throw new Error("F15 integration fixture artifacts unavailable")
  const fixtureRows = integrations.rows.filter((row) =>
    row.source_ref_ids.some((ref) => result.artifacts?.sourceManifest.sources.find((source) => source.source_id === ref)?.path === "packages/fixture-integration.ts"),
  )
  expect(fixtureRows).toHaveLength(2)
  expect(fixtureRows.every((row) => {
    const details = row.details
    return "endpoint_ref" in details &&
      details.endpoint_ref === null &&
      "credential_slot_ref" in details &&
      details.credential_slot_ref === null &&
      row.status !== "covered" &&
      row.reason_codes.includes("UNSAFE_SOURCE")
  })).toBe(true)
  const serialized = canonicalJson(integrations)
  expect(serialized).not.toContain("https://api.example.test/v1/send?token=")
  expect(serialized).not.toContain("https://hooks.slack.com/services/")
  const integrationPaths = integrations.rows.flatMap((row) => row.source_ref_ids.map((ref) => result.artifacts?.sourceManifest.sources.find((source) => source.source_id === ref)?.path ?? null))
  expect(integrationPaths).not.toContain("packages/sdk/dist/Slack/client.js")
})

test("canonical source scan does not emit unsafe fixture integrations", async () => {
  const parent = mkdtempSync("/tmp/parity-c2-source-scan-parent-")
  try {
    const expectedHead = execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()
    const cloneRoot = join(parent, "repo")
    execFileSync("git", ["clone", "--local", "--no-hardlinks", "--no-checkout", REPO_ROOT, cloneRoot])
    execFileSync("git", ["-C", cloneRoot, "checkout", "--detach", expectedHead])
    const clonedHead = execFileSync("git", ["-C", cloneRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()
    if (clonedHead !== expectedHead) throw new Error(`isolated clone HEAD mismatch: expected ${expectedHead}, received ${clonedHead}`)
    const context = await contextFor(cloneRoot, cloneRoot)
    const integrations = collectC2(context, sha256("canonical-c2-source-scan")).integrations
    expect(integrations.rows.length).toBeGreaterThan(0)
    expect(integrations.rows.filter((row) => row.reason_codes.includes("UNSAFE_SOURCE"))).toEqual([])
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
}, 120_000)
test("integration URLs survive comment stripping and loader registration", async () => {
  const legacyRoot = mkdtempSync("/tmp/parity-c2-integration-loader-legacy-")
  const monoRoot = mkdtempSync("/tmp/parity-c2-integration-loader-mono-")
  try {
    put(monoRoot, "apps/server/src/App/Infrastructure/Service/SlackClient.php", "<?php\nnamespace App\\Fixture;\nfinal class SlackClient { public function send(): void { fetch(\"https://api.slack.com/v1/send\"); } }\n")
    put(monoRoot, "apps/server/config/services.yaml", "services:\n  slack_client:\n    class: App\\Fixture\\SlackClient\n")
    const context = await contextFor(legacyRoot, monoRoot)
    const c2 = collectC2(context, sha256("integration-loader-c2"))
    const row = c2.integrations.rows.find((candidate) => candidate.source_ref_ids.some((ref) => context.sourcePathById.get(ref)?.path === "apps/server/src/App/Infrastructure/Service/SlackClient.php"))
    expect(row).toMatchObject({ details: { endpoint_ref: "https://api.slack.com/v1/send", provider_ref: "slack" } })
    expect(row?.status).not.toBe("dead_unimported")
  } finally {
    rmSync(legacyRoot, { recursive: true, force: true })
    rmSync(monoRoot, { recursive: true, force: true })
  }
})


test("command import edges distinguish registered and dead declarations", async () => {
  const legacyRoot = mkdtempSync("/tmp/parity-c2-import-legacy-")
  const monoRoot = mkdtempSync("/tmp/parity-c2-import-mono-")
  try {
    put(legacyRoot, "app/config/config.yml", "imports:\n  - { resource: parameters.yml }\n  - { resource: event_subscribers.yml }\n")
    put(legacyRoot, "app/config/event_subscribers.yml", "services:\n  AppBundle\\EventSubscriber\\:\n    resource: \"../../src/AppBundle/EventSubscriber\"\n")
    put(legacyRoot, "src/AppBundle/EventSubscriber/LoadedSubscriber.php", "<?php\nnamespace AppBundle\\EventSubscriber;\nfinal class LoadedSubscriber implements EventSubscriberInterface { private $repository; public function onEvent(): void { $this->repository->save(); } }\n")
    put(legacyRoot, "src/AppBundle/Command/LoadedCommand.php", "<?php\nnamespace AppBundle\\Command;\nfinal class LoadedCommand extends Command { private $repository; protected function execute(): void { $this->repository->save(); } }\n")
    put(monoRoot, "apps/server/src/App/Infrastructure/Command/OrphanCommand.php", "<?php\nnamespace App\\Fixture;\nfinal class OrphanCommand { public function __invoke(): void { $this->repository->save(); } }\n")
    put(monoRoot, "apps/server/src/App/Infrastructure/Command/ACommand.php", "<?php\nnamespace App\\Fixture;\n// App\\Fixture\\BCommand\nfinal class ACommand { public function __invoke(): void { $this->repository->save(); } }\n")
    put(monoRoot, "apps/server/src/App/Infrastructure/Command/BCommand.php", "<?php\nnamespace App\\Fixture;\n// App\\Fixture\\ACommand\nfinal class BCommand { public function __invoke(): void { $this->repository->save(); } }\n")
    let context = await contextFor(legacyRoot, monoRoot)
    let c2 = collectC2(context, sha256("dead-c2"))
    expect(c2.commandWrites.rows.some((row) => row.reason_codes.includes("DEAD_UNIMPORTED_SOURCE"))).toBe(true)
    const unregisteredRowIds = new Set(c2.commandWrites.rows
      .filter((row) => "owner_ref" in row.details && ["App\\Fixture\\ACommand", "App\\Fixture\\BCommand"].includes(row.details.owner_ref ?? ""))
      .map((row) => row.row_id))
    expect(c2.commandWrites.links.some((link) => link.to_row_ids.some((rowId) => unregisteredRowIds.has(rowId)))).toBe(false)
    const subscriber = c2.commandWrites.rows.find((candidate) =>
      "owner_ref" in candidate.details && candidate.details.owner_ref === "AppBundle\\EventSubscriber\\LoadedSubscriber",
    )
    const command = c2.commandWrites.rows.find((candidate) =>
      "owner_ref" in candidate.details && candidate.details.owner_ref === "AppBundle\\Command\\LoadedCommand",
    )
    expect(subscriber?.reason_codes).not.toContain("DEAD_UNIMPORTED_SOURCE")
    expect(command?.reason_codes).not.toContain("DEAD_UNIMPORTED_SOURCE")
    put(monoRoot, "apps/server/config/packages/api_platform.yaml", "parameters: {}\n")
    put(monoRoot, "apps/server/config/services.yaml", "services:\n  orphan:\n    class: App\\Fixture\\OrphanCommand\n")
    context = await contextFor(legacyRoot, monoRoot)
    c2 = collectC2(context, sha256("imported-c2"))
    expect(c2.commandWrites.rows.some((row) => "owner_ref" in row.details && row.details.owner_ref === "App\\Fixture\\OrphanCommand" && !row.reason_codes.includes("DEAD_UNIMPORTED_SOURCE"))).toBe(true)
    const orphanRow = c2.commandWrites.rows.find((row) => "owner_ref" in row.details && row.details.owner_ref === "App\\Fixture\\OrphanCommand")
    const importEdge = c2.commandWrites.derivation_edges.find(
      (edge) => edge.derivation === "E-C2-LOADER-IMPORT" && edge.to_row_ids.includes(orphanRow?.row_id ?? ""),
    )
    const importerPaths = importEdge?.from_ref_ids.map((ref) => context.sourcePathById.get(ref)?.path ?? null) ?? []
    expect(importerPaths).toEqual(["apps/server/config/services.yaml"])

    expect(c2.commandWrites.rows.some((row) => "entry_kind" in row.details && row.details.entry_kind === "unknown")).toBe(false)
  } finally {
    rmSync(legacyRoot, { recursive: true, force: true })
    rmSync(monoRoot, { recursive: true, force: true })
  }
})
test("routing roots establish controller write reachability", async () => {
  const legacyRoot = mkdtempSync("/tmp/parity-c2-route-loader-legacy-")
  const monoRoot = mkdtempSync("/tmp/parity-c2-route-loader-mono-")
  try {
    put(legacyRoot, "app/config/routing.yml", "controllers:\n  resource: \"@AppBundle/Controller/\"\n  type: annotation\nvendor_bundle:\n  resource: \"@VendorBundle/Resources/config/routing.yaml\"\n")
    put(legacyRoot, "src/AppBundle/Controller/WriteController.php", "<?php\nnamespace AppBundle\\Controller;\nfinal class WriteController { private $repository; public function create(): void { $this->repository->save(); } }\n")
    put(monoRoot, "apps/server/config/routes.yaml", "controllers:\n  resource: ../src/App/Controller/\n  type: attribute\n")
    put(monoRoot, "apps/server/src/App/Controller/WriteController.php", "<?php\nnamespace App\\Fixture\\Controller;\nfinal class WriteController { private object $repository; public function create(): void { $this->repository->save(); } }\n")
    const context = await contextFor(legacyRoot, monoRoot)
    const c2 = collectC2(context, sha256("route-loader-c2"))
    const row = c2.commandWrites.rows.find((candidate) =>
      "owner_ref" in candidate.details && candidate.details.owner_ref === "App\\Fixture\\Controller\\WriteController",
    )
    const legacyRow = c2.commandWrites.rows.find((candidate) =>
      "owner_ref" in candidate.details && candidate.details.owner_ref === "AppBundle\\Controller\\WriteController",
    )
    expect(row).toMatchObject({ status: "covered", reason_codes: [] })
    expect(row?.reason_codes).not.toContain("DEAD_UNIMPORTED_SOURCE")
    expect(
      row?.source_ref_ids.map((ref) => context.sourcePathById.get(ref)?.path).sort(),
    ).toEqual([
      "apps/server/config/routes.yaml",
      "apps/server/src/App/Controller/WriteController.php",
    ])
    expect(legacyRow).toMatchObject({ status: "covered", reason_codes: [] })
    expect(legacyRow?.reason_codes).not.toContain("DEAD_UNIMPORTED_SOURCE")
    expect(
      legacyRow?.source_ref_ids.map((ref) => context.sourcePathById.get(ref)?.path).sort(),
    ).toEqual([
      "app/config/routing.yml",
      "src/AppBundle/Controller/WriteController.php",
    ])
    expect(c2.commandWrites.links.some((link) =>
      link.relation_kind === "matches" &&
      link.from_row_id === legacyRow?.row_id &&
      link.to_row_id === row?.row_id,
    )).toBe(true)
  } finally {
    rmSync(legacyRoot, { recursive: true, force: true })
    rmSync(monoRoot, { recursive: true, force: true })
  }
})
test("legacy service locators reconcile command targets with injected mono dependencies", async () => {
  const legacyRoot = mkdtempSync("/tmp/parity-c2-locator-legacy-")
  const monoRoot = mkdtempSync("/tmp/parity-c2-locator-mono-")
  try {
    put(legacyRoot, "app/config/routing.yml", String.raw`controllers:
  resource: "@AppBundle/Controller/"
  type: annotation
`)
    put(legacyRoot, "app/config/services.yml", String.raw`services:
  locator_controller:
    class: AppBundle\Controller\LocatorController
  locator_writer:
    class: AppBundle\Service\Writer
  locator_repository:
    class: AppBundle\Repository\RecordRepository
`)
    put(monoRoot, "apps/server/config/routes.yaml", String.raw`controllers:
  resource: ../src/App/Fixture/Controller/
  type: attribute
`)
    put(monoRoot, "apps/server/config/services.yaml", String.raw`services:
  locator_controller:
    class: App\Fixture\Controller\LocatorController
  locator_writer:
    class: App\Fixture\Infrastructure\Writer
  locator_repository:
    class: App\Fixture\Infrastructure\RecordRepository
`)
    put(legacyRoot, "src/AppBundle/Controller/LocatorController.php", String.raw`<?php
namespace AppBundle\Controller;
use AppBundle\Entity\Record;
use AppBundle\Service\Writer;
final class LocatorController {
    public function updateAction(): void {
        $record = $this->getDoctrine()->getRepository(Record::class)->find(1);
        $this->get(Writer::class)->write($record);
        $this->get('event_dispatcher')->dispatch('record.updated', $record);
    }
}
`)
    put(legacyRoot, "src/AppBundle/Service/Writer.php", String.raw`<?php
namespace AppBundle\Service;
final class Writer {
    private $em;
    public function write(object $record): void { $this->em->persist($record); }
}
`)
    put(legacyRoot, "src/AppBundle/Repository/RecordRepository.php", String.raw`<?php
namespace AppBundle\Repository;
final class RecordRepository {
    public function find(int $id): object { return new \stdClass(); }
}
`)
    put(legacyRoot, "src/AppBundle/Entity/Record.php", String.raw`<?php
namespace AppBundle\Entity;
final class Record {}
`)
    put(monoRoot, "apps/server/src/App/Fixture/Controller/LocatorController.php", String.raw`<?php
namespace App\Fixture\Controller;
use App\Fixture\Infrastructure\RecordRepository;
use App\Fixture\Infrastructure\Writer;
final class LocatorController {
    private RecordRepository $recordRepository;
    private Writer $writer;
    public function updateAction(): void {
        $record = $this->recordRepository->find(1);
        $this->writer->write($record);
        $this->dispatcher->dispatch('record.updated', $record);
    }
}
`)
    put(monoRoot, "apps/server/src/App/Fixture/Infrastructure/Writer.php", String.raw`<?php
namespace App\Fixture\Infrastructure;
final class Writer {
    private $em;
    public function write(object $record): void { $this->em->persist($record); }
}
`)
    put(monoRoot, "apps/server/src/App/Fixture/Infrastructure/RecordRepository.php", String.raw`<?php
namespace App\Fixture\Infrastructure;
final class RecordRepository {
    public function find(int $id): object { return new \stdClass(); }
}
`)
    const context = await contextFor(legacyRoot, monoRoot)
    const c2 = collectC2(context, sha256("locator-command-c2"))
    const rows = c2.commandWrites.rows
    const legacy = rows.find((row) =>
      row.authority_line === "legacy"
      && "owner_ref" in row.details
      && row.details.owner_ref === "AppBundle\\Controller\\LocatorController",
    )
    const mono = rows.find((row) =>
      row.authority_line === "mono"
      && "owner_ref" in row.details
      && row.details.owner_ref === "App\\Fixture\\Controller\\LocatorController",
    )
    expect(legacy).toMatchObject({
      status: "covered",
      details: { effect_classes: ["durable_write", "outbound"] },
    })
    expect(mono).toMatchObject({
      status: "covered",
      details: { effect_classes: ["durable_write", "outbound"] },
    })
    expect(legacy?.details).toMatchObject({
      target_refs: expect.arrayContaining([
        "AppBundle\\Repository\\RecordRepository::find",
        "AppBundle\\Service\\Writer::write",
      ]),
    })
    expect(mono?.details).toMatchObject({
      target_refs: expect.arrayContaining([
        "App\\Fixture\\Infrastructure\\RecordRepository::find",
        "App\\Fixture\\Infrastructure\\Writer::write",
      ]),
    })
    expect(c2.commandWrites.links.some((link) =>
      link.relation_kind === "matches" && link.from_row_id === legacy?.row_id && link.to_row_id === mono?.row_id,
    )).toBe(true)
  } finally {
    rmSync(legacyRoot, { recursive: true, force: true })
    rmSync(monoRoot, { recursive: true, force: true })
  }
})
test("dynamic Doctrine and migrated service owners reconcile by method and effect", async () => {
  const legacyRoot = mkdtempSync("/tmp/parity-c2-dynamic-legacy-")
  const monoRoot = mkdtempSync("/tmp/parity-c2-dynamic-mono-")
  try {
    put(legacyRoot, "app/config/services.yml", String.raw`services:
  access_control:
    class: AppBundle\Service\AccessControlService
  feedback:
    class: AppBundle\Controller\FeedbackController
  slack:
    class: AppBundle\Service\SlackMessenger
`)
    put(monoRoot, "apps/server/config/services.yaml", String.raw`services:
  access_control:
    class: App\Identity\Infrastructure\AccessControlService
  feedback:
    class: App\Content\Controller\FeedbackController
  slack:
    class: App\Support\Infrastructure\Slack\SlackMessenger
`)
    put(legacyRoot, "src/AppBundle/Service/AccessControlService.php", String.raw`<?php
namespace AppBundle\Service;
final class AccessControlService {
    public function checkAccess(): void { $this->getDoctrine()->getManager()->persist($rule); }
    public function checkAccessToResourceAndMethod(): void { $this->getDoctrine()->getManager()->persist($rule); }
    public function createRule(): void { $this->getDoctrine()->getManager()->persist($rule); }
    public function markRuleAsUnhandledIfNotExists(): void { $this->getDoctrine()->getManager()->persist($rule); }
}
`)
    put(monoRoot, "apps/server/src/App/Identity/Infrastructure/AccessControlService.php", String.raw`<?php
namespace App\Identity\Infrastructure;
final class AccessControlService {
    private EntityManagerInterface $em;
    public function checkAccess(): void { $this->em->persist($rule); }
    public function checkAccessToResourceAndMethod(): void { $this->em->persist($rule); }
    public function createRule(): void { $this->em->persist($rule); }
    public function markRuleAsUnhandledIfNotExists(): void { $this->em->persist($rule); }
}
`)
    put(legacyRoot, "src/AppBundle/Service/SlackMessenger.php", String.raw`<?php
namespace AppBundle\Service;
final class SlackMessenger { private HttpClient $client; public function notify(): void { $this->client->sendMessage(); } }
`)
    put(monoRoot, "apps/server/src/App/Support/Infrastructure/Slack/SlackMessenger.php", String.raw`<?php
namespace App\Support\Infrastructure\Slack;
final class SlackMessenger { private HttpClient $client; public function notify(): void { $this->client->sendMessage(); } }
`)
    put(legacyRoot, "src/AppBundle/Controller/FeedbackController.php", String.raw`<?php
namespace AppBundle\Controller;
use AppBundle\Service\SlackMessenger;
final class FeedbackController {
    public function indexAction(): void {
        $em = $this->getDoctrine()->getManager();
        $em->persist($feedback);
        $em->flush();
        $messenger = $this->container->get(SlackMessenger::class);
        $messenger->notify();
    }
}
`)
    put(monoRoot, "apps/server/src/App/Content/Controller/FeedbackController.php", String.raw`<?php
namespace App\Content\Controller;
use App\Support\Infrastructure\Slack\SlackMessenger;
final class FeedbackController {
    private EntityManagerInterface $em;
    private SlackMessenger $slackMessenger;
    public function indexAction(): void {
        $this->em->persist($feedback);
        $this->em->flush();
        $this->slackMessenger->notify();
    }
}
`)

    const context = await contextFor(legacyRoot, monoRoot)
    const c2 = collectC2(context, sha256("dynamic-doctrine-service-migrations"))
    const rows = c2.commandWrites.rows
    const rowFor = (authority: "legacy" | "mono", owner: string, method: string) => rows.find((row) =>
      row.authority_line === authority
      && "owner_ref" in row.details
      && row.details.owner_ref === owner
      && row.details.symbol_ref?.endsWith(`::${method}`),
    )
    for (const method of ["checkAccess", "checkAccessToResourceAndMethod", "createRule", "markRuleAsUnhandledIfNotExists"]) {
      const legacy = rowFor("legacy", "AppBundle\\Service\\AccessControlService", method)
      const mono = rowFor("mono", "App\\Identity\\Infrastructure\\AccessControlService", method)
      expect(legacy).toMatchObject({ status: "covered", details: { effect_classes: ["durable_write"] } })
      expect(mono).toMatchObject({ status: "covered", details: { effect_classes: ["durable_write"] } })
      expect(c2.commandWrites.links.some((link) =>
        link.relation_kind === "matches" && link.from_row_id === legacy?.row_id && link.to_row_id === mono?.row_id,
      )).toBe(true)
    }

    const legacyFeedback = rowFor("legacy", "AppBundle\\Controller\\FeedbackController", "indexAction")
    const monoFeedback = rowFor("mono", "App\\Content\\Controller\\FeedbackController", "indexAction")
    expect(legacyFeedback).toMatchObject({ status: "covered", details: { effect_classes: ["durable_write", "outbound"] } })
    expect(monoFeedback).toMatchObject({ status: "covered", details: { effect_classes: ["durable_write", "outbound"] } })
    expect(c2.commandWrites.links.some((link) =>
      link.relation_kind === "matches" && link.from_row_id === legacyFeedback?.row_id && link.to_row_id === monoFeedback?.row_id,
    )).toBe(true)
  } finally {
    rmSync(legacyRoot, { recursive: true, force: true })
    rmSync(monoRoot, { recursive: true, force: true })
  }
})
test("unmanifested mono shared repositories retain durable command parity", async () => {
  const legacyRoot = mkdtempSync("/tmp/parity-c2-shared-repository-legacy-")
  const monoRoot = mkdtempSync("/tmp/parity-c2-shared-repository-mono-")
  try {
    put(legacyRoot, "app/config/services.yml", String.raw`services:
  semester_repository:
    class: AppBundle\Entity\Repository\SemesterRepository
`)
    put(monoRoot, "apps/server/config/services.yaml", String.raw`services:
  semester_repository:
    class: App\Shared\Repository\SemesterRepository
`)
    put(legacyRoot, "src/AppBundle/Entity/Repository/SemesterRepository.php", String.raw`<?php
namespace AppBundle\Entity\Repository;
final class SemesterRepository {
    public function findOrCreateCurrentSemester(): void {
        $this->getEntityManager()->persist($semester);
        $this->getEntityManager()->flush();
    }
}
`)
    put(monoRoot, "apps/server/src/App/Shared/Repository/SemesterRepository.php", String.raw`<?php
namespace App\Shared\Repository;
final class SemesterRepository {
    public function findOrCreateCurrentSemester(): void {
        $this->getEntityManager()->persist($semester);
        $this->getEntityManager()->flush();
    }
}
`)

    const context = await contextFor(legacyRoot, monoRoot)
    const c2 = collectC2(context, sha256("shared-repository-command-parity"))
    const rowFor = (authority: "legacy" | "mono", owner: string) => c2.commandWrites.rows.find((row) =>
      row.authority_line === authority
      && "owner_ref" in row.details
      && row.details.owner_ref === owner
      && row.details.symbol_ref?.endsWith("::findOrCreateCurrentSemester"),
    )
    const legacy = rowFor("legacy", "AppBundle\\Entity\\Repository\\SemesterRepository")
    const mono = rowFor("mono", "App\\Shared\\Repository\\SemesterRepository")
    expect(legacy).toMatchObject({ status: "covered", details: { effect_classes: ["durable_write"] } })
    expect(mono).toMatchObject({ status: "covered", details: { effect_classes: ["durable_write"] } })
    expect(c2.commandWrites.links.some((link) =>
      link.relation_kind === "matches" && link.from_row_id === legacy?.row_id && link.to_row_id === mono?.row_id,
    )).toBe(true)
  } finally {
    rmSync(legacyRoot, { recursive: true, force: true })
    rmSync(monoRoot, { recursive: true, force: true })
  }
})
test("transient survey projections do not become command writes without persistence", async () => {
  const legacyRoot = mkdtempSync("/tmp/parity-c2-transient-legacy-")
  const monoRoot = mkdtempSync("/tmp/parity-c2-transient-mono-")
  try {
    put(monoRoot, "apps/server/config/routes.yaml", String.raw`controllers:
  resource: ../src/App/Fixture/Controller/
  type: attribute
`)
    put(monoRoot, "apps/server/config/services.yaml", String.raw`services:
  survey_controller:
    class: App\Fixture\Controller\SurveyController
  survey_repository:
    class: App\Fixture\Infrastructure\SurveyRepository
  survey_taken_repository:
    class: App\Fixture\Infrastructure\SurveyTakenRepository
  access_control:
    class: App\Fixture\Infrastructure\AccessControlService
  policy:
    class: App\Fixture\Infrastructure\Policy
`)
    put(monoRoot, "apps/server/src/App/Fixture/Controller/SurveyController.php", String.raw`<?php
namespace App\Fixture\Controller;
use App\Fixture\Infrastructure\AccessControlService;
use App\Fixture\Infrastructure\SurveyRepository;
use App\Fixture\Infrastructure\SurveyTakenRepository;
final class SurveyController {
    private SurveyRepository $surveyRepo;
    private SurveyTakenRepository $surveyTakenRepo;
    private AccessControlService $accessControlService;
    public function showSurveysAction(): void {
        $surveysWithDepartment = $this->surveyRepo->findBy(['department' => 'x']);
        foreach ($surveysWithDepartment as $survey) {
            $totalAnswered = count($this->surveyTakenRepo->findAllTakenBySurvey($survey));
            $survey->setTotalAnswered($totalAnswered);
        }
        $globalSurveys = [];
        if ($this->accessControlService->isGranted('survey_admin')) {
            $globalSurveys = $this->surveyRepo->findBy(['department' => null]);
            foreach ($globalSurveys as $survey) {
                $totalAnswered = count($this->surveyTakenRepo->findBy(['survey' => $survey]));
                $survey->setTotalAnswered($totalAnswered);
            }
        }
    }
}
`)
    put(monoRoot, "apps/server/src/App/Fixture/Infrastructure/SurveyRepository.php", String.raw`<?php
namespace App\Fixture\Infrastructure;
final class SurveyRepository {
    public function findBy(array $criteria): array { return []; }
}
`)
    put(monoRoot, "apps/server/src/App/Fixture/Infrastructure/SurveyTakenRepository.php", String.raw`<?php
namespace App\Fixture\Infrastructure;
final class SurveyTakenRepository {
    public function findAllTakenBySurvey(object $survey): array { return []; }
    public function findBy(array $criteria): array { return []; }
}
`)
    put(monoRoot, "apps/server/src/App/Fixture/Infrastructure/AccessControlService.php", String.raw`<?php
namespace App\Fixture\Infrastructure;
final class AccessControlService {
    private Policy $policy;
    public function isGranted(string $role): bool { $this->policy->setRole($role); return true; }
}
`)
    put(monoRoot, "apps/server/src/App/Fixture/Infrastructure/Policy.php", String.raw`<?php
namespace App\Fixture\Infrastructure;
final class Policy {
    public function setRole(string $role): void {}
}
`)
    const context = await contextFor(legacyRoot, monoRoot)
    const c2 = collectC2(context, sha256("transient-survey-c2"))
    expect(c2.commandWrites.rows.some((row) =>
      row.authority_line === "mono"
      && "symbol_ref" in row.details
      && row.details.symbol_ref === "App\\Fixture\\Controller\\SurveyController::showSurveysAction",
    )).toBe(false)
  } finally {
    rmSync(legacyRoot, { recursive: true, force: true })
    rmSync(monoRoot, { recursive: true, force: true })
  }
})
test("relocated controller and event writes reconcile without rewriting authority details", async () => {
  const legacyRoot = mkdtempSync("/tmp/parity-c2-relocated-legacy-")
  const monoRoot = mkdtempSync("/tmp/parity-c2-relocated-mono-")
  try {
    put(legacyRoot, "app/config/services.yml", `services:
  relocated_controller:
    class: AppBundle\\Controller\\RelocatedController
  relocated_subscriber:
    class: AppBundle\\EventSubscriber\\RelocatedSubscriber
  divergent_controller:
    class: AppBundle\\Controller\\DivergentController
  renamed_controller:
    class: AppBundle\\Controller\\RenamedController
`)
    put(monoRoot, "apps/server/config/services.yaml", `services:
  relocated_controller:
    class: App\\Admissions\\Controller\\RelocatedController
  relocated_subscriber:
    class: App\\Admissions\\EventSubscriber\\RelocatedSubscriber
  divergent_controller:
    class: App\\Admissions\\Controller\\DivergentController
  renamed_controller:
    class: App\\Admissions\\Controller\\RenamedController
`)
    put(legacyRoot, "src/AppBundle/Controller/RelocatedController.php", "<?php\nnamespace AppBundle\\Controller;\nfinal class RelocatedController { private $em; public function updateAction(): void { $this->em->persist($value); } }\n")
    put(monoRoot, "apps/server/src/App/Admissions/Controller/RelocatedController.php", "<?php\nnamespace App\\Admissions\\Controller;\nfinal class RelocatedController { private $em; public function updateAction(): void { $this->em->persist($value); } }\n")
    put(legacyRoot, "src/AppBundle/EventSubscriber/RelocatedSubscriber.php", "<?php\nnamespace AppBundle\\EventSubscriber;\n#[AsEventListener]\nfinal class RelocatedSubscriber { public function __invoke(): void {} }\n")
    put(monoRoot, "apps/server/src/App/Admissions/EventSubscriber/RelocatedSubscriber.php", "<?php\nnamespace App\\Admissions\\EventSubscriber;\n#[AsEventListener]\nfinal class RelocatedSubscriber { public function __invoke(): void {} }\n")
    put(legacyRoot, "src/AppBundle/Controller/DivergentController.php", "<?php\nnamespace AppBundle\\Controller;\nfinal class DivergentController { private $em; public function updateAction(): void { $this->em->persist($value); } }\n")
    put(monoRoot, "apps/server/src/App/Admissions/Controller/DivergentController.php", "<?php\nnamespace App\\Admissions\\Controller;\nfinal class DivergentController { private $em; public function updateAction(): void { $this->em->persist($value); $this->em->setUser($value); } }\n")
    put(legacyRoot, "src/AppBundle/Controller/RenamedController.php", "<?php\nnamespace AppBundle\\Controller;\nfinal class RenamedController { private $em; public function createAction(): void { $this->em->persist($value); } }\n")
    put(monoRoot, "apps/server/src/App/Admissions/Controller/RenamedController.php", "<?php\nnamespace App\\Admissions\\Controller;\nfinal class RenamedController { private $em; public function deleteAction(): void { $this->em->persist($value); } }\n")
    const context = await contextFor(legacyRoot, monoRoot)
    const c2 = collectC2(context, sha256("relocated-command-c2"))
    const rows = c2.commandWrites.rows
    const statusCounts = rows.reduce<Record<string, number>>((counts, row) => ({
      ...counts,
      [row.status]: (counts[row.status] ?? 0) + 1,
    }), {})
    expect(statusCounts).toEqual({ covered: 4, extra: 2, missing: 2 })
    const rowFor = (owner: string, authority: "legacy" | "mono") => rows.find((row) =>
      row.authority_line === authority && "owner_ref" in row.details && row.details.owner_ref === owner,
    )
    const relocatedLegacy = rowFor("AppBundle\\Controller\\RelocatedController", "legacy")
    const relocatedMono = rowFor("App\\Admissions\\Controller\\RelocatedController", "mono")
    const subscriberLegacy = rowFor("AppBundle\\EventSubscriber\\RelocatedSubscriber", "legacy")
    const subscriberMono = rowFor("App\\Admissions\\EventSubscriber\\RelocatedSubscriber", "mono")
    expect(relocatedLegacy).toMatchObject({ status: "covered", details: { entry_kind: "controller_write", symbol_ref: "AppBundle\\Controller\\RelocatedController::updateAction", effect_classes: ["durable_write"] } })
    expect(relocatedMono).toMatchObject({ status: "covered", details: { entry_kind: "controller_write", symbol_ref: "App\\Admissions\\Controller\\RelocatedController::updateAction", effect_classes: ["durable_write"] } })
    expect(subscriberLegacy).toMatchObject({ status: "covered", details: { entry_kind: "event_handler", symbol_ref: "AppBundle\\EventSubscriber\\RelocatedSubscriber::__invoke", effect_classes: ["read_only"] } })
    expect(subscriberMono).toMatchObject({ status: "covered", details: { entry_kind: "event_handler", symbol_ref: "App\\Admissions\\EventSubscriber\\RelocatedSubscriber::__invoke", effect_classes: ["read_only"] } })
    expect(relocatedLegacy?.row_id).not.toBe(relocatedMono?.row_id)
    expect(relocatedLegacy?.source_ref_ids).not.toEqual(relocatedMono?.source_ref_ids)
    expect(c2.commandWrites.links.some((link) =>
      link.relation_kind === "matches" &&
      link.from_row_id === relocatedLegacy?.row_id &&
      link.to_row_id === relocatedMono?.row_id,
    )).toBe(true)
    const divergentLegacy = rowFor("AppBundle\\Controller\\DivergentController", "legacy")
    const divergentMono = rowFor("App\\Admissions\\Controller\\DivergentController", "mono")
    expect(divergentLegacy).toMatchObject({ status: "missing", details: { effect_classes: ["durable_write"] } })
    expect(divergentMono).toMatchObject({ status: "extra", details: { effect_classes: ["durable_write", "identity_or_authority"] } })
    const renamedLegacy = rowFor("AppBundle\\Controller\\RenamedController", "legacy")
    const renamedMono = rowFor("App\\Admissions\\Controller\\RenamedController", "mono")
    expect(renamedLegacy).toMatchObject({ status: "missing", details: { symbol_ref: "AppBundle\\Controller\\RenamedController::createAction" } })
    expect(renamedMono).toMatchObject({ status: "extra", details: { symbol_ref: "App\\Admissions\\Controller\\RenamedController::deleteAction" } })
  } finally {
    rmSync(legacyRoot, { recursive: true, force: true })
    rmSync(monoRoot, { recursive: true, force: true })
  }
})
test("relocated services and custom commands reconcile exact effects, with Slack adapter rename evidence", async () => {
  const legacyRoot = mkdtempSync("/tmp/parity-c2-relocated-service-legacy-")
  const monoRoot = mkdtempSync("/tmp/parity-c2-relocated-service-mono-")
  try {
    put(legacyRoot, "app/config/services.yml", String.raw`services:
  relocated_service:
    class: AppBundle\Service\RelocatedService
  divergent_service:
    class: AppBundle\Service\DivergentService
  slack_messenger:
    class: AppBundle\Service\SlackMessenger
  slack_mailer:
    class: AppBundle\Service\SlackMailer
  interview_notification_manager:
    class: AppBundle\Service\InterviewNotificationManager
  relocated_command:
    class: AppBundle\Command\RelocatedCommand
  divergent_command:
    class: AppBundle\Command\DivergentCommand
  relocated_subscriber:
    class: AppBundle\EventSubscriber\RelocatedSubscriber
`)
    put(monoRoot, "apps/server/config/services.yaml", String.raw`services:
  relocated_service:
    class: App\Fixture\Infrastructure\RelocatedService
  divergent_service:
    class: App\Fixture\Infrastructure\DivergentService
  slack_messenger:
    class: App\Fixture\Infrastructure\Slack\SlackMessenger
  slack_mailer:
    class: App\Fixture\Infrastructure\Slack\SlackMailer
  interview_notification_manager:
    class: App\Fixture\Infrastructure\InterviewNotificationManager
  relocated_command:
    class: App\Fixture\Infrastructure\Command\RelocatedCommand
  divergent_command:
    class: App\Fixture\Infrastructure\Command\DivergentCommand
  relocated_subscriber:
    class: App\Fixture\Infrastructure\Subscriber\RelocatedSubscriber
`)
    put(legacyRoot, "src/AppBundle/Service/RelocatedService.php", String.raw`<?php
namespace AppBundle\Service;
final class RelocatedService {
    private $em;
    public function mutate(): void { $this->em->persist($value); }
}
`)
    put(monoRoot, "apps/server/src/App/Fixture/Infrastructure/SurveyManager.php", String.raw`<?php
namespace App\Fixture\Infrastructure;
final class RelocatedService {
    private $em;
    public function mutate(): void { $this->em->persist($value); }
}
`)
    put(legacyRoot, "src/AppBundle/Service/DivergentService.php", String.raw`<?php
namespace AppBundle\Service;
final class DivergentService {
    private $em;
    public function mutate(): void { $this->em->persist($value); }
}
`)
    put(monoRoot, "apps/server/src/App/Fixture/Infrastructure/SurveyNotifier.php", String.raw`<?php
namespace App\Fixture\Infrastructure;
final class DivergentService {
    private $em;
    public function mutate(): void { $this->em->persist($value); $this->em->setUser($value); }
}
`)
    put(legacyRoot, "src/AppBundle/Service/SlackMessenger.php", String.raw`<?php
namespace AppBundle\Service;
use Nexy\Slack\Client;
final class SlackMessenger {
    private $slackClient;
    public function __construct() { $this->slackClient = new Client(); }
    public function createMessage(): object { return new \stdClass(); }
    public function send(): void { $this->slackClient->sendMessage($message); }
    public function notify(): void { $this->send(); }
}
`)
    put(monoRoot, "apps/server/src/App/Fixture/Infrastructure/Slack/SlackMessenger.php", String.raw`<?php
namespace App\Fixture\Infrastructure\Slack;
use GuzzleHttp\Client;
final class SlackMessenger {
    private $httpClient;
    public function __construct() { $this->httpClient = new Client(); }
    public function sendPayload(): void { $this->httpClient->post($this->endpoint, []); }
    public function notify(): void { $this->sendPayload(); }
}
`)
    put(legacyRoot, "src/AppBundle/Service/SlackMailer.php", String.raw`<?php
namespace AppBundle\Service;
final class SlackMailer {
    private $messenger;
    public function __construct(SlackMessenger $messenger) { $this->messenger = $messenger; }
    public function send(): void { $message = $this->messenger->createMessage(); $this->messenger->send($message); }
}
`)
    put(monoRoot, "apps/server/src/App/Fixture/Infrastructure/Slack/SlackMailer.php", String.raw`<?php
namespace App\Fixture\Infrastructure\Slack;
final class SlackMailer {
    private $messenger;
    public function __construct(SlackMessenger $messenger) { $this->messenger = $messenger; }
    public function send(): void { $this->messenger->sendPayload($message); }
}
`)
    put(legacyRoot, "src/AppBundle/Service/InterviewNotificationManager.php", String.raw`<?php
namespace AppBundle\Service;
final class InterviewNotificationManager {
    private $slackMessenger;
    public function __construct(SlackMessenger $slackMessenger) { $this->slackMessenger = $slackMessenger; }
    public function sendApplicationCountNotification(): void { $this->slackMessenger->notify($message); }
    public function sendInterviewsCompletedNotification(): void { $this->slackMessenger->notify($message); }
}
`)
    put(monoRoot, "apps/server/src/App/Fixture/Infrastructure/TeamMembershipService.php", String.raw`<?php
namespace App\Fixture\Infrastructure;
use App\Fixture\Infrastructure\Slack\SlackMessenger;
final class InterviewNotificationManager {
    private $slackMessenger;
    public function __construct(SlackMessenger $slackMessenger) { $this->slackMessenger = $slackMessenger; }
    public function sendApplicationCountNotification(): void { $this->slackMessenger->notify($message); }
    public function sendInterviewsCompletedNotification(): void { $this->slackMessenger->notify($message); }
}
`)
    put(legacyRoot, "src/AppBundle/Command/RelocatedCommand.php", String.raw`<?php
namespace AppBundle\Command;
use AppBundle\Service\RelocatedService;
final class RelocatedCommand extends \Symfony\Bundle\FrameworkBundle\Command\ContainerAwareCommand {
    /** @var RelocatedService */
    private $service;
    protected function configure(): void { $this->setName('fixture:relocated'); }
    protected function execute(): void { $this->service->mutate(); }
}
`)
    put(monoRoot, "apps/server/src/App/Fixture/Infrastructure/Command/RelocatedCommand.php", String.raw`<?php
namespace App\Fixture\Infrastructure\Command;
use App\Fixture\Infrastructure\RelocatedService;
final class RelocatedCommand extends \Symfony\Component\Console\Command\Command {
    public function __construct(private readonly RelocatedService $service) { parent::__construct(); }
    protected function configure(): void { $this->setName('fixture:relocated'); }
    protected function execute(): int { $this->service->mutate(); return Command::SUCCESS; }
}
`)
    put(legacyRoot, "src/AppBundle/Command/DivergentCommand.php", String.raw`<?php
namespace AppBundle\Command;
use AppBundle\Service\DivergentService;
final class DivergentCommand extends \Symfony\Bundle\FrameworkBundle\Command\ContainerAwareCommand {
    /** @var DivergentService */
    private $service;
    protected function configure(): void { $this->setName('fixture:divergent'); }
    protected function execute(): void { $this->service->mutate(); }
}
`)
    put(monoRoot, "apps/server/src/App/Fixture/Infrastructure/Command/DivergentCommand.php", String.raw`<?php
namespace App\Fixture\Infrastructure\Command;
use App\Fixture\Infrastructure\DivergentService;
final class DivergentCommand extends \Symfony\Component\Console\Command\Command {
    public function __construct(private readonly DivergentService $service) { parent::__construct(); }
    protected function configure(): void { $this->setName('fixture:divergent'); }
    protected function execute(): int { $this->service->mutate(); return Command::SUCCESS; }
}
`)
    put(legacyRoot, "src/AppBundle/EventSubscriber/RelocatedSubscriber.php", String.raw`<?php
namespace AppBundle\EventSubscriber;
final class RelocatedSubscriber {
    public function onEvent(): void { $this->em->persist($value); }
}
`)
    put(monoRoot, "apps/server/src/App/Fixture/Infrastructure/Subscriber/RelocatedSubscriber.php", String.raw`<?php
namespace App\Fixture\Infrastructure\Subscriber;
final class RelocatedSubscriber {
    public function onEvent(): void { $this->em->persist($value); }
}
`)
    const context = await contextFor(legacyRoot, monoRoot)
    const c2 = collectC2(context, sha256("relocated-service-c2"))
    const rows = c2.commandWrites.rows
    const rowFor = (authority: "legacy" | "mono", ownerSuffix: string, method: string) => rows.find((row) =>
      row.authority_line === authority
      && "owner_ref" in row.details
      && row.details.owner_ref?.endsWith(ownerSuffix)
      && row.details.symbol_ref?.endsWith(`::${method}`),
    )
    const linkFor = (left: InventoryRow | undefined, right: InventoryRow | undefined): boolean =>
      left !== undefined && right !== undefined && c2.commandWrites.links.some((link) =>
        link.relation_kind === "matches" && link.from_row_id === left.row_id && link.to_row_id === right.row_id,
      )
    const relocatedSubscriberLegacy = rowFor("legacy", "\\RelocatedSubscriber", "onEvent")
    const relocatedSubscriberMono = rowFor("mono", "\\RelocatedSubscriber", "onEvent")
    expect(relocatedSubscriberLegacy).toMatchObject({ status: "covered", details: { entry_kind: "event_handler", effect_classes: ["durable_write"], target_refs: [] } })
    expect(relocatedSubscriberMono).toMatchObject({ status: "covered", details: { entry_kind: "event_handler", effect_classes: ["durable_write"], target_refs: [] } })
    expect(linkFor(relocatedSubscriberLegacy, relocatedSubscriberMono)).toBe(true)
    const relocatedServiceLegacy = rowFor("legacy", "\\RelocatedService", "mutate")
    const relocatedServiceMono = rowFor("mono", "\\RelocatedService", "mutate")
    expect(relocatedServiceLegacy).toMatchObject({ status: "covered", details: { entry_kind: "integration_write", effect_classes: ["durable_write"], target_refs: [] } })
    expect(relocatedServiceMono).toMatchObject({ status: "covered", details: { entry_kind: "integration_write", effect_classes: ["durable_write"], target_refs: [] } })
    expect(linkFor(relocatedServiceLegacy, relocatedServiceMono)).toBe(true)
    const relocatedCommandLegacy = rowFor("legacy", "\\RelocatedCommand", "execute")
    const relocatedCommandMono = rowFor("mono", "\\RelocatedCommand", "execute")
    expect(relocatedCommandLegacy).toMatchObject({ status: "covered", details: { command_name: "fixture:relocated", effect_classes: ["durable_write"] } })
    expect(relocatedCommandMono).toMatchObject({ status: "covered", details: { command_name: "fixture:relocated", effect_classes: ["durable_write"] } })
    expect(linkFor(relocatedCommandLegacy, relocatedCommandMono)).toBe(true)
    const slackLegacy = rowFor("legacy", "\\SlackMessenger", "send")
    const slackMono = rowFor("mono", "\\SlackMessenger", "sendPayload")
    expect(slackLegacy).toMatchObject({ status: "covered", details: { effect_classes: ["outbound"], target_refs: ["Client::sendMessage"] } })
    expect(slackMono).toMatchObject({ status: "covered", details: { effect_classes: ["outbound"], target_refs: ["Client::post"] } })
    expect(linkFor(slackLegacy, slackMono)).toBe(true)
    const slackMailerLegacy = rowFor("legacy", "\\SlackMailer", "send")
    const slackMailerMono = rowFor("mono", "\\SlackMailer", "send")
    expect(slackMailerLegacy).toMatchObject({
      status: "covered",
      details: {
        effect_classes: ["outbound"],
        target_refs: ["AppBundle\\Service\\SlackMessenger::createMessage", "AppBundle\\Service\\SlackMessenger::send"],
      },
    })
    expect(slackMailerMono).toMatchObject({
      status: "covered",
      details: {
        effect_classes: ["outbound"],
        target_refs: ["App\\Fixture\\Infrastructure\\Slack\\SlackMessenger::sendPayload"],
      },
    })
    expect(linkFor(slackMailerLegacy, slackMailerMono)).toBe(true)
    for (const method of ["sendApplicationCountNotification", "sendInterviewsCompletedNotification"]) {
      const interviewLegacy = rowFor("legacy", "\\InterviewNotificationManager", method)
      const interviewMono = rowFor("mono", "\\InterviewNotificationManager", method)
      expect(interviewLegacy).toMatchObject({
        status: "covered",
        details: {
          effect_classes: ["outbound"],
          target_refs: ["AppBundle\\Service\\SlackMessenger::notify"],
        },
      })
      expect(interviewMono).toMatchObject({
        status: "covered",
        details: {
          owner_ref: "App\\Fixture\\Infrastructure\\InterviewNotificationManager",
          effect_classes: ["outbound"],
          target_refs: ["App\\Fixture\\Infrastructure\\Slack\\SlackMessenger::notify"],
        },
      })
      expect(interviewLegacy?.signature).not.toContain("Client")
      expect(interviewMono?.signature).not.toContain("Client")
      expect(linkFor(interviewLegacy, interviewMono)).toBe(true)
    }
    const divergentServiceLegacy = rowFor("legacy", "\\DivergentService", "mutate")
    const divergentServiceMono = rowFor("mono", "\\DivergentService", "mutate")
    expect(divergentServiceLegacy).toMatchObject({ status: "missing", details: { effect_classes: ["durable_write"] } })
    expect(divergentServiceMono).toMatchObject({ status: "extra", details: { effect_classes: ["durable_write", "identity_or_authority"] } })
    expect(linkFor(divergentServiceLegacy, divergentServiceMono)).toBe(false)
    const divergentCommandLegacy = rowFor("legacy", "\\DivergentCommand", "execute")
    const divergentCommandMono = rowFor("mono", "\\DivergentCommand", "execute")
    expect(divergentCommandLegacy).toMatchObject({ status: "missing", details: { effect_classes: ["durable_write"] } })
    expect(divergentCommandMono).toMatchObject({ status: "extra", details: { effect_classes: ["durable_write", "identity_or_authority"] } })
    expect(linkFor(divergentCommandLegacy, divergentCommandMono)).toBe(false)
  } finally {
    rmSync(legacyRoot, { recursive: true, force: true })
    rmSync(monoRoot, { recursive: true, force: true })
  }
})


test("URL-bearing file fetches reconcile GeoLocation writes without classifying local reads", async () => {
  const legacyRoot = mkdtempSync("/tmp/parity-c2-geo-url-legacy-")
  const monoRoot = mkdtempSync("/tmp/parity-c2-geo-url-mono-")
  try {
    put(legacyRoot, "app/config/services.yml", [
      "services:",
      "  geo:",
      "    class: AppBundle\\Service\\GeoLocation",
      "  log:",
      "    class: AppBundle\\Service\\LogService",
      "  slack:",
      "    class: AppBundle\\Service\\SlackMessenger",
      "  local:",
      "    class: AppBundle\\Service\\LocalReader",
      "  company:",
      "    class: AppBundle\\Service\\CompanyEmailMaker",
    ].join("\n"))
    put(monoRoot, "apps/server/config/services.yaml", [
      "services:",
      "  geo:",
      "    class: App\\Fixture\\Infrastructure\\GeoLocation",
      "  log:",
      "    class: App\\Fixture\\Infrastructure\\LogService",
      "  slack:",
      "    class: App\\Fixture\\Infrastructure\\SlackMessenger",
      "  local:",
      "    class: App\\Fixture\\Infrastructure\\LocalReader",
      "  company:",
      "    class: App\\Identity\\Infrastructure\\CompanyEmailMaker",
    ].join("\n"))
    put(legacyRoot, "src/AppBundle/Service/GeoLocation.php", [
      "<?php",
      "namespace AppBundle\\Service;",
      "final class GeoLocation {",
      "    private $logger;",
      "    public function __construct(LogService $logger) { $this->logger = $logger; }",
      "    public function findCoordinates($ip) {",
      "        $raw = file_get_contents(\"http://ipinfo.io/$ip\");",
      "        $this->logger->warning($raw);",
      "        return $raw;",
      "    }",
      "    public function readLocal($path) { return file_get_contents($path); }",
      "}",
    ].join("\n"))
    put(monoRoot, "apps/server/src/App/Fixture/Infrastructure/GeoLocation.php", [
      "<?php",
      "namespace App\\Fixture\\Infrastructure;",
      "final class GeoLocation {",
      "    public function __construct(private readonly LogService $logger) {}",
      "    public function findCoordinates($ip) {",
      "        $raw = file_get_contents(\"http://ipinfo.io/$ip\");",
      "        $this->logger->warning($raw);",
      "        return $raw;",
      "    }",
      "    public function readLocal($path) { return file_get_contents($path); }",
      "}",
    ].join("\n"))
    put(legacyRoot, "src/AppBundle/Service/LogService.php", [
      "<?php",
      "namespace AppBundle\\Service;",
      "final class LogService {",
      "    private $slackMessenger;",
      "    public function __construct(SlackMessenger $slackMessenger) { $this->slackMessenger = $slackMessenger; }",
      "    public function warning($message, array $context = array()) { $this->slackMessenger->log($message, $context); }",
      "}",
    ].join("\n"))
    put(monoRoot, "apps/server/src/App/Fixture/Infrastructure/LogService.php", [
      "<?php",
      "namespace App\\Fixture\\Infrastructure;",
      "final class LogService {",
      "    public function __construct(private readonly SlackMessenger $slackMessenger) {}",
      "    public function warning($message, array $context = array()) { $this->slackMessenger->log($message, $context); }",
      "}",
    ].join("\n"))
    put(legacyRoot, "src/AppBundle/Service/SlackMessenger.php", [
      "<?php",
      "namespace AppBundle\\Service;",
      "final class SlackMessenger {",
      "    private $slackClient;",
      "    public function __construct(Client $slackClient) { $this->slackClient = $slackClient; }",
      "    public function log($message, array $context = array()) { $this->send($message); }",
      "    public function send($message) { $this->slackClient->sendMessage($message); }",
      "}",
    ].join("\n"))
    put(monoRoot, "apps/server/src/App/Fixture/Infrastructure/SlackMessenger.php", [
      "<?php",
      "namespace App\\Fixture\\Infrastructure;",
      "final class SlackMessenger {",
      "    private $slackClient;",
      "    public function __construct(Client $slackClient) { $this->slackClient = $slackClient; }",
      "    public function log($message, array $context = array()) { $this->sendPayload($message); }",
      "    public function sendPayload($message) { $this->slackClient->post([], []); }",
      "}",
    ].join("\n"))
    put(legacyRoot, "src/AppBundle/Service/CompanyEmailMaker.php", [
      "<?php",
      "namespace AppBundle\\Service;",
      "final class CompanyEmailMaker {",
      "    private $em;",
      "    private $logger;",
      "    public function __construct(EntityManagerInterface $em, LogService $logger) { $this->em = $em; $this->logger = $logger; }",
      "    public function setCompanyEmailFor(User $user) {",
      "        $user->setCompanyEmail(\"user@example.test\");",
      "        $this->em->flush();",
      "        $this->logger->warning(\"company email updated\");",
      "    }",
      "}",
    ].join("\n"))
    put(legacyRoot, "src/AppBundle/Service/LocalReader.php", [
      "<?php",
      "namespace AppBundle\\Service;",
      "final class LocalReader {",
      "    public function read($path) { return file_get_contents($path); }",
      "}",
    ].join("\n"))
    put(monoRoot, "apps/server/src/App/Identity/Infrastructure/CompanyEmailMaker.php", [
      "<?php",
      "namespace App\\Identity\\Infrastructure;",
      "use App\\Fixture\\Infrastructure\\LogService;",
      "final class CompanyEmailMaker {",
      "    private $em;",
      "    private $logger;",
      "    public function __construct(EntityManagerInterface $em, LogService $logger) { $this->em = $em; $this->logger = $logger; }",
      "    public function setCompanyEmailFor(User $user) {",
      "        $user->setCompanyEmail(\"user@example.test\");",
      "        $this->em->flush();",
      "        $this->logger->warning(\"company email updated\");",
      "    }",
      "}",
    ].join("\n"))
    put(monoRoot, "apps/server/src/App/Fixture/Infrastructure/LocalReader.php", [
      "<?php",
      "namespace App\\Fixture\\Infrastructure;",
      "final class LocalReader {",
      "    public function read($path) { return file_get_contents($path); }",
      "}",
    ].join("\n"))
    const context = await contextFor(legacyRoot, monoRoot)
    const c2 = collectC2(context, sha256("geo-file-get-contents"))
    const rows = c2.commandWrites.rows
    const rowFor = (authority: "legacy" | "mono", suffix: string) => rows.find((row) =>
      row.authority_line === authority
      && "owner_ref" in row.details
      && row.details.owner_ref?.endsWith(suffix),
    )
    const legacyGeo = rowFor("legacy", "\\GeoLocation")
    const monoGeo = rowFor("mono", "\\GeoLocation")
    const legacyCompany = rowFor("legacy", "\\CompanyEmailMaker")
    const monoCompany = rowFor("mono", "\\CompanyEmailMaker")
    expect(legacyCompany).toMatchObject({ status: "covered", details: { effect_classes: ["durable_write", "outbound"] } })
    expect(monoCompany).toMatchObject({ status: "covered", details: { effect_classes: ["durable_write", "outbound"] } })
    expect(c2.commandWrites.links.some((link) =>
      link.relation_kind === "matches" && link.from_row_id === legacyCompany?.row_id && link.to_row_id === monoCompany?.row_id,
    )).toBe(true)
    expect(legacyGeo).toMatchObject({ status: "covered", details: { effect_classes: ["outbound"] } })
    expect(monoGeo).toMatchObject({ status: "covered", details: { effect_classes: ["outbound"] } })
    expect(legacyGeo?.details.target_refs.some((target) => target.startsWith("unresolved:"))).toBe(false)
    expect(monoGeo?.details.target_refs.some((target) => target.startsWith("unresolved:"))).toBe(false)
    expect(c2.commandWrites.links.some((link) =>
      link.relation_kind === "matches" && link.from_row_id === legacyGeo?.row_id && link.to_row_id === monoGeo?.row_id,
    )).toBe(true)
    expect(rows.some((row) => row.details.owner_ref?.endsWith("\\LocalReader"))).toBe(false)
  } finally {
    rmSync(legacyRoot, { recursive: true, force: true })
    rmSync(monoRoot, { recursive: true, force: true })
  }
})

test("dead relocated command rows link without losing dead status", async () => {
  const legacyRoot = mkdtempSync("/tmp/parity-c2-dead-relocated-legacy-")
  const monoRoot = mkdtempSync("/tmp/parity-c2-dead-relocated-mono-")
  try {
    put(legacyRoot, "src/AppBundle/Command/DeadRelocatedCommand.php", String.raw`<?php
namespace AppBundle\Command;
final class DeadRelocatedCommand extends \Symfony\Bundle\FrameworkBundle\Command\ContainerAwareCommand {
    protected function configure(): void { $this->setName('fixture:dead-relocated'); }
    protected function execute(): void { $this->em->persist($value); }
}
`)
    put(monoRoot, "apps/server/src/App/Fixture/Infrastructure/Command/DeadRelocatedCommand.php", String.raw`<?php
namespace App\Fixture\Infrastructure\Command;
final class DeadRelocatedCommand extends \Symfony\Component\Console\Command\Command {
    protected function configure(): void { $this->setName('fixture:dead-relocated'); }
    protected function execute(): int { $this->em->persist($value); return Command::SUCCESS; }
}
`)
    const context = await contextFor(legacyRoot, monoRoot)
    const c2 = collectC2(context, sha256("dead-relocated-c2"))
    const rows = c2.commandWrites.rows.filter((row) => "owner_ref" in row.details && row.details.owner_ref?.endsWith("\\DeadRelocatedCommand"))
    expect(rows).toHaveLength(2)
    expect(rows.every((row) => row.status === "dead_unimported")).toBe(true)
    expect(rows.every((row) => row.mismatch.kind === "dead_unimported")).toBe(true)
    expect(c2.commandWrites.links.filter((link) => link.relation_kind === "matches" && rows.some((row) => row.row_id === link.from_row_id || row.row_id === link.to_row_id))).toHaveLength(1)
    expect(rows.some((row) => row.status === "missing" || row.status === "extra")).toBe(false)
  } finally {
    rmSync(legacyRoot, { recursive: true, force: true })
    rmSync(monoRoot, { recursive: true, force: true })
  }
})

test("C2 source family selectors remain literal and complete", () => {
  const byId = new Map(SOURCE_FAMILIES.map((family) => [family.family_id, family]))
  expect(byId.get("legacy_commands_writes")?.patterns).toEqual([
    "src/AppBundle/**/Command/**/*.php",
    "src/AppBundle/**/Controller/**/*.php",
    "src/AppBundle/**/Service/**/*.php",
    "src/AppBundle/**/Entity/**/*.php",
    "src/AppBundle/**/Event/**/*.php",
    "src/AppBundle/**/EventSubscriber/**/*.php",
    "src/AppBundle/**/Repository/**/*.php",
    "app/config/services*.yml",
    "app/config/config*.yml",
    "app/config/routing*.yml",
  ])
  expect(byId.get("mono_commands_writes")?.patterns).toEqual([
    "apps/server/src/App/**/Infrastructure/Command/**/*.php",
    "apps/server/src/App/**/Controller/**/*.php",
    "apps/server/src/App/**/Infrastructure/Repository/**/*.php",
    "apps/server/src/App/**/Infrastructure/AccessControlService.php",
    "apps/server/src/App/**/Infrastructure/AdmissionNotifier.php",
    "apps/server/src/App/**/Infrastructure/ApplicationAdmission.php",
    "apps/server/src/App/**/Infrastructure/ApplicationData.php",
    "apps/server/src/App/**/Infrastructure/ApplicationManager.php",
    "apps/server/src/App/**/Infrastructure/AssistantHistoryData.php",
    "apps/server/src/App/**/Infrastructure/BetaRedirecter.php",
    "apps/server/src/App/**/Infrastructure/CompanyEmailMaker.php",
    "apps/server/src/App/**/Infrastructure/ContentModeManager.php",
    "apps/server/src/App/**/Infrastructure/EmailSender.php",
    "apps/server/src/App/**/Infrastructure/FileUploader.php",
    "apps/server/src/App/**/Infrastructure/GeoLocation.php",
    "apps/server/src/App/**/Infrastructure/InterviewManager.php",
    "apps/server/src/App/**/Infrastructure/InterviewNotificationManager.php",
    "apps/server/src/App/**/Infrastructure/LogService.php",
    "apps/server/src/App/**/Infrastructure/LoginManager.php",
    "apps/server/src/App/**/Infrastructure/PasswordManager.php",
    "apps/server/src/App/**/Infrastructure/RoleManager.php",
    "apps/server/src/App/**/Infrastructure/SbsData.php",
    "apps/server/src/App/**/Infrastructure/Slack/SlackMessenger.php",
    "apps/server/src/App/**/Infrastructure/Slack/SlackMailer.php",
    "apps/server/src/App/**/Infrastructure/SurveyManager.php",
    "apps/server/src/App/**/Infrastructure/SurveyNotifier.php",
    "apps/server/src/App/**/Infrastructure/TeamMembershipService.php",
    "apps/server/src/App/**/Infrastructure/UserGroupCollectionManager.php",
    "apps/server/src/App/**/Infrastructure/UserRegistration.php",
    "apps/server/src/App/**/Infrastructure/UserService.php",
    "apps/server/src/App/**/Infrastructure/Subscriber/**/*.php",
    "apps/server/src/App/**/Event/**/*.php",
    "apps/server/src/App/**/EventSubscriber/**/*.php",
    "apps/server/config/services*.yaml",
    "apps/server/config/packages/*.yaml",
    "apps/server/config/routes*.yaml",
    "apps/server/config/routes/**/*.yaml",
  ])
  expect(byId.get("mono_schedules")?.patterns).toEqual([
    ".github/workflows/**/*.yml",
    ".github/workflows/**/*.yaml",
    "infra/**/*.ts",
    "infra/**/*.tsx",
    "infra/**/*.js",
    "infra/**/*.mjs",
    "infra/**/*.yml",
    "infra/**/*.yaml",
    "apps/server/config/**/*.yaml",
    "apps/server/src/App/**/Infrastructure/Command/**/*.php",
    "apps/server/src/App/**/Infrastructure/Subscriber/**/*.php",
    "apps/server/src/App/**/EventSubscriber/**/*.php",
  ])
  expect(byId.get("mono_integrations")?.patterns).toEqual([
    "apps/server/src/App/**/Infrastructure/**/*.php",
    "apps/server/src/App/**/Support/**/*.php",
    "apps/server/src/App/**/Controller/**/*.php",
    "packages/**/*.ts",
    "packages/**/*.tsx",
    "packages/**/*.js",
    ".github/workflows/**/*.yml",
    ".github/workflows/**/*.yaml",
    "infra/**/*.ts",
    "infra/**/*.tsx",
    "infra/**/*.js",
    "infra/**/*.mjs",
  ])
})

test("mono Infrastructure integration sources have explicit command-write coverage", async () => {
  const legacyRoot = mkdtempSync("/tmp/parity-c2-infrastructure-allowlist-legacy-")
  const cloneParent = mkdtempSync("/tmp/parity-c2-infrastructure-allowlist-clone-")
  const cloneRoot = join(cloneParent, "repo")
  try {
    execFileSync("git", ["clone", "--local", "--no-hardlinks", "--no-checkout", REPO_ROOT, cloneRoot], { stdio: "ignore" })
    execFileSync("git", ["-C", cloneRoot, "checkout", "--detach", "HEAD"], { stdio: "ignore" })
    const context = await contextFor(legacyRoot, cloneRoot)
    const integrationFamily = SOURCE_FAMILIES.find((family) => family.family_id === "mono_integrations")
    const commandFamily = SOURCE_FAMILIES.find((family) => family.family_id === "mono_commands_writes")
    if (integrationFamily === undefined || commandFamily === undefined) throw new Error("C2 source family configuration is incomplete")
    const looseInfrastructurePaths = sourceFamilyMatchedPaths(context, integrationFamily)
      .filter((path) => path.startsWith("apps/server/src/App/") && path.includes("/Infrastructure/") && path.endsWith(".php"))
    const explicitExcludedPatterns = [
      "apps/server/src/App/**/Infrastructure/Entity/**/*.php",
      "apps/server/src/App/**/Infrastructure/Validator/**/*.php",
      "apps/server/src/App/**/Infrastructure/Google/**/*.php",
      "apps/server/src/App/**/Infrastructure/Sms/**/*.php",
      "apps/server/src/App/**/Infrastructure/Mailer/**/*.php",
      "apps/server/src/App/**/Infrastructure/InterviewDistributionFactory.php",
      "apps/server/src/App/**/Infrastructure/UserChecker.php",
      "apps/server/src/App/**/Infrastructure/UserMap.php",
      "apps/server/src/App/**/Infrastructure/ReversedRoleHierarchy.php",
    ]
    const commandWritePaths = looseInfrastructurePaths.filter((path) =>
      commandFamily.patterns.some((pattern) => matchesLiteralPattern(path, pattern)),
    )
    const excludedPaths = looseInfrastructurePaths.filter((path) =>
      explicitExcludedPatterns.some((pattern) => matchesLiteralPattern(path, pattern)),
    )
    const uncoveredPaths = looseInfrastructurePaths.filter((path) =>
      !commandWritePaths.includes(path) && !excludedPaths.includes(path),
    )
    const overlappingPaths = looseInfrastructurePaths.filter((path) =>
      commandWritePaths.includes(path) && excludedPaths.includes(path),
    )
    expect({ uncoveredPaths, overlappingPaths }).toEqual({ uncoveredPaths: [], overlappingPaths: [] })
    expect(commandWritePaths).toContain("apps/server/src/App/Support/Infrastructure/Slack/SlackMailer.php")
    expect(excludedPaths).toContain("apps/server/src/App/Support/Infrastructure/Mailer/MailerInterface.php")
  } finally {
    rmSync(legacyRoot, { recursive: true, force: true })
    rmSync(cloneParent, { recursive: true, force: true })
  }
}, 30_000)

test("comment-only schedule literals do not create schedule rows", async () => {
  const legacyRoot = mkdtempSync("/tmp/parity-c2-comment-schedule-legacy-")
  const monoRoot = mkdtempSync("/tmp/parity-c2-comment-schedule-mono-")
  try {
    put(monoRoot, "infra/decoy.ts", "// schedule(\"nightly\", \"0 0 * * *\")\n")
    const context = await contextFor(legacyRoot, monoRoot)
    const c2 = collectC2(context, sha256("comment-schedule-c2"))
    const decoyRows = c2.schedules.rows.filter((row) => row.source_ref_ids.some((ref) => context.sourcePathById.get(ref)?.path === "infra/decoy.ts"))
    expect(decoyRows).toEqual([])
    expect(c2.schedules.rows.some((row) => row.status === "absent" && row.authority_line === "mono")).toBe(true)
  } finally {
    rmSync(legacyRoot, { recursive: true, force: true })
    rmSync(monoRoot, { recursive: true, force: true })
  }
})

test("non-scheduled infrastructure files leave only the family absence observation", async () => {
  const legacyRoot = mkdtempSync("/tmp/parity-c2-duplicate-schedule-legacy-")
  const monoRoot = mkdtempSync("/tmp/parity-c2-duplicate-schedule-mono-")
  try {
    put(monoRoot, "infra/a.ts", "export const marker = true\n")
    put(monoRoot, "infra/b.ts", "export const marker = true\n")
    put(monoRoot, "apps/server/config/packages/cache.yaml", "framework:\n  cache: true\n")
    const context = await contextFor(legacyRoot, monoRoot)
    const c2 = collectC2(context, sha256("duplicate-schedule-c2"))
    expect(c2.schedules.rows.filter((row) => row.source_ref_ids.some((ref) => {
      const path = context.sourcePathById.get(ref)?.path
      return path === "infra/a.ts" || path === "infra/b.ts" || path === "apps/server/config/packages/cache.yaml"
    }))).toEqual([])
    expect(c2.schedules.rows.filter((row) => row.authority_line === "mono" && row.status === "absent")).toHaveLength(1)
  } finally {
    rmSync(legacyRoot, { recursive: true, force: true })
    rmSync(monoRoot, { recursive: true, force: true })
  }
})

test("schedule expressions use literal cron grammar and redact payload-shaped values", async () => {
  const legacyRoot = mkdtempSync("/tmp/parity-c2-cron-legacy-")
  const monoRoot = mkdtempSync("/tmp/parity-c2-cron-mono-")
  const payload = "not-a-cron-payload-12345"
  const invalidAlphabetic = "0 0 * foo *"
  const highEntropy = "999999999999 999999999999 999999999999 999999999999 999999999999"
  try {
    put(monoRoot, "infra/timer.ts", `schedule("nightly", "${payload}")\nschedule("alpha", "${invalidAlphabetic}")\nschedule("entropy", "${highEntropy}")\nconst note = 'schedule("decoy", "0 0 * * *")'\n`)
    const context = await contextFor(legacyRoot, monoRoot)
    const c2 = collectC2(context, sha256("cron-grammar-c2"))
    const serialized = canonicalJson(c2.schedules)
    expect(serialized).not.toContain(payload)
    const rows = c2.schedules.rows.filter((row) => row.source_ref_ids.some((ref) => context.sourcePathById.get(ref)?.path === "infra/timer.ts"))
    expect(rows.some((row) => row.status === "unresolved" && row.reason_codes.includes("SCHEDULE_EXPRESSION_UNRESOLVED"))).toBe(true)
    expect(rows.every((row) => row.status === "unresolved")).toBe(true)
    expect(c2.schedules.rows.some((row) => row.status === "absent" && row.authority_line === "mono")).toBe(false)
  } finally {
    rmSync(legacyRoot, { recursive: true, force: true })
    rmSync(monoRoot, { recursive: true, force: true })
  }
})
test("generic local request and send calls do not create integrations", async () => {
  const legacyRoot = mkdtempSync("/tmp/parity-c2-dynamic-legacy-")
  const monoRoot = mkdtempSync("/tmp/parity-c2-dynamic-mono-")
  try {
    put(monoRoot, "apps/server/src/App/Infrastructure/Service/Delegate.php", "<?php\nfinal class Delegate { public function sendThing(): void { $this->delegate->send($payload); } }\n")
    put(monoRoot, "apps/server/src/App/Infrastructure/Service/Request.php", "<?php\nfinal class Request { public function read(): JsonResponse { $value = $request->request->get('local'); return new JsonResponse($value); } }\n")
    put(monoRoot, "packages/google-client.ts", "export class GoogleClient { fetch(dynamicEndpoint) { return dynamicEndpoint }\n}\n")
    put(monoRoot, "packages/preview.ts", "export function handle(request: Request): Promise<Response> { request.headers.get('host'); if (request.method !== 'GET') throw new Error('method'); return fetch(request) }\n")
    put(monoRoot, "packages/tool/tests/client.test.ts", "test('fixture', () => fetch('https://api.example.test/v1/items'))\n")
    const context = await contextFor(legacyRoot, monoRoot)
    const c2 = collectC2(context, sha256("dynamic-integration-c2"))
    const genericPaths = new Set([
      "apps/server/src/App/Infrastructure/Service/Delegate.php",
      "apps/server/src/App/Infrastructure/Service/Request.php",
      "packages/tool/tests/client.test.ts",
    ])
    expect(c2.integrations.rows.filter((row) => row.source_ref_ids.some((ref) => genericPaths.has(context.sourcePathById.get(ref)?.path ?? "")))).toEqual([])
    const googleRows = c2.integrations.rows.filter((row) => row.source_ref_ids.some((ref) => context.sourcePathById.get(ref)?.path === "packages/google-client.ts"))
    expect(googleRows).toHaveLength(1)
    expect(googleRows[0]).toMatchObject({
      status: "dead_unimported",
      reason_codes: ["DEAD_UNIMPORTED_SOURCE"],
      details: {
        provider_ref: "google",
        protocol: "https",
        endpoint_ref: null,
        call_site_ref: "GoogleClient::fetch",
      },
    })
    const previewRows = c2.integrations.rows.filter((row) =>
      row.source_ref_ids.some((ref) => context.sourcePathById.get(ref)?.path === "packages/preview.ts"),
    )
    expect(previewRows).toHaveLength(1)
    expect(previewRows[0]).toMatchObject({
      status: "unresolved",
      reason_codes: ["UNKNOWN_INTEGRATION"],
      details: {
        call_site_ref: "packages/preview.ts#handle",
        provider_ref: null,
        protocol: "http",
        effect_classes: ["unknown"],
      },
    })
  } finally {
    rmSync(legacyRoot, { recursive: true, force: true })
    rmSync(monoRoot, { recursive: true, force: true })
  }
})
test("command rows require positive declarations or write effects", async () => {
  const legacyRoot = mkdtempSync("/tmp/parity-c2-positive-command-legacy-")
  const monoRoot = mkdtempSync("/tmp/parity-c2-positive-command-mono-")
  try {
    put(monoRoot, "apps/server/config/services.yaml", "services:\n  read:\n    class: App\\Fixture\\Infrastructure\\Repository\\ReadRepository\n  write:\n    class: App\\Fixture\\Infrastructure\\Repository\\WriteRepository\n")
    put(monoRoot, "apps/server/config/packages/framework.yaml", "framework:\n  name: generic-config-name\n")
    put(monoRoot, "apps/server/src/App/Infrastructure/Repository/ReadRepository.php", "<?php\nnamespace App\\Fixture\\Infrastructure\\Repository;\nfinal class ReadRepository { public function find(): void {} }\n")
    put(monoRoot, "apps/server/src/App/Infrastructure/Repository/WriteRepository.php", "<?php\nnamespace App\\Fixture\\Infrastructure\\Repository;\nfinal class WriteRepository { public function persist(): void {} public function flush(): void {} }\n")
    put(monoRoot, "apps/server/src/App/Infrastructure/Command/ReadCommand.php", "<?php\nnamespace App\\Fixture\\Infrastructure\\Command;\n#[AsCommand(name: 'fixture:read')]\nfinal class ReadCommand { public function __invoke(): void {} }\n")
    const context = await contextFor(legacyRoot, monoRoot)
    const c2 = collectC2(context, sha256("positive-command-c2"))
    const hasPath = (row: { readonly source_ref_ids: readonly string[] }, path: string): boolean =>
      row.source_ref_ids.some((sourceRefId) => context.sourcePathById.get(sourceRefId)?.path === path)
    const commandRows = c2.commandWrites.rows.filter((row) => row.authority_line === "mono")
    expect(commandRows.some((row) => hasPath(row, "apps/server/config/packages/framework.yaml"))).toBe(false)
    expect(commandRows.some((row) => hasPath(row, "apps/server/src/App/Infrastructure/Repository/ReadRepository.php"))).toBe(false)
    const writes = commandRows.filter((row) => hasPath(row, "apps/server/src/App/Infrastructure/Repository/WriteRepository.php"))
    expect(writes).toHaveLength(2)
    expect(writes.every((row) => "effect_classes" in row.details && row.details.effect_classes.includes("durable_write"))).toBe(true)
    expect(commandRows.find((row) => hasPath(row, "apps/server/src/App/Infrastructure/Command/ReadCommand.php"))).toMatchObject({ details: { effect_classes: ["read_only"] } })
  } finally {
    rmSync(legacyRoot, { recursive: true, force: true })
    rmSync(monoRoot, { recursive: true, force: true })
  }
})
test("provider-specific and literal HTTP integration anchors remain visible", async () => {
  const legacyRoot = mkdtempSync("/tmp/parity-c2-real-integrations-legacy-")
  const monoRoot = mkdtempSync("/tmp/parity-c2-real-integrations-mono-")
  try {
    put(monoRoot, "apps/server/src/App/Infrastructure/Service/MailerAdapter.php", "<?php\nfinal class MailerAdapter { public function send(): void {} }\n")
    put(monoRoot, "apps/server/src/App/Infrastructure/Service/SmsGateway.php", "<?php\nfinal class SmsGateway { public function send(): void {} }\n")
    put(monoRoot, "apps/server/src/App/Infrastructure/Service/GatewayAPIAdapter.php", "<?php\nfinal class GatewayAPIAdapter { public function request(): void {} }\n")
    put(monoRoot, "apps/server/src/App/Infrastructure/Service/GitHubClient.php", "<?php\nfinal class GitHubClient { public function request(): void {} }\n")
    put(monoRoot, "apps/server/src/App/Support/Controller/GitHubController.php", "<?php\nfinal class GitHubController { public function ipIsFromGitHub(): bool { $ch = curl_init(); return curl_exec($ch); } }\n")
    put(monoRoot, "apps/server/src/App/Infrastructure/Service/HttpClientAdapter.php", "<?php\nfinal class HttpClientAdapter { public function request(): void { $this->http->request('https://api.example.test/v1/items'); } }\n")
    const context = await contextFor(legacyRoot, monoRoot)
    const integrations = collectC2(context, sha256("real-integrations-c2")).integrations
    const sourcePaths = new Set(integrations.rows.flatMap((row) => row.source_ref_ids.map((ref) => context.sourcePathById.get(ref)?.path ?? "")))
    expect([...sourcePaths]).toEqual(expect.arrayContaining([
      "apps/server/src/App/Infrastructure/Service/MailerAdapter.php",
      "apps/server/src/App/Infrastructure/Service/SmsGateway.php",
      "apps/server/src/App/Infrastructure/Service/GatewayAPIAdapter.php",
      "apps/server/src/App/Infrastructure/Service/GitHubClient.php",
      "apps/server/src/App/Infrastructure/Service/HttpClientAdapter.php",
      "apps/server/src/App/Support/Controller/GitHubController.php",
    ]))
    expect(
      integrations.rows
        .filter((row) => row.source_ref_ids.some((ref) => sourcePaths.has(context.sourcePathById.get(ref)?.path ?? "")))
        .every((row) => "call_site_ref" in row.details && row.details.call_site_ref !== null),
    ).toBe(true)
    const httpRows = integrations.rows.filter((row) => row.source_ref_ids.some((ref) => context.sourcePathById.get(ref)?.path === "apps/server/src/App/Infrastructure/Service/HttpClientAdapter.php"))
    expect(httpRows.some((row) => "endpoint_ref" in row.details && row.details.endpoint_ref === "https://api.example.test/v1/items")).toBe(true)
    const githubControllerRows = integrations.rows.filter((row) =>
      row.source_ref_ids.some((ref) => context.sourcePathById.get(ref)?.path === "apps/server/src/App/Support/Controller/GitHubController.php"),
    )
    expect(githubControllerRows).toHaveLength(1)
    expect(githubControllerRows[0]).toMatchObject({
      status: "dead_unimported",
      reason_codes: ["DEAD_UNIMPORTED_SOURCE"],
      details: { provider_ref: "github", protocol: "https" },
    })
  } finally {
    rmSync(legacyRoot, { recursive: true, force: true })
    rmSync(monoRoot, { recursive: true, force: true })
  }
})

test("YAML block scalars cannot forge loader imports or class authority", async () => {
  const legacyRoot = mkdtempSync("/tmp/parity-c2-loader-block-legacy-")
  const monoRoot = mkdtempSync("/tmp/parity-c2-loader-block-mono-")
  try {
    put(monoRoot, "apps/server/src/App/Infrastructure/Command/BlockCommand.php", "<?php\nnamespace App\\Fixture;\nfinal class BlockCommand { public function __invoke(): void { $this->repository->save(); } }\n")
    put(monoRoot, "apps/server/config/services.yaml", "decoy:\n  class: App\\Fixture\\BlockCommand\nservices:\n  forged:\n    class: |\n      App\\Fixture\\BlockCommand\nimports:\n  - resource: |\n      services-fake.yaml\n")
    const context = await contextFor(legacyRoot, monoRoot)
    const c2 = collectC2(context, sha256("loader-block-c2"))
    const row = c2.commandWrites.rows.find((candidate) => "owner_ref" in candidate.details && candidate.details.owner_ref === "App\\Fixture\\BlockCommand")
    expect(row).toMatchObject({ status: "unresolved", reason_codes: expect.arrayContaining(["DEAD_UNIMPORTED_SOURCE", "UNKNOWN_EFFECT"]) })
    expect(c2.commandWrites.links.some((link) => link.to_row_id === row?.row_id && link.relation_kind === "imports")).toBe(false)
  } finally {
    rmSync(legacyRoot, { recursive: true, force: true })
    rmSync(monoRoot, { recursive: true, force: true })
  }
})

test("command imports require rooted loader reachability and reject loader cycles", async () => {
  const legacyRoot = mkdtempSync("/tmp/parity-c2-loader-legacy-")
  const monoRoot = mkdtempSync("/tmp/parity-c2-loader-mono-")
  try {
    put(monoRoot, "apps/server/src/App/Infrastructure/Command/ACommand.php", "<?php\nnamespace App\\Fixture;\nfinal class ACommand { private const REF = \"App\\\\Fixture\\\\BCommand\"; public function __invoke(): void { $this->repository->save(); } }\n")
    put(monoRoot, "apps/server/src/App/Infrastructure/Command/BCommand.php", "<?php\nnamespace App\\Fixture;\nfinal class BCommand { private const REF = \"App\\\\Fixture\\\\ACommand\"; public function __invoke(): void { $this->repository->save(); } }\n")
    put(monoRoot, "apps/server/config/services.yaml", "services:\n  a:\n    class: App\\Fixture\\ACommand\n")
    put(monoRoot, "apps/server/config/services-a.yaml", "imports:\n  - resource: services-b.yaml\nservices:\n  a:\n    class: App\\Fixture\\ACommand\n")
    put(monoRoot, "apps/server/config/services-b.yaml", "imports:\n  - resource: services-a.yaml\nservices:\n  b:\n    class: App\\Fixture\\BCommand\n")
    const context = await contextFor(legacyRoot, monoRoot)
    const c2 = collectC2(context, sha256("loader-cycle-c2"))
    const aRow = c2.commandWrites.rows.find((row) => "owner_ref" in row.details && row.details.owner_ref === "App\\Fixture\\ACommand")
    const bRow = c2.commandWrites.rows.find((row) => "owner_ref" in row.details && row.details.owner_ref === "App\\Fixture\\BCommand")
    expect(aRow).toBeDefined()
    expect(aRow?.reason_codes.includes("DEAD_UNIMPORTED_SOURCE")).toBe(false)
    expect(bRow).toMatchObject({ status: "unresolved", reason_codes: expect.arrayContaining(["DEAD_UNIMPORTED_SOURCE", "UNKNOWN_EFFECT"]) })
  } finally {
    rmSync(legacyRoot, { recursive: true, force: true })
    rmSync(monoRoot, { recursive: true, force: true })
  }
})
test("effect evidence keeps unresolved receiver calls unknown without lexical target authority", async () => {
  const legacyRoot = mkdtempSync("/tmp/parity-c2-effect-authority-legacy-")
  const monoRoot = mkdtempSync("/tmp/parity-c2-effect-authority-mono-")
  try {
    put(monoRoot, "apps/server/src/App/Infrastructure/Command/UnknownCommand.php", "<?php\nnamespace App\\Fixture;\nfinal class UnknownCommand { private function save(): void {} public function __invoke(): void { save(); } }\n")
    const context = await contextFor(legacyRoot, monoRoot)
    const c2 = collectC2(context, sha256("effect-authority-c2"))
    const row = c2.commandWrites.rows.find((candidate) => context.sourcePathById.get(candidate.source_ref_ids[0] ?? "")?.path === "apps/server/src/App/Infrastructure/Command/UnknownCommand.php")
    expect(row).toMatchObject({
      status: "unresolved",
      reason_codes: expect.arrayContaining(["UNKNOWN_EFFECT"]),
      details: { target_refs: ["unresolved:App\\Fixture\\UnknownCommand::save"] },
    })
  } finally {
    rmSync(legacyRoot, { recursive: true, force: true })
    rmSync(monoRoot, { recursive: true, force: true })
  }
})

test("framework effect anchors remain authoritative without local receiver types", async () => {
  const legacyRoot = mkdtempSync("/tmp/parity-c2-framework-effects-legacy-")
  const monoRoot = mkdtempSync("/tmp/parity-c2-framework-effects-mono-")
  try {
    put(monoRoot, "apps/server/src/App/Infrastructure/Command/DoctrineCommand.php", "<?php\nnamespace App\\Fixture;\nfinal class DoctrineCommand { public function __invoke($entity): void { $em->persist($entity); $em->flush(); $manager->remove($entity); } }\n")
    put(monoRoot, "apps/server/src/App/Infrastructure/Command/EventCommand.php", "<?php\nnamespace App\\Fixture;\nfinal class EventCommand { public function __invoke(): void { $this->get('event_dispatcher')->dispatch('created', new Event()); } }\n")
    put(monoRoot, "apps/server/src/App/Infrastructure/Command/FileCommand.php", "<?php\nnamespace App\\Fixture;\nfinal class FileCommand { public function __invoke(): void { mkdir('path'); unlink('path'); } }\n")
    put(monoRoot, "apps/server/src/App/Infrastructure/Command/IdentityCommand.php", "<?php\nnamespace App\\Fixture;\nfinal class IdentityCommand { public function __invoke($member, $application, $user): void { $member->setUser($user); $application->getInterview()->setUser($user); } }\n")
    put(monoRoot, "apps/server/src/App/Infrastructure/Command/SmsValueCommand.php", "<?php\nnamespace App\\Fixture;\nfinal class SmsValueCommand { public function __invoke(): void { $message = new Sms('body'); } }\n")
    const context = await contextFor(legacyRoot, monoRoot)
    const rows = collectC2(context, sha256("framework-effects-c2")).commandWrites.rows
    const rowFor = (ownerRef: string) =>
      rows.find((row) => "owner_ref" in row.details && row.details.owner_ref === ownerRef && row.details.entry_kind !== "integration_write")
      ?? rows.find((row) => "owner_ref" in row.details && row.details.owner_ref === ownerRef)
    const expectEffects = (ownerRef: string, expected: readonly string[]): void => {
      const row = rowFor(ownerRef)
      expect(row?.reason_codes).not.toContain("UNKNOWN_EFFECT")
      expect(row?.details).toMatchObject({ effect_classes: expect.arrayContaining(expected) })
    }
    expectEffects("App\\Fixture\\DoctrineCommand", ["durable_write"])
    expectEffects("App\\Fixture\\EventCommand", ["outbound"])
    expectEffects("App\\Fixture\\FileCommand", ["filesystem"])
    expectEffects("App\\Fixture\\IdentityCommand", ["identity_or_authority"])
    expect(rowFor("App\\Fixture\\SmsValueCommand")).toMatchObject({
      details: { effect_classes: ["read_only"], target_refs: [] },
    })
  } finally {
    rmSync(legacyRoot, { recursive: true, force: true })
    rmSync(monoRoot, { recursive: true, force: true })
  }
})

test("schedule identities and credential slots are decoded before artifact identity", async () => {
  const legacyRoot = mkdtempSync("/tmp/parity-c2-field-decoder-legacy-")
  const monoRoot = mkdtempSync("/tmp/parity-c2-field-decoder-mono-")
  const scheduleSecret = "aB1cD2eF3gH4iJ5kL6mN7oP8qR9sT0uV"
  const hexScheduleSecret = "abcdef0123456789abcdef0123456789"
  const credentialSecret = "abcdef0123456789abcdef0123456789"
  try {
    put(monoRoot, "infra/timer.ts", `export class FixtureHandler {}\nexport const timer = schedule("${scheduleSecret}", "0 0 * * *", FixtureHandler)\nexport const hexTimer = schedule("${hexScheduleSecret}", "0 0 * * *", FixtureHandler)\n`)
    put(monoRoot, "apps/server/src/App/Infrastructure/Service/SlackClient.php", `<?php\nnamespace App\\Fixture;\nfinal class SlackClient { public function send(): void { secret("${credentialSecret}"); fetch("https://api.slack.com/v1/send"); } }\n`)
    put(monoRoot, "apps/server/config/services.yaml", "services:\n  App\\Fixture\\SlackClient:\n    class: App\\Fixture\\SlackClient\n")
    const context = await contextFor(legacyRoot, monoRoot)
    const c2 = collectC2(context, sha256("field-decoder-c2"))
    const serialized = canonicalJson(c2)
    expect(serialized).not.toContain(scheduleSecret)
    expect(serialized).not.toContain(credentialSecret)
    expect(serialized).not.toContain(hexScheduleSecret)
    expect(c2.schedules.rows.some((row) => row.reason_codes.includes("SCHEDULE_IDENTITY_UNRESOLVED"))).toBe(true)
    expect(c2.integrations.rows.some((row) => row.reason_codes.includes("CREDENTIAL_SLOT_UNRESOLVED"))).toBe(true)
  } finally {
    rmSync(legacyRoot, { recursive: true, force: true })
    rmSync(monoRoot, { recursive: true, force: true })
  }
})

test("loader authority requires exact roots and supports FQCN keys plus PSR-4 resources", async () => {
  const legacyRoot = mkdtempSync("/tmp/parity-c2-loader-schema-legacy-")
  const monoRoot = mkdtempSync("/tmp/parity-c2-loader-schema-mono-")
  try {
    put(monoRoot, "apps/server/src/App/Infrastructure/Command/Loaded/LoadedCommand.php", "<?php\nnamespace App\\Fixture;\nfinal class LoadedCommand { public function __invoke(): void { $this->repository->save(); } }\n")
    put(monoRoot, "apps/server/src/App/Infrastructure/Command/OrphanCommand.php", "<?php\nnamespace App\\Fixture;\nfinal class OrphanCommand { public function __invoke(): void { $this->repository->save(); } }\n")
    put(monoRoot, "apps/server/src/App/Infrastructure/Command/Loaded/ExcludedCommand.php", "<?php\nnamespace App\\Fixture;\nfinal class ExcludedCommand { public function __invoke(): void { $this->repository->save(); } }\n")
    put(monoRoot, "apps/server/config/services.yaml", "services:\n  App\\Fixture\\LoadedCommand:\n    arguments: []\n  App\\Fixture\\:\n    resource: ../src/App/Infrastructure/Command/Loaded/\n    exclude: ../src/App/Infrastructure/Command/Loaded/{ExcludedCommand.php,MissingCommand.php}\n")
    put(monoRoot, "apps/server/config/services-dead.yaml", "services:\n  orphan:\n    class: App\\Fixture\\OrphanCommand\n")
    const context = await contextFor(legacyRoot, monoRoot)
    const c2 = collectC2(context, sha256("loader-schema-c2"))
    const loaded = c2.commandWrites.rows.find((row) => "owner_ref" in row.details && row.details.owner_ref === "App\\Fixture\\LoadedCommand")
    const orphan = c2.commandWrites.rows.find((row) => "owner_ref" in row.details && row.details.owner_ref === "App\\Fixture\\OrphanCommand")
    const excluded = c2.commandWrites.rows.find((row) => "owner_ref" in row.details && row.details.owner_ref === "App\\Fixture\\ExcludedCommand")
    expect(loaded?.reason_codes).not.toContain("DEAD_UNIMPORTED_SOURCE")
    expect(orphan).toMatchObject({ status: "unresolved", reason_codes: expect.arrayContaining(["DEAD_UNIMPORTED_SOURCE", "UNKNOWN_EFFECT"]) })
    expect(excluded).toMatchObject({ status: "unresolved", reason_codes: expect.arrayContaining(["DEAD_UNIMPORTED_SOURCE", "UNKNOWN_EFFECT"]) })
  } finally {
    rmSync(legacyRoot, { recursive: true, force: true })
    rmSync(monoRoot, { recursive: true, force: true })
  }
})

test("YAML block scalar schedule documentation cannot create a validated cron", async () => {
  const legacyRoot = mkdtempSync("/tmp/parity-c2-yaml-schedule-legacy-")
  const monoRoot = mkdtempSync("/tmp/parity-c2-yaml-schedule-mono-")
  try {
    put(monoRoot, "infra/documentation.yaml", "metadata:\n  documentation: |\n    cron: '0 0 * * *'\n    handler: FakeHandler\n")
    const context = await contextFor(legacyRoot, monoRoot)
    const c2 = collectC2(context, sha256("yaml-schedule-c2"))
    const rows = c2.schedules.rows.filter((row) => row.source_ref_ids.some((ref) => context.sourcePathById.get(ref)?.path === "infra/documentation.yaml"))
    expect(rows.some((row) => row.status === "covered")).toBe(false)
    expect(c2.schedules.rows.some((row) => row.authority_line === "mono" && row.status === "absent")).toBe(true)
  } finally {
    rmSync(legacyRoot, { recursive: true, force: true })
    rmSync(monoRoot, { recursive: true, force: true })
  }
})

test("owner-null integration modules require positive loader reachability", async () => {
  const legacyRoot = mkdtempSync("/tmp/parity-c2-owner-null-legacy-")
  const monoRoot = mkdtempSync("/tmp/parity-c2-owner-null-mono-")
  try {
    put(monoRoot, "packages/decoy.ts", "export const send = () => fetch('https://api.slack.com/v1/send')\n")
    const context = await contextFor(legacyRoot, monoRoot)
    const c2 = collectC2(context, sha256("owner-null-c2"))
    const row = c2.integrations.rows.find((candidate) => candidate.source_ref_ids.some((ref) => context.sourcePathById.get(ref)?.path === "packages/decoy.ts"))
    expect(row).toMatchObject({
      status: "unresolved",
      reason_codes: ["UNKNOWN_INTEGRATION"],
      details: {
        provider_ref: null,
        protocol: "https",
        endpoint_ref: "https://api.slack.com/v1/send",
      },
    })
  } finally {
    rmSync(legacyRoot, { recursive: true, force: true })
    rmSync(monoRoot, { recursive: true, force: true })
  }
})
