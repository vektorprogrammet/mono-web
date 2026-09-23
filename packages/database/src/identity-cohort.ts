import { createHash } from "node:crypto";
import { createLocalAccountIssuer } from "better-auth";
import { Schema } from "effect";
import type { Pool, PoolClient } from "pg";
import { ContactEmail } from "@vektorprogrammet/domain/contact";
import { canonicalJson } from "@vektorprogrammet/domain/evidence";
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
export const IdentityCohortSnapshot = Schema.Struct({
  sourceRepository: Label,
  sourceRevision: Id,
  snapshotId: Id,
  transformationRevision: Id,
  sourceKind: Schema.Union([Schema.Literal("Synthetic"), Schema.Literal("LegacyBackup")]),
  occurrences: Schema.Array(Schema.Struct({ occurrenceId: Id, row: Schema.Unknown })).pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(10000)),
  ),
  mappings: Schema.Array(
    Schema.Struct({
      sourceUserId: Id,
      personId: Id,
      emailOwnership: Schema.Struct({ email: ContactEmail, attestedBy: Id, evidenceRef: Id }),
    }),
  ).pipe(Schema.check(Schema.isMaxLength(10000))),
});
export type IdentityCohortSnapshot = typeof IdentityCohortSnapshot.Type;
export class IdentityCohortFailure extends Error {
  constructor(
    readonly code:
      | "InvalidSnapshot"
      | "SnapshotConflict"
      | "SourceIdentityConflict"
      | "PersistenceFailure",
  ) {
    super(code);
    this.name = "IdentityCohortFailure";
  }
}
export type CohortReason =
  | "Imported"
  | "ExactReplay"
  | "InvalidRow"
  | "Inactive"
  | "MissingPassword"
  | "UnsupportedHash"
  | "MappingMissing"
  | "MappingAmbiguous"
  | "EmailUnattested"
  | "DuplicateSource"
  | "DuplicateEmail"
  | "DuplicateTarget"
  | "PersonMissing"
  | "PersonReconciliationMissing"
  | "TargetConflict"
  | "EmailConflict";
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
  occurrences: CohortOccurrence[];
  aliases: "LegacyUsernameAndCompanyEmailUnsupported";
}
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const sourceIdOf = (row: unknown): string | undefined =>
  typeof row === "object" && row !== null && "sourceUserId" in row &&
  typeof row.sourceUserId === "string" ? row.sourceUserId : undefined;
export const decodeIdentityCohort = (input: unknown): IdentityCohortSnapshot => {
  try {
    const snapshot = Schema.decodeUnknownSync(IdentityCohortSnapshot)(input, {
      onExcessProperty: "error",
    });
    if (
      new Set(snapshot.occurrences.map((r) => r.occurrenceId)).size !== snapshot.occurrences.length
    )
      throw new Error();
    return snapshot;
  } catch {
    throw new IdentityCohortFailure("InvalidSnapshot");
  }
};
const report = async (tx: PoolClient, key: string): Promise<CohortReport> => {
  const rows = await tx.query<CohortOccurrence>(
    `SELECT occurrence_id AS "occurrenceId",disposition,reason FROM auth.credential_cohort_occurrences WHERE snapshot_key=$1 ORDER BY occurrence_id`,
    [key],
  );
  const accepted = rows.rows.filter((r) => r.disposition === "Accepted").length;
  return {
    snapshotKey: key,
    input: rows.rows.length,
    accepted,
    quarantined: rows.rows.length - accepted,
    occurrences: rows.rows,
    aliases: "LegacyUsernameAndCompanyEmailUnsupported",
  };
};
/** All source occurrences and credential writes are one transaction; no engine adapter's separate pool. */
export const importIdentityCohort = async (
  pool: Pool,
  input: unknown,
  client?: PoolClient,
): Promise<CohortReport> => {
  const snapshot = decodeIdentityCohort(input);
  const key = digest([snapshot.sourceRepository, snapshot.snapshotId]);
  const snapshotDigest = digest(snapshot);
  const decoded = snapshot.occurrences.map((occurrence) => {
    try {
      return {
        ...occurrence,
        value: Schema.decodeUnknownSync(LegacyRow)(occurrence.row, { onExcessProperty: "error" }),
      };
    } catch {
      return { ...occurrence, value: undefined };
    }
  });
  const mappingsBySource = new Map<string, typeof snapshot.mappings[number][]>();
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
  const tx = client ?? (await pool.connect());
  try {
    if (!client) await tx.query("BEGIN");
    // One import boundary owns writes; Read Committed takes fresh snapshots after this lock.
    await tx.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('native-credential-cohort-import',0))",
    );
    const prior = await tx.query<{ snapshot_digest: string }>(
      "SELECT snapshot_digest FROM auth.credential_cohort_snapshots WHERE snapshot_key=$1",
      [key],
    );
    if (prior.rows[0]) {
      if (prior.rows[0].snapshot_digest !== snapshotDigest)
        throw new IdentityCohortFailure("SnapshotConflict");
      const result = await report(tx, key);
      if (!client) await tx.query("COMMIT");
      return result;
    }
    await tx.query(
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
        const previousSource = await tx.query<{ source_digest: string }>(
          "SELECT source_digest FROM auth.credential_cohort_imports WHERE source_repository=$1 AND source_user_id=$2",
          [snapshot.sourceRepository, sourceId],
        );
        if (
          previousSource.rows[0] &&
          (!row || !mapping || previousSource.rows[0].source_digest !== digest({ row, mapping }))
        )
          throw new IdentityCohortFailure("SourceIdentityConflict");
      }
      if (!row) reason = "InvalidRow";
      else if ((sourceCounts.get(row.sourceUserId) ?? 0) > 1) reason = "DuplicateSource";
      else if ((emailCounts.get(row.email.toLowerCase()) ?? 0) > 1)
        reason = "DuplicateEmail";
      else if (!row.active) reason = "Inactive";
      else if (row.passwordHash === null || row.passwordHash === "") reason = "MissingPassword";
      else if (!isSupportedLegacyPasswordHash(row.passwordHash)) reason = "UnsupportedHash";
      else if (!mappings.length) reason = "MappingMissing";
      else if (mappings.length > 1) reason = "MappingAmbiguous";
      else if (mapping!.emailOwnership.email.toLowerCase() !== row.email.toLowerCase())
        reason = "EmailUnattested";
      else if ((targetCounts.get(mapping!.personId) ?? 0) > 1)
        reason = "DuplicateTarget";
      let sourceDigest: string | undefined;
      let accountId: string | undefined;
      let person: { first_name: string; last_name: string; contact_email: string | null } | undefined;
      if (!reason && row && mapping) {
        sourceDigest = digest({ row, mapping });
        accountId = `cohort-${digest([snapshot.sourceRepository, row.sourceUserId])}`;
        const imported = await tx.query<{
          source_digest: string;
          person_id: string;
          account_id: string;
        }>(
          "SELECT source_digest,person_id,account_id FROM auth.credential_cohort_imports WHERE source_repository=$1 AND source_user_id=$2",
          [snapshot.sourceRepository, row.sourceUserId],
        );
        if (imported.rows[0]) {
          if (
            imported.rows[0].source_digest !== sourceDigest ||
            imported.rows[0].person_id !== mapping.personId ||
            imported.rows[0].account_id !== accountId
          )
            throw new IdentityCohortFailure("SourceIdentityConflict");
          reason = "ExactReplay";
        } else {
          person = (
            await tx.query<{ first_name: string; last_name: string; contact_email: string | null }>(
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
          ).rows[0];
          if (!person) reason = "PersonReconciliationMissing";
          else if (person.contact_email?.toLowerCase() !== row.email.toLowerCase())
            reason = "EmailConflict";
          else if (
            (await tx.query('SELECT 1 FROM auth."user" WHERE id=$1', [mapping.personId])).rowCount
          )
            reason = "TargetConflict";
          else if (
            (
              await tx.query('SELECT 1 FROM auth."user" WHERE lower(email)=$1', [
                row.email.toLowerCase(),
              ])
            ).rowCount
          )
            reason = "EmailConflict";
          else reason = "Imported";
        }
      }
      if (!reason) throw new IdentityCohortFailure("PersistenceFailure");
      const accepted = reason === "Imported" || reason === "ExactReplay";
      await tx.query(
        "INSERT INTO auth.credential_cohort_occurrences(snapshot_key,occurrence_id,disposition,reason) VALUES($1,$2,$3,$4)",
        [key, occurrence.occurrenceId, accepted ? "Accepted" : "Quarantined", reason],
      );
      if (reason === "Imported" && row && mapping && person && accountId && sourceDigest) {
        await tx.query(
          'INSERT INTO auth."user"(id,name,email,"emailVerified") VALUES($1,$2,$3,false)',
          [mapping.personId, `${person.first_name} ${person.last_name}`, row.email.toLowerCase()],
        );
        await tx.query(
          'INSERT INTO auth."account"(id,"accountId","providerId",issuer,"userId",password,"updatedAt") VALUES($1,$2,\'credential\',$3,$2,$4,now())',
          [accountId, mapping.personId, createLocalAccountIssuer("credential"), row.passwordHash],
        );
        await tx.query(
          "INSERT INTO auth.credential_cohort_imports(source_repository,source_user_id,person_id,account_id,source_digest,snapshot_key,occurrence_id) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [
            snapshot.sourceRepository,
            row.sourceUserId,
            mapping.personId,
            accountId,
            sourceDigest,
            key,
            occurrence.occurrenceId,
          ],
        );
        await tx.query(
          `INSERT INTO auth.identity_security_audit(event_id,event_kind,subject_person_id,actor_principal,details) VALUES($1,'account-provisioned-administratively',$2,$3,$4::jsonb)`,
          [
            `cohort-${sourceDigest}`,
            mapping.personId,
            snapshot.sourceKind === "LegacyBackup"
              ? "administrative:legacy-backup-cohort"
              : "administrative:synthetic-cohort",
            JSON.stringify({ outcomeCode: "account-provisioned", affectedSessionCount: 0 }),
          ],
        );
      }
    }
    const result = await report(tx, key);
    if (result.input !== snapshot.occurrences.length)
      throw new IdentityCohortFailure("PersistenceFailure");
    if (!client) await tx.query("COMMIT");
    return result;
  } catch (cause) {
    if (!client) await tx.query("ROLLBACK");
    throw cause instanceof IdentityCohortFailure
      ? cause
      : new IdentityCohortFailure("PersistenceFailure");
  } finally {
    if (!client) tx.release();
  }
};
