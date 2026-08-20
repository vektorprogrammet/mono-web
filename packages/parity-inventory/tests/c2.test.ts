import { Effect } from "effect"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { applyAcceptedAbsent, collectC2 } from "../src/effects.js"
import { collectRoutes } from "../src/routes.js"
import { acceptedIntentRevisionRefId } from "../src/coverage.js"
import { canonicalJson, sha256 } from "../src/canonical.js"
import { SOURCE_FAMILIES } from "../src/source-manifest.js"
import { COMMITTED_PROJECTIONS, PROJECTION_DIRECTORY, run, runTrustedFixtureTerminalCycle } from "../src/runner.js"
import { scanRootEffect } from "../src/runtime.js"
import { validateInventory } from "../src/schema.js"
import { createManifestContextFromSnapshots } from "../src/source-manifest.js"
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
  try {
    return await Effect.runPromise(run({ root, legacyRoot, intentRegisterPath: path, mode }))
  } finally {
    rmSync(authority, { recursive: true, force: true })
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
    expect(row).toMatchObject({ status: "extra", reason_codes: ["EXTRA_COUNTERPART"] })
    expect(row?.reason_codes).not.toContain("DEAD_UNIMPORTED_SOURCE")
    expect(
      row?.source_ref_ids.map((ref) => context.sourcePathById.get(ref)?.path).sort(),
    ).toEqual([
      "apps/server/config/routes.yaml",
      "apps/server/src/App/Controller/WriteController.php",
    ])
    expect(legacyRow).toMatchObject({ status: "missing", reason_codes: ["MISSING_COUNTERPART"] })
    expect(legacyRow?.reason_codes).not.toContain("DEAD_UNIMPORTED_SOURCE")
    expect(
      legacyRow?.source_ref_ids.map((ref) => context.sourcePathById.get(ref)?.path).sort(),
    ).toEqual([
      "app/config/routing.yml",
      "src/AppBundle/Controller/WriteController.php",
    ])
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
    "apps/server/src/App/**/Infrastructure/Service/**/*.php",
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
    expect(previewRows[0]?.details).toMatchObject({
      call_site_ref: "packages/preview.ts#handle",
      provider_ref: "packages/preview.ts#handle",
      protocol: "http",
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
    put(monoRoot, "apps/server/src/App/Infrastructure/Command/IdentityCommand.php", "<?php\nnamespace App\\Fixture;\nfinal class IdentityCommand { public function __invoke($member, $user): void { $member->setUser($user); } }\n")
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
      status: "dead_unimported",
      reason_codes: ["DEAD_UNIMPORTED_SOURCE"],
      details: {
        provider_ref: "packages/decoy.ts#fetch",
        protocol: "https",
        endpoint_ref: "https://api.slack.com/v1/send",
      },
    })
  } finally {
    rmSync(legacyRoot, { recursive: true, force: true })
    rmSync(monoRoot, { recursive: true, force: true })
  }
})
