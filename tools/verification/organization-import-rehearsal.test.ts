import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importLegacyOrganizationEffect } from "@vektorprogrammet/domain/organization";
import { canonicalJsonBytes, sha256Hex } from "@vektorprogrammet/domain/evidence";
import { Database } from "@vektorprogrammet/database";
import { DatabaseTest } from "@vektorprogrammet/database/live";
import { Schema, Predicate, Effect, Layer } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import {
  boundedCookieCapabilityFailure,
  classifyExistingPageSessionCapability,
  isNativeBrowserJourneyRequestAllowed,
  isExpectedNativeBrowserJourneyObservation,
  captureGeneratedOutputs,
  clearCapturedGeneratedOutputs,
  restoreGeneratedOutput,
  writeSanitizedOrganizationImportRehearsalArtifact,
} from "./organization-import-rehearsal-main.js";
import { makeControlledTestRuntime } from "../../packages/database/test/runtime.js";
import {
  NATIVE_BROWSER_JOURNEY_REQUIREMENTS,
  SPEC_0067,
  decodeFrozenOrganizationSnapshot,
  decodeOrganizationImportRehearsalArtifact,
  decodeOrganizationImportBrowserFailedEvidence,
  expectedOrganizationImportOutcomeMatrix,
  frozenOrganizationSnapshotCore,
  frozenOrganizationSnapshotInput,
  initOrganizationImportSqlObserverState,
  observeOrganizationImportSql,
  organizationImportOutcomeMatrix,
  organizationImportProvenanceEvidence,
  verifyOrganizationImportRehearsalArtifact,
} from "./organization-import-rehearsal.js";

const testRuntime = makeControlledTestRuntime(Layer.empty);

afterAll(() => testRuntime.dispose());

const decodeFixture = () =>
  testRuntime.runPromise(decodeFrozenOrganizationSnapshot(frozenOrganizationSnapshotInput));

const expectDeepFrozen = <A>(value: A): void => {
  if (!Predicate.isObjectOrArray(value)) return;
  expect(Object.isFrozen(value)).toBe(true);

  for (const child of Object.values(value)) expectDeepFrozen(child);
};

describe("spec 0067 generated-output ownership", () => {
  it("clears captured output before generation, then restores pre-existing bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "spec-0067-generated-output-"));
    const preexisting = join(root, "preexisting");
    const runnerCreated = join(root, "runner-created");
    const backup = join(root, "backup");

    try {
      await mkdir(preexisting);
      await writeFile(join(preexisting, "value.txt"), "before", "utf8");
      const snapshots = await captureGeneratedOutputs([preexisting, runnerCreated], backup);
      await clearCapturedGeneratedOutputs(snapshots);
      await expect(readFile(join(preexisting, "value.txt"), "utf8")).rejects.toBeDefined();
      await expect(readFile(join(runnerCreated, "generated.txt"), "utf8")).rejects.toBeDefined();
      await mkdir(preexisting);
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
  it("requires the bounded session and correct request source for browser evidence", () => {
    expect(
      isExpectedNativeBrowserJourneyObservation({
        method: "GET",
        path: "/api/departments",
        status: 200,
        sessionCookieAuth: true,
        requestSource: "BrowserSameOrigin",
      }),
    ).toBe(true);
    expect(
      isExpectedNativeBrowserJourneyObservation({
        method: "GET",
        path: "/api/teams",
        status: 200,
        sessionCookieAuth: false,
        requestSource: "BrowserSameOrigin",
      }),
    ).toBe(false);
    expect(
      isExpectedNativeBrowserJourneyObservation({
        method: "GET",
        path: "/api/session",
        status: 200,
        sessionCookieAuth: true,
        requestSource: "DashboardSsr",
      }),
    ).toBe(true);
    expect(
      isExpectedNativeBrowserJourneyObservation({
        method: "GET",
        path: "/api/profile",
        status: 200,
        sessionCookieAuth: true,
        requestSource: "DashboardSsr",
      }),
    ).toBe(true);
    expect(
      isExpectedNativeBrowserJourneyObservation({
        method: "GET",
        path: "/api/people",
        status: 200,
        sessionCookieAuth: false,
        requestSource: "DashboardSsr",
      }),
    ).toBe(false);
    expect(
      isExpectedNativeBrowserJourneyObservation({
        method: "GET",
        path: "/api/departments",
        status: 200,
        sessionCookieAuth: false,
        requestSource: "DashboardSsr",
      }),
    ).toBe(false);
    expect(
      isExpectedNativeBrowserJourneyObservation({
        method: "GET",
        path: "/api/people",
        status: 200,
        sessionCookieAuth: true,
        requestSource: "BrowserSameOrigin",
      }),
    ).toBe(false);
    expect(
      isExpectedNativeBrowserJourneyObservation({
        method: "GET",
        path: "/api/profile",
        status: 200,
        sessionCookieAuth: false,
        requestSource: "BrowserSameOrigin",
      }),
    ).toBe(false);
    expect(isNativeBrowserJourneyRequestAllowed("GET", "/api/teams")).toBe(true);
    expect(isNativeBrowserJourneyRequestAllowed("GET", "/api/profile")).toBe(true);
    expect(isNativeBrowserJourneyRequestAllowed("POST", "/api/profile")).toBe(false);
    expect(isNativeBrowserJourneyRequestAllowed("GET", "/api/profile/extra")).toBe(false);
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

  it("classifies only observed existing-page session incompatibility as not practical", () => {
    expect(
      classifyExistingPageSessionCapability([
        { path: "/dashboard/team", status: 200, location: null },
        { path: "/dashboard/brukere", status: 200, location: null },
      ]),
    ).toHaveProperty("_tag", "Practical");
    {
      const result = classifyExistingPageSessionCapability([
        { path: "/dashboard/team", status: 302, location: "/login?expired=true" },
      ]);

      expect(result).toHaveProperty("_tag", "BrowserNotPractical");
      expect(result).toHaveProperty("capability", "ExistingPageBoundedSession");
    }

    {
      const result = classifyExistingPageSessionCapability([
        { path: "/dashboard/brukere", status: 401, location: null },
      ]);

      expect(result).toHaveProperty("_tag", "BrowserNotPractical");
      expect(result).toHaveProperty("capability", "ExistingPageBoundedSession");
    }

    expect(
      classifyExistingPageSessionCapability([
        { path: "/dashboard/team", status: 500, location: null },
      ]),
    ).toHaveProperty("_tag", "EnvironmentFailure");
    expect(
      classifyExistingPageSessionCapability([
        { path: "/dashboard/team", status: 302, location: "/maintenance" },
      ]),
    ).toHaveProperty("_tag", "EnvironmentFailure");
    expect(
      classifyExistingPageSessionCapability([
        { path: "/dashboard/team", status: 204, location: null },
      ]),
    ).toHaveProperty("_tag", "EnvironmentFailure");
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

    {
      const actual = testRuntime.runPromise(Effect.flip(decodeFrozenOrganizationSnapshot(excess)));
      await expect(actual).resolves.toHaveProperty("_tag", "FrozenOrganizationFixtureDecodeError");
    }

    {
      const actual = testRuntime.runPromise(Effect.flip(decodeFrozenOrganizationSnapshot(changed)));
      await expect(actual).resolves.toHaveProperty("_tag", "FrozenOrganizationFixtureDecodeError");
    }
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
  const databaseRuntime = makeControlledTestRuntime(DatabaseTest());

  afterAll(() => databaseRuntime.dispose());

  it("records runtime writes and SQL failure while rolling the transaction back", async () => {
    const state = initOrganizationImportSqlObserverState();
    state.captureImportTrace = true;

    const evidence = await databaseRuntime.runPromise(
      Effect.gen(function* () {
        const sql = yield* Database;

        for (const statement of [
          "CREATE TEMP TABLE organization_departments (department_id text)",
          "CREATE TEMP TABLE organization_teams (team_id text)",
          "CREATE TEMP TABLE organization_memberships (membership_id text)",
          "CREATE TEMP TABLE organization_membership_quarantine (source_occurrence integer)",
          "CREATE TEMP TABLE organization_import_ledger (source_primary_key text)",
          `CREATE FUNCTION pg_temp.reject_observed_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '${SPEC_0067.failureMessage}'; END $$`,
          `CREATE TRIGGER reject_observed_ledger BEFORE INSERT ON organization_import_ledger
            FOR EACH STATEMENT EXECUTE FUNCTION pg_temp.reject_observed_ledger()`,
        ])
          yield* sql.unsafe(statement);
        const observed = observeOrganizationImportSql(sql, state);

        const outcome = yield* Effect.result(
          observed.withTransaction(
            Effect.gen(function* () {
              yield* observed`INSERT INTO organization_departments (department_id) VALUES ('6701')`;
              yield* observed`INSERT INTO organization_teams (team_id) VALUES ('6711')`;
              yield* observed`INSERT INTO organization_memberships (membership_id) VALUES ('6721')`;

              for (let occurrence = 0; occurrence < 5; occurrence += 1) {
                yield* observed`INSERT INTO organization_membership_quarantine (source_occurrence) VALUES (${occurrence})`;
              }

              yield* observed`INSERT INTO organization_import_ledger (source_primary_key) VALUES ('6701')`;
            }),
          ),
        );

        const counts = yield* sql<{
          departments: number;
          teams: number;
          memberships: number;
          quarantine: number;
        }>`
        SELECT (SELECT count(*)::int FROM organization_departments) AS departments,
          (SELECT count(*)::int FROM organization_teams) AS teams,
          (SELECT count(*)::int FROM organization_memberships) AS memberships,
          (SELECT count(*)::int FROM organization_membership_quarantine) AS quarantine`;

        return { outcome, counts };
      }),
    );

    expect(evidence.outcome).toHaveProperty("_tag", "Failure");
    expect(evidence.outcome).toHaveProperty("failure._tag", "SqlError");
    expect(evidence.counts).toEqual([{ departments: 0, teams: 0, memberships: 0, quarantine: 0 }]);
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

  it("keeps nested PostgreSQL fragments composable", async () => {
    const rows = await databaseRuntime.runPromise(
      Database.use((sql) => {
        const observed = observeOrganizationImportSql(
          sql,
          initOrganizationImportSqlObserverState(),
        );

        return observed<{
          value: number;
        }>`SELECT value FROM (VALUES (1), (2)) AS selected(value) ${observed`WHERE value = ${2}`}`;
      }),
    );

    expect(rows).toEqual([{ value: 2 }]);
  });

  it("counts forbidden DML and locking attempts sent to PostgreSQL", async () => {
    const state = initOrganizationImportSqlObserverState();
    await databaseRuntime.runPromise(
      Database.use((sql) =>
        Effect.gen(function* () {
          const observed = observeOrganizationImportSql(sql, state);
          yield* observed`/* leading audit comment */ INSERT INTO "public"."authz_rules" (rule_id) SELECT 'rule' WHERE false`;
          yield* observed`WITH selected AS (SELECT 1) UPDATE "auth"."session" SET "updatedAt" = now() WHERE false`;
          yield* observed`-- comment
        DELETE FROM "public"."economy_receipts" WHERE false`;
          yield* observed`/* comment */ INSERT INTO "public"."admission_period_outbox" (effect_id) SELECT 'e' WHERE false`;
          yield* observed`WITH claimable AS (SELECT effect_id FROM "public"."admission_period_outbox")
        UPDATE "public"."admission_period_outbox" SET claimed_at = now() WHERE false`;
          yield* observed`SELECT pg_advisory_xact_lock(hashtextextended(${"vektorprogrammet:person-authorization:v1:person-1"}, 0))`;
          yield* observed`SELECT effect_id FROM "public"."admission_period_outbox" FOR UPDATE SKIP LOCKED`;
          yield* observed`SELECT effect_id, claim_id, claimed_at FROM "public"."admission_period_outbox" ORDER BY effect_id`;
        }),
      ),
    );

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

  const dashboardRuntime = {
    build: "ReactRouterProductionBuild",
    server: "BunDashboardServer",
    viteDependencyOptimizer: "NotUsed",
  } as const;

  const failedBrowserEvidence = {
    status: "Failed",
    failure: "Expected the imported team heading to be visible",
    pageErrors: ["Dashboard client entry did not evaluate"],
    consoleMessages: [
      {
        type: "error",
        text: "Failed to load resource: the server responded with a status of 504",
      },
    ],
    rejectedDestinations: [],
    unexpectedApiRequests: [],
    requests: [
      {
        method: "GET",
        origin: "dashboard-loopback",
        path: "/node_modules/.vite/deps/effect.js",
        resourceType: "script",
      },
    ],
    failedResponses: [
      {
        origin: "dashboard-loopback",
        path: "/node_modules/.vite/deps/effect.js",
        status: 504,
      },
    ],
    finalPageState: {
      path: "/dashboard/team",
      customElementDefined: false,
      host: { connected: true, childCount: 0 },
      container: { connected: false, childCount: 0 },
      headings: [],
      alerts: ["No catalog rows"],
    },
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
  it("strictly decodes and digests bounded failed browser evidence", async () => {
    await expect(
      testRuntime.runPromise(decodeOrganizationImportBrowserFailedEvidence(failedBrowserEvidence)),
    ).resolves.toEqual(failedBrowserEvidence);
    await expect(
      testRuntime.runPromise(
        Effect.flip(
          decodeOrganizationImportBrowserFailedEvidence({
            ...failedBrowserEvidence,
            failedResponses: Array.from({ length: 129 }, (_, index) => ({
              origin: "dashboard-loopback",
              path: `/assets/failed-${index}.js`,
              status: 500,
            })),
          }),
        ),
      ),
    ).resolves.toBeDefined();

    const failedBrowserCore = {
      ...artifactCore,
      browser: {
        status: "Failed",
        dashboardRuntime,
        evidence: failedBrowserEvidence,
      },
    } as const;

    const failedBrowserArtifact = {
      ...failedBrowserCore,
      evidenceSha256: sha256Hex(canonicalJsonBytes(failedBrowserCore)),
    };

    await expect(
      testRuntime.runPromise(verifyOrganizationImportRehearsalArtifact(failedBrowserArtifact)),
    ).resolves.toEqual(failedBrowserArtifact);
  });

  it("rejects undeclared request, cookie, and raw-contact diagnostic fields", async () => {
    await expect(
      testRuntime.runPromise(
        Effect.flip(
          decodeOrganizationImportBrowserFailedEvidence({
            ...failedBrowserEvidence,
            sessionCookie: "forbidden",
          }),
        ),
      ),
    ).resolves.toBeDefined();
    await expect(
      testRuntime.runPromise(
        Effect.flip(
          decodeOrganizationImportBrowserFailedEvidence({
            ...failedBrowserEvidence,
            requests: [
              {
                method: "GET",
                origin: "dashboard-loopback",
                path: "/node_modules/.vite/deps/effect.js",
                resourceType: "script",
                requestHeaders: { cookie: "forbidden" },
              },
            ],
          }),
        ),
      ),
    ).resolves.toBeDefined();

    const rawContactCore = {
      ...artifactCore,
      browser: {
        status: "Failed",
        dashboardRuntime,
        evidence: {
          ...failedBrowserEvidence,
          rawContactBody: { email: "forbidden" },
        },
      },
    } as const;

    await expect(
      testRuntime.runPromise(
        Effect.flip(
          verifyOrganizationImportRehearsalArtifact({
            ...rawContactCore,
            evidenceSha256: sha256Hex(canonicalJsonBytes(rawContactCore)),
          }),
        ),
      ),
    ).resolves.toBeDefined();
  });

  it("verifies the stored digest and rejects a mismatch", async () => {
    await expect(
      testRuntime.runPromise(verifyOrganizationImportRehearsalArtifact(artifact)),
    ).resolves.toEqual(artifact);
    {
      const actual = testRuntime.runPromise(
        Effect.flip(
          verifyOrganizationImportRehearsalArtifact({
            ...artifact,
            evidenceSha256: "0".repeat(64),
          }),
        ),
      );

      await expect(actual).resolves.toHaveProperty(
        "_tag",
        "OrganizationImportRehearsalEvidenceDigestMismatch",
      );
    }
  });

  it("accepts exact bounded existing-page session practicality evidence", async () => {
    const browserNotPracticalCore = {
      ...artifactCore,
      browser: {
        status: "BrowserNotPractical",
        dashboardRuntime,
        capability: "ExistingPageBoundedSession",
        reason:
          "existing page/session gate cannot consume the bounded cookie: /dashboard/team redirected to /login; proceeding would require credentials, an auth write, a product change, or a legacy service",
        pageSessionPreflight: [{ path: "/dashboard/team", status: 302, location: "/login" }],
        backendProxyRequests: [
          {
            method: "GET",
            path: "/api/session",
            status: 200,
            sessionCookieAuth: true,
            requestSource: "DashboardSsr",
          },
        ],
      },
    } as const;

    const browserNotPracticalArtifact = {
      ...browserNotPracticalCore,
      evidenceSha256: sha256Hex(canonicalJsonBytes(browserNotPracticalCore)),
    };

    await expect(
      testRuntime.runPromise(
        verifyOrganizationImportRehearsalArtifact(browserNotPracticalArtifact),
      ),
    ).resolves.toEqual(browserNotPracticalArtifact);
  });

  it("enforces exact production evidence and native authority paths", async () => {
    const nativePathObservations = NATIVE_BROWSER_JOURNEY_REQUIREMENTS.map((requirement) => ({
      ...requirement,
      status: 200,
      sessionCookieAuth: true,
    }));

    const backendProxyRequests = nativePathObservations.map(
      ({ path, status, sessionCookieAuth, requestSource }) => ({
        method: "GET",
        path,
        status,
        sessionCookieAuth,
        requestSource,
      }),
    );

    const observedBrowserCore = {
      ...artifactCore,
      browser: {
        status: "Observed",
        dashboardRuntime,
        practicality: "Existing pages accepted the bounded session without credential changes",
        pageSessionPreflight: [
          { path: "/dashboard/team", status: 200, location: null },
          { path: "/dashboard/brukere", status: 200, location: null },
        ],
        preflightBackendProxyRequests: [
          {
            method: "GET",
            path: "/api/session",
            status: 200,
            sessionCookieAuth: true,
            requestSource: "DashboardSsr",
          },
        ],
        evidence: {
          authorizationInstant: SPEC_0067.authorizationInstant,
          pages: [],
          pageErrors: [],
          legacyOrganizationRequests: 0,
          rejectedDestinations: [],
          unexpectedApiRequests: [],
          requests: [],
          failedResponses: [],
          viteDependencyRequests: 0,
          dependencyOptimizerFailures: 0,
          status: "Observed",
        },
        nativePathObservations,
        backendProxyRequests,
      },
    } as const;

    const observedBrowserArtifact = {
      ...observedBrowserCore,
      evidenceSha256: sha256Hex(canonicalJsonBytes(observedBrowserCore)),
    };

    await expect(
      testRuntime.runPromise(verifyOrganizationImportRehearsalArtifact(observedBrowserArtifact)),
    ).resolves.toEqual(observedBrowserArtifact);

    const expectRejectedBrowserArtifact = async (browser: Schema.Json): Promise<void> => {
      const rejectedCore = { ...artifactCore, browser };
      await expect(
        testRuntime.runPromise(
          Effect.flip(
            verifyOrganizationImportRehearsalArtifact({
              ...rejectedCore,
              evidenceSha256: sha256Hex(canonicalJsonBytes(rejectedCore)),
            }),
          ),
        ),
      ).resolves.toBeDefined();
    };

    await expectRejectedBrowserArtifact({
      ...observedBrowserCore.browser,
      dashboardRuntime: {
        build: "ViteDevelopmentServer",
        server: "ViteDevelopmentServer",
        viteDependencyOptimizer: "Used",
      },
    });
    await expectRejectedBrowserArtifact({
      ...observedBrowserCore.browser,
      evidence: {
        ...observedBrowserCore.browser.evidence,
        viteDependencyRequests: 1,
      },
    });
    await expectRejectedBrowserArtifact({
      ...observedBrowserCore.browser,
      evidence: {
        ...observedBrowserCore.browser.evidence,
        dependencyOptimizerFailures: 1,
      },
    });
    await expectRejectedBrowserArtifact({
      ...observedBrowserCore.browser,
      evidence: {
        ...observedBrowserCore.browser.evidence,
        dependencyOptimizerCacheEvidence: [],
      },
    });
    await expectRejectedBrowserArtifact({
      ...observedBrowserCore.browser,
      evidence: {
        ...observedBrowserCore.browser.evidence,
        viteCachePath: "apps/dashboard/node_modules/.vite",
      },
    });
    await expectRejectedBrowserArtifact({
      ...observedBrowserCore.browser,
      evidence: {
        ...observedBrowserCore.browser.evidence,
        failedResponses: [
          {
            origin: "dashboard-loopback",
            path: "/assets/failed.js",
            status: 500,
          },
        ],
      },
    });

    const incompleteBrowserCore = {
      ...observedBrowserCore,
      browser: {
        ...observedBrowserCore.browser,
        nativePathObservations: nativePathObservations.filter(
          ({ path }) => path !== "/api/profile",
        ),
      },
    } as const;

    const incompleteBrowserArtifact = {
      ...incompleteBrowserCore,
      evidenceSha256: sha256Hex(canonicalJsonBytes(incompleteBrowserCore)),
    };

    await expect(
      testRuntime.runPromise(
        Effect.flip(verifyOrganizationImportRehearsalArtifact(incompleteBrowserArtifact)),
      ),
    ).resolves.toBeDefined();

    const misclassifiedBrowserCore = {
      ...observedBrowserCore,
      browser: {
        ...observedBrowserCore.browser,
        nativePathObservations: nativePathObservations.map((observation) =>
          observation.path === "/api/profile"
            ? {
                ...observation,
                access: "Public" as const,
                sessionCookieAuth: false,
                requestSource: "BrowserSameOrigin" as const,
              }
            : observation,
        ),
      },
    } as const;

    const misclassifiedBrowserArtifact = {
      ...misclassifiedBrowserCore,
      evidenceSha256: sha256Hex(canonicalJsonBytes(misclassifiedBrowserCore)),
    };

    await expect(
      testRuntime.runPromise(
        Effect.flip(verifyOrganizationImportRehearsalArtifact(misclassifiedBrowserArtifact)),
      ),
    ).resolves.toBeDefined();
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

  it("refuses known raw contacts inside schema-valid failure diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "spec-0067-contact-leak-"));
    const rawContacts = ["imported-member.0067@example.invalid", "+4700006731"] as const;

    try {
      for (const [index, rawContact] of rawContacts.entries()) {
        const evidencePath = join(root, `failed-${index}.json`);

        const leakedContactCore = {
          ...artifactCore,
          browser: {
            status: "Failed",
            dashboardRuntime,
            evidence: {
              ...failedBrowserEvidence,
              failure: `Expected ${rawContact} to be visible`,
            },
          },
        } as const;

        await expect(
          writeSanitizedOrganizationImportRehearsalArtifact({
            artifactCore: leakedContactCore,
            evidencePath,
            sensitiveValues: rawContacts,
          }),
        ).rejects.toThrow("sanitized evidence contained a secret value");
        await expect(readFile(evidencePath, "utf8")).rejects.toBeDefined();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
