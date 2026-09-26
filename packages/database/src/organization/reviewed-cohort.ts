import { Effect, FileSystem, flow, Option, Path, Predicate, Schema } from "effect";
import type { Pool, PoolClient } from "pg";
import {
  classifyReviewedOrganization,
  decodeReviewedOrganizationSnapshot,
  organizationEvidenceDigest,
  organizationOccurrenceSourceDigest,
  OrganizationCohortFailure,
  OrganizationReview,
  ReviewedOrganizationSnapshot,
  type LegacyDepartmentRow,
  type ReviewedOrganizationOccurrence,
} from "@vektorprogrammet/domain/organization";
import { canonicalJson } from "@vektorprogrammet/domain/shared-kernel";
import { pgQuery, pgTransaction } from "../pg-pool.js";

export {
  organizationSnapshotDigest,
  reviewedOrganizationTargetId,
  OrganizationCohortFailure,
} from "@vektorprogrammet/domain/organization";

export const organizationImportSourceDigest = Effect.fn("organizationImportSourceDigest")(
  function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const sources = yield* Effect.forEach(
      [
        "./reviewed-cohort.ts",
        "../../../domain/src/organization/import.ts",
        "../../../domain/src/organization/review.ts",
        "../../../domain/src/organization/review-classification.ts",
        "../../../domain/src/organization/lifecycle.ts",
        "../../../domain/src/organization/schema.ts",
        "../../../domain/src/time.ts",
        "../../../domain/src/shared-kernel/canonical-json.ts",
        "../../migrations/0066-reviewed-organization-cohort.sql",
      ],
      (source) =>
        path
          .fromFileUrl(new URL(source, import.meta.url))
          .pipe(Effect.flatMap((file) => fs.readFileString(file))),
      { concurrency: "unbounded" },
    );

    return organizationEvidenceDigest(sources);
  },
);

export interface ReviewedOrganizationReport {
  readonly snapshotKey: string;
  readonly replay: boolean;
  readonly input: number;
  readonly accepted: number;
  readonly quarantined: number;
  readonly excluded: number;
  readonly occurrences: ReadonlyArray<ReviewedOrganizationOccurrence>;
}

// A decoded snapshot always encodes; a failure here is a defect.
const encodeReview = flow(
  Schema.encodeEffect(Schema.fromJsonString(OrganizationReview)),
  Effect.orDie,
);

const encodeSnapshot = flow(
  Schema.encodeEffect(Schema.fromJsonString(ReviewedOrganizationSnapshot)),
  Effect.orDie,
);

const report = (tx: PoolClient, snapshotKey: string, replay: boolean) =>
  pgQuery<ReviewedOrganizationOccurrence>(
    tx,
    `SELECT occurrence_id AS "occurrenceId", result, reason, target_id AS "targetId" FROM public.organization_cohort_occurrences WHERE snapshot_key=$1 ORDER BY occurrence_id`,
    [snapshotKey],
  ).pipe(
    Effect.map(({ rows: occurrences }): ReviewedOrganizationReport => {
      const counts = { Accepted: 0, Quarantined: 0, Excluded: 0 };

      for (const row of occurrences) counts[row.result] += 1;

      return {
        snapshotKey,
        replay,
        input: occurrences.length,
        accepted: counts.Accepted,
        quarantined: counts.Quarantined,
        excluded: counts.Excluded,
        occurrences,
      };
    }),
  );

const References = Schema.Struct({
  departments: Schema.Array(
    Schema.Struct({ sourceDepartmentId: Schema.String, departmentId: Schema.String }),
  ),
});

const resolvedEvidence = Effect.fnUntraced(function* (
  tx: PoolClient,
  snapshot: ReviewedOrganizationSnapshot,
) {
  const reference = (yield* pgQuery<{
    source_revision: string;
    reference_digest: string;
    source_id_mappings: unknown;
  }>(
    tx,
    `SELECT source_revision,reference_digest,source_id_mappings FROM public.historical_service_reference_provenance WHERE source_repository=$1 AND snapshot_id=$2 FOR SHARE`,
    [snapshot.sourceRepository, snapshot.snapshotId],
  )).rows[0];

  if (
    !reference ||
    reference.source_revision !== snapshot.sourceRevision ||
    reference.reference_digest !== snapshot.referenceDigest
  )
    return yield* new OrganizationCohortFailure({ code: "ReferenceProvenanceConflict" });
  const decoded = Schema.decodeUnknownOption(References)(reference.source_id_mappings);

  if (Option.isNone(decoded))
    return yield* new OrganizationCohortFailure({ code: "ReferenceProvenanceConflict" });

  const acceptedDepartments = new Map(
    decoded.value.departments.map((row) => [row.sourceDepartmentId, row.departmentId]),
  );

  if (
    acceptedDepartments.size !== decoded.value.departments.length ||
    snapshot.mappings.departments.some(
      (row) => acceptedDepartments.get(row.sourceDepartmentId) !== row.departmentId,
    )
  )
    return yield* new OrganizationCohortFailure({ code: "ReferenceProvenanceConflict" });

  const personSnapshot = yield* pgQuery(
    tx,
    `SELECT 1 FROM public.person_cohort_snapshots WHERE snapshot_key=$1 AND source_repository=$2 AND source_revision=$3 AND snapshot_id=$4 FOR SHARE`,
    [
      snapshot.personSnapshotKey,
      snapshot.sourceRepository,
      snapshot.sourceRevision,
      snapshot.snapshotId,
    ],
  );

  if (!personSnapshot.rowCount)
    return yield* new OrganizationCohortFailure({ code: "PersonSnapshotConflict" });

  const people = yield* pgQuery<{ source_user_id: string; person_id: string }>(
    tx,
    `SELECT a.source_user_id,i.person_id FROM public.person_cohort_accepted_mappings a JOIN public.person_cohort_imports i USING(source_repository,source_user_id) WHERE a.snapshot_key=$1 AND a.source_repository=$2 FOR SHARE`,
    [snapshot.personSnapshotKey, snapshot.sourceRepository],
  );

  const acceptedPeople = new Map(people.rows.map((row) => [row.source_user_id, row.person_id]));

  const persons = Object.fromEntries(
    snapshot.mappings.persons
      .filter((row) => acceptedPeople.get(row.sourceUserId) === row.personId)
      .map((row) => [row.sourceUserId.replace(/^legacy-user:/, ""), row.personId]),
  );

  const nativeDepartments = yield* pgQuery<
    Omit<LegacyDepartmentRow, "id"> & { departmentId: string }
  >(
    tx,
    `SELECT department_id AS "departmentId",name,short_name AS "shortName",email,address,city,latitude,longitude,slack_channel AS "slackChannel",logo_path AS "logoPath",active FROM public.organization_departments WHERE department_id=ANY($1::text[]) FOR SHARE`,
    [snapshot.mappings.departments.map((row) => row.departmentId)],
  );

  const departments = snapshot.mappings.departments.flatMap((mapping) => {
    const native = nativeDepartments.rows.find((row) => row.departmentId === mapping.departmentId);
    const sourceId = mapping.sourceDepartmentId.replace(/^legacy-department:/, "");

    if (!native || !/^-?\d+$/.test(sourceId) || !Number.isSafeInteger(Number(sourceId))) return [];
    const { departmentId: _departmentId, ...department } = native;

    return [{ ...department, id: Number(sourceId) }];
  });

  return { persons, departments };
});

/** Joins caller-owned cutover transactions; otherwise owns the entire cohort transaction. */
export const importReviewedOrganizationCohort = Effect.fn("importReviewedOrganizationCohort")(
  function* (pool: Pool, input: Schema.Json, client?: PoolClient) {
    const snapshot = yield* Effect.fromResult(decodeReviewedOrganizationSnapshot(input));

    const snapshotKey = organizationEvidenceDigest([
      snapshot.sourceRepository,
      snapshot.snapshotId,
    ]);

    const importInTransaction = Effect.fnUntraced(function* (tx: PoolClient) {
      yield* pgQuery(
        tx,
        "SELECT pg_advisory_xact_lock(hashtextextended('native-reviewed-organization-import',0))",
      );

      const prior = (yield* pgQuery<{ snapshot_digest: string }>(
        tx,
        "SELECT snapshot_digest FROM public.organization_cohort_snapshots WHERE snapshot_key=$1",
        [snapshotKey],
      )).rows[0];

      if (prior) {
        if (prior.snapshot_digest !== snapshot.snapshotDigest)
          return yield* new OrganizationCohortFailure({ code: "SnapshotConflict" });

        return yield* report(tx, snapshotKey, true);
      }

      for (const personId of [
        ...new Set(snapshot.mappings.persons.map((row) => row.personId)),
      ].sort())
        yield* pgQuery(
          tx,
          "SELECT pg_advisory_xact_lock(hashtextextended('vektorprogrammet:person-authorization:v1:' || $1,0))",
          [personId],
        );

      const sourceBindings = yield* pgQuery<{
        source_kind: string;
        source_id: string;
        source_digest: string;
      }>(
        tx,
        "SELECT source_kind,source_id,source_digest FROM public.organization_cohort_imports WHERE source_repository=$1 AND source_kind IN ('TeamMembership','BoardMembership')",
        [snapshot.sourceRepository],
      );

      const bindings = new Map(
        sourceBindings.rows.map((row) => [
          canonicalJson([row.source_kind, row.source_id]),
          row.source_digest,
        ]),
      );

      for (const occurrence of snapshot.occurrences) {
        const priorDigest = bindings.get(
          canonicalJson([occurrence.sourceKind, occurrence.sourceId]),
        );

        if (priorDigest && priorDigest !== organizationOccurrenceSourceDigest(snapshot, occurrence))
          return yield* new OrganizationCohortFailure({ code: "SourceConflict" });
      }

      const evidence = yield* resolvedEvidence(tx, snapshot);

      const classified = classifyReviewedOrganization(
        snapshot,
        evidence.persons,
        evidence.departments,
      );

      yield* pgQuery(
        tx,
        `INSERT INTO public.organization_cohort_snapshots(snapshot_key,source_repository,source_revision,snapshot_id,source_watermark,snapshot_digest,transformation_revision,person_snapshot_key,reference_digest,review,input_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb)`,
        [
          snapshotKey,
          snapshot.sourceRepository,
          snapshot.sourceRevision,
          snapshot.snapshotId,
          snapshot.sourceWatermark,
          snapshot.snapshotDigest,
          snapshot.transformationRevision,
          snapshot.personSnapshotKey,
          snapshot.referenceDigest,
          yield* encodeReview(snapshot.review),
          yield* encodeSnapshot(snapshot),
        ],
      );
      const outcomes = new Map(classified.outcomes.map((row) => [row.occurrenceId, row]));

      const existingSource = Effect.fnUntraced(function* (
        kind: string,
        sourceId: string,
        sourceDigest: string,
        targetId: string,
      ) {
        const prior = (yield* pgQuery<{ source_digest: string; target_id: string }>(
          tx,
          `SELECT source_digest,target_id FROM public.organization_cohort_imports WHERE source_repository=$1 AND source_kind=$2 AND source_id=$3`,
          [snapshot.sourceRepository, kind, sourceId],
        )).rows[0];

        if (prior && (prior.source_digest !== sourceDigest || prior.target_id !== targetId))
          return yield* new OrganizationCohortFailure({ code: "SourceConflict" });

        return prior !== undefined;
      });

      const recordSource = (
        kind: string,
        sourceId: string,
        sourceDigest: string,
        targetId: string,
      ) =>
        pgQuery(
          tx,
          `INSERT INTO public.organization_cohort_imports(source_repository,source_kind,source_id,source_digest,target_id,snapshot_key) VALUES($1,$2,$3,$4,$5,$6)`,
          [snapshot.sourceRepository, kind, sourceId, sourceDigest, targetId, snapshotKey],
        );

      for (const item of classified.appointments) {
        const { occurrence, membership, boardId, positionName, sourceDigest } = item;

        if (
          yield* existingSource(
            occurrence.sourceKind,
            occurrence.sourceId,
            sourceDigest,
            membership.membershipId,
          )
        ) {
          outcomes.set(occurrence.occurrenceId, {
            occurrenceId: occurrence.occurrenceId,
            result: "Accepted",
            reason: "ExactReplay",
            targetId: membership.membershipId,
          });
          continue;
        }

        yield* pgQuery(tx, "SAVEPOINT organization_appointment");
        let unitAvailable = true;

        if (membership.teamId !== null) {
          const team = classified.teams.find((team) => team.teamId === membership.teamId)!;

          const rawTeam = snapshot.teams.find(
            (raw) =>
              Predicate.isObjectOrArray(raw) &&
              "id" in raw &&
              organizationEvidenceDigest(["Team", snapshot.sourceRepository, String(raw.id)]) ===
                team.teamId.slice(4),
          );

          if (!Predicate.isObjectOrArray(rawTeam) || !("id" in rawTeam))
            return yield* new OrganizationCohortFailure({ code: "InvalidSnapshot" });
          const teamSourceId = String(rawTeam.id);

          const teamDigest = organizationEvidenceDigest({
            raw: rawTeam,
            teamId: team.teamId,
            departmentId: team.departmentId,
            transformationRevision: snapshot.transformationRevision,
          });

          if (!(yield* existingSource("Team", teamSourceId, teamDigest, team.teamId))) {
            const inserted = yield* pgQuery(
              tx,
              `INSERT INTO public.organization_teams(team_id,department_id,name,email,description,short_description,accept_application,deadline,active,revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,0) ON CONFLICT DO NOTHING RETURNING team_id`,
              [
                team.teamId,
                team.departmentId,
                team.name,
                team.email,
                team.description,
                team.shortDescription,
                team.acceptApplication,
                team.deadline,
                team.active,
              ],
            );

            unitAvailable = !!inserted.rowCount;

            if (unitAvailable) yield* recordSource("Team", teamSourceId, teamDigest, team.teamId);
          }
        } else if (boardId !== null) {
          const board = classified.boards.find((board) => board.boardId === boardId)!;

          const boardDigest = organizationEvidenceDigest({
            board,
            transformationRevision: snapshot.transformationRevision,
          });

          if (!(yield* existingSource("Board", String(board.id), boardDigest, boardId))) {
            const inserted = yield* pgQuery(
              tx,
              `INSERT INTO public.organization_national_boards(board_id,name) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING board_id`,
              [boardId, board.name],
            );

            unitAvailable = !!inserted.rowCount;

            if (unitAvailable) yield* recordSource("Board", String(board.id), boardDigest, boardId);
          }
        }

        if (unitAvailable && membership.teamId !== null)
          unitAvailable = !!(yield* pgQuery(
            tx,
            "SELECT 1 FROM public.organization_teams WHERE team_id=$1 FOR SHARE",
            [membership.teamId],
          )).rowCount;

        if (unitAvailable && boardId !== null)
          unitAvailable = !!(yield* pgQuery(
            tx,
            "SELECT 1 FROM public.organization_national_boards WHERE board_id=$1 FOR SHARE",
            [boardId],
          )).rowCount;
        let inserted = false;

        if (unitAvailable) {
          const result = yield* pgQuery(
            tx,
            `INSERT INTO public.organization_memberships(membership_id,person_id,team_id,deleted_team_name,start_at,end_at,position_id,is_team_leader,is_suspended,revision,board_id,position_name) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,0,$10,$11) ON CONFLICT DO NOTHING RETURNING membership_id`,
            [
              membership.membershipId,
              membership.personId,
              membership.teamId,
              membership.deletedTeamName,
              membership.startAt,
              membership.endAt,
              membership.positionId,
              membership.isTeamLeader,
              membership.isSuspended,
              boardId,
              positionName,
            ],
          );

          inserted = !!result.rowCount;
        }

        if (inserted)
          yield* recordSource(
            occurrence.sourceKind,
            occurrence.sourceId,
            sourceDigest,
            membership.membershipId,
          );
        else {
          yield* pgQuery(tx, "ROLLBACK TO SAVEPOINT organization_appointment");
          outcomes.set(occurrence.occurrenceId, {
            occurrenceId: occurrence.occurrenceId,
            result: "Quarantined",
            reason: "TargetConflict",
            targetId: null,
          });
        }

        yield* pgQuery(tx, "RELEASE SAVEPOINT organization_appointment");
      }

      if (![...outcomes.values()].some((row) => row.result === "Accepted"))
        return yield* new OrganizationCohortFailure({ code: "NoAcceptedAppointments" });

      for (const occurrence of snapshot.occurrences) {
        const row = outcomes.get(occurrence.occurrenceId)!;
        yield* pgQuery(
          tx,
          `INSERT INTO public.organization_cohort_occurrences(snapshot_key,occurrence_id,source_kind,source_id,source_row_digest,result,reason,target_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            snapshotKey,
            occurrence.occurrenceId,
            occurrence.sourceKind,
            occurrence.sourceId,
            occurrence.sourceRowDigest,
            row.result,
            row.reason,
            row.targetId,
          ],
        );
      }

      return yield* report(tx, snapshotKey, false);
    });

    return yield* client === undefined
      ? pgTransaction(pool, importInTransaction)
      : importInTransaction(client);
  },
);
