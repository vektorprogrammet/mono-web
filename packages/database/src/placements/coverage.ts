import { Effect, Schema } from "effect";
import type * as Statement from "effect/unstable/sql/Statement";
import { Database, type DatabaseShape } from "../service.js";
import {
  CoverageBoard,
  OwnCoverageView,
  PlacementFailure,
  SchoolServiceAbsence,
  SchoolServiceClosure,
  SchoolServiceCoverageAcknowledgement,
  SchoolServiceDispatchNotification,
  SchoolServiceDispatchNotificationRequest,
  SchoolServiceOfferResponse,
  SchoolServiceOccurrence,
  SchoolServiceProposal,
  SchoolServiceSubstituteOffer,
  hasExactSubstitutedSchoolServiceAttendance,
  type CoverageCommand,
  type OwnCoverageCommand,
  type PlacementScope,
  type SchoolServiceAbsence as SchoolServiceAbsenceType,
} from "@vektorprogrammet/domain/placements";
import type { PersonId } from "@vektorprogrammet/domain/organization";

const fail = (code: PlacementFailure["code"], status: PlacementFailure["status"] = 422) =>
  Effect.fail(new PlacementFailure({ code, status }));

const decode = <A>(schema: Schema.ConstraintDecoder<A, never>, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value, { onExcessProperty: "error" });

const proposalForScope = (sql: DatabaseShape, scope: PlacementScope, proposalId: string) =>
  Effect.gen(function* () {
    const rows = yield* sql`
      SELECT proposal_id AS "proposalId",status,revision,
        to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
        created_by_person_id AS "createdBy",
        CASE WHEN confirmed_at IS NULL THEN NULL
          ELSE to_char(confirmed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        END AS "confirmedAt",
        confirmed_by_person_id AS "confirmedBy",demand_snapshot AS demands,
        assignment_snapshot AS assignments,exception_snapshot AS exceptions,
        reviewed_exception_ids AS "reviewedExceptionIds"
      FROM public.school_service_proposals
      WHERE proposal_id=${proposalId}
        AND department_id=${scope.departmentId}
        AND semester_id=${scope.semesterId}
      FOR SHARE
    `;
    const row = rows[0];
    if (row === undefined) return null;
    return yield* decode(SchoolServiceProposal, row);
  });

const ensureServiceDate = (
  sql: DatabaseShape,
  scope: PlacementScope,
  serviceDate: string,
  day: string,
) =>
  Effect.gen(function* () {
    const valid = yield* sql`
      SELECT 1
      FROM public.admission_period_semesters
      WHERE semester_id=${scope.semesterId}
        AND CAST(${serviceDate} AS date) BETWEEN start_at::date AND end_at::date
        AND EXTRACT(ISODOW FROM CAST(${serviceDate} AS date)) = CASE ${day}
          WHEN 'Monday' THEN 1
          WHEN 'Tuesday' THEN 2
          WHEN 'Wednesday' THEN 3
          WHEN 'Thursday' THEN 4
          WHEN 'Friday' THEN 5
          ELSE 0
        END
    `;
    if (valid.length === 0) return yield* fail("absence.target-invalid");
  });

const ensureNoOccurrence = (
  sql: DatabaseShape,
  input: {
    readonly proposalId: string;
    readonly schoolId: number;
    readonly day: string;
    readonly block: string;
    readonly serviceDate: string;
  },
  code: "absence.target-invalid" | "coverage.occurrence-duplicate",
) =>
  Effect.gen(function* () {
    const rows = yield* sql`
      SELECT 1
      FROM public.school_service_occurrences
      WHERE proposal_id=${input.proposalId}
        AND school_id=${input.schoolId}
        AND day=${input.day}
        AND block=${input.block}
        AND occurred_on=CAST(${input.serviceDate} AS date)
    `;
    if (rows.length > 0) return yield* fail(code, code === "coverage.occurrence-duplicate" ? 409 : 422);
  });

const ensureAbsenceTarget = (
  sql: DatabaseShape,
  scope: PlacementScope,
  input: {
    readonly personId: PersonId;
    readonly proposalId: string;
    readonly schoolId: number;
    readonly day: string;
    readonly block: string;
    readonly serviceDate: string;
  },
) =>
  Effect.gen(function* () {
    const proposal = yield* proposalForScope(sql, scope, input.proposalId);
    if (proposal === null || proposal.status !== "Confirmed") {
      return yield* fail("absence.target-invalid");
    }
    const scheduled = proposal.assignments.some(
      (assignment) =>
        assignment.personId === input.personId &&
        assignment.schoolId === input.schoolId &&
        assignment.day === input.day &&
        assignment.block === input.block,
    );
    if (!scheduled) return yield* fail("absence.target-invalid");
    yield* ensureServiceDate(sql, scope, input.serviceDate, input.day);
    yield* ensureNoOccurrence(sql, input, "absence.target-invalid");
    return proposal;
  });

const absenceRows = (sql: DatabaseShape, where: Statement.Fragment) =>
  sql`
    SELECT absence.absence_id AS "absenceId",absence.proposal_id AS "proposalId",
      absence.department_id AS "departmentId",absence.semester_id AS "semesterId",
      absence.person_id AS "personId",absence.school_id::double precision AS "schoolId",
      school.name AS "schoolName",absence.day,absence.block,
      to_char(absence.service_date,'YYYY-MM-DD') AS "serviceDate",
      absence.reporter_person_id AS "reporterPersonId",
      to_char(absence.reported_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "reportedAt"
    FROM public.school_service_absences AS absence
    JOIN public.schools_directory_schools AS school USING(school_id)
    WHERE ${where}
  `;

const offerRows = (sql: DatabaseShape, where: Statement.Fragment) =>
  sql`
    SELECT offer.offer_id AS "offerId",offer.absence_id AS "absenceId",
      absence.proposal_id AS "proposalId",absence.department_id AS "departmentId",
      absence.semester_id AS "semesterId",offer.candidate_person_id AS "candidatePersonId",
      candidate.first_name AS "candidateFirstName",candidate.last_name AS "candidateLastName",
      absence.school_id::double precision AS "schoolId",school.name AS "schoolName",
      absence.day,absence.block,to_char(absence.service_date,'YYYY-MM-DD') AS "serviceDate",
      offer.dispatcher_person_id AS "dispatcherPersonId",
      to_char(offer.dispatched_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "dispatchedAt",
      offer.status,offer.revision,offer.eligibility_snapshot AS "eligibilitySnapshot"
    FROM public.school_service_substitute_offers AS offer
    JOIN public.school_service_absences AS absence USING(absence_id)
    JOIN public.person_profiles AS candidate ON candidate.person_id=offer.candidate_person_id
    JOIN public.schools_directory_schools AS school ON school.school_id=absence.school_id
    WHERE ${where}
  `;

const responseRows = (sql: DatabaseShape, where: Statement.Fragment) =>
  sql`
    SELECT response.offer_id AS "offerId",response.absence_id AS "absenceId",response.response,
      response.responder_person_id AS "responderPersonId",
      to_char(response.responded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "respondedAt"
    FROM public.school_service_substitute_offer_responses AS response
    JOIN public.school_service_substitute_offers AS offer USING(offer_id)
    JOIN public.school_service_absences AS absence USING(absence_id)
    WHERE ${where}
  `;

const notificationRows = (sql: DatabaseShape, where: Statement.Fragment) =>
  sql`
    SELECT notification.effect_id AS "effectId",notification.offer_id AS "offerId",
      notification.absence_id AS "absenceId",notification.person_id AS "personId",notification.status,
      notification.attempts,
      CASE WHEN notification.delivered_at IS NULL THEN NULL
        ELSE to_char(notification.delivered_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      END AS "deliveredAt",notification.last_failure_tag AS "lastFailureTag"
    FROM public.school_service_dispatch_notification_outbox AS notification
    JOIN public.school_service_substitute_offers AS offer USING(offer_id)
    JOIN public.school_service_absences AS absence USING(absence_id)
    WHERE ${where}
  `;

const acknowledgementRows = (sql: DatabaseShape, where: Statement.Fragment) =>
  sql`
    SELECT acknowledgement.acknowledgement_id AS "acknowledgementId",
      acknowledgement.offer_id AS "offerId",acknowledgement.absence_id AS "absenceId",
      acknowledgement.candidate_person_id AS "candidatePersonId",
      acknowledgement.acknowledged_by_person_id AS "acknowledgedByPersonId",
      to_char(acknowledgement.acknowledged_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "acknowledgedAt"
    FROM public.school_service_coverage_acknowledgements AS acknowledgement
    JOIN public.school_service_absences AS absence USING(absence_id)
    WHERE ${where}
  `;

const closureRows = (sql: DatabaseShape, where: Statement.Fragment) =>
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
  `;

const occurrenceRows = (sql: DatabaseShape, scope: PlacementScope) =>
  sql`
    SELECT occurrence.occurrence_id AS "occurrenceId",occurrence.proposal_id AS "proposalId",
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

const readAbsenceForUpdate = (sql: DatabaseShape, scope: PlacementScope, absenceId: string) =>
  Effect.gen(function* () {
    const rows = yield* sql`
      SELECT absence.absence_id AS "absenceId",absence.proposal_id AS "proposalId",
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
    return yield* decode(SchoolServiceAbsence, row);
  });

const readOfferForUpdate = (sql: DatabaseShape, scope: PlacementScope, offerId: string) =>
  Effect.gen(function* () {
    const rows = yield* sql`
      SELECT offer.offer_id AS "offerId",offer.absence_id AS "absenceId",
        absence.proposal_id AS "proposalId",absence.department_id AS "departmentId",
        absence.semester_id AS "semesterId",offer.candidate_person_id AS "candidatePersonId",
        candidate.first_name AS "candidateFirstName",candidate.last_name AS "candidateLastName",
        absence.school_id::double precision AS "schoolId",school.name AS "schoolName",
        absence.day,absence.block,to_char(absence.service_date,'YYYY-MM-DD') AS "serviceDate",
        offer.dispatcher_person_id AS "dispatcherPersonId",
        to_char(offer.dispatched_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "dispatchedAt",
        offer.status,offer.revision,offer.eligibility_snapshot AS "eligibilitySnapshot"
      FROM public.school_service_substitute_offers AS offer
      JOIN public.school_service_absences AS absence USING(absence_id)
      JOIN public.person_profiles AS candidate ON candidate.person_id=offer.candidate_person_id
      JOIN public.schools_directory_schools AS school ON school.school_id=absence.school_id
      WHERE offer.offer_id=${offerId}
        AND absence.department_id=${scope.departmentId}
        AND absence.semester_id=${scope.semesterId}
      FOR UPDATE OF offer
    `;
    const row = rows[0];
    if (row === undefined) return yield* fail("resource.not-found", 404);
    return yield* decode(SchoolServiceSubstituteOffer, row);
  });

const ensureNoClosure = (sql: DatabaseShape, absenceId: string) =>
  Effect.gen(function* () {
    const rows = yield* sql`SELECT 1 FROM public.school_service_closures WHERE absence_id=${absenceId}`;
    if (rows.length > 0) return yield* fail("absence.closed", 409);
  });

/** Candidate identity is only canonical through applicant_account_links. */
const eligibilitySnapshot = (
  sql: DatabaseShape,
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
          WHERE proposal.proposal_id=absence.proposalId
            AND assignment->>'personId'=link.person_id
            AND (assignment->>'schoolId')::bigint=absence.schoolId
            AND assignment->>'day'=absence.day
            AND assignment->>'block'=absence.block
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
          SELECT 1
          FROM public.school_service_coverage_acknowledgements AS acknowledgement
          JOIN public.school_service_substitute_offers AS covered_offer
            ON covered_offer.offer_id=acknowledgement.offer_id
          JOIN public.school_service_absences AS covered_absence
            ON covered_absence.absence_id=covered_offer.absence_id
          WHERE covered_offer.candidate_person_id=link.person_id
            AND covered_absence.service_date=CAST(${absence.serviceDate} AS date)
            AND covered_absence.block=${absence.block}
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
  sql: DatabaseShape,
  scope: PlacementScope,
  actor: PersonId,
  action:
    | "ReportAbsence"
    | "DispatchSubstituteOffer"
    | "RespondToOffer"
    | "WithdrawSubstituteOffer"
    | "AcknowledgeCoverage"
    | "CloseCoverage",
  now: string,
  snapshot: object,
) =>
  sql`INSERT INTO public.school_service_coverage_audit(department_id,semester_id,actor_person_id,action,occurred_at,snapshot) VALUES(${scope.departmentId},${scope.semesterId},${actor},${action},${now},${sql.json(snapshot)})`;

export const readOwnCoverage = (scope: PlacementScope, personId: PersonId) =>
  Database.use((sql) =>
    Effect.gen(function* () {
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
      const absences = yield* decode(
        Schema.Array(SchoolServiceAbsence),
        yield* absenceRows(
          sql,
          sql`absence.department_id=${scope.departmentId} AND absence.semester_id=${scope.semesterId} AND absence.person_id=${personId}`,
        ),
      );
      const offers = yield* decode(
        Schema.Array(SchoolServiceSubstituteOffer),
        yield* offerRows(
          sql,
          sql`absence.department_id=${scope.departmentId} AND absence.semester_id=${scope.semesterId} AND offer.candidate_person_id=${personId}`,
        ),
      );
      const responses = yield* decode(
        Schema.Array(SchoolServiceOfferResponse),
        yield* responseRows(
          sql,
          sql`absence.department_id=${scope.departmentId} AND absence.semester_id=${scope.semesterId} AND offer.candidate_person_id=${personId}`,
        ),
      );
      const dispatchNotifications = yield* decode(
        Schema.Array(SchoolServiceDispatchNotification),
        yield* notificationRows(
          sql,
          sql`absence.department_id=${scope.departmentId} AND absence.semester_id=${scope.semesterId} AND notification.person_id=${personId}`,
        ),
      );
      return yield* decode(OwnCoverageView, {
        ...scope,
        rosterSlots: rosterRows,
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
      const absences = yield* decode(
        Schema.Array(SchoolServiceAbsence),
        yield* absenceRows(
          sql,
          sql`absence.department_id=${scope.departmentId} AND absence.semester_id=${scope.semesterId}`,
        ),
      );
      const offers = yield* decode(
        Schema.Array(SchoolServiceSubstituteOffer),
        yield* offerRows(
          sql,
          sql`absence.department_id=${scope.departmentId} AND absence.semester_id=${scope.semesterId}`,
        ),
      );
      const responses = yield* decode(
        Schema.Array(SchoolServiceOfferResponse),
        yield* responseRows(
          sql,
          sql`absence.department_id=${scope.departmentId} AND absence.semester_id=${scope.semesterId}`,
        ),
      );
      const acknowledgements = yield* decode(
        Schema.Array(SchoolServiceCoverageAcknowledgement),
        yield* acknowledgementRows(
          sql,
          sql`absence.department_id=${scope.departmentId} AND absence.semester_id=${scope.semesterId}`,
        ),
      );
      const closures = yield* decode(
        Schema.Array(SchoolServiceClosure),
        yield* closureRows(
          sql,
          sql`absence.department_id=${scope.departmentId} AND absence.semester_id=${scope.semesterId}`,
        ),
      );
      const dispatchNotifications = yield* decode(
        Schema.Array(SchoolServiceDispatchNotification),
        yield* notificationRows(
          sql,
          sql`absence.department_id=${scope.departmentId} AND absence.semester_id=${scope.semesterId}`,
        ),
      );
      const occurrences = yield* decode(Schema.Array(SchoolServiceOccurrence), yield* occurrenceRows(sql, scope));
      const candidates = yield* sql`
        SELECT DISTINCT ON (absence.absence_id,link.person_id)
          absence.absence_id AS "absenceId",application.application_id AS "applicationId",
          link.person_id AS "personId",applicant.first_name AS "firstName",applicant.last_name AS "lastName"
        FROM public.school_service_absences AS absence
        JOIN public.admission_substitute_preferences AS preferences ON preferences.active
        JOIN public.admission_applications AS application
          ON application.application_id=preferences.application_id
        JOIN public.admission_periods AS period
          ON period.admission_period_id=application.admission_period_id
          AND period.department_id=application.department_id
        JOIN public.admission_applicants AS applicant ON applicant.applicant_id=application.applicant_id
        JOIN public.applicant_account_links AS link ON link.applicant_id=application.applicant_id
        JOIN public.organization_volunteer_affiliations AS affiliation
          ON affiliation.person_id=link.person_id
          AND affiliation.department_id=${scope.departmentId}
          AND affiliation.status='Active'
        WHERE absence.department_id=${scope.departmentId}
          AND absence.semester_id=${scope.semesterId}
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
            SELECT 1 FROM public.assistant_placements AS placement
            WHERE placement.active
              AND placement.person_id=link.person_id
              AND placement.semester_id=${scope.semesterId}
              AND placement.day=absence.day
              AND placement.block IN (absence.block,'Both')
          )
          AND NOT EXISTS (
            SELECT 1
            FROM public.school_service_coverage_acknowledgements AS acknowledgement
            JOIN public.school_service_substitute_offers AS covered_offer
              ON covered_offer.offer_id=acknowledgement.offer_id
            JOIN public.school_service_absences AS covered_absence
              ON covered_absence.absence_id=covered_offer.absence_id
            WHERE covered_offer.candidate_person_id=link.person_id
              AND covered_absence.service_date=absence.service_date
              AND covered_absence.block=absence.block
          )
        ORDER BY absence.absence_id,link.person_id,application.application_id
      `;
      return yield* decode(CoverageBoard, {
        ...scope,
        absences,
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
  sql: DatabaseShape,
  scope: PlacementScope,
  input: {
    readonly personId: PersonId;
    readonly proposalId: string;
    readonly schoolId: number;
    readonly day: string;
    readonly block: string;
    readonly serviceDate: string;
  },
  reporter: PersonId,
  now: string,
  absenceId: string,
) =>
  Effect.gen(function* () {
    yield* ensureAbsenceTarget(sql, scope, input);
    const duplicate = yield* sql`
      SELECT absence_id FROM public.school_service_absences
      WHERE proposal_id=${input.proposalId}
        AND school_id=${input.schoolId}
        AND day=${input.day}
        AND block=${input.block}
        AND service_date=CAST(${input.serviceDate} AS date)
        AND person_id=${input.personId}
      FOR UPDATE
    `;
    if (duplicate.length > 0) return yield* fail("absence.duplicate", 409);
    yield* sql`
      INSERT INTO public.school_service_absences(
        absence_id,proposal_id,department_id,semester_id,person_id,school_id,day,block,
        service_date,reporter_person_id,reported_at
      ) VALUES(
        ${absenceId},${input.proposalId},${scope.departmentId},${scope.semesterId},${input.personId},
        ${input.schoolId},${input.day},${input.block},CAST(${input.serviceDate} AS date),${reporter},${now}
      )
    `;
    yield* writeAudit(sql, scope, reporter, "ReportAbsence", now, { absenceId, ...input });
  });

const respondToOffer = (
  sql: DatabaseShape,
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
    yield* ensureNoClosure(sql, absence.absenceId);
    yield* eligibilitySnapshot(sql, scope, absence, actor, now);
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
  sql: DatabaseShape,
  scope: PlacementScope,
  command: Extract<CoverageCommand, { readonly action: "DispatchSubstituteOffer" }>,
  actor: PersonId,
  now: string,
  offerId: string,
) =>
  Effect.gen(function* () {
    const absence = yield* readAbsenceForUpdate(sql, scope, command.absenceId);
    yield* ensureNoClosure(sql, absence.absenceId);
    const active = yield* sql`
      SELECT offer_id FROM public.school_service_substitute_offers
      WHERE absence_id=${absence.absenceId}
        AND status IN ('Offered','Accepted','Acknowledged')
      FOR UPDATE
    `;
    if (active.length > 0) return yield* fail("offer.unresolved", 409);
    const snapshot = yield* eligibilitySnapshot(sql, scope, absence, command.candidatePersonId, now);
    yield* sql`
      INSERT INTO public.school_service_substitute_offers(
        offer_id,absence_id,candidate_person_id,dispatcher_person_id,dispatched_at,status,revision,eligibility_snapshot
      ) VALUES(${offerId},${absence.absenceId},${command.candidatePersonId},${actor},${now},'Offered',1,${sql.json(snapshot)})
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
      schoolName: absence.schoolName,
      day: absence.day,
      block: absence.block,
      serviceDate: absence.serviceDate,
      dispatchedAt: now,
    };
    yield* decode(SchoolServiceDispatchNotificationRequest, payload);
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
  sql: DatabaseShape,
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
    yield* ensureNoClosure(sql, absence.absenceId);
    yield* sql`UPDATE public.school_service_substitute_offers SET status='Withdrawn',revision=revision+1 WHERE offer_id=${offer.offerId} AND status IN ('Offered','Accepted')`;
    yield* sql`
      INSERT INTO public.school_service_substitute_offer_withdrawals(
        offer_id,absence_id,withdrawn_by_person_id,withdrawn_at
      ) VALUES(${offer.offerId},${offer.absenceId},${actor},${now})
    `;
    yield* writeAudit(sql, scope, actor, "WithdrawSubstituteOffer", now, { offerId: offer.offerId });
  });

const acknowledgeCoverage = (
  sql: DatabaseShape,
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
    yield* ensureNoClosure(sql, absence.absenceId);
    const accepted = yield* sql`
      SELECT 1 FROM public.school_service_substitute_offer_responses
      WHERE offer_id=${offer.offerId} AND absence_id=${absence.absenceId} AND response='Accept'
    `;
    if (accepted.length === 0) return yield* fail("coverage.acknowledgement-invalid", 409);
    yield* eligibilitySnapshot(sql, scope, absence, offer.candidatePersonId, now);
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

const closeCoverage = (
  sql: DatabaseShape,
  scope: PlacementScope,
  command: Extract<CoverageCommand, { readonly action: "CloseCoverage" }>,
  actor: PersonId,
  now: string,
  occurrenceId: string,
) =>
  Effect.gen(function* () {
    const proposal = yield* proposalForScope(sql, scope, command.proposalId);
    if (proposal === null || proposal.status !== "Confirmed") {
      return yield* fail("school-service.proposal-inactive");
    }
    const scheduled = proposal.assignments.some(
      (assignment) =>
        assignment.schoolId === command.schoolId &&
        assignment.day === command.day &&
        assignment.block === command.block,
    );
    if (!scheduled) return yield* fail("coverage.attendance-invalid");
    yield* ensureServiceDate(sql, scope, command.occurredOn, command.day);
    yield* ensureNoOccurrence(
      sql,
      { ...command, serviceDate: command.occurredOn },
      "coverage.occurrence-duplicate",
    );
    const absenceRowsForSlot = yield* sql`
      SELECT absence.absence_id AS "absenceId",absence.proposal_id AS "proposalId",
        absence.department_id AS "departmentId",absence.semester_id AS "semesterId",
        absence.person_id AS "personId",absence.school_id::double precision AS "schoolId",
        school.name AS "schoolName",absence.day,absence.block,
        to_char(absence.service_date,'YYYY-MM-DD') AS "serviceDate",
        absence.reporter_person_id AS "reporterPersonId",
        to_char(absence.reported_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "reportedAt"
      FROM public.school_service_absences AS absence
      JOIN public.schools_directory_schools AS school USING(school_id)
      WHERE absence.proposal_id=${command.proposalId}
        AND absence.department_id=${scope.departmentId}
        AND absence.semester_id=${scope.semesterId}
        AND absence.school_id=${command.schoolId}
        AND absence.day=${command.day}
        AND absence.block=${command.block}
        AND absence.service_date=CAST(${command.occurredOn} AS date)
      FOR UPDATE OF absence
    `;
    const absences = yield* decode(Schema.Array(SchoolServiceAbsence), absenceRowsForSlot);
    if (absences.length === 0) return yield* fail("resource.not-found", 404);
    const alreadyClosed = yield* sql`
      SELECT closure.absence_id
      FROM public.school_service_closures AS closure
      JOIN public.school_service_absences AS absence USING(absence_id)
      WHERE absence.proposal_id=${command.proposalId}
        AND absence.department_id=${scope.departmentId}
        AND absence.semester_id=${scope.semesterId}
        AND absence.school_id=${command.schoolId}
        AND absence.day=${command.day}
        AND absence.block=${command.block}
        AND absence.service_date=CAST(${command.occurredOn} AS date)
    `;
    if (alreadyClosed.length > 0) return yield* fail("absence.closed", 409);
    const states = yield* sql<{
      readonly absenceId: string;
      readonly status: string;
    }>`
      SELECT offer.absence_id AS "absenceId",offer.status
      FROM public.school_service_substitute_offers AS offer
      JOIN public.school_service_absences AS absence USING(absence_id)
      WHERE absence.proposal_id=${command.proposalId}
        AND absence.department_id=${scope.departmentId}
        AND absence.semester_id=${scope.semesterId}
        AND absence.school_id=${command.schoolId}
        AND absence.day=${command.day}
        AND absence.block=${command.block}
        AND absence.service_date=CAST(${command.occurredOn} AS date)
      FOR UPDATE OF offer
    `;
    if (states.some((state) => state.status === "Offered" || state.status === "Accepted")) {
      return yield* fail("coverage.pending-offer", 409);
    }
    const acknowledgementRowsForSlot = yield* sql`
      SELECT acknowledgement.acknowledgement_id AS "acknowledgementId",
        acknowledgement.offer_id AS "offerId",acknowledgement.absence_id AS "absenceId",
        acknowledgement.candidate_person_id AS "candidatePersonId",
        acknowledgement.acknowledged_by_person_id AS "acknowledgedByPersonId",
        to_char(acknowledgement.acknowledged_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "acknowledgedAt"
      FROM public.school_service_coverage_acknowledgements AS acknowledgement
      JOIN public.school_service_absences AS absence USING(absence_id)
      WHERE absence.proposal_id=${command.proposalId}
        AND absence.department_id=${scope.departmentId}
        AND absence.semester_id=${scope.semesterId}
        AND absence.school_id=${command.schoolId}
        AND absence.day=${command.day}
        AND absence.block=${command.block}
        AND absence.service_date=CAST(${command.occurredOn} AS date)
    `;
    const acknowledgements = yield* decode(
      Schema.Array(SchoolServiceCoverageAcknowledgement),
      acknowledgementRowsForSlot,
    );
    const acknowledgedAbsenceIds = new Set(
      acknowledgements.map((acknowledgement) => acknowledgement.absenceId),
    );
    if (
      states.some(
        (state) => state.status === "Acknowledged" && !acknowledgedAbsenceIds.has(state.absenceId),
      )
    ) {
      return yield* fail("coverage.acknowledgement-invalid", 409);
    }
    if (!hasExactSubstitutedSchoolServiceAttendance(proposal, absences, acknowledgements, {
      schoolId: command.schoolId,
      day: command.day,
      block: command.block,
      serviceDate: command.occurredOn,
      attendedPersonIds: command.attendedPersonIds,
    })) {
      return yield* fail("coverage.attendance-invalid");
    }
    yield* sql`
      INSERT INTO public.school_service_occurrences(
        occurrence_id,proposal_id,department_id,semester_id,school_id,day,block,occurred_on,
        attended_person_ids,recorded_at,recorded_by_person_id
      ) VALUES(${occurrenceId},${command.proposalId},${scope.departmentId},${scope.semesterId},
        ${command.schoolId},${command.day},${command.block},CAST(${command.occurredOn} AS date),
        ${sql.json(command.attendedPersonIds)},${now},${actor})
    `;
    const acknowledgementByAbsence = new Map(
      acknowledgements.map((acknowledgement) => [acknowledgement.absenceId, acknowledgement]),
    );
    yield* Effect.forEach(
      absences,
      (absence) => {
        const acknowledgement = acknowledgementByAbsence.get(absence.absenceId);
        const closureId = absence.absenceId.replace(
          "school-service-absence-",
          "school-service-closure-",
        );
        return sql`
          INSERT INTO public.school_service_closures(
            closure_id,absence_id,occurrence_id,scheduled_person_id,outcome,acknowledgement_id,
            substitute_person_id,closed_by_person_id,closed_at
          ) VALUES(${closureId},${absence.absenceId},${occurrenceId},${absence.personId},
            ${acknowledgement === undefined ? "Uncovered" : "Covered"},
            ${acknowledgement?.acknowledgementId ?? null},${acknowledgement?.candidatePersonId ?? null},
            ${actor},${now})
        `;
      },
      { discard: true },
    );
    yield* writeAudit(sql, scope, actor, "CloseCoverage", now, {
      occurrenceId,
      proposalId: command.proposalId,
      schoolId: command.schoolId,
      day: command.day,
      block: command.block,
      occurredOn: command.occurredOn,
      absenceOutcomes: absences.map((absence) => ({
        absenceId: absence.absenceId,
        outcome: acknowledgementByAbsence.has(absence.absenceId) ? "Covered" : "Uncovered",
      })),
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
          yield* acknowledgeCoverage(sql, scope, command.offerId, actor, now, ids.acknowledgementId);
          break;
        case "CloseCoverage":
          yield* closeCoverage(sql, scope, command, actor, now, ids.occurrenceId);
          break;
      }
      return yield* readCoverageBoard(scope);
    }),
  );
