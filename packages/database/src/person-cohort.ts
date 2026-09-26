import { createHash } from "node:crypto";
import { Data, Effect, flow, Option, Predicate, Schema } from "effect";
import type { Pool, PoolClient } from "pg";
import { canonicalJson } from "@vektorprogrammet/domain/shared-kernel";
import { PersonId } from "@vektorprogrammet/domain/organization";
import {
  PersonContactEmail,
  PersonContactPhone,
  PersonProfileName,
} from "@vektorprogrammet/domain/profile";
import { pgQuery, pgTransaction } from "./pg-pool.js";

const Id = Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9._:-]{1,128}$/)));

const Sha256 = Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/)));

const Label = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(256)),
);

const Revision = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));

const LegacyPersonRow = Schema.Struct({
  sourceUserId: Id,
  active: Schema.Boolean,
  firstName: PersonProfileName,
  lastName: PersonProfileName,
  email: PersonContactEmail,
  phone: PersonContactPhone,
  username: Schema.optional(Schema.NullOr(Label)),
  companyEmail: Schema.optional(Schema.NullOr(Label)),
});

const EmailOwnership = Schema.Struct({
  email: PersonContactEmail,
  attestedBy: Id,
  evidenceRef: Id,
});

export const PersonMapping = Schema.TaggedUnion({
  CreatePerson: { sourceUserId: Id, personId: PersonId, emailOwnership: EmailOwnership },
  LinkExistingPerson: {
    sourceUserId: Id,
    personId: PersonId,
    emailOwnership: EmailOwnership,
    expectedNameRevision: Revision,
    expectedContactRevision: Revision,
  },
});

export const PersonCohortSnapshot = Schema.Struct({
  sourceRepository: Label,
  sourceRevision: Id,
  snapshotId: Id,
  transformationRevision: Id,
  sourceKind: Schema.Literals(["Synthetic", "LegacyBackup"]),
  occurrences: Schema.Array(
    Schema.Struct({
      occurrenceId: Id,
      row: Schema.Unknown,
      sourceRowDigest: Schema.optional(Sha256),
    }),
  ).pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(10_000))),
  mappings: Schema.Array(PersonMapping).pipe(Schema.check(Schema.isMaxLength(10_000))),
});

export type PersonCohortSnapshot = typeof PersonCohortSnapshot.Type;

type LegacyPersonRow = typeof LegacyPersonRow.Type;

export type PersonMapping = typeof PersonMapping.Type;

export class PersonCohortFailure extends Data.TaggedError("PersonCohortFailure")<{
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

export const PersonCohortReason = Schema.Literals([
  "CreatedPerson",
  "LinkedExistingPerson",
  "ExactReplay",
  "InvalidRow",
  "Inactive",
  "MappingMissing",
  "MappingAmbiguous",
  "EmailUnattested",
  "DuplicateSource",
  "DuplicateEmail",
  "DuplicateTarget",
  "TargetConflict",
  "EmailConflict",
  "PersonMissing",
  "ExistingPersonStale",
  "ExistingEmailConflict",
]);

export type PersonCohortReason = typeof PersonCohortReason.Type;

export const PersonCohortOccurrence = Schema.Struct({
  occurrenceId: Schema.String,
  disposition: Schema.Literals(["Accepted", "Quarantined"]),
  reason: PersonCohortReason,
});

export type PersonCohortOccurrence = typeof PersonCohortOccurrence.Type;

export const PersonCohortReport = Schema.Struct({
  snapshotKey: Schema.String,
  replay: Schema.Boolean,
  input: Schema.Int,
  accepted: Schema.Int,
  quarantined: Schema.Int,
  occurrences: Schema.Array(PersonCohortOccurrence),
  aliases: Schema.Literal("LegacyUsernameAndCompanyEmailUnsupported"),
  credentials: Schema.Literal("HandledByCredentialCohort"),
});

export type PersonCohortReport = typeof PersonCohortReport.Type;

const digest = flow(canonicalJson, (json) => createHash("sha256").update(json).digest("hex"));

export const personCohortSourceRowDigest = digest;

export const isPersonCohortMappableRow = flow(
  Schema.decodeUnknownOption(LegacyPersonRow, { onExcessProperty: "error" }),
  Option.match({ onSome: (row) => row.active, onNone: () => false }),
);

const sourceIdOf = flow(
  Schema.decodeUnknownOption(Schema.Struct({ sourceUserId: Schema.String })),
  Option.map((row) => row.sourceUserId),
  Option.getOrUndefined,
);

const increment = (counts: Map<string, number>, key: string | undefined) => {
  if (key !== undefined) counts.set(key, (counts.get(key) ?? 0) + 1);
};

export const decodePersonCohort = flow(
  Schema.decodeUnknownOption(PersonCohortSnapshot, { onExcessProperty: "error" }),
  Option.getOrThrowWith(() => new PersonCohortFailure({ code: "InvalidSnapshot" })),
  (snapshot) => {
    try {
      if (
        new Set(snapshot.occurrences.map(({ occurrenceId }) => occurrenceId)).size !==
        snapshot.occurrences.length
      )
        throw new Error();

      if (
        snapshot.sourceKind === "LegacyBackup" &&
        snapshot.occurrences.some(
          ({ row, sourceRowDigest }) =>
            sourceRowDigest === undefined || sourceRowDigest !== personCohortSourceRowDigest(row),
        )
      )
        throw new Error();

      return snapshot;
    } catch {
      throw new PersonCohortFailure({ code: "InvalidSnapshot" });
    }
  },
);

const cohortReport = (tx: PoolClient, snapshotKey: string, replay: boolean) =>
  pgQuery<PersonCohortOccurrence>(
    tx,
    `SELECT occurrence_id AS "occurrenceId", disposition, reason
       FROM public.person_cohort_occurrences
      WHERE snapshot_key = $1
      ORDER BY occurrence_id`,
    [snapshotKey],
  ).pipe(
    Effect.map((rows): PersonCohortReport => {
      const accepted = rows.rows.filter(({ disposition }) => disposition === "Accepted").length;

      return {
        snapshotKey,
        replay,
        input: rows.rows.length,
        accepted,
        quarantined: rows.rows.length - accepted,
        occurrences: rows.rows,
        aliases: "LegacyUsernameAndCompanyEmailUnsupported",
        credentials: "HandledByCredentialCohort",
      };
    }),
  );

interface AcceptedPersonEvidence {
  readonly snapshotKey: string;
  readonly occurrenceId: string;
  readonly sourceRepository: string;
  readonly sourceUserId: string;
  readonly personId: PersonId;
  readonly sourceDigest: string;
}

const appendAcceptedPersonMapping = Effect.fnUntraced(function* (
  tx: PoolClient,
  evidence: AcceptedPersonEvidence,
) {
  const values = [
    evidence.snapshotKey,
    evidence.occurrenceId,
    evidence.sourceRepository,
    evidence.sourceUserId,
    evidence.personId,
    evidence.sourceDigest,
  ];

  const inserted = yield* pgQuery(
    tx,
    `INSERT INTO public.person_cohort_accepted_mappings
       (snapshot_key, occurrence_id, source_repository, source_user_id)
     SELECT $1, $2, source_repository, source_user_id
       FROM public.person_cohort_imports
      WHERE source_repository = $3 AND source_user_id = $4 AND person_id = $5 AND source_digest = $6
     ON CONFLICT (snapshot_key, occurrence_id) DO NOTHING`,
    values,
  );

  if (inserted.rowCount) return;

  const existing = yield* pgQuery(
    tx,
    `SELECT 1 FROM public.person_cohort_accepted_mappings a
      JOIN public.person_cohort_imports i USING (source_repository, source_user_id)
      WHERE a.snapshot_key = $1 AND a.occurrence_id = $2
        AND a.source_repository = $3 AND a.source_user_id = $4
        AND i.person_id = $5 AND i.source_digest = $6`,
    values,
  );

  if (!existing.rowCount) return yield* new PersonCohortFailure({ code: "SourceIdentityConflict" });
});

/** Person/profile writes and source evidence share the caller transaction when supplied. */
export const importPersonCohort = Effect.fn("importPersonCohort")(function* (
  pool: Pool,
  input: typeof PersonCohortSnapshot.Encoded,
  client?: PoolClient,
) {
  const snapshot = yield* Effect.try({
    try: () => decodePersonCohort(input),
    catch: () => new PersonCohortFailure({ code: "InvalidSnapshot" }),
  });

  const snapshotKey = digest([snapshot.sourceRepository, snapshot.snapshotId]);
  const snapshotDigest = digest(snapshot);

  const decoded = snapshot.occurrences.map((occurrence) => {
    try {
      return {
        ...occurrence,
        value: Schema.decodeUnknownSync(LegacyPersonRow)(occurrence.row, {
          onExcessProperty: "error",
        }),
      };
    } catch {
      return { ...occurrence, value: undefined };
    }
  });

  const mappingsBySource = new Map<string, PersonMapping[]>();
  const mappingTargetCounts = new Map<string, number>();

  for (const mapping of snapshot.mappings) {
    const mappings = mappingsBySource.get(mapping.sourceUserId);

    if (mappings === undefined) mappingsBySource.set(mapping.sourceUserId, [mapping]);
    else mappings.push(mapping);
    increment(mappingTargetCounts, mapping.personId);
  }

  const sourceCounts = new Map<string, number>();
  const emailCounts = new Map<string, number>();

  for (const occurrence of decoded) {
    increment(sourceCounts, sourceIdOf(occurrence.row));
    increment(emailCounts, occurrence.value?.email.toLowerCase());
  }

  const importInTransaction = Effect.fnUntraced(function* (tx: PoolClient) {
    yield* pgQuery(
      tx,
      "SELECT pg_advisory_xact_lock(hashtextextended('native-person-cohort-import', 0))",
    );

    const prior = yield* pgQuery<{ snapshot_digest: string }>(
      tx,
      `SELECT snapshot_digest FROM public.person_cohort_snapshots WHERE snapshot_key = $1`,
      [snapshotKey],
    );

    if (prior.rows[0]) {
      if (prior.rows[0].snapshot_digest !== snapshotDigest)
        return yield* new PersonCohortFailure({ code: "SnapshotConflict" });
      const result = yield* cohortReport(tx, snapshotKey, true);

      const acceptedOccurrences = new Set(
        result.occurrences
          .filter(({ disposition }) => disposition === "Accepted")
          .map(({ occurrenceId }) => occurrenceId),
      );

      // A matching supplied snapshot proves old replay identities; occurrence IDs alone do not.
      for (const occurrence of decoded) {
        if (!acceptedOccurrences.has(occurrence.occurrenceId)) continue;
        const row = occurrence.value;
        const mappings = row ? mappingsBySource.get(row.sourceUserId) : undefined;

        if (!row || mappings?.length !== 1)
          return yield* new PersonCohortFailure({ code: "SourceIdentityConflict" });
        const mapping = mappings[0]!;
        yield* appendAcceptedPersonMapping(tx, {
          snapshotKey,
          occurrenceId: occurrence.occurrenceId,
          sourceRepository: snapshot.sourceRepository,
          sourceUserId: row.sourceUserId,
          personId: mapping.personId,
          sourceDigest: digest({ row, mapping }),
        });
      }

      return result;
    }

    const acceptedImports = yield* pgQuery<{ source_user_id: string; source_digest: string }>(
      tx,
      `SELECT source_user_id, source_digest
         FROM public.person_cohort_imports
        WHERE source_repository = $1`,
      [snapshot.sourceRepository],
    );

    const importedDigests = new Map(
      acceptedImports.rows.map(({ source_user_id, source_digest }) => [
        source_user_id,
        source_digest,
      ]),
    );

    const acceptedTargets = yield* pgQuery<{ person_id: string }>(
      tx,
      `SELECT person_id
         FROM public.person_cohort_imports
        WHERE person_id = ANY($1::text[])`,
      [snapshot.mappings.map(({ personId }) => personId)],
    );

    const importedPersonIds = new Set(acceptedTargets.rows.map(({ person_id }) => person_id));

    for (const occurrence of decoded) {
      const sourceUserId = sourceIdOf(occurrence.row);
      const previousDigest = sourceUserId ? importedDigests.get(sourceUserId) : undefined;

      if (previousDigest !== undefined) {
        const mappings = sourceUserId ? (mappingsBySource.get(sourceUserId) ?? []) : [];
        const mapping = mappings.length === 1 ? mappings[0] : undefined;

        if (
          !occurrence.value ||
          !mapping ||
          previousDigest !== digest({ row: occurrence.value, mapping })
        )
          return yield* new PersonCohortFailure({ code: "SourceIdentityConflict" });
      }
    }

    yield* pgQuery(
      tx,
      `INSERT INTO public.person_cohort_snapshots
         (snapshot_key, source_repository, snapshot_id, source_revision,
          transformation_revision, snapshot_digest, occurrence_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        snapshotKey,
        snapshot.sourceRepository,
        snapshot.snapshotId,
        snapshot.sourceRevision,
        snapshot.transformationRevision,
        snapshotDigest,
        snapshot.occurrences.length,
      ],
    );

    for (const occurrence of decoded) {
      const row = occurrence.value;
      const mappings = row ? (mappingsBySource.get(row.sourceUserId) ?? []) : [];
      const mapping = mappings.length === 1 ? mappings[0] : undefined;
      let reason: PersonCohortReason;
      let sourceDigest: string | undefined;

      if (!row) reason = "InvalidRow";
      else if (!row.active) reason = "Inactive";
      else if ((sourceCounts.get(row.sourceUserId) ?? 0) > 1) reason = "DuplicateSource";
      else if ((emailCounts.get(row.email.toLowerCase()) ?? 0) > 1) reason = "DuplicateEmail";
      else if (mappings.length === 0) reason = "MappingMissing";
      else if (mappings.length > 1) reason = "MappingAmbiguous";
      else if (mapping!.emailOwnership.email.toLowerCase() !== row.email.toLowerCase())
        reason = "EmailUnattested";
      else if ((mappingTargetCounts.get(mapping!.personId) ?? 0) > 1) reason = "DuplicateTarget";
      else {
        sourceDigest = digest({ row, mapping });

        if (importedDigests.get(row.sourceUserId) === sourceDigest) reason = "ExactReplay";
        else if (importedPersonIds.has(mapping!.personId)) reason = "TargetConflict";
        else if (Predicate.isTagged(mapping!, "CreatePerson")) {
          const target = yield* pgQuery(
            tx,
            `SELECT 1 FROM public.person_profiles WHERE person_id = $1 FOR SHARE`,
            [mapping!.personId],
          );

          if (target.rowCount) reason = "TargetConflict";
          else {
            const emailOwner = yield* pgQuery(
              tx,
              `SELECT 1 FROM public.person_contact_profiles WHERE lower(email) = $1 FOR SHARE`,
              [row.email.toLowerCase()],
            );

            reason = emailOwner.rowCount ? "EmailConflict" : "CreatedPerson";
          }
        } else {
          const existing = (yield* pgQuery<{
            name_revision: number;
            contact_revision: number;
            email: string;
          }>(
            tx,
            `SELECT p.revision AS name_revision, c.revision AS contact_revision, c.email
                 FROM public.person_profiles p
                 JOIN public.person_contact_profiles c USING (person_id)
                WHERE p.person_id = $1
                FOR SHARE OF p, c`,
            [mapping!.personId],
          )).rows[0];

          if (!existing) reason = "PersonMissing";
          else if (
            existing.name_revision !== mapping!.expectedNameRevision ||
            existing.contact_revision !== mapping!.expectedContactRevision
          )
            reason = "ExistingPersonStale";
          else if (existing.email.toLowerCase() !== row.email.toLowerCase())
            reason = "ExistingEmailConflict";
          else reason = "LinkedExistingPerson";
        }
      }

      const accepted = ["CreatedPerson", "LinkedExistingPerson", "ExactReplay"].includes(reason);
      yield* pgQuery(
        tx,
        `INSERT INTO public.person_cohort_occurrences
           (snapshot_key, occurrence_id, disposition, reason)
         VALUES ($1, $2, $3, $4)`,
        [snapshotKey, occurrence.occurrenceId, accepted ? "Accepted" : "Quarantined", reason],
      );

      if (
        (reason === "CreatedPerson" || reason === "LinkedExistingPerson") &&
        row &&
        mapping &&
        sourceDigest
      ) {
        if (reason === "CreatedPerson") {
          yield* pgQuery(
            tx,
            `INSERT INTO public.person_profiles (person_id, first_name, last_name)
             VALUES ($1, $2, $3)`,
            [mapping.personId, row.firstName, row.lastName],
          );
          yield* pgQuery(
            tx,
            `INSERT INTO public.person_contact_profiles (person_id, email, phone)
             VALUES ($1, $2, $3)`,
            [mapping.personId, row.email.toLowerCase(), row.phone],
          );
        }

        yield* pgQuery(
          tx,
          `INSERT INTO public.person_cohort_imports
             (source_repository, source_user_id, person_id, mapping_action, source_digest,
              evidence_ref, snapshot_key, occurrence_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            snapshot.sourceRepository,
            row.sourceUserId,
            mapping.personId,
            mapping._tag,
            sourceDigest,
            mapping.emailOwnership.evidenceRef,
            snapshotKey,
            occurrence.occurrenceId,
          ],
        );
      }

      if (accepted && row && mapping && sourceDigest)
        yield* appendAcceptedPersonMapping(tx, {
          snapshotKey,
          occurrenceId: occurrence.occurrenceId,
          sourceRepository: snapshot.sourceRepository,
          sourceUserId: row.sourceUserId,
          personId: mapping.personId,
          sourceDigest,
        });
    }

    const result = yield* cohortReport(tx, snapshotKey, false);

    if (result.input !== snapshot.occurrences.length)
      return yield* new PersonCohortFailure({ code: "PersistenceFailure" });

    return result;
  });

  return yield* (
    client === undefined ? pgTransaction(pool, importInTransaction) : importInTransaction(client)
  ).pipe(
    Effect.catchTag("PgQueryError", () =>
      Effect.fail(new PersonCohortFailure({ code: "PersistenceFailure" })),
    ),
  );
});
