import { Match, Effect, Schema } from "effect";
import type * as Statement from "effect/unstable/sql/Statement";
import { Database, type DatabaseOperations } from "@vektorprogrammet/database";
import {
  CoverageBoard,
  CoverageRosterAssignment,
  OwnCoverageView,
  PlacementFailure,
  SchoolServiceAbsence,
  SchoolServiceClosure,
  SchoolServiceCommitment,
  isEligibleSchoolServiceAttendance,
  SchoolServiceCoverageAcknowledgement,
  SchoolServiceDispatchNotification,
  SchoolServiceDispatchNotificationRequest,
  SchoolServiceOfferResponse,
  SchoolServiceOccurrence,
  SchoolServiceSubstituteOffer,
  type CoverageCommand,
  type OwnCoverageCommand,
  type PlacementScope,
  type SchoolServiceAbsence as SchoolServiceAbsenceType,
} from "@vektorprogrammet/placements/contracts";
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
        OR EXISTS (SELECT 1 FROM public.school_service_absences AS absence
          JOIN public.school_service_coverage_acknowledgements AS acknowledgement USING(absence_id)
          WHERE absence.commitment_id=commitment.commitment_id AND acknowledgement.candidate_person_id=${personId})
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

const offerRows = (sql: DatabaseOperations, where: Statement.Fragment) =>
  sql`
    SELECT offer.offer_id AS "offerId",offer.absence_id AS "absenceId",
      absence.proposal_id AS "proposalId",absence.department_id AS "departmentId",
      absence.semester_id AS "semesterId",offer.candidate_person_id AS "candidatePersonId",
      candidate.first_name AS "candidateFirstName",candidate.last_name AS "candidateLastName",
      absence.school_id::double precision AS "schoolId",offer.school_name_snapshot AS "schoolName",
      absence.day,absence.block,to_char(absence.service_date,'YYYY-MM-DD') AS "serviceDate",
      to_char(commitment.start_time,'HH24:MI') AS "startTime",to_char(commitment.end_time,'HH24:MI') AS "endTime",
      offer.dispatcher_person_id AS "dispatcherPersonId",
      to_char(offer.dispatched_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "dispatchedAt",
      offer.status,offer.revision,offer.eligibility_snapshot AS "eligibilitySnapshot"
    FROM public.school_service_substitute_offers AS offer
    JOIN public.school_service_absences AS absence USING(absence_id)
    JOIN public.person_profiles AS candidate ON candidate.person_id=offer.candidate_person_id
    LEFT JOIN public.school_service_commitments AS commitment ON commitment.commitment_id=absence.commitment_id
    WHERE ${where}
    ORDER BY offer.offer_id
  `;

const responseRows = (sql: DatabaseOperations, where: Statement.Fragment) =>
  sql`
    SELECT response.offer_id AS "offerId",response.absence_id AS "absenceId",response.response,
      response.responder_person_id AS "responderPersonId",
      to_char(response.responded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "respondedAt"
    FROM public.school_service_substitute_offer_responses AS response
    JOIN public.school_service_substitute_offers AS offer
      ON offer.offer_id=response.offer_id AND offer.absence_id=response.absence_id
    JOIN public.school_service_absences AS absence ON absence.absence_id=offer.absence_id
    WHERE ${where}
    ORDER BY response.offer_id
  `;

const notificationRows = (sql: DatabaseOperations, where: Statement.Fragment) =>
  sql`
    SELECT notification.effect_id AS "effectId",notification.offer_id AS "offerId",
      notification.absence_id AS "absenceId",notification.person_id AS "personId",notification.status,
      notification.attempts,
      CASE WHEN notification.delivered_at IS NULL THEN NULL
        ELSE to_char(notification.delivered_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      END AS "deliveredAt",notification.last_failure_tag AS "lastFailureTag"
    FROM public.school_service_dispatch_notification_outbox AS notification
    JOIN public.school_service_substitute_offers AS offer
      ON offer.offer_id=notification.offer_id AND offer.absence_id=notification.absence_id
    JOIN public.school_service_absences AS absence ON absence.absence_id=offer.absence_id
    WHERE ${where}
    ORDER BY notification.effect_id
  `;

const acknowledgementRows = (sql: DatabaseOperations, where: Statement.Fragment) =>
  sql`
    SELECT acknowledgement.acknowledgement_id AS "acknowledgementId",
      acknowledgement.offer_id AS "offerId",acknowledgement.absence_id AS "absenceId",
      acknowledgement.candidate_person_id AS "candidatePersonId",
      acknowledgement.acknowledged_by_person_id AS "acknowledgedByPersonId",
      to_char(acknowledgement.acknowledged_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "acknowledgedAt"
    FROM public.school_service_coverage_acknowledgements AS acknowledgement
    JOIN public.school_service_absences AS absence USING(absence_id)
    WHERE ${where}
    ORDER BY acknowledgement.acknowledgement_id
  `;

const closureRows = (sql: DatabaseOperations, where: Statement.Fragment) =>
  sql`
    SELECT closure.closure_id AS "closureId",closure.absence_id AS "absenceId",
      closure.occurrence_id AS "occurrenceId",
      closure.scheduled_person_id AS "scheduledPersonId",closure.outcome,
      closure.acknowledgement_id AS "acknowledgementId",
      closure.substitute_person_id AS "substitutePersonId",
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

const readOfferForUpdate = (sql: DatabaseOperations, scope: PlacementScope, offerId: string) =>
  Effect.gen(function* () {
    const rows = yield* sql`
      SELECT offer.offer_id AS "offerId",offer.absence_id AS "absenceId",
        absence.proposal_id AS "proposalId",absence.department_id AS "departmentId",
        absence.semester_id AS "semesterId",offer.candidate_person_id AS "candidatePersonId",
        candidate.first_name AS "candidateFirstName",candidate.last_name AS "candidateLastName",
        absence.school_id::double precision AS "schoolId",offer.school_name_snapshot AS "schoolName",
        absence.day,absence.block,to_char(absence.service_date,'YYYY-MM-DD') AS "serviceDate",
        to_char(commitment.start_time,'HH24:MI') AS "startTime",to_char(commitment.end_time,'HH24:MI') AS "endTime",
        offer.dispatcher_person_id AS "dispatcherPersonId",
        to_char(offer.dispatched_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "dispatchedAt",
        offer.status,offer.revision,offer.eligibility_snapshot AS "eligibilitySnapshot"
      FROM public.school_service_substitute_offers AS offer
      JOIN public.school_service_absences AS absence USING(absence_id)
      JOIN public.person_profiles AS candidate ON candidate.person_id=offer.candidate_person_id
      LEFT JOIN public.school_service_commitments AS commitment ON commitment.commitment_id=absence.commitment_id
      WHERE offer.offer_id=${offerId}
        AND absence.department_id=${scope.departmentId}
        AND absence.semester_id=${scope.semesterId}
      FOR UPDATE OF offer
    `;

    const row = rows[0];

    if (row === undefined) return yield* fail("resource.not-found", 404);

    return yield* decode(SchoolServiceSubstituteOffer)(row);
  });

/** Candidate identity is only canonical through applicant_account_links. */
const eligibilitySnapshot = (
  sql: DatabaseOperations,
  scope: PlacementScope,
  absence: SchoolServiceAbsenceType,
  candidatePersonId: PersonId,
  checkedAt: string,
) =>
  Effect.gen(function* () {
    const rows = yield* sql<{
      readonly applicationId: string;
    }>`
      SELECT application.application_id AS "applicationId"
      FROM public.admission_substitute_preferences AS preferences
      JOIN public.admission_applications AS application
        ON application.application_id=preferences.application_id
      JOIN public.admission_periods AS period
        ON period.admission_period_id=application.admission_period_id
        AND period.department_id=application.department_id
      JOIN public.applicant_account_links AS link
        ON link.applicant_id=application.applicant_id
      JOIN public.organization_volunteer_affiliations AS affiliation
        ON affiliation.person_id=link.person_id
        AND affiliation.department_id=${scope.departmentId}
      WHERE preferences.active
        AND affiliation.status='Active'
        AND link.person_id=${candidatePersonId}
        AND period.department_id=${scope.departmentId}
        AND period.semester_id=${scope.semesterId}
        AND CASE ${absence.day}
          WHEN 'Monday' THEN preferences.monday
          WHEN 'Tuesday' THEN preferences.tuesday
          WHEN 'Wednesday' THEN preferences.wednesday
          WHEN 'Thursday' THEN preferences.thursday
          WHEN 'Friday' THEN preferences.friday
          ELSE false
        END
        AND link.person_id<>${absence.personId}
        AND NOT EXISTS (
          SELECT 1
          FROM public.school_service_proposals AS proposal
          CROSS JOIN LATERAL jsonb_array_elements(proposal.assignment_snapshot) AS assignment
          WHERE proposal.proposal_id=${absence.proposalId}
            AND assignment->>'personId'=link.person_id
            AND (assignment->>'schoolId')::bigint=${absence.schoolId}
            AND assignment->>'day'=${absence.day}
            AND assignment->>'block'=${absence.block}
        )
        AND NOT EXISTS (
          SELECT 1
          FROM public.assistant_placements AS placement
          WHERE placement.active
            AND placement.person_id=link.person_id
            AND placement.semester_id=${scope.semesterId}
            AND placement.day=${absence.day}
            AND placement.block IN (${absence.block},'Both')
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.school_service_person_reservations AS reservation
          JOIN public.school_service_commitments AS target ON target.commitment_id=${absence.commitmentId}
          WHERE reservation.person_id=link.person_id
            AND reservation.service_interval && tsrange(target.service_date+target.start_time,target.service_date+target.end_time,'[)')
        )
      ORDER BY application.application_id
      LIMIT 1
    `;

    const row = rows[0];

    if (row === undefined) return yield* fail("offer.candidate-ineligible");

    return {
      applicationId: row.applicationId,
      candidatePersonId,
      activeAffiliation: true as const,
      activePool: true as const,
      weekdayAvailable: true as const,
      placementConflict: false as const,
      acknowledgedCoverageConflict: false as const,
      checkedAt,
    };
  });

const writeAudit = (
  sql: DatabaseOperations,
  scope: PlacementScope,
  actor: PersonId,
  action:
    | "ReportAbsence"
    | "DispatchSubstituteOffer"
    | "RespondToOffer"
    | "WithdrawSubstituteOffer"
    | "AcknowledgeCoverage"
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

      const offers = yield* decode(Schema.Array(SchoolServiceSubstituteOffer))(
        yield* offerRows(
          sql,
          sql`absence.department_id=${scope.departmentId} AND absence.semester_id=${scope.semesterId} AND offer.candidate_person_id=${personId}`,
        ),
      );

      const responses = yield* decode(Schema.Array(SchoolServiceOfferResponse))(
        yield* responseRows(
          sql,
          sql`absence.department_id=${scope.departmentId} AND absence.semester_id=${scope.semesterId} AND offer.candidate_person_id=${personId}`,
        ),
      );

      const dispatchNotifications = yield* decode(Schema.Array(SchoolServiceDispatchNotification))(
        yield* notificationRows(
          sql,
          sql`absence.department_id=${scope.departmentId} AND absence.semester_id=${scope.semesterId} AND notification.person_id=${personId}`,
        ),
      );

      return yield* decode(OwnCoverageView)({
        ...scope,
        personId,
        rosterSlots: rosterRows,
        commitments: yield* readSchoolServiceCommitments(sql, scope, personId),
        absences,
        offers,
        responses,
        dispatchNotifications,
      });
    }),
  );

export const readCoverageBoard = (scope: PlacementScope) =>
  Database.use((sql) =>
    Effect.gen(function* () {
      yield* ensureCoverageScope(sql, scope);

      const absences = yield* decode(Schema.Array(SchoolServiceAbsence))(
        yield* absenceRows(
          sql,
          sql`absence.department_id=${scope.departmentId} AND absence.semester_id=${scope.semesterId}`,
        ),
      );

      const offers = yield* decode(Schema.Array(SchoolServiceSubstituteOffer))(
        yield* offerRows(
          sql,
          sql`absence.department_id=${scope.departmentId} AND absence.semester_id=${scope.semesterId}`,
        ),
      );

      const responses = yield* decode(Schema.Array(SchoolServiceOfferResponse))(
        yield* responseRows(
          sql,
          sql`absence.department_id=${scope.departmentId} AND absence.semester_id=${scope.semesterId}`,
        ),
      );

      const acknowledgements = yield* decode(Schema.Array(SchoolServiceCoverageAcknowledgement))(
        yield* acknowledgementRows(
          sql,
          sql`absence.department_id=${scope.departmentId} AND absence.semester_id=${scope.semesterId}`,
        ),
      );

      const rosterAssignments = yield* decode(Schema.Array(CoverageRosterAssignment))(
        yield* coverageRosterRows(sql, scope),
      );

      const closures = yield* decode(Schema.Array(SchoolServiceClosure))(
        yield* closureRows(
          sql,
          sql`absence.department_id=${scope.departmentId} AND absence.semester_id=${scope.semesterId}`,
        ),
      );

      const dispatchNotifications = yield* decode(Schema.Array(SchoolServiceDispatchNotification))(
        yield* notificationRows(
          sql,
          sql`absence.department_id=${scope.departmentId} AND absence.semester_id=${scope.semesterId}`,
        ),
      );

      const occurrences = yield* decode(Schema.Array(SchoolServiceOccurrence))(
        yield* occurrenceRows(sql, scope),
      );

      const candidates = yield* sql`
        SELECT DISTINCT ON (absence.absence_id,link.person_id)
          absence.absence_id AS "absenceId",application.application_id AS "applicationId",
          link.person_id AS "personId",profile.first_name AS "firstName",profile.last_name AS "lastName"
        FROM public.school_service_absences AS absence
        JOIN public.admission_substitute_preferences AS preferences ON preferences.active
        JOIN public.admission_applications AS application
          ON application.application_id=preferences.application_id
        JOIN public.admission_periods AS period
          ON period.admission_period_id=application.admission_period_id
          AND period.department_id=application.department_id
        JOIN public.admission_applicants AS applicant ON applicant.applicant_id=application.applicant_id
        JOIN public.applicant_account_links AS link ON link.applicant_id=application.applicant_id
        JOIN public.person_profiles AS profile ON profile.person_id=link.person_id
        JOIN public.organization_volunteer_affiliations AS affiliation
          ON affiliation.person_id=link.person_id
          AND affiliation.department_id=${scope.departmentId}
          AND affiliation.status='Active'
        WHERE absence.department_id=${scope.departmentId}
          AND absence.semester_id=${scope.semesterId}
          AND absence.commitment_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM public.school_service_decisions AS decision WHERE decision.commitment_id=absence.commitment_id)
          AND NOT EXISTS (SELECT 1 FROM public.school_service_closures AS closure WHERE closure.absence_id=absence.absence_id)
          AND period.department_id=${scope.departmentId}
          AND period.semester_id=${scope.semesterId}
          AND link.person_id<>absence.person_id
          AND CASE absence.day
            WHEN 'Monday' THEN preferences.monday
            WHEN 'Tuesday' THEN preferences.tuesday
            WHEN 'Wednesday' THEN preferences.wednesday
            WHEN 'Thursday' THEN preferences.thursday
            WHEN 'Friday' THEN preferences.friday
            ELSE false
          END
          AND NOT EXISTS (
            SELECT 1
            FROM public.school_service_proposals AS proposal
            CROSS JOIN LATERAL jsonb_array_elements(proposal.assignment_snapshot) AS assignment
            WHERE proposal.proposal_id=absence.proposal_id
              AND assignment->>'personId'=link.person_id
              AND (assignment->>'schoolId')::bigint=absence.school_id
              AND assignment->>'day'=absence.day
              AND assignment->>'block'=absence.block
          )
          AND NOT EXISTS (
            SELECT 1 FROM public.assistant_placements AS placement
            WHERE placement.active
              AND placement.person_id=link.person_id
              AND placement.semester_id=${scope.semesterId}
              AND placement.day=absence.day
              AND placement.block IN (absence.block,'Both')
          )
          AND NOT EXISTS (
            SELECT 1 FROM public.school_service_person_reservations AS reservation
            JOIN public.school_service_commitments AS target ON target.commitment_id=absence.commitment_id
            WHERE reservation.person_id=link.person_id
              AND reservation.service_interval && tsrange(target.service_date+target.start_time,target.service_date+target.end_time,'[)')
          )
        ORDER BY absence.absence_id,link.person_id,application.application_id
      `;

      return yield* decode(CoverageBoard)({
        ...scope,
        absences,
        rosterAssignments,
        commitments: yield* readSchoolServiceCommitments(sql, scope),
        candidates,
        offers,
        responses,
        acknowledgements,
        closures,
        dispatchNotifications,
        occurrences,
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

const respondToOffer = (
  sql: DatabaseOperations,
  scope: PlacementScope,
  command: Extract<OwnCoverageCommand, { readonly action: "RespondToOffer" }>,
  actor: PersonId,
  now: string,
) =>
  Effect.gen(function* () {
    const offer = yield* readOfferForUpdate(sql, scope, command.offerId);

    if (offer.candidatePersonId !== actor) return yield* fail("offer.owner-invalid", 403);

    if (offer.status !== "Offered") return yield* fail("offer.response-invalid", 409);
    const absence = yield* readAbsenceForUpdate(sql, scope, offer.absenceId);
    yield* openCommitment(sql, scope, absence.commitmentId ?? "");
    const status = command.response === "Accept" ? "Accepted" : "Declined";
    yield* sql`UPDATE public.school_service_substitute_offers SET status=${status},revision=revision+1 WHERE offer_id=${offer.offerId} AND status='Offered'`;
    yield* sql`
      INSERT INTO public.school_service_substitute_offer_responses(
        offer_id,absence_id,response,responder_person_id,responded_at
      ) VALUES(${offer.offerId},${offer.absenceId},${command.response},${actor},${now})
    `;
    yield* writeAudit(sql, scope, actor, "RespondToOffer", now, {
      offerId: offer.offerId,
      response: command.response,
    });
  });

export const mutateOwnCoverage = (
  scope: PlacementScope,
  command: OwnCoverageCommand,
  actor: PersonId,
  now: string,
  absenceId: string,
) =>
  Database.use((sql) =>
    Effect.gen(function* () {
      if (command.action === "ReportAbsence") {
        yield* reportAbsence(sql, scope, { ...command, personId: actor }, actor, now, absenceId);
      } else {
        yield* respondToOffer(sql, scope, command, actor, now);
      }

      return yield* readOwnCoverage(scope, actor);
    }),
  );

const dispatchOffer = (
  sql: DatabaseOperations,
  scope: PlacementScope,
  command: Extract<CoverageCommand, { readonly action: "DispatchSubstituteOffer" }>,
  actor: PersonId,
  now: string,
  offerId: string,
) =>
  Effect.gen(function* () {
    const absence = yield* readAbsenceForUpdate(sql, scope, command.absenceId);
    const commitment = yield* openCommitment(sql, scope, absence.commitmentId ?? "");

    const active = yield* sql`
      SELECT offer_id FROM public.school_service_substitute_offers
      WHERE absence_id=${absence.absenceId}
        AND status IN ('Offered','Accepted','Acknowledged')
      FOR UPDATE
    `;

    if (active.length > 0) return yield* fail("offer.unresolved", 409);

    const snapshot = yield* eligibilitySnapshot(
      sql,
      scope,
      absence,
      command.candidatePersonId,
      now,
    );

    yield* sql`
      INSERT INTO public.school_service_substitute_offers(
        offer_id,absence_id,candidate_person_id,dispatcher_person_id,dispatched_at,status,revision,
        school_name_snapshot,eligibility_snapshot
      ) VALUES(${offerId},${absence.absenceId},${command.candidatePersonId},${actor},${now},'Offered',1,${commitment.schoolName},${sql.json(snapshot)})
    `;
    const effectId = `school-service-substitute-dispatch:${offerId}`;

    const payload = {
      _tag: "NotifySchoolServiceSubstituteOffer" as const,
      effectId,
      offerId,
      absenceId: absence.absenceId,
      personId: command.candidatePersonId,
      proposalId: absence.proposalId,
      departmentId: scope.departmentId,
      semesterId: scope.semesterId,
      schoolId: absence.schoolId,
      schoolName: commitment.schoolName,
      day: absence.day,
      block: absence.block,
      serviceDate: absence.serviceDate,
      startTime: commitment.startTime,
      endTime: commitment.endTime,
      dispatchedAt: now,
    };

    yield* decode(SchoolServiceDispatchNotificationRequest)(payload);
    yield* sql`
      INSERT INTO public.school_service_dispatch_notification_outbox(
        effect_id,offer_id,absence_id,person_id,payload_json
      ) VALUES(${effectId},${offerId},${absence.absenceId},${command.candidatePersonId},${sql.json(payload)})
    `;
    yield* writeAudit(sql, scope, actor, "DispatchSubstituteOffer", now, {
      offerId,
      absenceId: absence.absenceId,
      candidatePersonId: command.candidatePersonId,
      eligibilitySnapshot: snapshot,
      effectId,
    });
  });

const withdrawOffer = (
  sql: DatabaseOperations,
  scope: PlacementScope,
  offerId: string,
  actor: PersonId,
  now: string,
) =>
  Effect.gen(function* () {
    const offer = yield* readOfferForUpdate(sql, scope, offerId);

    if (offer.status !== "Offered" && offer.status !== "Accepted") {
      return yield* fail("offer.withdraw-invalid", 409);
    }

    const absence = yield* readAbsenceForUpdate(sql, scope, offer.absenceId);
    yield* openCommitment(sql, scope, absence.commitmentId ?? "");
    yield* sql`UPDATE public.school_service_substitute_offers SET status='Withdrawn',revision=revision+1 WHERE offer_id=${offer.offerId} AND status IN ('Offered','Accepted')`;
    yield* sql`
      INSERT INTO public.school_service_substitute_offer_withdrawals(
        offer_id,absence_id,withdrawn_by_person_id,withdrawn_at
      ) VALUES(${offer.offerId},${offer.absenceId},${actor},${now})
    `;
    yield* writeAudit(sql, scope, actor, "WithdrawSubstituteOffer", now, {
      offerId: offer.offerId,
    });
  });

const acknowledgeCoverage = (
  sql: DatabaseOperations,
  scope: PlacementScope,
  offerId: string,
  actor: PersonId,
  now: string,
  acknowledgementId: string,
) =>
  Effect.gen(function* () {
    const offer = yield* readOfferForUpdate(sql, scope, offerId);

    if (offer.status !== "Accepted") return yield* fail("coverage.acknowledgement-invalid", 409);
    const absence = yield* readAbsenceForUpdate(sql, scope, offer.absenceId);
    const commitment = yield* openCommitment(sql, scope, absence.commitmentId ?? "");

    const competing = yield* sql`SELECT 1 FROM public.school_service_person_reservations
      WHERE person_id=${offer.candidatePersonId} AND source_id<>${offer.offerId}
        AND service_interval && tsrange(
          CAST(${commitment.serviceDate} AS date)+CAST(${commitment.startTime} AS time),
          CAST(${commitment.serviceDate} AS date)+CAST(${commitment.endTime} AS time),'[)')
      LIMIT 1`;

    if (competing.length > 0) return yield* fail("coverage.acknowledgement-invalid", 409);

    const accepted = yield* sql`
      SELECT 1 FROM public.school_service_substitute_offer_responses
      WHERE offer_id=${offer.offerId} AND absence_id=${absence.absenceId} AND response='Accept'
    `;

    if (accepted.length === 0) return yield* fail("coverage.acknowledgement-invalid", 409);
    yield* sql`UPDATE public.school_service_substitute_offers SET status='Acknowledged',revision=revision+1 WHERE offer_id=${offer.offerId} AND status='Accepted'`;
    yield* sql`
      INSERT INTO public.school_service_coverage_acknowledgements(
        acknowledgement_id,offer_id,absence_id,candidate_person_id,acknowledged_by_person_id,acknowledged_at
      ) VALUES(${acknowledgementId},${offer.offerId},${absence.absenceId},${offer.candidatePersonId},${actor},${now})
    `;
    yield* writeAudit(sql, scope, actor, "AcknowledgeCoverage", now, {
      acknowledgementId,
      offerId: offer.offerId,
      absenceId: absence.absenceId,
    });
  });

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

    const absences = yield* decode(Schema.Array(SchoolServiceAbsence))(
      yield* absenceRows(sql, sql`absence.commitment_id=${commitment.commitmentId}`),
    );

    const unresolved =
      yield* sql`SELECT offer.offer_id FROM public.school_service_substitute_offers AS offer
    JOIN public.school_service_absences AS absence USING(absence_id)
    WHERE absence.commitment_id=${commitment.commitmentId} AND offer.status IN ('Offered','Accepted')
    FOR UPDATE OF offer`;

    if (unresolved.length > 0) return yield* fail("commitment.pending-offer", 409);

    const acknowledgements = yield* decode(Schema.Array(SchoolServiceCoverageAcknowledgement))(
      yield* acknowledgementRows(sql, sql`absence.commitment_id=${commitment.commitmentId}`),
    );

    const attendees = command.action === "CancelService" ? [] : command.attendedPersonIds;

    if (!isEligibleSchoolServiceAttendance(commitment, absences, acknowledgements, attendees)) {
      return yield* fail("commitment.attendance-invalid");
    }

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
      const attendeeSet = new Set(attendees);

      const acknowledgedByAbsence = new Map(
        acknowledgements.map((acknowledgement) => [acknowledgement.absenceId, acknowledgement]),
      );

      yield* Effect.forEach(
        absences,
        (absence) => {
          const acknowledged = acknowledgedByAbsence.get(absence.absenceId);

          const attendingSubstitute =
            acknowledged !== undefined && attendeeSet.has(acknowledged.candidatePersonId)
              ? acknowledged
              : undefined;

          const closureId = absence.absenceId.replace(
            "school-service-absence-",
            "school-service-closure-",
          );

          return sql`INSERT INTO public.school_service_closures(
        closure_id,absence_id,occurrence_id,scheduled_person_id,outcome,acknowledgement_id,
        substitute_person_id,closed_by_person_id,closed_at
      ) VALUES(${closureId},${absence.absenceId},${linkedOccurrenceId},${absence.personId},
        ${attendingSubstitute === undefined ? "Uncovered" : "Covered"},
        ${attendingSubstitute?.acknowledgementId ?? null},${attendingSubstitute?.candidatePersonId ?? null},
        ${actor},${now})`;
        },
        { discard: true },
      );
    }

    yield* writeAudit(sql, scope, actor, command.action, now, {
      ...command,
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
    readonly offerId: string;
    readonly acknowledgementId: string;
    readonly occurrenceId: string;
  },
) =>
  Database.use((sql) =>
    Effect.gen(function* () {
      switch (command.action) {
        case "ReportAbsenceForVolunteer":
          yield* reportAbsence(sql, scope, command, actor, now, ids.absenceId);
          break;
        case "DispatchSubstituteOffer":
          yield* dispatchOffer(sql, scope, command, actor, now, ids.offerId);
          break;
        case "WithdrawSubstituteOffer":
          yield* withdrawOffer(sql, scope, command.offerId, actor, now);
          break;
        case "AcknowledgeCoverage":
          yield* acknowledgeCoverage(
            sql,
            scope,
            command.offerId,
            actor,
            now,
            ids.acknowledgementId,
          );
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
