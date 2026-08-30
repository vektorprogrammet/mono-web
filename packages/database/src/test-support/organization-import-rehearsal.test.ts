import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importLegacyOrganizationEffect } from "@vektorprogrammet/domain/organization";
import { canonicalJsonBytes, sha256Hex } from "@vektorprogrammet/domain/evidence";
import type { DatabaseShape } from "@vektorprogrammet/domain/database";
import { Effect, Layer } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import {
  EXPECTED_MIGRATION_23_AUTH_TABLES,
  EXPECTED_MIGRATION_23_PUBLIC_TABLES,
  boundedCookieCapabilityFailure,
  isNativeBrowserJourneyRequestAllowed,
  captureGeneratedOutputs,
  restoreGeneratedOutput,
  writeSanitizedOrganizationImportRehearsalArtifact,
} from "../../runtime/organization-import-rehearsal-main.js";
import { makeControlledTestRuntime } from "../../test/runtime.js";
import {
  SPEC_0067,
  decodeFrozenOrganizationSnapshot,
  decodeOrganizationImportRehearsalArtifact,
  expectedOrganizationImportOutcomeMatrix,
  frozenOrganizationSnapshotCore,
  frozenOrganizationSnapshotInput,
  makeOrganizationImportSqlObserverState,
  observeOrganizationImportSql,
  organizationImportOutcomeMatrix,
  organizationImportProvenanceEvidence,
  verifyOrganizationImportRehearsalArtifact,
} from "./organization-import-rehearsal.js";

const testRuntime = makeControlledTestRuntime(Layer.empty);
afterAll(() => testRuntime.dispose());

const decodeFixture = () =>
  testRuntime.runPromise(decodeFrozenOrganizationSnapshot(frozenOrganizationSnapshotInput));

const expectDeepFrozen = (value: unknown): void => {
  if (typeof value !== "object" || value === null) return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeepFrozen(child);
};

describe("spec 0067 generated-output ownership", () => {
  it("restores pre-existing bytes and removes runner-created output", async () => {
    const root = await mkdtemp(join(tmpdir(), "spec-0067-generated-output-"));
    const preexisting = join(root, "preexisting");
    const runnerCreated = join(root, "runner-created");
    const backup = join(root, "backup");
    try {
      await mkdir(preexisting);
      await writeFile(join(preexisting, "value.txt"), "before", "utf8");
      const snapshots = await captureGeneratedOutputs([preexisting, runnerCreated], backup);
      await writeFile(join(preexisting, "value.txt"), "after", "utf8");
      await mkdir(runnerCreated);
      await writeFile(join(runnerCreated, "generated.txt"), "generated", "utf8");

      const restorations = [];
      for (const snapshot of snapshots) {
        restorations.push(await restoreGeneratedOutput(snapshot));
      }

      await expect(readFile(join(preexisting, "value.txt"), "utf8")).resolves.toBe("before");
      await expect(readFile(join(runnerCreated, "generated.txt"), "utf8")).rejects.toBeDefined();
      expect(restorations.every(({ restored }) => restored)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails cleanup when a pre-existing output cannot be restored byte-for-byte", async () => {
    const root = await mkdtemp(join(tmpdir(), "spec-0067-generated-output-failure-"));
    const preexisting = join(root, "preexisting");
    const backup = join(root, "backup");
    try {
      await mkdir(preexisting);
      await writeFile(join(preexisting, "value.txt"), "before", "utf8");
      const [snapshot] = await captureGeneratedOutputs([preexisting], backup);
      if (snapshot === undefined) throw new Error("capture did not return its requested path");
      await writeFile(join(backup, "0", "value.txt"), "corrupted backup", "utf8");
      await expect(restoreGeneratedOutput(snapshot)).rejects.toThrow(
        "generated output restoration mismatch",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
describe("spec 0067 runtime capability contracts", () => {
  it("pins the complete migration-23 catalog and only classifies bounded-cookie preflight", () => {
    expect(EXPECTED_MIGRATION_23_AUTH_TABLES).toEqual([
      "auth.account",
      "auth.session",
      "auth.user",
      "auth.verification",
    ]);
    expect(EXPECTED_MIGRATION_23_PUBLIC_TABLES).toHaveLength(60);
    expect([...EXPECTED_MIGRATION_23_PUBLIC_TABLES].sort()).toEqual([
      ...EXPECTED_MIGRATION_23_PUBLIC_TABLES,
    ]);
    expect(isNativeBrowserJourneyRequestAllowed("GET", "/api/teams")).toBe(true);
    expect(isNativeBrowserJourneyRequestAllowed("POST", "/api/teams")).toBe(false);
    expect(isNativeBrowserJourneyRequestAllowed("GET", "/api/unexpected")).toBe(false);
    expect(
      boundedCookieCapabilityFailure({
        cookieName: SPEC_0067.sessionCookieName,
        cookieValue: "bounded-cookie",
        dashboardOrigin: "http://127.0.0.1:5187",
        apiOrigin: "http://127.0.0.1:3001",
        authorizationInstant: SPEC_0067.authorizationInstant,
        expiresAt: SPEC_0067.sessionExpiresAt,
      }),
    ).toBeUndefined();
    expect(
      boundedCookieCapabilityFailure({
        cookieName: SPEC_0067.sessionCookieName,
        cookieValue: "",
        dashboardOrigin: "http://127.0.0.1:5187",
        apiOrigin: "http://127.0.0.1:3001",
        authorizationInstant: SPEC_0067.authorizationInstant,
        expiresAt: SPEC_0067.sessionExpiresAt,
      }),
    ).toBe("bounded cookie value is empty");
  });
});

describe("spec 0067 frozen Organization import fixture", () => {
  it("decodes strictly, stays immutable, and has the frozen canonical hash", async () => {
    const snapshot = await decodeFixture();

    expectDeepFrozen(snapshot);
    expectDeepFrozen(frozenOrganizationSnapshotInput);
    expect(sha256Hex(canonicalJsonBytes(frozenOrganizationSnapshotCore))).toBe(
      SPEC_0067.snapshotHash,
    );
    expect(snapshot.snapshotId).toBe(SPEC_0067.snapshotId);
  });

  it("rejects excess fields and every hash-changing fixture mutation", async () => {
    const excess = {
      ...frozenOrganizationSnapshotInput,
      unauthorizedSource: true,
    };
    const changed = {
      ...frozenOrganizationSnapshotInput,
      departments: frozenOrganizationSnapshotInput.departments.map((row) =>
        row.id === 6701 ? { ...row, name: "Changed" } : row,
      ),
    };

    await expect(
      testRuntime.runPromise(Effect.flip(decodeFrozenOrganizationSnapshot(excess))),
    ).resolves.toMatchObject({ _tag: "FrozenOrganizationFixtureDecodeError" });
    await expect(
      testRuntime.runPromise(Effect.flip(decodeFrozenOrganizationSnapshot(changed))),
    ).resolves.toMatchObject({ _tag: "FrozenOrganizationFixtureDecodeError" });
  });

  it("uses the existing classifier to retain exact order, collision occurrences, and metadata", async () => {
    const snapshot = await decodeFixture();
    const result = await testRuntime.runPromise(importLegacyOrganizationEffect(snapshot));

    expect(organizationImportOutcomeMatrix(result)).toEqual(
      expectedOrganizationImportOutcomeMatrix,
    );
    expect(result).toMatchObject({
      departments: [{ departmentId: "6701" }],
      teams: [{ teamId: "6711", departmentId: "6701" }],
      memberships: [
        {
          membershipId: "6721",
          personId: "6731",
          teamId: "6711",
          positionId: "6741",
          isTeamLeader: true,
        },
      ],
    });
    expect(result.quarantined).toHaveLength(5);
    expect(result.ledger).toHaveLength(8);
    expect(result.ledger[4]?.sourceMetadata).toEqual({
      startSemesterId: 501,
      endSemesterId: null,
    });
    expect(
      organizationImportProvenanceEvidence(result)
        .filter((entry) => entry.sourcePrimaryKey === "6722")
        .map((entry) => [entry.sourceOccurrence, entry.targetSemanticIdentity]),
    ).toEqual([
      [0, "6732|6711|2037-01-01T00:00:00.000Z|6742"],
      [1, "6732|6711|2037-01-01T00:00:00.000Z|6743"],
    ]);
  });
});

describe("spec 0067 SQL observation seam", () => {
  it("records runtime write attempts and delegates the injected failure unchanged", async () => {
    const injected = {
      _tag: "SqlError",
      cause: { code: "P0001", message: SPEC_0067.failureMessage },
    } as const;
    let transactions = 0;
    const base = Object.assign(
      ((strings: TemplateStringsArray) =>
        strings.join("?").includes("organization_import_ledger")
          ? Effect.fail(injected)
          : Effect.succeed([])) as unknown as DatabaseShape,
      {
        unsafe: () => Effect.succeed([]),
        withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => {
          transactions += 1;
          return effect;
        },
      },
    );
    const state = makeOrganizationImportSqlObserverState();
    state.captureImportTrace = true;
    const observed = observeOrganizationImportSql(base, state);

    const failure = await testRuntime.runPromise(
      Effect.gen(function* () {
        return yield* observed.withTransaction(
          Effect.gen(function* () {
            yield* observed`INSERT INTO organization_departments (department_id) VALUES ('6701')`;
            yield* observed`INSERT INTO organization_teams (team_id) VALUES ('6711')`;
            yield* observed`INSERT INTO organization_memberships (membership_id) VALUES ('6721')`;
            for (let occurrence = 0; occurrence < 5; occurrence += 1) {
              yield* observed`INSERT INTO organization_membership_quarantine (source_occurrence) VALUES (${occurrence})`;
            }
            return yield* Effect.flip(
              observed`INSERT INTO organization_import_ledger (source_primary_key) VALUES ('6701')`,
            );
          }),
        );
      }),
    );

    expect(failure).toBe(injected);
    expect(transactions).toBe(1);
    expect(state.importTrace).toEqual([
      { phase: "DepartmentInsert" },
      { phase: "TeamInsert" },
      { phase: "MembershipInsert" },
      { phase: "QuarantineInsert" },
      { phase: "QuarantineInsert" },
      { phase: "QuarantineInsert" },
      { phase: "QuarantineInsert" },
      { phase: "QuarantineInsert" },
      { phase: "LedgerInsert" },
      { phase: "LedgerSqlError", sqlState: "P0001", message: SPEC_0067.failureMessage },
    ]);
  });

  it("returns unobserved SQL fragments unchanged so nested PostgreSQL syntax stays composable", () => {
    const fragment = Effect.succeed([]);
    const base = Object.assign((() => fragment) as unknown as DatabaseShape, {
      unsafe: () => fragment,
    });
    const observed = observeOrganizationImportSql(base, makeOrganizationImportSqlObserverState());

    expect(observed`FOR SHARE`).toBe(fragment);
  });

  it("counts forbidden DML before delegation without rewriting successful results", async () => {
    const rows = [{ delegated: true }] as const;
    const base = Object.assign((() => Effect.succeed(rows)) as unknown as DatabaseShape, {
      unsafe: () => Effect.succeed(rows),
    });
    const state = makeOrganizationImportSqlObserverState();
    const observed = observeOrganizationImportSql(base, state);

    const result = await testRuntime.runPromise(
      observed`/* leading audit comment */ INSERT INTO "public"."authz_rules" (rule_id) VALUES ('rule')`,
    );
    await testRuntime.runPromise(
      observed`WITH selected AS (SELECT 1) UPDATE "auth"."session" SET "updatedAt" = now()`,
    );
    await testRuntime.runPromise(observed`-- comment
      DELETE FROM "public"."economy_receipts"`);
    await testRuntime.runPromise(
      observed`/* comment */ INSERT INTO "public"."admission_period_outbox" (effect_id) VALUES ('e')`,
    );
    await testRuntime.runPromise(observed`WITH claimable AS (SELECT effect_id FROM "public"."admission_period_outbox")
      UPDATE "public"."admission_period_outbox" SET claimed_at = now()`);
    await testRuntime.runPromise(
      observed`SELECT pg_advisory_xact_lock(${`vektorprogrammet:person-authorization:v1:person-1`})`,
    );
    await testRuntime.runPromise(
      observed`SELECT effect_id FROM "public"."admission_period_outbox" FOR UPDATE SKIP LOCKED`,
    );

    expect(result).toBe(rows);
    expect(state).toMatchObject({
      ruleDmlAttempts: 1,
      authDmlAttempts: 1,
      receiptDmlAttempts: 1,
      outboxDmlAttempts: 2,
      outboxClaimAttempts: 2,
      personAuthorizationLockAttempts: 1,
    });
  });
});
describe("spec 0067 artifact boundary", () => {
  const unavailable = { status: "NotObservedDueToFailure" } as const;
  const artifactCore = {
    contract: {
      revision: "0067.0",
      frozenCodeBaseHead: "f".repeat(40),
      implementationBaseHead: "i".repeat(40),
      runtimeHead: "r".repeat(40),
      frozenBaseMergeBase: "f".repeat(40),
      implementationBaseMergeBase: "i".repeat(40),
      actualBaseVerified: false,
    },
    source: {
      sourceRepository: "synthetic://source",
      sourceRevision: "revision",
      snapshotId: "snapshot",
      snapshotHash: "s".repeat(64),
      transformationRevision: "transformation",
      authorizationInstant: "2037-01-15T12:00:00.000Z",
      sessionCookieSha256: "c".repeat(64),
    },
    database: unavailable,
    inventory: unavailable,
    prerequisites: unavailable,
    classifier: unavailable,
    rollback: unavailable,
    commitAndReplay: unavailable,
    http: unavailable,
    personAuthority: unavailable,
    browser: unavailable,
    forbiddenEffects: unavailable,
    cleanup: {
      status: "Observed",
      processExitStatuses: [],
      portRelease: { backend: true, proxy: true, dashboard: true },
      databaseDisposal: { databaseAbsent: true, residualConnections: 0 },
      failureObjectsRemovedBeforeCommit: "NotObservedDueToFailure",
      cookieCleared: true,
      processSecretCleared: true,
      databaseUrlCleared: true,
      unsanitizedBrowserArtifactRemoved: true,
      residualGeneratedPaths: [],
      generatedOutputRestoration: [],
      runnerTempRootRemoved: true,
      lifecycle: {
        databaseDisposalCompleted: true,
        cleanupFinalizationCompleted: true,
        artifactValidationRequiresCleanupFinalization: true,
        evidenceWriteRequiresArtifactValidation: true,
      },
      errors: [],
    },
    observations: {
      status: "Failed",
      failedStage: "preflight",
      message: "injected failure",
    },
    evidenceClassification: {
      class: "local runtime observation over synthetic data",
      productionReadinessClaim: false,
      proofClaim: false,
      status: "Failed",
      failedChecks: [{ stage: "preflight", message: "injected failure" }],
    },
  } as const;
  const artifact = {
    ...artifactCore,
    evidenceSha256: sha256Hex(canonicalJsonBytes(artifactCore)),
  } as const;

  it("accepts only the canonical top-level artifact fields", async () => {
    await expect(
      testRuntime.runPromise(decodeOrganizationImportRehearsalArtifact(artifact)),
    ).resolves.toEqual(artifact);
    await expect(
      testRuntime.runPromise(
        Effect.flip(
          decodeOrganizationImportRehearsalArtifact({ ...artifact, rawSessionCookie: "forbidden" }),
        ),
      ),
    ).resolves.toBeDefined();
    await expect(
      testRuntime.runPromise(
        Effect.flip(
          decodeOrganizationImportRehearsalArtifact({
            ...artifact,
            cleanup: { ...artifact.cleanup, undeclaredLifecycleClaim: true },
          }),
        ),
      ),
    ).resolves.toBeDefined();
    const { runnerTempRootRemoved: _omitted, ...incompleteCleanup } = artifact.cleanup;
    await expect(
      testRuntime.runPromise(
        Effect.flip(
          decodeOrganizationImportRehearsalArtifact({
            ...artifact,
            cleanup: incompleteCleanup,
          }),
        ),
      ),
    ).resolves.toBeDefined();
  });

  it("verifies the stored digest and rejects a mismatch", async () => {
    await expect(
      testRuntime.runPromise(verifyOrganizationImportRehearsalArtifact(artifact)),
    ).resolves.toEqual(artifact);
    await expect(
      testRuntime.runPromise(
        Effect.flip(
          verifyOrganizationImportRehearsalArtifact({
            ...artifact,
            evidenceSha256: "0".repeat(64),
          }),
        ),
      ),
    ).resolves.toMatchObject({
      _tag: "OrganizationImportRehearsalEvidenceDigestMismatch",
    });
  });

  it("persists a sanitized failed artifact even when database cleanup fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "spec-0067-failed-evidence-"));
    const evidencePath = join(root, "failed.json");
    const failedCleanupCore = {
      ...artifactCore,
      cleanup: {
        ...artifactCore.cleanup,
        status: "Failed",
        databaseDisposal: { databaseAbsent: false, residualConnections: -1 },
        lifecycle: {
          ...artifactCore.cleanup.lifecycle,
          databaseDisposalCompleted: false,
        },
        errors: ["injected database cleanup failure"],
      },
    } as const;
    try {
      const { evidenceSha256 } = await writeSanitizedOrganizationImportRehearsalArtifact({
        artifactCore: failedCleanupCore,
        evidencePath,
        sensitiveValues: ["not-present-secret"],
      });
      const persisted: unknown = JSON.parse(await readFile(evidencePath, "utf8"));
      await expect(
        testRuntime.runPromise(verifyOrganizationImportRehearsalArtifact(persisted)),
      ).resolves.toMatchObject({
        cleanup: {
          status: "Failed",
          databaseDisposal: { databaseAbsent: false, residualConnections: -1 },
        },
        evidenceSha256,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
