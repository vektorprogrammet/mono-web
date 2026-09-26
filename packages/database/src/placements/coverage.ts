import { Match, Effect, Schema } from "effect";
import type * as Statement from "effect/unstable/sql/Statement";
import { Database, type DatabaseOperations } from "../service.js";
import {
  CoverageBoard,
  CoverageCoverer,
  CoverageRosterAssignment,
  OwnCoverageView,
  PlacementFailure,
  SchoolServiceAbsence,
  SchoolServiceClosure,
  SchoolServiceCommitment,
  SchoolServiceCoverage,
  SchoolServiceOccurrence,
  schoolServiceAttendance,
  type CoverageCommand,
  type OwnCoverageCommand,
  type PlacementScope,
} from "@vektorprogrammet/domain/placements";
import type { PersonId } from "@vektorprogrammet/domain/organization";

const fail = (code: PlacementFailure["code"], status: PlacementFailure["status"] = 422) =>
  Effect.fail(new PlacementFailure({ code, status }));

const decode = <A>(schema: Schema.ConstraintDecoder<A, never>) =>
  Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" });

export const readSchoolServiceCommitments = (
  sql: DatabaseOperations,
  scope: PlacementScope,
  personId?: PersonId,
) =>
  Effect.gen(function* () {
    const rows = yield* sql`
    SELECT commitment.commitment_id AS "commitmentId", commitment.proposal_id AS "proposalId",
      commitment.department_id AS "departmentId", commitment.semester_id AS "semesterId",
      commitment.school_id::double precision AS "schoolId", commitment.school_name AS "schoolName",
      commitment.day, commitment.block, to_char(commitment.service_date,'YYYY-MM-DD') AS "serviceDate",
      to_char(commitment.start_time,'HH24:MI') AS "startTime",
      to_char(commitment.end_time,'HH24:MI') AS "endTime",
      commitment.required_volunteers AS "requiredVolunteers",
      commitment.assignment_snapshot AS assignments,
      to_char(commitment.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
      commitment.created_by_person_id AS "createdBy",
      CASE WHEN decision.commitment_id IS NULL THEN NULL ELSE jsonb_build_object(
        'outcome',decision.outcome,
        'decidedAt',to_char(decision.decided_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'decidedBy',decision.decided_by_person_id,'evidenceSource',decision.evidence_source,
        'reason',decision.reason,'attendedPersonIds',decision.attended_person_ids,
        'occurrenceId',decision.occurrence_id) END AS decision,
      (decision.commitment_id IS NULL AND
        (commitment.service_date+commitment.end_time) AT TIME ZONE 'Europe/Oslo' < CURRENT_TIMESTAMP) AS overdue
    FROM public.school_service_commitments AS commitment
    LEFT JOIN public.school_service_decisions AS decision USING(commitment_id)
    WHERE commitment.department_id=${scope.departmentId}
      AND commitment.semester_id=${scope.semesterId}
      ${
        personId === undefined
          ? sql``
          : sql`AND (
        EXISTS (SELECT 1 FROM jsonb_array_elements(commitment.assignment_snapshot) AS assignment
          WHERE assignment->>'personId'=${personId})
        OR (decision.outcome IS DISTINCT FROM 'Cancelled' AND EXISTS (
          SELECT 1 FROM public.school_service_absences AS absence
          JOIN public.school_service_coverage_records AS coverage USING(absence_id)
          WHERE absence.commitment_id=commitment.commitment_id
            AND coverage.covering_person_id=${personId} AND coverage.withdrawn_at IS NULL))
      )`
      }
    ORDER BY commitment.service_date,commitment.start_time,commitment.commitment_id
  `;

    return yield* decode(Schema.Array(SchoolServiceCommitment))(rows);
  });

const ensureCoverageScope = (sql: DatabaseOperations, scope: PlacementScope) =>
  Effect.gen(function* () {
    const rows = yield* sql`SELECT 1 FROM public.organization_departments AS department
      CROSS JOIN public.admission_period_semesters AS semester
      WHERE department.department_id=${scope.departmentId} AND semester.semester_id=${scope.semesterId}`;

    if (rows.length === 0) return yield* fail("scope.invalid");
  });

const openCommitment = (sql: DatabaseOperations, scope: PlacementScope, commitmentId: string) =>
  Effect.gen(function* () {
    const rows = yield* readSchoolServiceCommitments(sql, scope);
    const commitment = rows.find((entry) => entry.commitmentId === commitmentId);

    if (commitment === undefined) return yield* fail("resource.not-found", 404);

    if (commitment.decision !== null) return yield* fail("commitment.closed", 409);

    return commitment;
  });

const absenceRows = (sql: DatabaseOperations, where: Statement.Fragment) =>
  sql`
    SELECT absence.absence_id AS "absenceId",absence.commitment_id AS "commitmentId",absence.proposal_id AS "proposalId",
      absence.department_id AS "departmentId",absence.semester_id AS "semesterId",
      absence.person_id AS "personId",absence.school_id::double precision AS "schoolId",
      school.name AS "schoolName",absence.day,absence.block,
      to_char(absence.service_date,'YYYY-MM-DD') AS "serviceDate",
      absence.reporter_person_id AS "reporterPersonId",
      to_char(absence.reported_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "reportedAt"
    FROM public.school_service_absences AS absence
    JOIN public.schools_directory_schools AS school USING(school_id)
    WHERE ${where}
    ORDER BY absence.absence_id
  `;

/** Current coverage only: a withdrawn record is history in the coverage audit, not a fact of the absence. */
const coverageRows = (sql: DatabaseOperations, where: Statement.Fragment) =>
  sql`
    SELECT coverage.coverage_id AS "coverageId",coverage.absence_id AS "absenceId",
      coverage.covering_person_id AS "coveringPersonId",
      profile.first_name AS "coveringFirstName",profile.last_name AS "coveringLastName",
      coverage.coverer_kind AS "covererKind",coverage.recorded_by_person_id AS "recordedByPersonId",
      to_char(coverage.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "recordedAt"
    FROM public.school_service_coverage_records AS coverage
    JOIN public.school_service_absences AS absence USING(absence_id)
    JOIN public.person_profiles AS profile ON profile.person_id=coverage.covering_person_id
    WHERE coverage.withdrawn_at IS NULL AND ${where}
    ORDER BY coverage.absence_id
  `;

const closureRows = (sql: DatabaseOperations, where: Statement.Fragment) =>
  sql`
    SELECT closure.closure_id AS "closureId",closure.absence_id AS "absenceId",
      closure.occurrence_id AS "occurrenceId",
      closure.scheduled_person_id AS "scheduledPersonId",closure.outcome,
      closure.coverage_id AS "coverageId",
      closure.covering_person_id AS "coveringPersonId",
      closure.closed_by_person_id AS "closedByPersonId",
      to_char(closure.closed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "closedAt"
    FROM public.school_service_closures AS closure
    JOIN public.school_service_absences AS absence USING(absence_id)
    WHERE ${where}
    ORDER BY closure.closure_id
  `;

const occurrenceRows = (sql: DatabaseOperations, scope: PlacementScope) =>
  sql`
    SELECT occurrence.occurrence_id AS "occurrenceId",occurrence.commitment_id AS "commitmentId",occurrence.proposal_id AS "proposalId",
      occurrence.school_id::double precision AS "schoolId",school.name AS "schoolName",
      occurrence.day,occurrence.block,to_char(occurrence.occurred_on,'YYYY-MM-DD') AS "occurredOn",
      occurrence.attended_person_ids AS "attendedPersonIds",
      to_char(occurrence.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "recordedAt",
      occurrence.recorded_by_person_id AS "recordedBy"
    FROM public.school_service_occurrences AS occurrence
    JOIN public.schools_directory_schools AS school USING(school_id)
    WHERE occurrence.department_id=${scope.departmentId}
      AND occurrence.semester_id=${scope.semesterId}
    ORDER BY occurrence.occurred_on,occurrence.occurrence_id
  `;

const coverageRosterRows = (sql: DatabaseOperations, scope: PlacementScope) =>
  sql`
    SELECT proposal.proposal_id AS "proposalId",
      assignment->>'placementId' AS "placementId",
      assignment->>'personId' AS "personId",
      assignment->>'firstName' AS "firstName",
      assignment->>'lastName' AS "lastName",
      (assignment->>'schoolId')::double precision AS "schoolId",
      assignment->>'schoolName' AS "schoolName",
      assignment->>'day' AS day,
      assignment->>'block' AS block
    FROM public.school_service_proposals AS proposal
    CROSS JOIN LATERAL jsonb_array_elements(proposal.assignment_snapshot) AS assignment
    WHERE proposal.department_id=${scope.departmentId}
      AND proposal.semester_id=${scope.semesterId}
      AND proposal.status='Confirmed'
    ORDER BY proposal.proposal_id,(assignment->>'schoolId')::bigint,
      assignment->>'day',assignment->>'block',assignment->>'personId'
  `;

/**
 * People who can cover in the scope: an active placement makes an assistant; otherwise a Person
 * linked to an application of the scope whose current admission outcome is Substitute.
 */
const covererRows = (sql: DatabaseOperations, scope: PlacementScope, personId?: PersonId) =>
  sql`
    SELECT coverer.person_id AS "personId",profile.first_name AS "firstName",
      profile.last_name AS "lastName",coverer.kind
    FROM (
      SELECT DISTINCT ON (candidate.person_id) candidate.person_id,candidate.kind
      FROM (
        SELECT placement.person_id,'Assistant' AS kind,0 AS rank
        FROM public.assistant_placements AS placement
        WHERE placement.active
          AND placement.department_id=${scope.departmentId}
          AND placement.semester_id=${scope.semesterId}
        UNION ALL
        SELECT link.person_id,'Substitute' AS kind,1 AS rank
        FROM public.admission_applications AS application
        JOIN public.admission_periods AS period
          ON period.admission_period_id=application.admission_period_id
          AND period.department_id=application.department_id
        JOIN public.applicant_account_links AS link ON link.applicant_id=application.applicant_id
        JOIN LATERAL (
          SELECT outcome.outcome FROM public.admission_application_outcomes AS outcome
          WHERE outcome.application_id=application.application_id
          ORDER BY outcome.revision DESC LIMIT 1
        ) AS current ON current.outcome='Substitute'
        WHERE period.department_id=${scope.departmentId}
          AND period.semester_id=${scope.semesterId}
      ) AS candidate
      ${personId === undefined ? sql`` : sql`WHERE candidate.person_id=${personId}`}
      ORDER BY candidate.person_id,candidate.rank
    ) AS coverer
    JOIN public.person_profiles AS profile ON profile.person_id=coverer.person_id
    ORDER BY profile.last_name,profile.first_name,coverer.person_id
  `;

const readAbsenceForUpdate = (sql: DatabaseOperations, scope: PlacementScope, absenceId: string) =>
  Effect.gen(function* () {
    const rows = yield* sql`
      SELECT absence.absence_id AS "absenceId",absence.commitment_id AS "commitmentId",absence.proposal_id AS "proposalId",
        absence.department_id AS "departmentId",absence.semester_id AS "semesterId",
        absence.person_id AS "personId",absence.school_id::double precision AS "schoolId",
        school.name AS "schoolName",absence.day,absence.block,
        to_char(absence.service_date,'YYYY-MM-DD') AS "serviceDate",
        absence.reporter_person_id AS "reporterPersonId",
        to_char(absence.reported_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "reportedAt"
      FROM public.school_service_absences AS absence
      JOIN public.schools_directory_schools AS school USING(school_id)
      WHERE absence.absence_id=${absenceId}
        AND absence.department_id=${scope.departmentId}
        AND absence.semester_id=${scope.semesterId}
      FOR UPDATE OF absence
    `;

    const row = rows[0];

    if (row === undefined) return yield* fail("resource.not-found", 404);

    return yield* decode(SchoolServiceAbsence)(row);
  });

const currentCoverageForUpdate = (sql: DatabaseOperations, absenceId: string) =>
  Effect.map(
    sql<{ readonly coverageId: string; readonly coveringPersonId: string }>`
      SELECT coverage_id AS "coverageId",covering_person_id AS "coveringPersonId"
      FROM public.school_service_coverage_records
      WHERE absence_id=${absenceId} AND withdrawn_at IS NULL
      FOR UPDATE
    `,
    (rows) => rows[0],
  );

const writeAudit = (
  sql: DatabaseOperations,
  scope: PlacementScope,
  actor: PersonId,
  action:
    | "ReportAbsence"
    | "RecordCoverage"
    | "WithdrawCoverage"
    | "CompleteService"
    | "CancelService"
    | "MarkUnfulfilledService",
  now: string,
  snapshot: Schema.Json,
) =>
  sql`INSERT INTO public.school_service_coverage_audit(department_id,semester_id,actor_person_id,action,occurred_at,snapshot) VALUES(${scope.departmentId},${scope.semesterId},${actor},${action},${now},${sql.json(snapshot)})`;

export const readOwnCoverage = (scope: PlacementScope, personId: PersonId) =>
  Database.use((sql) =>
    Effect.gen(function* () {
      yield* ensureCoverageScope(sql, scope);

      const placements = yield* sql`
        SELECT x.placement_id AS "placementId",x.person_id AS "personId",
          x.department_id AS "departmentId",x.semester_id AS "semesterId",
          x.school_id::double precision AS "schoolId",x.day,x.workdays,x.block,x.active,x.revision,
          p.first_name AS "firstName",p.last_name AS "lastName",s.name AS "schoolName"
        FROM public.assistant_placements x
        JOIN public.person_profiles p USING(person_id)
        JOIN public.schools_directory_schools s USING(school_id)
        WHERE x.department_id=${scope.departmentId}
          AND x.semester_id=${scope.semesterId}
          AND x.person_id=${personId} AND x.active
        ORDER BY x.placement_id
      `;

      const rosterRows = yield* sql`
        SELECT proposal.proposal_id AS "proposalId",(assignment->>'schoolId')::double precision AS "schoolId",
          assignment->>'schoolName' AS "schoolName",assignment->>'day' AS day,assignment->>'block' AS block
        FROM public.school_service_proposals AS proposal
        CROSS JOIN LATERAL jsonb_array_elements(proposal.assignment_snapshot) AS assignment
        WHERE proposal.department_id=${scope.departmentId}
          AND proposal.semester_id=${scope.semesterId}
          AND proposal.status='Confirmed'
          AND assignment->>'personId'=${personId}
        ORDER BY proposal.confirmed_at DESC,proposal.proposal_id,assignment->>'schoolId',assignment->>'day',assignment->>'block'
      `;

      const absences = yield* decode(Schema.Array(SchoolServiceAbsence))(
        yield* absenceRows(
          sql,
          sql`absence.department_id=${scope.departmentId} AND absence.semester_id=${scope.semesterId} AND absence.person_id=${personId}`,
        ),
      );

      // A cancelled service ends the duty of whoever covers it (its reservation is released), so
      // the coverer no longer reads it; the absent person keeps the record with the absence.
      const coverage = yield* decode(Schema.Array(SchoolServiceCoverage))(
        yield* coverageRows(
          sql,
          sql`absence.department_id=${scope.departmentId} AND absence.semester_id=${scope.semesterId}
            AND (absence.person_id=${personId} OR (coverage.covering_person_id=${personId}
              AND NOT EXISTS (SELECT 1 FROM public.school_service_decisions AS decision
                WHERE decision.commitment_id=absence.commitment_id AND decision.outcome='Cancelled')))`,
        ),
      );

      const commitments = yield* readSchoolServiceCommitments(sql, scope, personId);

      // Names of possible coverers are shown only to a person who has an absence to cover.
      const hasOpenAbsence = absences.some((absence) =>
        commitments.some(
          (commitment) =>
            commitment.commitmentId === absence.commitmentId && commitment.decision === null,
        ),
      );

      const coverers = hasOpenAbsence
        ? (yield* decode(Schema.Array(CoverageCoverer))(yield* covererRows(sql, scope))).filter(
            (coverer) => coverer.personId !== personId,
          )
        : [];

      return yield* decode(OwnCoverageView)({
        ...scope,
        personId,
        placements,
        rosterSlots: rosterRows,
        commitments,
        absences,
        coverage,
        coverers,
      });
    }),
  );

export const readCoverageBoard = (scope: PlacementScope) =>
  Database.use((sql) =>
    Effect.gen(function* () {
      yield* ensureCoverageScope(sql, scope);

      const inScope = sql`absence.department_id=${scope.departmentId} AND absence.semester_id=${scope.semesterId}`;

      return yield* decode(CoverageBoard)({
        ...scope,
        rosterAssignments: yield* decode(Schema.Array(CoverageRosterAssignment))(
          yield* coverageRosterRows(sql, scope),
        ),
        commitments: yield* readSchoolServiceCommitments(sql, scope),
        absences: yield* decode(Schema.Array(SchoolServiceAbsence))(
          yield* absenceRows(sql, inScope),
        ),
        coverage: yield* decode(Schema.Array(SchoolServiceCoverage))(
          yield* coverageRows(sql, inScope),
        ),
        coverers: yield* decode(Schema.Array(CoverageCoverer))(yield* covererRows(sql, scope)),
        closures: yield* decode(Schema.Array(SchoolServiceClosure))(
          yield* closureRows(sql, inScope),
        ),
        occurrences: yield* decode(Schema.Array(SchoolServiceOccurrence))(
          yield* occurrenceRows(sql, scope),
        ),
      });
    }),
  );

const reportAbsence = (
  sql: DatabaseOperations,
  scope: PlacementScope,
  input: { readonly personId: PersonId; readonly commitmentId: string },
  reporter: PersonId,
  now: string,
  absenceId: string,
) =>
  Effect.gen(function* () {
    const commitment = yield* openCommitment(sql, scope, input.commitmentId);

    if (!commitment.assignments.some((assignment) => assignment.personId === input.personId)) {
      return yield* fail("absence.target-invalid");
    }

    const duplicate = yield* sql`SELECT absence_id FROM public.school_service_absences
    WHERE commitment_id=${commitment.commitmentId} AND person_id=${input.personId} FOR UPDATE`;

    if (duplicate.length > 0) return yield* fail("absence.duplicate", 409);
    yield* sql`INSERT INTO public.school_service_absences(
    absence_id,commitment_id,proposal_id,department_id,semester_id,person_id,school_id,day,block,
    service_date,reporter_person_id,reported_at
  ) VALUES(${absenceId},${commitment.commitmentId},${commitment.proposalId},${scope.departmentId},
    ${scope.semesterId},${input.personId},${commitment.schoolId},${commitment.day},
    ${commitment.block},CAST(${commitment.serviceDate} AS date),${reporter},${now})`;
    yield* writeAudit(sql, scope, reporter, "ReportAbsence", now, { absenceId, ...input });
  });

/** Locks a live absence of an open commitment; an own command must name the actor's absence. */
const openAbsence = (
  sql: DatabaseOperations,
  scope: PlacementScope,
  absenceId: string,
  owner: PersonId | null,
) =>
  Effect.gen(function* () {
    const absence = yield* readAbsenceForUpdate(sql, scope, absenceId);

    if (owner !== null && absence.personId !== owner) {
      return yield* fail("coverage.owner-invalid", 403);
    }

    const commitment = yield* openCommitment(sql, scope, absence.commitmentId ?? "");

    return { absence, commitment };
  });

const recordCoverage = (
  sql: DatabaseOperations,
  scope: PlacementScope,
  input: { readonly absenceId: string; readonly coveringPersonId: PersonId },
  owner: PersonId | null,
  actor: PersonId,
  now: string,
  coverageId: string,
) =>
  Effect.gen(function* () {
    const { absence, commitment } = yield* openAbsence(sql, scope, input.absenceId, owner);
    const current = yield* currentCoverageForUpdate(sql, absence.absenceId);

    if (current?.coveringPersonId === input.coveringPersonId) return;

    const coverer =
      input.coveringPersonId === absence.personId
        ? undefined
        : (yield* decode(Schema.Array(CoverageCoverer))(
            yield* covererRows(sql, scope, input.coveringPersonId),
          ))[0];

    if (coverer === undefined) return yield* fail("coverage.coverer-ineligible");

    // Scheduled on this or an overlapping service, or covering another absence at the same time.
    const busy = yield* sql`SELECT 1 FROM public.school_service_person_reservations
      WHERE person_id=${input.coveringPersonId}
        AND service_interval && tsrange(
          CAST(${commitment.serviceDate} AS date)+CAST(${commitment.startTime} AS time),
          CAST(${commitment.serviceDate} AS date)+CAST(${commitment.endTime} AS time),'[)')
      LIMIT 1`;

    if (busy.length > 0) return yield* fail("coverage.coverer-unavailable", 409);

    if (current !== undefined) {
      yield* sql`UPDATE public.school_service_coverage_records
        SET withdrawn_by_person_id=${actor},withdrawn_at=${now}
        WHERE coverage_id=${current.coverageId} AND withdrawn_at IS NULL`;
    }

    yield* sql`INSERT INTO public.school_service_coverage_records(
      coverage_id,absence_id,covering_person_id,coverer_kind,recorded_by_person_id,recorded_at
    ) VALUES(${coverageId},${absence.absenceId},${input.coveringPersonId},${coverer.kind},${actor},${now})`;
    yield* writeAudit(sql, scope, actor, "RecordCoverage", now, {
      coverageId,
      absenceId: absence.absenceId,
      coveringPersonId: input.coveringPersonId,
      covererKind: coverer.kind,
      replacedCoverageId: current?.coverageId ?? null,
    });
  });

const withdrawCoverage = (
  sql: DatabaseOperations,
  scope: PlacementScope,
  absenceId: string,
  owner: PersonId | null,
  actor: PersonId,
  now: string,
) =>
  Effect.gen(function* () {
    const { absence } = yield* openAbsence(sql, scope, absenceId, owner);
    const current = yield* currentCoverageForUpdate(sql, absence.absenceId);

    if (current === undefined) return yield* fail("coverage.not-recorded", 409);
    yield* sql`UPDATE public.school_service_coverage_records
      SET withdrawn_by_person_id=${actor},withdrawn_at=${now}
      WHERE coverage_id=${current.coverageId} AND withdrawn_at IS NULL`;
    yield* writeAudit(sql, scope, actor, "WithdrawCoverage", now, {
      coverageId: current.coverageId,
      absenceId: absence.absenceId,
    });
  });

export const mutateOwnCoverage = (
  scope: PlacementScope,
  command: OwnCoverageCommand,
  actor: PersonId,
  now: string,
  ids: { readonly absenceId: string; readonly coverageId: string },
) =>
  Database.use((sql) =>
    Effect.gen(function* () {
      switch (command.action) {
        case "ReportAbsence":
          yield* reportAbsence(
            sql,
            scope,
            { ...command, personId: actor },
            actor,
            now,
            ids.absenceId,
          );
          break;
        case "RecordCoverage":
          yield* recordCoverage(sql, scope, command, actor, actor, now, ids.coverageId);
          break;
        case "WithdrawCoverage":
          yield* withdrawCoverage(sql, scope, command.absenceId, actor, actor, now);
          break;
      }

      return yield* readOwnCoverage(scope, actor);
    }),
  );

const decideService = (
  sql: DatabaseOperations,
  scope: PlacementScope,
  command: Extract<
    CoverageCommand,
    { readonly action: "CompleteService" | "CancelService" | "MarkUnfulfilledService" }
  >,
  actor: PersonId,
  now: string,
  occurrenceId: string,
) =>
  Effect.gen(function* () {
    const commitment = yield* openCommitment(sql, scope, command.commitmentId);

    if (command.action !== "CancelService") {
      const ended = yield* sql`SELECT 1 WHERE
      (CAST(${commitment.serviceDate} AS date)+CAST(${commitment.endTime} AS time)) AT TIME ZONE 'Europe/Oslo' <= CAST(${now} AS timestamptz)`;

      if (ended.length === 0) return yield* fail("commitment.outcome-invalid");
    }

    const onCommitment = sql`absence.commitment_id=${commitment.commitmentId}`;

    const absences = yield* decode(Schema.Array(SchoolServiceAbsence))(
      yield* absenceRows(sql, onCommitment),
    );

    const coverage = yield* decode(Schema.Array(SchoolServiceCoverage))(
      yield* coverageRows(sql, onCommitment),
    );

    const attendees =
      command.action === "CancelService"
        ? []
        : schoolServiceAttendance(commitment, absences, coverage);

    if (
      (command.action === "CompleteService" && attendees.length < commitment.requiredVolunteers) ||
      (command.action === "MarkUnfulfilledService" &&
        attendees.length >= commitment.requiredVolunteers)
    ) {
      return yield* fail("commitment.outcome-invalid");
    }

    const outcome = Match.value(command.action).pipe(
      Match.when("CompleteService", () => "Completed" as const),
      Match.when("CancelService", () => "Cancelled" as const),
      Match.orElse(() => "Unfulfilled" as const),
    );

    const linkedOccurrenceId = attendees.length > 0 ? occurrenceId : null;
    const reason = command.action === "CompleteService" ? null : command.reason;
    yield* sql`INSERT INTO public.school_service_decisions(
    commitment_id,outcome,decided_at,decided_by_person_id,evidence_source,reason,attended_person_ids,occurrence_id
  ) VALUES(${commitment.commitmentId},${outcome},${now},${actor},${command.evidenceSource},${reason},
    ${sql.json(attendees)},${linkedOccurrenceId})`;

    if (linkedOccurrenceId !== null) {
      yield* sql`INSERT INTO public.school_service_occurrences(
      occurrence_id,commitment_id,proposal_id,department_id,semester_id,school_id,day,block,
      occurred_on,attended_person_ids,recorded_at,recorded_by_person_id
    ) VALUES(${linkedOccurrenceId},${commitment.commitmentId},${commitment.proposalId},
      ${scope.departmentId},${scope.semesterId},${commitment.schoolId},${commitment.day},
      ${commitment.block},CAST(${commitment.serviceDate} AS date),${sql.json(attendees)},${now},${actor})`;
    }

    if (outcome !== "Cancelled") {
      const coverageByAbsence = new Map(coverage.map((record) => [record.absenceId, record]));

      yield* Effect.forEach(
        absences,
        (absence) => {
          const covered = coverageByAbsence.get(absence.absenceId);

          const closureId = absence.absenceId.replace(
            "school-service-absence-",
            "school-service-closure-",
          );

          return sql`INSERT INTO public.school_service_closures(
        closure_id,absence_id,occurrence_id,scheduled_person_id,outcome,coverage_id,
        covering_person_id,closed_by_person_id,closed_at
      ) VALUES(${closureId},${absence.absenceId},${linkedOccurrenceId},${absence.personId},
        ${covered === undefined ? "Uncovered" : "Covered"},
        ${covered?.coverageId ?? null},${covered?.coveringPersonId ?? null},
        ${actor},${now})`;
        },
        { discard: true },
      );
    }

    yield* writeAudit(sql, scope, actor, command.action, now, {
      ...command,
      attendedPersonIds: [...attendees],
      occurrenceId: linkedOccurrenceId,
      outcome,
    });
  });

export const mutateCoverageBoard = (
  scope: PlacementScope,
  command: CoverageCommand,
  actor: PersonId,
  now: string,
  ids: {
    readonly absenceId: string;
    readonly coverageId: string;
    readonly occurrenceId: string;
  },
) =>
  Database.use((sql) =>
    Effect.gen(function* () {
      switch (command.action) {
        case "ReportAbsenceForVolunteer":
          yield* reportAbsence(sql, scope, command, actor, now, ids.absenceId);
          break;
        case "RecordCoverage":
          yield* recordCoverage(sql, scope, command, null, actor, now, ids.coverageId);
          break;
        case "WithdrawCoverage":
          yield* withdrawCoverage(sql, scope, command.absenceId, null, actor, now);
          break;
        case "CompleteService":
        case "CancelService":
        case "MarkUnfulfilledService":
          yield* decideService(sql, scope, command, actor, now, ids.occurrenceId);
          break;
      }

      return yield* readCoverageBoard(scope);
    }),
  );
