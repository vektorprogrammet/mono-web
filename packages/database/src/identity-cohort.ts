/**
 * EX-0021: required public native APIs in exact stable Effect 4 retain upstream unstable annotations.
 * @effect-diagnostics unstableApiUsage:off
 */
import { createLocalAccountIssuer } from "better-auth";
import { Data, Effect, flow, Option, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import { withTypedTransactionFailures } from "./service.js";
import { ContactEmail } from "@vektorprogrammet/domain/contact";
import { canonicalJsonBytes, sha256Hex } from "@vektorprogrammet/domain/shared-kernel";
import { isSupportedLegacyPasswordHash } from "./password-codec.js";

const Id = Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9._:-]{1,128}$/)));

const Label = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(256)),
);

const LegacyRow = Schema.Struct({
  sourceUserId: Id,
  active: Schema.Boolean,
  email: ContactEmail,
  passwordHash: Schema.NullOr(Schema.String.pipe(Schema.check(Schema.isMaxLength(256)))),
  username: Schema.optional(Schema.NullOr(Label)),
  companyEmail: Schema.optional(Schema.NullOr(Label)),
});

const decodeLegacyRow = Schema.decodeUnknownOption(LegacyRow, { onExcessProperty: "error" });

export const IdentityCohortSnapshot = Schema.Struct({
  sourceRepository: Label,
  sourceRevision: Id,
  snapshotId: Id,
  transformationRevision: Id,
  sourceKind: Schema.Union([Schema.Literal("Synthetic"), Schema.Literal("LegacyBackup")]),
  passwordlessPolicy: Schema.Union([
    Schema.Literal("Quarantine"),
    Schema.Literal("ProvisionRecovery"),
  ]),
  occurrences: Schema.Array(Schema.Struct({ occurrenceId: Id, row: Schema.Unknown })).pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(10000)),
  ),
  mappings: Schema.Array(
    Schema.Struct({
      sourceUserId: Id,
      personId: Id,
      // Person evidence may use an email that native login rejects; quarantine that row, not the cohort.
      emailOwnership: Schema.Struct({ email: Schema.String, attestedBy: Id, evidenceRef: Id }),
    }),
  ).pipe(Schema.check(Schema.isMaxLength(10000))),
});

export type IdentityCohortSnapshot = typeof IdentityCohortSnapshot.Type;

export class IdentityCohortFailure extends Data.TaggedError("IdentityCohortFailure")<{
  readonly code:
    | "InvalidSnapshot"
    | "SnapshotConflict"
    | "SourceIdentityConflict"
    | "PersistenceFailure";
}> {
  override get message(): string {
    return this.code;
  }
}

const CohortReasonSchema = Schema.Literals([
  "Imported",
  "RecoveryPending",
  "ExactReplay",
  "InvalidRow",
  "Inactive",
  "MissingPassword",
  "UnsupportedHash",
  "MappingMissing",
  "MappingAmbiguous",
  "EmailUnattested",
  "DuplicateSource",
  "DuplicateEmail",
  "DuplicateTarget",
  "PersonMissing",
  "PersonReconciliationMissing",
  "TargetConflict",
  "EmailConflict",
]);

export type CohortReason = typeof CohortReasonSchema.Type;

export interface CohortOccurrence {
  occurrenceId: string;
  disposition: "Accepted" | "Quarantined";
  reason: CohortReason;
}

export interface CohortReport {
  snapshotKey: string;
  input: number;
  accepted: number;
  quarantined: number;
  occurrences: ReadonlyArray<CohortOccurrence>;
  aliases: "LegacyUsernameAndCompanyEmailUnsupported";
}

const digest = flow(canonicalJsonBytes, sha256Hex);

const encodeAuditDetails = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({ outcomeCode: Schema.String, affectedSessionCount: Schema.Int }),
  ),
);

const sourceIdOf = flow(
  Schema.decodeUnknownOption(Schema.Struct({ sourceUserId: Schema.String })),
  Option.map((row) => row.sourceUserId),
  Option.getOrUndefined,
);

export const decodeIdentityCohort = flow(
  Schema.decodeUnknownOption(IdentityCohortSnapshot, { onExcessProperty: "error" }),
  Option.getOrThrowWith(() => new IdentityCohortFailure({ code: "InvalidSnapshot" })),
  (snapshot) => {
    try {
      if (
        new Set(snapshot.occurrences.map((r) => r.occurrenceId)).size !==
        snapshot.occurrences.length
      )
        throw new Error();

      return snapshot;
    } catch {
      throw new IdentityCohortFailure({ code: "InvalidSnapshot" });
    }
  },
);

const decodeSnapshotDigests = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ snapshot_digest: Schema.String })),
);

const decodeSourceDigests = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ source_digest: Schema.String })),
);

const decodeImportedIdentities = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      source_digest: Schema.String,
      person_id: Schema.String,
      account_id: Schema.NullOr(Schema.String),
      import_mode: Schema.Literals(["CredentialImported", "RecoveryPending"]),
    }),
  ),
);

const decodePersonEvidence = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      first_name: Schema.String,
      last_name: Schema.String,
      contact_email: Schema.NullOr(Schema.String),
    }),
  ),
);

const decodeOccurrences = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      occurrenceId: Schema.String,
      disposition: Schema.Literals(["Accepted", "Quarantined"]),
      reason: CohortReasonSchema,
    }),
  ),
);

const report = (tx: SqlClient.SqlClient, key: string) =>
  tx
    .unsafe(
      `SELECT occurrence_id AS "occurrenceId",disposition,reason FROM auth.credential_cohort_occurrences WHERE snapshot_key=$1 ORDER BY occurrence_id`,
      [key],
    )
    .pipe(
      Effect.flatMap(decodeOccurrences),
      Effect.map((rows): CohortReport => {
        const accepted = rows.filter((r) => r.disposition === "Accepted").length;

        return {
          snapshotKey: key,
          input: rows.length,
          accepted,
          quarantined: rows.length - accepted,
          occurrences: rows,
          aliases: "LegacyUsernameAndCompanyEmailUnsupported",
        };
      }),
    );

/** Commits source occurrences and identity writes atomically; nested callers use the same client's savepoint. */

export const importIdentityCohort = Effect.fn("importIdentityCohort")(function* (
  sql: SqlClient.SqlClient,
  input: typeof IdentityCohortSnapshot.Encoded,
): Effect.fn.Return<CohortReport, IdentityCohortFailure> {
  const snapshot = yield* Effect.try({
    try: () => decodeIdentityCohort(input),
    catch: () => new IdentityCohortFailure({ code: "InvalidSnapshot" }),
  });

  const key = digest([snapshot.sourceRepository, snapshot.snapshotId]);

  const snapshotDigest = digest(snapshot);

  const decoded = snapshot.occurrences.map((occurrence) => ({
    ...occurrence,
    value: Option.getOrUndefined(decodeLegacyRow(occurrence.row)),
  }));

  const mappingsBySource = new Map<string, (typeof snapshot.mappings)[number][]>();

  const targetCounts = new Map<string, number>();

  for (const mapping of snapshot.mappings) {
    const mappings = mappingsBySource.get(mapping.sourceUserId) ?? [];
    mappings.push(mapping);
    mappingsBySource.set(mapping.sourceUserId, mappings);
    targetCounts.set(mapping.personId, (targetCounts.get(mapping.personId) ?? 0) + 1);
  }

  const sourceCounts = new Map<string, number>();

  const emailCounts = new Map<string, number>();

  for (const occurrence of decoded) {
    const sourceId = sourceIdOf(occurrence.row);

    if (sourceId) sourceCounts.set(sourceId, (sourceCounts.get(sourceId) ?? 0) + 1);

    if (occurrence.value) {
      const email = occurrence.value.email.toLowerCase();
      emailCounts.set(email, (emailCounts.get(email) ?? 0) + 1);
    }
  }

  const importInTransaction = Effect.fnUntraced(function* (tx: SqlClient.SqlClient) {
    // One import boundary owns writes; Read Committed takes fresh snapshots after this lock.

    yield* tx.unsafe(
      "SELECT pg_advisory_xact_lock(hashtextextended('native-credential-cohort-import',0))",
    );

    const prior = yield* tx
      .unsafe(
        "SELECT snapshot_digest FROM auth.credential_cohort_snapshots WHERE snapshot_key=$1",
        [key],
      )
      .pipe(Effect.flatMap(decodeSnapshotDigests));

    if (prior[0]) {
      if (prior[0].snapshot_digest !== snapshotDigest)
        return yield* new IdentityCohortFailure({ code: "SnapshotConflict" });

      return yield* report(tx, key);
    }

    yield* tx.unsafe(
      `INSERT INTO auth.credential_cohort_snapshots(snapshot_key,source_repository,snapshot_id,source_revision,transformation_revision,snapshot_digest,occurrence_count,source_kind) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        key,
        snapshot.sourceRepository,
        snapshot.snapshotId,
        snapshot.sourceRevision,
        snapshot.transformationRevision,
        snapshotDigest,
        snapshot.occurrences.length,
        snapshot.sourceKind,
      ],
    );

    for (const occurrence of decoded) {
      const row = occurrence.value;

      let reason: CohortReason | undefined;

      const mappings = row ? (mappingsBySource.get(row.sourceUserId) ?? []) : [];

      const mapping = mappings.length === 1 ? mappings[0] : undefined;

      const sourceId = sourceIdOf(occurrence.row);

      if (sourceId) {
        const previousSource = yield* tx
          .unsafe(
            "SELECT source_digest FROM auth.account_cohort_imports WHERE source_repository=$1 AND source_user_id=$2",
            [snapshot.sourceRepository, sourceId],
          )
          .pipe(Effect.flatMap(decodeSourceDigests));

        if (
          previousSource[0] &&
          (!row || !mapping || previousSource[0].source_digest !== digest({ row, mapping }))
        )
          return yield* new IdentityCohortFailure({ code: "SourceIdentityConflict" });
      }

      if (!row) reason = "InvalidRow";
      else if ((sourceCounts.get(row.sourceUserId) ?? 0) > 1) reason = "DuplicateSource";
      else if ((emailCounts.get(row.email.toLowerCase()) ?? 0) > 1) reason = "DuplicateEmail";
      else if (!row.active) reason = "Inactive";
      else if (
        (row.passwordHash === null || row.passwordHash === "") &&
        snapshot.passwordlessPolicy === "Quarantine"
      )
        reason = "MissingPassword";
      else if (
        row.passwordHash !== null &&
        row.passwordHash !== "" &&
        !isSupportedLegacyPasswordHash(row.passwordHash)
      )
        reason = "UnsupportedHash";
      else if (!mappings.length) reason = "MappingMissing";
      else if (mappings.length > 1) reason = "MappingAmbiguous";
      else if (mapping!.emailOwnership.email.toLowerCase() !== row.email.toLowerCase())
        reason = "EmailUnattested";
      else if ((targetCounts.get(mapping!.personId) ?? 0) > 1) reason = "DuplicateTarget";

      let sourceDigest: string | undefined;

      let accountId: string | null | undefined;

      const passwordless = row?.passwordHash === null || row?.passwordHash === "";

      const importMode = passwordless ? "RecoveryPending" : "CredentialImported";

      let person:
        | { first_name: string; last_name: string; contact_email: string | null }
        | undefined;

      if (!reason && row && mapping) {
        sourceDigest = digest({ row, mapping });
        accountId = passwordless
          ? null
          : `cohort-${digest([snapshot.sourceRepository, row.sourceUserId])}`;

        const imported = yield* tx
          .unsafe(
            "SELECT source_digest,person_id,account_id,import_mode FROM auth.account_cohort_imports WHERE source_repository=$1 AND source_user_id=$2",
            [snapshot.sourceRepository, row.sourceUserId],
          )
          .pipe(Effect.flatMap(decodeImportedIdentities));

        if (imported[0]) {
          if (
            imported[0].source_digest !== sourceDigest ||
            imported[0].person_id !== mapping.personId ||
            imported[0].import_mode !== importMode ||
            imported[0].account_id !== accountId
          )
            return yield* new IdentityCohortFailure({ code: "SourceIdentityConflict" });
          reason = "ExactReplay";
        } else {
          person = (yield* tx
            .unsafe(
              `SELECT p.first_name, p.last_name, c.email AS contact_email
               FROM public.person_cohort_imports i
               JOIN public.person_profiles p ON p.person_id = i.person_id
               JOIN public.person_contact_profiles c ON c.person_id = i.person_id
              WHERE i.source_repository = $1
                AND i.source_user_id = $2
                AND i.person_id = $3
                FOR SHARE OF i, p, c`,
              [snapshot.sourceRepository, row.sourceUserId, mapping.personId],
            )
            .pipe(Effect.flatMap(decodePersonEvidence)))[0];

          if (!person) reason = "PersonReconciliationMissing";
          else if (person.contact_email?.toLowerCase() !== row.email.toLowerCase())
            reason = "EmailConflict";
          else if (
            (yield* tx.unsafe('SELECT 1 FROM auth."user" WHERE id=$1', [mapping.personId])).length
          )
            reason = "TargetConflict";
          else if (
            (yield* tx.unsafe('SELECT 1 FROM auth."user" WHERE lower(email)=$1', [
              row.email.toLowerCase(),
            ])).length
          )
            reason = "EmailConflict";
          else reason = passwordless ? "RecoveryPending" : "Imported";
        }
      }

      if (!reason) return yield* new IdentityCohortFailure({ code: "PersistenceFailure" });

      const accepted =
        reason === "Imported" || reason === "RecoveryPending" || reason === "ExactReplay";

      yield* tx.unsafe(
        "INSERT INTO auth.credential_cohort_occurrences(snapshot_key,occurrence_id,disposition,reason) VALUES($1,$2,$3,$4)",
        [key, occurrence.occurrenceId, accepted ? "Accepted" : "Quarantined", reason],
      );

      if (
        (reason === "Imported" || reason === "RecoveryPending") &&
        row &&
        mapping &&
        person &&
        accountId !== undefined &&
        sourceDigest
      ) {
        yield* tx.unsafe(
          'INSERT INTO auth."user"(id,name,email,"emailVerified") VALUES($1,$2,$3,false)',
          [mapping.personId, `${person.first_name} ${person.last_name}`, row.email.toLowerCase()],
        );

        if (accountId !== null)
          yield* tx.unsafe(
            'INSERT INTO auth."account"(id,"accountId","providerId",issuer,"userId",password,"updatedAt") VALUES($1,$2,\'credential\',$3,$2,$4,date_trunc(\'milliseconds\',now(),\'UTC\'))',
            [accountId, mapping.personId, createLocalAccountIssuer("credential"), row.passwordHash],
          );

        yield* tx.unsafe(
          "INSERT INTO auth.account_cohort_imports(source_repository,source_user_id,person_id,account_id,import_mode,source_digest,snapshot_key,occurrence_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
          [
            snapshot.sourceRepository,
            row.sourceUserId,
            mapping.personId,
            accountId,
            importMode,
            sourceDigest,
            key,
            occurrence.occurrenceId,
          ],
        );

        const details = yield* encodeAuditDetails({
          outcomeCode: passwordless ? "recovery-pending" : "account-provisioned",
          affectedSessionCount: 0,
        });

        yield* tx.unsafe(
          `INSERT INTO auth.identity_security_audit(event_id,event_kind,subject_person_id,actor_principal,details) VALUES($1,$5,$2,$3,$4::jsonb)`,
          [
            `cohort-${sourceDigest}`,
            mapping.personId,
            snapshot.sourceKind === "LegacyBackup"
              ? "administrative:legacy-backup-cohort"
              : "administrative:synthetic-cohort",
            details,
            passwordless
              ? "recovery-identity-provisioned-administratively"
              : "account-provisioned-administratively",
          ],
        );
      }
    }

    const result = yield* report(tx, key);

    if (result.input !== snapshot.occurrences.length)
      return yield* new IdentityCohortFailure({ code: "PersistenceFailure" });

    return result;
  });

  return yield* withTypedTransactionFailures(sql.withTransaction)(importInTransaction(sql)).pipe(
    Effect.catchTags({
      SqlError: () => Effect.fail(new IdentityCohortFailure({ code: "PersistenceFailure" })),
      SchemaError: () => Effect.fail(new IdentityCohortFailure({ code: "PersistenceFailure" })),
    }),
  );
});
