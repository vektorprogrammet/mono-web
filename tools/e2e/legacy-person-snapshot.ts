import {
  decodePersonCohort,
  isPersonCohortMappableRow,
  personCohortSourceRowDigest,
  type PersonCohortSnapshot,
} from "@vektorprogrammet/database/person-cohort";
import { PersonId } from "@vektorprogrammet/domain/organization";
import { PersonContactEmail } from "@vektorprogrammet/domain/profile";
import { Schema } from "effect";

// Contact and name values remain raw: Person reconciliation owns quarantine decisions.
export const LegacyUserJson = Schema.Struct({
  id: Schema.Union([Schema.Int, Schema.String]),
  active: Schema.Union([Schema.Int, Schema.String, Schema.Boolean]),
  firstName: Schema.Unknown,
  lastName: Schema.Unknown,
  email: Schema.Unknown,
  phone: Schema.Unknown,
  username: Schema.Unknown,
  companyEmail: Schema.Unknown,
});

export type LegacyUserJson = typeof LegacyUserJson.Type;

interface SnapshotIdentity {
  readonly sourceRevision: string;
  readonly transformationRevision: string;
  readonly snapshotId: string;
  readonly attestedBy: string;
}

/** Both local backup and cutover use the same Person classification and identity mapping. */
export const buildLegacyPersonSnapshot = (
  rows: ReadonlyArray<LegacyUserJson>,
  identity: SnapshotIdentity,
): PersonCohortSnapshot => {
  const occurrences = rows.map((source) => {
    const sourceUserId = `legacy-user:${String(source.id)}`;

    const row = {
      sourceUserId,
      active: source.active === 1 || source.active === "1" || source.active === true,
      firstName: source.firstName,
      lastName: source.lastName,
      email: source.email,
      phone: source.phone,
      username: source.username,
      companyEmail: source.companyEmail,
    };

    return {
      occurrenceId: `legacy-user-row-${String(source.id)}`,
      row,
      sourceRowDigest: personCohortSourceRowDigest(row),
    };
  });

  const mappings = occurrences.flatMap(({ row, sourceRowDigest }) =>
    isPersonCohortMappableRow(row)
      ? [
          {
            _tag: "CreatePerson" as const,
            sourceUserId: row.sourceUserId,
            personId: PersonId.make(
              "legacy-person-" + row.sourceUserId.slice("legacy-user:".length),
            ),
            emailOwnership: {
              email: Schema.decodeUnknownSync(PersonContactEmail)(row.email),
              attestedBy: identity.attestedBy,
              evidenceRef: sourceRowDigest,
            },
          },
        ]
      : [],
  );

  return decodePersonCohort({
    sourceRepository: "vektorprogrammet/vektorprogrammet",
    sourceRevision: identity.sourceRevision,
    snapshotId: identity.snapshotId,
    transformationRevision: identity.transformationRevision,
    sourceKind: "LegacyBackup",
    occurrences,
    mappings,
  });
};
