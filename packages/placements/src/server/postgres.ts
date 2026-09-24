import { Effect, Schema } from "effect";
import { readSchoolServiceCommitments } from "./coverage.js";
import { Database, type DatabaseOperations } from "@vektorprogrammet/database";
import type { OrganizationPersonAuthority } from "@vektorprogrammet/domain/organization";
import type { DepartmentId, PersonId } from "@vektorprogrammet/domain/organization";
import {
  SchoolServiceNotificationRequest,
  Affiliation,
  PlacementBoard,
  PlacementFailure,
  PlacementScopes,
  SchoolServiceProposal,
  buildSchoolServiceProposal,
  canManagePlacements,
  hasExactSchoolServiceExceptionReview,
  nextAffiliationStatus,
  type PlacementScope,
  type PlacementCommand,
  type OwnAffiliationCommand,
} from "@vektorprogrammet/placements/contracts";

const fail = (code: PlacementFailure["code"], status: PlacementFailure["status"] = 422) =>
  Effect.fail(new PlacementFailure({ code, status }));

interface SchoolServiceProposalRow {
  readonly proposalId: string;
  readonly status: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly confirmedAt: string | null;
  readonly confirmedBy: string | null;
  readonly demands: unknown;
  readonly assignments: unknown;
  readonly exceptions: unknown;
  readonly reviewedExceptionIds: unknown;
}

const readSchoolServiceProposal = (
  sql: DatabaseOperations,
  scope: PlacementScope,
  proposalId: string,
) =>
  Effect.gen(function* () {
    const rows = yield* sql<SchoolServiceProposalRow>`
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
    `;

    return rows[0] === undefined
      ? null
      : yield* Schema.decodeUnknownEffect(SchoolServiceProposal)(rows[0]);
  });

export const readPlacementScopes = (authority: OrganizationPersonAuthority) =>
  Database.use((sql) =>
    Effect.gen(function* () {
      const departments = yield* sql<{
        departmentId: DepartmentId;
        name: string;
      }>`SELECT department_id AS "departmentId",name FROM public.organization_departments ORDER BY name,department_id`;

      const semesters =
        yield* sql`SELECT semester_id AS "semesterId",to_char(start_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startAt",to_char(end_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "endAt" FROM public.admission_period_semesters ORDER BY start_at DESC,semester_id`;

      return yield* Schema.decodeUnknownEffect(PlacementScopes)({
        departments: departments.map((department) => ({
          ...department,
          canManage: canManagePlacements(authority, department.departmentId),
        })),
        semesters,
      });
    }),
  );

export const lockPlacementDepartment = (departmentId: DepartmentId) =>
  Database.use((sql) =>
    Effect.gen(function* () {
      const rows =
        yield* sql`SELECT department_id FROM public.organization_departments WHERE department_id=${departmentId} FOR UPDATE`;

      if (!rows.length) return yield* fail("scope.invalid");
    }),
  );

export const readOwnAffiliation = (personId: PersonId, departmentId: DepartmentId) =>
  Database.use((sql) =>
    Effect.gen(function* () {
      const departments =
        yield* sql`SELECT department_id FROM public.organization_departments WHERE department_id=${departmentId}`;

      if (!departments.length) return yield* fail("scope.invalid");

      const rows =
        yield* sql`SELECT status,revision FROM public.organization_volunteer_affiliations WHERE person_id=${personId} AND department_id=${departmentId}`;

      return yield* Schema.decodeUnknownEffect(Affiliation)({
        personId,
        departmentId,
        ...(rows[0] ?? { status: "Absent", revision: 0 }),
      });
    }),
  );

export const mutateAffiliation = (
  current: Affiliation,
  action: OwnAffiliationCommand["action"] | "Establish" | "Reject" | "Revoke",
  actor: PersonId,
  now: string,
) =>
  Database.use((sql) =>
    Effect.gen(function* () {
      const status = nextAffiliationStatus(current.status, action);

      if (status === null) return yield* fail("affiliation.transition-invalid");
      const revision = current.revision + 1;
      yield* sql`INSERT INTO public.organization_volunteer_affiliations(person_id,department_id,status,revision) VALUES(${current.personId},${current.departmentId},${status},${revision}) ON CONFLICT(person_id,department_id) DO UPDATE SET status=EXCLUDED.status,revision=EXCLUDED.revision`;
      yield* sql`INSERT INTO public.organization_volunteer_affiliation_audit(person_id,department_id,revision,action,actor_person_id,occurred_at) VALUES(${current.personId},${current.departmentId},${revision},${action},${actor},${now})`;

      return yield* readOwnAffiliation(current.personId, current.departmentId);
    }),
  );

export const readPlacementBoard = (scope: PlacementScope) =>
  Database.use((sql) =>
    Effect.gen(function* () {
      const semesters =
        yield* sql`SELECT semester_id FROM public.admission_period_semesters WHERE semester_id=${scope.semesterId}`;

      if (!semesters.length) return yield* fail("scope.invalid");

      const affiliations =
        yield* sql`SELECT a.person_id AS "personId",a.department_id AS "departmentId",a.status,a.revision,p.first_name AS "firstName",p.last_name AS "lastName" FROM public.organization_volunteer_affiliations a JOIN public.person_profiles p USING(person_id) WHERE a.department_id=${scope.departmentId} ORDER BY p.last_name,p.first_name,a.person_id`;

      const placements =
        yield* sql`SELECT x.placement_id AS "placementId",x.person_id AS "personId",x.department_id AS "departmentId",x.semester_id AS "semesterId",x.school_id::double precision AS "schoolId",x.day,x.workdays,x.block,x.active,x.revision,p.first_name AS "firstName",p.last_name AS "lastName",s.name AS "schoolName" FROM public.assistant_placements x JOIN public.person_profiles p USING(person_id) JOIN public.schools_directory_schools s USING(school_id) WHERE x.department_id=${scope.departmentId} AND x.semester_id=${scope.semesterId} ORDER BY x.placement_id`;

      const schools =
        yield* sql`SELECT s.school_id::double precision AS "schoolId",s.name FROM public.schools_directory_schools s JOIN public.schools_directory_departments d USING(school_id) WHERE d.department_id=${scope.departmentId} AND s.active ORDER BY s.name,s.school_id`;

      const demands =
        yield* sql`SELECT school_id::double precision AS "schoolId",day,block,required_volunteers AS "requiredVolunteers",revision FROM public.school_service_demand WHERE department_id=${scope.departmentId} AND semester_id=${scope.semesterId} ORDER BY school_id,day,block`;

      const proposalRows =
        yield* sql<SchoolServiceProposalRow>`SELECT proposal_id AS "proposalId",status,revision,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",created_by_person_id AS "createdBy",CASE WHEN confirmed_at IS NULL THEN NULL ELSE to_char(confirmed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS "confirmedAt",confirmed_by_person_id AS "confirmedBy",demand_snapshot AS demands,assignment_snapshot AS assignments,exception_snapshot AS exceptions,reviewed_exception_ids AS "reviewedExceptionIds" FROM public.school_service_proposals WHERE department_id=${scope.departmentId} AND semester_id=${scope.semesterId} ORDER BY created_at DESC,proposal_id DESC LIMIT 1`;

      const proposal =
        proposalRows.length === 0
          ? null
          : yield* Schema.decodeUnknownEffect(SchoolServiceProposal)(proposalRows[0]);

      const notifications =
        proposal === null
          ? []
          : yield* sql`SELECT effect_id AS "effectId",proposal_id AS "proposalId",person_id AS "personId",status,attempts,CASE WHEN delivered_at IS NULL THEN NULL ELSE to_char(delivered_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS "deliveredAt",last_failure_tag AS "lastFailureTag" FROM public.school_service_notification_outbox WHERE proposal_id=${proposal.proposalId} ORDER BY person_id`;

      const occurrences =
        yield* sql`SELECT o.occurrence_id AS "occurrenceId",o.commitment_id AS "commitmentId",o.proposal_id AS "proposalId",o.school_id::double precision AS "schoolId",s.name AS "schoolName",o.day,o.block,to_char(o.occurred_on,'YYYY-MM-DD') AS "occurredOn",o.attended_person_ids AS "attendedPersonIds",to_char(o.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "recordedAt",o.recorded_by_person_id AS "recordedBy" FROM public.school_service_occurrences o JOIN public.schools_directory_schools s USING(school_id) WHERE o.department_id=${scope.departmentId} AND o.semester_id=${scope.semesterId} ORDER BY o.occurred_on,o.occurrence_id`;

      const commitments = yield* readSchoolServiceCommitments(sql, scope);

      return yield* Schema.decodeUnknownEffect(PlacementBoard)({
        ...scope,
        affiliations,
        placements,
        schools,
        demands,
        proposal,
        notifications,
        commitments,
        occurrences,
      });
    }),
  );

/** Caller holds the department lock and HTTP receipt transaction. */
export const mutatePlacementBoard = (
  scope: PlacementScope,
  command: PlacementCommand,
  actor: PersonId,
  now: string,
  newId: string,
) =>
  Database.use((sql) =>
    Effect.gen(function* () {
      if (command.action === "Affiliation") {
        const current = yield* readOwnAffiliation(command.personId, scope.departmentId);

        if (current.status === "Absent") return yield* fail("resource.not-found", 404);
        yield* mutateAffiliation(current, command.transition, actor, now);

        return yield* readPlacementBoard(scope);
      }

      const board = yield* readPlacementBoard(scope);

      if (command.action === "SetDemand") {
        if (!board.schools.some((school) => school.schoolId === command.schoolId)) {
          return yield* fail("scope.invalid");
        }

        const current = board.demands.find(
          (demand) =>
            demand.schoolId === command.schoolId &&
            demand.day === command.day &&
            demand.block === command.block,
        );

        if (command.requiredVolunteers === 0) {
          if (current !== undefined) {
            yield* sql`DELETE FROM public.school_service_demand WHERE department_id=${scope.departmentId} AND semester_id=${scope.semesterId} AND school_id=${command.schoolId} AND day=${command.day} AND block=${command.block}`;
            yield* sql`INSERT INTO public.school_service_audit(department_id,semester_id,actor_person_id,action,occurred_at,snapshot) VALUES(${scope.departmentId},${scope.semesterId},${actor},'RemoveDemand',${now},${sql.json(command)})`;
          }
        } else {
          const revision = (current?.revision ?? 0) + 1;
          yield* sql`INSERT INTO public.school_service_demand(department_id,semester_id,school_id,day,block,required_volunteers,revision) VALUES(${scope.departmentId},${scope.semesterId},${command.schoolId},${command.day},${command.block},${command.requiredVolunteers},${revision}) ON CONFLICT(department_id,semester_id,school_id,day,block) DO UPDATE SET required_volunteers=EXCLUDED.required_volunteers,revision=EXCLUDED.revision`;
          yield* sql`INSERT INTO public.school_service_audit(department_id,semester_id,actor_person_id,action,occurred_at,snapshot) VALUES(${scope.departmentId},${scope.semesterId},${actor},'SetDemand',${now},${sql.json({ ...command, revision })})`;
        }

        return yield* readPlacementBoard(scope);
      }

      if (command.action === "GenerateProposal") {
        if (board.demands.length === 0 && !board.placements.some((placement) => placement.active)) {
          return yield* fail("school-service.proposal-empty");
        }

        const proposal = buildSchoolServiceProposal({
          proposalId: yield* Schema.decodeUnknownEffect(SchoolServiceProposal.fields.proposalId)(
            newId,
          ),
          board,
          actor,
          now,
        });

        yield* sql`INSERT INTO public.school_service_proposals(proposal_id,department_id,semester_id,status,revision,created_at,created_by_person_id,demand_snapshot,assignment_snapshot,exception_snapshot,reviewed_exception_ids) VALUES(${proposal.proposalId},${scope.departmentId},${scope.semesterId},${proposal.status},${proposal.revision},${proposal.createdAt},${proposal.createdBy},${sql.json(proposal.demands)},${sql.json(proposal.assignments)},${sql.json(proposal.exceptions)},${sql.json(proposal.reviewedExceptionIds)})`;
        yield* sql`INSERT INTO public.school_service_audit(department_id,semester_id,actor_person_id,action,occurred_at,snapshot) VALUES(${scope.departmentId},${scope.semesterId},${actor},'GenerateProposal',${now},${sql.json({ proposalId: proposal.proposalId, exceptionIds: proposal.exceptions.map((exception) => exception.exceptionId) })})`;

        return yield* readPlacementBoard(scope);
      }

      if (command.action === "ConfirmProposal") {
        const proposal = yield* readSchoolServiceProposal(sql, scope, command.proposalId);

        if (proposal === null) return yield* fail("resource.not-found", 404);

        if (proposal.status !== "Draft") return yield* fail("school-service.proposal-inactive");

        if (!hasExactSchoolServiceExceptionReview(proposal, command.reviewedExceptionIds)) {
          return yield* fail("school-service.exception-review-invalid");
        }

        yield* sql`UPDATE public.school_service_proposals SET status='Confirmed',revision=revision+1,confirmed_at=${now},confirmed_by_person_id=${actor},reviewed_exception_ids=${sql.json(command.reviewedExceptionIds)} WHERE proposal_id=${proposal.proposalId}`;

        const personIds = [
          ...new Set(proposal.assignments.map((assignment) => assignment.personId)),
        ].sort();

        yield* Effect.forEach(
          personIds,
          (personId) => {
            const effectId = `school-service-notification:${proposal.proposalId}:${personId}`;

            const payload = SchoolServiceNotificationRequest.make({
              effectId,
              proposalId: proposal.proposalId,
              personId,
              departmentId: scope.departmentId,
              semesterId: scope.semesterId,
              assignments: proposal.assignments.filter(
                (assignment) => assignment.personId === personId,
              ),
              confirmedAt: now,
            });

            return sql`INSERT INTO public.school_service_notification_outbox(effect_id,proposal_id,person_id,payload_json) VALUES(${effectId},${proposal.proposalId},${personId},${sql.json(payload)})`;
          },
          { discard: true },
        );
        yield* sql`INSERT INTO public.school_service_audit(department_id,semester_id,actor_person_id,action,occurred_at,snapshot) VALUES(${scope.departmentId},${scope.semesterId},${actor},'ConfirmProposal',${now},${sql.json(command)})`;

        return yield* readPlacementBoard(scope);
      }

      if (command.action === "ScheduleService") {
        const proposal = yield* readSchoolServiceProposal(sql, scope, command.proposalId);

        if (proposal?.status !== "Confirmed") return yield* fail("commitment.target-invalid");

        if (command.startTime >= command.endTime) return yield* fail("commitment.interval-invalid");

        const demand = proposal.demands.find(
          (entry) =>
            entry.schoolId === command.schoolId &&
            entry.day === command.day &&
            entry.block === command.block,
        );

        if (
          demand === undefined ||
          demand.requiredVolunteers <= 0 ||
          !board.schools.some((school) => school.schoolId === command.schoolId)
        ) {
          return yield* fail("commitment.target-invalid");
        }

        const validDate = yield* sql`SELECT 1 FROM public.admission_period_semesters
          WHERE semester_id=${scope.semesterId}
          AND CAST(${command.serviceDate} AS date) BETWEEN start_at::date AND end_at::date
          AND EXTRACT(ISODOW FROM CAST(${command.serviceDate} AS date))=CASE ${command.day}
            WHEN 'Monday' THEN 1 WHEN 'Tuesday' THEN 2 WHEN 'Wednesday' THEN 3
            WHEN 'Thursday' THEN 4 WHEN 'Friday' THEN 5 ELSE 0 END`;

        if (validDate.length === 0) return yield* fail("commitment.target-invalid");

        const duplicate = yield* sql`SELECT 1 FROM public.school_service_commitments
          WHERE department_id=${scope.departmentId} AND school_id=${command.schoolId}
            AND service_date=CAST(${command.serviceDate} AS date) AND block=${command.block}`;

        if (duplicate.length > 0) return yield* fail("commitment.duplicate", 409);

        const historical = yield* sql`SELECT 1 FROM public.school_service_occurrences
          WHERE department_id=${scope.departmentId} AND school_id=${command.schoolId}
            AND occurred_on=CAST(${command.serviceDate} AS date) AND block=${command.block}`;

        if (historical.length > 0) return yield* fail("commitment.duplicate", 409);

        const oldAbsence = yield* sql`SELECT 1 FROM public.school_service_absences
          WHERE department_id=${scope.departmentId} AND school_id=${command.schoolId}
            AND service_date=CAST(${command.serviceDate} AS date) AND block=${command.block}`;

        if (oldAbsence.length > 0) return yield* fail("commitment.duplicate", 409);

        const assignments = proposal.assignments.filter(
          (entry) =>
            entry.schoolId === command.schoolId &&
            entry.day === command.day &&
            entry.block === command.block,
        );

        const schoolName = board.schools.find(
          (school) => school.schoolId === command.schoolId,
        )!.name;

        const occupied =
          yield* sql`SELECT 1 FROM jsonb_array_elements(${sql.json(assignments)}) AS assignment
          JOIN public.school_service_person_reservations AS reservation
            ON reservation.person_id=assignment->>'personId'
          WHERE reservation.service_interval && tsrange(
            CAST(${command.serviceDate} AS date)+CAST(${command.startTime} AS time),
            CAST(${command.serviceDate} AS date)+CAST(${command.endTime} AS time),'[)')
          LIMIT 1`;

        if (occupied.length > 0) return yield* fail("commitment.duplicate", 409);
        yield* sql`INSERT INTO public.school_service_commitments(
          commitment_id,proposal_id,department_id,semester_id,school_id,school_name,day,block,
          service_date,start_time,end_time,required_volunteers,assignment_snapshot,created_at,created_by_person_id
        ) VALUES(${newId},${proposal.proposalId},${scope.departmentId},${scope.semesterId},
          ${command.schoolId},${schoolName},${command.day},${command.block},CAST(${command.serviceDate} AS date),
          CAST(${command.startTime} AS time),CAST(${command.endTime} AS time),${demand.requiredVolunteers},
          ${sql.json(assignments)},${now},${actor})`;
        yield* sql`INSERT INTO public.school_service_audit(department_id,semester_id,actor_person_id,action,occurred_at,snapshot)
          VALUES(${scope.departmentId},${scope.semesterId},${actor},'ScheduleService',${now},${sql.json({ ...command, commitmentId: newId, requiredVolunteers: demand.requiredVolunteers, assignments })})`;

        return yield* readPlacementBoard(scope);
      }

      const existing =
        command.action === "Create"
          ? undefined
          : board.placements.find((placement) => placement.placementId === command.placementId);

      if (command.action !== "Create" && !existing) return yield* fail("resource.not-found", 404);

      if (existing && !existing.active) return yield* fail("placement.inactive");
      const personId = command.action === "Create" ? command.personId : existing!.personId;
      const placementId = command.action === "Create" ? newId : existing!.placementId;
      const revision = (existing?.revision ?? 0) + 1;

      if (command.action !== "Remove") {
        const affiliation = yield* readOwnAffiliation(personId, scope.departmentId);

        if (affiliation.status !== "Active") return yield* fail("affiliation.inactive");

        if (!board.schools.some((school) => school.schoolId === command.schoolId)) {
          return yield* fail("scope.invalid");
        }

        const overlaps =
          yield* sql`SELECT placement_id FROM public.assistant_placements WHERE active AND person_id=${personId} AND school_id=${command.schoolId} AND semester_id=${scope.semesterId} AND placement_id<>${placementId} AND block=${command.block}`;

        if (overlaps.length) return yield* fail("placement.overlap", 409);
        yield* sql`INSERT INTO public.assistant_placements(placement_id,person_id,department_id,semester_id,school_id,day,workdays,block,active,revision) VALUES(${placementId},${personId},${scope.departmentId},${scope.semesterId},${command.schoolId},${command.day},${command.workdays},${command.block},true,${revision}) ON CONFLICT(placement_id) DO UPDATE SET school_id=EXCLUDED.school_id,day=EXCLUDED.day,workdays=EXCLUDED.workdays,block=EXCLUDED.block,revision=EXCLUDED.revision`;
      } else {
        yield* sql`UPDATE public.assistant_placements SET active=false,revision=${revision} WHERE placement_id=${placementId}`;
      }

      yield* sql`INSERT INTO public.assistant_placement_audit(placement_id,revision,actor_person_id,occurred_at,action,snapshot) SELECT placement_id,revision,${actor},${now},${command.action},to_jsonb(placement) FROM public.assistant_placements placement WHERE placement_id=${placementId}`;

      return yield* readPlacementBoard(scope);
    }),
  );
