import {
  decodePersonCohort,
  isPersonCohortMappableRow,
  personCohortSourceRowDigest,
  type PersonCohortSnapshot,
} from "@vektorprogrammet/database/person-cohort";
import type { PersonId } from "@vektorprogrammet/domain/organization";

export interface LegacyUserJson {
  readonly id: number | string;
  readonly active: number | string | boolean;
  readonly firstName: unknown;
  readonly lastName: unknown;
  readonly email: unknown;
  readonly phone: unknown;
  readonly username: unknown;
  readonly companyEmail: unknown;
}

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
            personId: ("legacy-person-" +
              row.sourceUserId.slice("legacy-user:".length)) as PersonId,
            emailOwnership: {
              email: row.email as string,
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
