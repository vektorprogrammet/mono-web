/**
 * EX-0028: required public native APIs in exact stable Effect 4 retain upstream unstable annotations.
 * @effect-diagnostics unstableApiUsage:off
 */
import { selectLegacyTargetTransport } from "./legacy-database-transport";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import process from "node:process";
import * as BunServices from "@effect/platform-bun/BunServices";
import { canonicalJsonBytes, sha256Hex } from "@vektorprogrammet/domain/shared-kernel";
import {
  importPersonCohort,
  type PersonCohortReport,
  type PersonCohortSnapshot,
} from "@vektorprogrammet/database/person-cohort";
import {
  decodeHistoricalServiceSnapshot,
  historicalServiceSourceRowDigest,
  importHistoricalServiceCohort,
  type HistoricalServiceReport,
} from "@vektorprogrammet/database/historical-service-cohort";
import {
  decodeIdentityCohort,
  importIdentityCohort,
  type CohortReport as IdentityCohortReport,
} from "@vektorprogrammet/database/identity-cohort";
import { readPrivateCohortJson } from "@vektorprogrammet/database/cohort-cli";
import { CurrentAssignmentReview } from "@vektorprogrammet/domain/placements";
import {
  currentAssignmentImportSourceDigest,
  CurrentAssignmentFailure,
  importReconciledCurrentAssignmentCohort,
  type CurrentAssignmentReport,
} from "@vektorprogrammet/database/placements";
import {
  OrganizationCohortFailure,
  OrganizationReview,
} from "@vektorprogrammet/domain/organization";
import {
  importReviewedOrganizationCohort,
  organizationImportSourceDigest,
} from "@vektorprogrammet/database/organization";
import { withTypedTransactionFailures } from "@vektorprogrammet/database";
import { nativePgLayer } from "@vektorprogrammet/database/pg-pool";
import { NativeDatabaseStartupOptions } from "@vektorprogrammet/database/search-path";
import { SqlClient } from "effect/sql";
import { Console, Effect, flow, Redacted, Result, Schema } from "effect";
import {
  buildLegacyReferences,
  departmentId,
  schoolId,
  seedLegacyReferences,
  semesterId,
} from "./legacy-cutover-references";
import { buildLegacyPersonSnapshot } from "./legacy-person-snapshot";
import { buildLegacyCurrentAssignmentSnapshot } from "./legacy-current-assignment-snapshot";
import {
  buildLegacyOrganizationSnapshot,
  reviewLegacyOrganizationSource,
} from "./legacy-organization-snapshot";
import { readLegacySourceSnapshot, type LegacySourceSnapshot } from "./legacy-source-snapshot";

const repository = "vektorprogrammet/vektorprogrammet";

const digest = flow(canonicalJsonBytes, sha256Hex);

const id = (value: number | string): string => String(value);

const sourceUserId = (value: number | string): string => `legacy-user:${id(value)}`;

const sourceSchoolId = (value: number | string): string => `legacy-school:${id(value)}`;

const sourceHistoryId = (value: number | string): string => `legacy-history:${id(value)}`;

export interface CutoverOptions {
  readonly sourceUrl: string;
  readonly targetUrl: string;
  readonly targetDatabase: string;
  readonly snapshotId: string;
  readonly attestedBy: string;
  readonly passwordlessPolicy: "ProvisionRecovery";
  readonly currentAssignments: "NotRequested" | CurrentAssignmentReview;
  readonly organization: "NotRequested" | OrganizationReview;
}

const CutoverStage = Schema.Literals([
  "SourceRead",
  "TargetConnect",
  "ReferenceSeed",
  "PersonProjection",
  "PersonImport",
  "OrganizationProjection",
  "OrganizationImport",
  "CurrentAssignmentProjection",
  "CurrentAssignmentImport",
  "HistoricalProjection",
  "HistoricalImport",
  "AccountProjection",
  "AccountImport",
  "TargetCommit",
  "TargetRollback",
  "TargetClose",
]);

type CutoverStage = typeof CutoverStage.Type;

export class CutoverStageFailure extends Schema.TaggedError<CutoverStageFailure>()(
  "CutoverStageFailure",
  { stage: CutoverStage, detail: Schema.optional(Schema.String) },
) {
  override get message() {
    return (
      "Legacy cutover " +
      this.stage +
      (this.detail ? "/" + this.detail : "") +
      " failed; details redacted"
    );
  }
}

const decodeSelectedDatabase = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ database: Schema.String })),
);

const inStageEffect = <A, E, R>(stage: CutoverStage, operation: Effect.Effect<A, E, R>) =>
  operation.pipe(Effect.mapError(() => new CutoverStageFailure({ stage })));

const project = <A>(stage: CutoverStage, operation: () => A) =>
  Effect.try({ try: operation, catch: () => new CutoverStageFailure({ stage }) });

const inStage = async <A>(stage: CutoverStage, operation: () => Promise<A>): Promise<A> => {
  try {
    return await operation();
  } catch (error) {
    const detail =
      stage === "SourceRead" && error instanceof Error
        ? /^Legacy source (Connection|Grants|DatabaseSelection|Transaction|Engines|Users|Credentials|Departments|Semesters|Schools|Relationships|History|Teams|Positions|TeamMemberships|ExecutiveBoards|ExecutiveBoardMemberships) failed; details redacted$/.exec(
            error.message,
          )?.[1]
        : undefined;

    throw new CutoverStageFailure(detail === undefined ? { stage } : { stage, detail });
  }
};

const reasons = (
  occurrences: ReadonlyArray<{ readonly reason: string }>,
): Record<string, number> => {
  const counts: Record<string, number> = {};

  for (const occurrence of occurrences)
    counts[occurrence.reason] = (counts[occurrence.reason] ?? 0) + 1;

  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
};

/** Projection only: past service never creates a current school placement or attendance fact. */

export const buildLegacyHistoricalSnapshot = (
  source: LegacySourceSnapshot,
  person: PersonCohortReport,
  personSnapshot: PersonCohortSnapshot,
  identity: {
    readonly snapshotId: string;
    readonly sourceRevision: string;
    readonly transformationRevision: string;
    readonly referenceDigest: string;
  },
) => {
  const acceptedPeople = new Set(
    person.occurrences
      .filter((occurrence) => occurrence.disposition === "Accepted")
      .map((occurrence) => occurrence.occurrenceId),
  );

  const personEvidence = new Map(
    personSnapshot.mappings
      .filter((mapping) =>
        acceptedPeople.has(`legacy-user-row-${mapping.sourceUserId.slice("legacy-user:".length)}`),
      )
      .map(
        (mapping) =>
          [
            mapping.sourceUserId,
            {
              personId: mapping.personId,
              evidenceRef: mapping.emailOwnership.evidenceRef,
            },
          ] as const,
      ),
  );

  const occurrences = source.history.map((sourceRow) => {
    const row = {
      sourceHistoryId: sourceHistoryId(sourceRow.id),
      sourceUserId: sourceRow.userId === null ? null : sourceUserId(sourceRow.userId),
      sourceDepartmentId:
        sourceRow.departmentId === null ? null : departmentId(sourceRow.departmentId),
      sourceSemesterId: sourceRow.semesterId === null ? null : semesterId(sourceRow.semesterId),
      sourceSchoolId: sourceRow.schoolId === null ? null : sourceSchoolId(sourceRow.schoolId),
      workdays: sourceRow.workdays,
      block: sourceRow.bolk,
      day: sourceRow.day,
    };

    return {
      occurrenceId: `legacy-history-row-${id(sourceRow.id)}`,
      row,
      sourceRowDigest: historicalServiceSourceRowDigest(row),
    };
  });

  const mappings = source.history.flatMap((row) => {
    if (
      row.userId === null ||
      row.departmentId === null ||
      row.semesterId === null ||
      row.schoolId === null
    )
      return [];

    const person = personEvidence.get(sourceUserId(row.userId));

    if (!person) return [];

    return [
      {
        sourceHistoryId: sourceHistoryId(row.id),
        sourceUserId: sourceUserId(row.userId),
        sourceDepartmentId: departmentId(row.departmentId),
        sourceSemesterId: semesterId(row.semesterId),
        sourceSchoolId: sourceSchoolId(row.schoolId),
        personId: person.personId,
        departmentId: departmentId(row.departmentId),
        semesterId: semesterId(row.semesterId),
        schoolId: schoolId(row.schoolId),
        evidenceRef: person.evidenceRef,
      },
    ];
  });

  return decodeHistoricalServiceSnapshot({
    sourceRepository: repository,
    sourceRevision: identity.sourceRevision,
    snapshotId: identity.snapshotId,
    transformationRevision: identity.transformationRevision,
    sourceKind: "LegacyBackup",
    referenceDigest: identity.referenceDigest,
    occurrences,
    mappings,
  });
};

/** Project account rows only through accepted Person reconciliation. */

export const buildLegacyAccountSnapshot = (
  source: LegacySourceSnapshot,
  person: PersonCohortReport,
  personSnapshot: PersonCohortSnapshot,
  identity: {
    readonly snapshotId: string;
    readonly transformationRevision: string;
    readonly passwordlessPolicy: "ProvisionRecovery";
  },
) => {
  const accepted = new Set(
    person.occurrences
      .filter((occurrence) => occurrence.disposition === "Accepted")
      .map((occurrence) => occurrence.occurrenceId),
  );

  const users = new Map(source.users.map((user) => [String(user.id), user]));

  const occurrences = source.credentials.map((credential) => {
    const sourceId = String(credential.id);

    const user = users.get(sourceId);

    return {
      occurrenceId: "legacy-user-row-" + sourceId,
      row: {
        sourceUserId: sourceUserId(sourceId),
        active: user?.active === 1 || user?.active === "1" || user?.active === true,
        email: user?.email,
        passwordHash: credential.passwordHash,
        username: user?.username,
        companyEmail: user?.companyEmail,
      },
    };
  });

  return decodeIdentityCohort({
    sourceRepository: repository,
    sourceRevision: digest(source.credentials),
    snapshotId: identity.snapshotId,
    transformationRevision: identity.transformationRevision,
    sourceKind: "LegacyBackup",
    passwordlessPolicy: identity.passwordlessPolicy,
    occurrences,
    mappings: personSnapshot.mappings
      .filter((mapping) =>
        accepted.has("legacy-user-row-" + mapping.sourceUserId.slice("legacy-user:".length)),
      )
      .map((mapping) => ({
        sourceUserId: mapping.sourceUserId,
        personId: mapping.personId,
        emailOwnership: mapping.emailOwnership,
      })),
  });
};

/** Imports all selected cohorts in one caller-owned transaction. */

export const runLegacyServiceCutover = async (options: CutoverOptions) => {
  if (
    options.passwordlessPolicy !== "ProvisionRecovery" ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(options.snapshotId) ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(options.attestedBy) ||
    !/^[A-Za-z0-9_]+$/.test(options.targetDatabase) ||
    options.sourceUrl === options.targetUrl
  )
    throw new Error("Explicit source, target, snapshot and attestation selections are required");

  const review =
    options.currentAssignments === "NotRequested"
      ? undefined
      : await inStage("CurrentAssignmentProjection", async () =>
          Schema.decodeUnknownSync(CurrentAssignmentReview)(options.currentAssignments, {
            onExcessProperty: "error",
          }),
        );

  const organizationReview =
    options.organization === "NotRequested"
      ? undefined
      : await inStage("OrganizationProjection", async () =>
          Schema.decodeUnknownSync(OrganizationReview)(options.organization, {
            onExcessProperty: "error",
          }),
        );

  const { targetSelection, socketPath, caEnv } = selectLegacyTargetTransport(
    options.targetUrl,
    options.targetDatabase,
  );

  const source = await inStage("SourceRead", () =>
    readLegacySourceSnapshot(
      options.sourceUrl,
      organizationReview === undefined ? "NotRequested" : "Include",
      "NotRequested",
    ),
  );

  const {
    credentials,
    receipts: _receipts,
    paymentAccounts: _paymentAccounts,
    ...personAndServiceSource
  } = source;

  const sourceRevision = digest(personAndServiceSource);

  if (
    source.history.length === 0 &&
    (organizationReview === undefined ||
      (source.teamMemberships?.length ?? 0) + (source.executiveBoardMemberships?.length ?? 0) === 0)
  )
    throw new Error("Selected legacy source cohorts are empty; target untouched");

  if (organizationReview !== undefined)
    await inStage("OrganizationProjection", async () =>
      reviewLegacyOrganizationSource(source, organizationReview),
    );

  const transformationRevision = digest(
    await Promise.all([
      Effect.runPromise(
        currentAssignmentImportSourceDigest().pipe(Effect.provide(BunServices.layer)),
      ),
      ...(organizationReview === undefined
        ? []
        : [
            Effect.runPromise(
              organizationImportSourceDigest().pipe(Effect.provide(BunServices.layer)),
            ),
          ]),
      ...[
        fileURLToPath(import.meta.url),
        fileURLToPath(new URL("./legacy-source-snapshot.ts", import.meta.url)),
        fileURLToPath(new URL("./legacy-person-snapshot.ts", import.meta.url)),
        fileURLToPath(new URL("./legacy-cutover-references.ts", import.meta.url)),
        fileURLToPath(new URL("./legacy-current-assignment-snapshot.ts", import.meta.url)),
        fileURLToPath(import.meta.resolve("@vektorprogrammet/database/person-cohort")),
        fileURLToPath(import.meta.resolve("@vektorprogrammet/database/historical-service-cohort")),
        fileURLToPath(import.meta.resolve("@vektorprogrammet/database/identity-cohort")),
        ...(organizationReview === undefined
          ? []
          : [fileURLToPath(new URL("./legacy-organization-snapshot.ts", import.meta.url))]),
      ].map((path) => readFile(path, "utf8")),
    ]),
  ).slice(0, 32);

  const identity = { sourceRepository: repository, sourceRevision, snapshotId: options.snapshotId };

  const references = buildLegacyReferences(source);

  const program = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    let lifecycleStage: CutoverStage = "TargetConnect";

    return yield* withTypedTransactionFailures(sql.withTransaction)(
      Effect.gen(function* () {
        const selected = yield* inStageEffect(
          "TargetConnect",
          sql
            .unsafe("SELECT current_database() AS database")
            .pipe(Effect.flatMap(decodeSelectedDatabase)),
        );

        if (selected[0]?.database !== options.targetDatabase)
          return yield* new CutoverStageFailure({ stage: "TargetConnect" });

        const referenceStage = yield* inStageEffect(
          "ReferenceSeed",
          seedLegacyReferences(sql, identity, references),
        );

        const personSnapshot = yield* project("PersonProjection", () =>
          buildLegacyPersonSnapshot(source.users, {
            sourceRevision,
            transformationRevision,
            snapshotId: options.snapshotId,
            attestedBy: options.attestedBy,
          }),
        );

        const person = yield* inStageEffect(
          "PersonImport",
          importPersonCohort(sql, personSnapshot),
        );

        const organizationSnapshot =
          organizationReview === undefined
            ? undefined
            : yield* project("OrganizationProjection", () =>
                buildLegacyOrganizationSnapshot(
                  source,
                  person,
                  personSnapshot,
                  organizationReview,
                  {
                    snapshotId: options.snapshotId,
                    transformationRevision,
                    referenceDigest: references.referenceDigest,
                  },
                ),
              );

        const organization =
          organizationSnapshot === undefined
            ? undefined
            : yield* inStageEffect(
                "OrganizationImport",
                importReviewedOrganizationCohort(sql, organizationSnapshot),
              );

        if (organization !== undefined && organization.accepted === 0)
          return yield* new CutoverStageFailure({
            stage: "OrganizationImport",
            detail: "NoAcceptedAppointments",
          });

        const currentSnapshot =
          review === undefined
            ? undefined
            : yield* project("CurrentAssignmentProjection", () =>
                buildLegacyCurrentAssignmentSnapshot(source, person, personSnapshot, review, {
                  snapshotId: options.snapshotId,
                  transformationRevision,
                  referenceDigest: references.referenceDigest,
                }),
              );

        const historicalSource =
          review === undefined
            ? source
            : {
                ...source,
                history: source.history.filter(
                  (row) =>
                    row.semesterId === null ||
                    semesterId(row.semesterId) !== review.sourceSemesterId,
                ),
              };

        let historical: HistoricalServiceReport | undefined;

        if (historicalSource.history.length > 0) {
          const historicalSnapshot = yield* project("HistoricalProjection", () =>
            buildLegacyHistoricalSnapshot(historicalSource, person, personSnapshot, {
              sourceRevision,
              transformationRevision,
              snapshotId: options.snapshotId,
              referenceDigest: references.referenceDigest,
            }),
          );

          historical = yield* inStageEffect(
            "HistoricalImport",
            importHistoricalServiceCohort(sql, historicalSnapshot),
          );

          if (historical.accepted === 0)
            return yield* new CutoverStageFailure({
              stage: "HistoricalImport",
              detail: "NoAcceptedService",
            });
        }

        const current: CurrentAssignmentReport | undefined =
          currentSnapshot === undefined
            ? undefined
            : yield* inStageEffect(
                "CurrentAssignmentImport",
                importReconciledCurrentAssignmentCohort(sql, currentSnapshot),
              );

        if (current !== undefined && current.accepted === 0)
          return yield* new CutoverStageFailure({
            stage: "CurrentAssignmentImport",
            detail: "NoAcceptedAssignments",
          });

        const accountSnapshot = yield* project("AccountProjection", () =>
          buildLegacyAccountSnapshot(source, person, personSnapshot, {
            snapshotId: options.snapshotId,
            transformationRevision,
            passwordlessPolicy: options.passwordlessPolicy,
          }),
        );

        const accountsReport: IdentityCohortReport = yield* inStageEffect(
          "AccountImport",
          importIdentityCohort(sql, accountSnapshot),
        );

        lifecycleStage = "TargetCommit";

        return {
          scope:
            organizationReview !== undefined
              ? review === undefined
                ? "PersonReferencesOrganizationHistoricalServiceAndAccounts"
                : "PersonReferencesOrganizationHistoricalServiceCurrentAssignmentsAndAccounts"
              : review === undefined
                ? "PersonReferencesHistoricalServiceAndAccounts"
                : "PersonReferencesHistoricalServiceCurrentAssignmentsAndAccounts",
          organization:
            organization === undefined || organizationReview === undefined
              ? ("NotRequested" as const)
              : {
                  stage: "Reconciled" as const,
                  asOf: organizationReview.asOf,
                  sourceWatermark: organizationReview.sourceWatermark,
                  input: organization.input,
                  accepted: organization.accepted,
                  quarantined: organization.quarantined,
                  excluded: organization.excluded,
                  reasons: reasons(organization.occurrences),
                },
          currentAssignments:
            current === undefined || review === undefined
              ? ("NotImported" as const)
              : {
                  stage: "Reconciled" as const,
                  sourceSemesterId: review.sourceSemesterId,
                  asOf: review.asOf,
                  sourceWatermark: review.sourceWatermark,
                  currentState: current.currentState,
                  input: current.input,
                  accepted: current.accepted,
                  quarantined: current.quarantined,
                  reasons: reasons(current.occurrences),
                },
          source: {
            snapshotId: options.snapshotId,
            revision: sourceRevision,
            credentialRevision: digest(credentials),
            transformationRevision,
          },
          references: {
            stage: referenceStage,
            departments: references.rows.departments.length,
            semesters: references.rows.semesters.length,
            schools: references.rows.schools.length,
            relationships: references.rows.relationships.length,
            digest: references.referenceDigest,
          },
          person: {
            stage: person.replay ? "ExactReplay" : "Imported",
            input: person.input,
            accepted: person.accepted,
            quarantined: person.quarantined,
            reasons: reasons(person.occurrences),
          },
          historicalService: {
            stage: historical === undefined ? "NotImported" : "Reconciled",
            currentState: "Unchanged",
            input: historical?.input ?? 0,
            accepted: historical?.accepted ?? 0,
            quarantined: historical?.quarantined ?? 0,
            reasons: historical === undefined ? {} : reasons(historical.occurrences),
          },
          accounts: {
            stage: "Reconciled",
            input: accountsReport.input,
            accepted: accountsReport.accepted,
            credentialImported: accountsReport.occurrences.filter(
              ({ reason }) => reason === "Imported",
            ).length,
            recoveryPending: accountsReport.occurrences.filter(
              ({ reason }) => reason === "RecoveryPending",
            ).length,
            quarantined: accountsReport.quarantined,
            reasons: reasons(accountsReport.occurrences),
            dispositionFingerprint: digest(accountsReport.occurrences),
          },
        };
      }).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            lifecycleStage = "TargetRollback";
          }),
        ),
      ),
    ).pipe(
      Effect.catchTag("SqlError", () =>
        Effect.fail(new CutoverStageFailure({ stage: lifecycleStage })),
      ),
    );
  });

  const outcome = await Effect.runPromise(
    program.pipe(
      Effect.provide(
        nativePgLayer({
          url: Redacted.make(targetSelection.toString()),
          maxConnections: 3,
          minConnections: 0,
          idleTimeout: "10 seconds",
          connectionTTL: undefined,
          prepare: false,
          ssl:
            socketPath === null ? { ca: process.env[caEnv!], rejectUnauthorized: true } : undefined,
          applicationName: "legacy-service-cohort-cutover",
          startupOptions: NativeDatabaseStartupOptions,
        }),
      ),
      Effect.catchTag(["SqlError", "SchemaError"], () =>
        Effect.fail(new CutoverStageFailure({ stage: "TargetConnect" })),
      ),
      Effect.result,
    ),
  );

  return Result.getOrThrow(outcome);
};

const usage =
  "Usage: bun run run-legacy-service-cutover.ts --source-url-env=NAME --target-url-env=NAME --target-database=NAME --snapshot-id=ID --attested-by=ID --passwordless-policy=provision-recovery --current-assignments=none|PATH --organization=none|PATH (remote PostgreSQL requires ?sslCaEnv=NAME; local target uses ?host=/absolute/socket; source remains SELECT-only)";

if (import.meta.main) {
  if (process.argv.length === 3 && process.argv[2] === "--help") {
    await Effect.runPromise(Console.log(usage));
  } else {
    try {
      const argumentsByName = Object.fromEntries(
        process.argv.slice(2).map((argument) => {
          const match = /^--([a-z-]+)=(.+)$/.exec(argument);

          if (!match) throw new Error("Invalid options");

          return [match[1], match[2]];
        }),
      );

      const names = [
        "source-url-env",
        "target-url-env",
        "target-database",
        "snapshot-id",
        "attested-by",
        "passwordless-policy",
        "current-assignments",
        "organization",
      ];

      if (
        process.argv.length !== names.length + 2 ||
        Object.keys(argumentsByName).length !== names.length ||
        names.some((name) => !argumentsByName[name]) ||
        argumentsByName["passwordless-policy"] !== "provision-recovery"
      )
        throw new Error("Required option missing");

      const sourceEnv = argumentsByName["source-url-env"]!;

      const targetEnv = argumentsByName["target-url-env"]!;

      if (
        !/^[A-Z][A-Z0-9_]*$/.test(sourceEnv) ||
        !/^[A-Z][A-Z0-9_]*$/.test(targetEnv) ||
        sourceEnv === targetEnv ||
        !process.env[sourceEnv] ||
        !process.env[targetEnv]
      )
        throw new Error("Connection environment selection is invalid");

      const currentAssignments =
        argumentsByName["current-assignments"] === "none"
          ? ("NotRequested" as const)
          : Schema.decodeUnknownSync(CurrentAssignmentReview)(
              await Effect.runPromise(
                readPrivateCohortJson(
                  argumentsByName["current-assignments"],
                  () => new CurrentAssignmentFailure({ code: "InvalidSnapshot" }),
                ),
              ),
              { onExcessProperty: "error" },
            );

      const organization =
        argumentsByName["organization"] === "none"
          ? ("NotRequested" as const)
          : Schema.decodeUnknownSync(OrganizationReview)(
              await Effect.runPromise(
                readPrivateCohortJson(
                  argumentsByName["organization"],
                  () => new OrganizationCohortFailure({ code: "InvalidSnapshot" }),
                  16_777_216,
                ),
              ),
              { onExcessProperty: "error" },
            );

      const result = await runLegacyServiceCutover({
        sourceUrl: process.env[sourceEnv]!,
        targetUrl: process.env[targetEnv]!,
        targetDatabase: argumentsByName["target-database"]!,
        snapshotId: argumentsByName["snapshot-id"]!,
        attestedBy: argumentsByName["attested-by"]!,
        passwordlessPolicy: "ProvisionRecovery",
        currentAssignments,
        organization,
      });

      await Effect.runPromise(Console.log(JSON.stringify(result)));
    } catch (error) {
      // Driver and SQL exceptions can contain credentials or Person fields. No row-level diagnostics.

      await Effect.runPromise(
        Console.error(
          Schema.is(CutoverStageFailure)(error)
            ? error.message
            : "Legacy cohort cutover failed; details redacted. No completion report was issued.",
        ),
      );
      process.exitCode = 1;
    }
  }
}
