import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { afterAll, describe, expect, it } from "vitest";
import { Database } from "./service.js";
import { DepartmentId, PersonId, SemesterId } from "@vektorprogrammet/domain/organization";
import {
  SchoolServiceAbsenceId,
  SchoolServiceCommitmentId,
  SchoolServiceCoverageAcknowledgementId,
  SchoolServiceDispatchNotificationDeliveryError,
  SchoolServiceOccurrenceId,
  SchoolServiceProposalId,
  SchoolServiceSubstituteOfferId,
} from "@vektorprogrammet/domain/placements";
import { SchoolId } from "@vektorprogrammet/domain/schools";
import {
  deliverNextSchoolServiceDispatchNotification,
  deliverNextSchoolServiceNotification,
  lockPlacementDepartment,
  mutateAffiliation,
  mutateCoverageBoard,
  mutateOwnCoverage,
  mutatePlacementBoard,
  readCoverageBoard,
  readOwnAffiliation,
  readOwnCoverage,
  readPlacementBoard,
} from "@vektorprogrammet/database/placements";
import { Effect } from "effect";
import { DatabaseTest } from "./layers.js";
import { makeControlledTestRuntime } from "../test/runtime.js";
const runtime = makeControlledTestRuntime(DatabaseTest());
afterAll(() => runtime.dispose());
const scope = {
  departmentId: DepartmentId.make("placement-department"),
  semesterId: SemesterId.make("placement-semester"),
};
const volunteer = PersonId.make("placement-volunteer");
const coordinator = PersonId.make("placement-coordinator");
const now = "2026-09-06T00:00:00.000Z";
describe("canonical placement persistence", () => {
  it("retains audited parent, distinct blocks and person across create/edit/remove and affiliation revocation", async () => {
    const observed = await runtime.runPromise(
      Database.use((sql) =>
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO organization_departments(department_id,name,short_name,email,city) VALUES(${scope.departmentId},'Placement department','PD','placement@example.invalid','Trondheim')`;
            yield* sql`INSERT INTO admission_period_semesters(semester_id,start_at,end_at) VALUES(${scope.semesterId},'2024-08-01T00:00:00Z','2024-12-31T00:00:00Z')`;
            yield* sql`INSERT INTO person_profiles(person_id,first_name,last_name) VALUES(${volunteer},'Vera','Volunteer'),(${coordinator},'Cora','Coordinator')`;
            const schools = yield* sql<{
              schoolId: number;
            }>`INSERT INTO schools_directory_schools(name,contact_person,email,phone,language,active) VALUES('Placement school','Contact','school@example.invalid','12345678','Norwegian',true) RETURNING school_id::double precision AS "schoolId"`;
            const schoolId = SchoolId.make(schools[0]!.schoolId);
            yield* sql`INSERT INTO schools_directory_departments(school_id,department_id) VALUES(${schoolId},${scope.departmentId})`;
            yield* lockPlacementDepartment(scope.departmentId);
            const absent = yield* readOwnAffiliation(volunteer, scope.departmentId);
            const pending = yield* mutateAffiliation(absent, "Request", volunteer, now);
            const active = yield* mutateAffiliation(pending, "Establish", coordinator, now);
            const one = `placement-${"1".repeat(64)}`;
            const two = `placement-${"2".repeat(64)}`;
            const values = { schoolId, day: "Monday" as const, workdays: 4, block: "1" as const };
            yield* mutatePlacementBoard(
              scope,
              { action: "Create", personId: volunteer, ...values },
              coordinator,
              now,
              one,
            );
            yield* mutatePlacementBoard(
              scope,
              { action: "Create", personId: volunteer, ...values, block: "2" },
              coordinator,
              now,
              two,
            );
            yield* mutatePlacementBoard(
              scope,
              { action: "Edit", placementId: one, ...values, day: "Friday", workdays: 8 },
              coordinator,
              now,
              "unused",
            );
            yield* mutatePlacementBoard(
              scope,
              { action: "Remove", placementId: one },
              coordinator,
              now,
              "unused",
            );
            yield* mutateAffiliation(active, "Revoke", coordinator, now);
            const board = yield* readPlacementBoard(scope);
            const audit =
              yield* sql`SELECT placement_id AS "placementId",revision,action,snapshot->>'active' AS active FROM assistant_placement_audit ORDER BY placement_id,revision`;
            const people =
              yield* sql`SELECT person_id,first_name,last_name FROM person_profiles WHERE person_id=${volunteer}`;
            const inactive = yield* Effect.flip(
              mutatePlacementBoard(
                scope,
                { action: "Create", personId: volunteer, ...values },
                coordinator,
                now,
                `placement-${"3".repeat(64)}`,
              ),
            );
            return { board, audit, people, inactive };
          }),
        ),
      ),
    );
    expect(observed.board.placements).toMatchObject([
      { active: false, revision: 3, day: "Friday", workdays: 8, block: "1" },
      { active: true, revision: 1, day: "Monday", workdays: 4, block: "2" },
    ]);
    expect(observed.audit.map((row) => [row.revision, row.action, row.active])).toEqual([
      [1, "Create", "true"],
      [2, "Edit", "true"],
      [3, "Remove", "false"],
      [1, "Create", "true"],
    ]);
    expect(observed.board.affiliations[0]?.status).toBe("Inactive");
    expect(observed.people).toEqual([
      { person_id: volunteer, first_name: "Vera", last_name: "Volunteer" },
    ]);
    expect(observed.inactive).toMatchObject({ code: "affiliation.inactive" });
  }, 15000);
  it("freezes reviewed demand into a confirmed roster and exact teaching occurrence", async () => {
    const serviceScope = {
      departmentId: DepartmentId.make("service-department"),
      semesterId: SemesterId.make("service-semester"),
    };
    const serviceVolunteer = PersonId.make("service-volunteer");
    const serviceCoordinator = PersonId.make("service-coordinator");
    const proposalId = SchoolServiceProposalId.make(`school-service-proposal-${"a".repeat(64)}`);
    const newerProposalId = SchoolServiceProposalId.make(
      `school-service-proposal-${"c".repeat(64)}`,
    );
    const commitmentId = SchoolServiceCommitmentId.make(`school-service-commitment-${"b".repeat(64)}`);
    const observed = await runtime.runPromise(
      Database.use((sql) =>
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO organization_departments(department_id,name,short_name,email,city) VALUES(${serviceScope.departmentId},'Service department','SD','service@example.invalid','Trondheim')`;
            yield* sql`INSERT INTO admission_period_semesters(semester_id,start_at,end_at) VALUES(${serviceScope.semesterId},'2026-08-01T00:00:00Z','2026-12-31T00:00:00Z')`;
            yield* sql`INSERT INTO person_profiles(person_id,first_name,last_name) VALUES(${serviceVolunteer},'Sara','Service'),(${serviceCoordinator},'Cora','Coordinator')`;
            const schools = yield* sql<{
              schoolId: number;
            }>`INSERT INTO schools_directory_schools(name,contact_person,email,phone,language,active) VALUES('Service school','Contact','service-school@example.invalid','12345678','Norwegian',true) RETURNING school_id::double precision AS "schoolId"`;
            const schoolId = SchoolId.make(schools[0]!.schoolId);
            yield* sql`INSERT INTO schools_directory_departments(school_id,department_id) VALUES(${schoolId},${serviceScope.departmentId})`;
            const pending = yield* mutateAffiliation(
              yield* readOwnAffiliation(serviceVolunteer, serviceScope.departmentId),
              "Request",
              serviceVolunteer,
              now,
            );
            yield* mutateAffiliation(pending, "Establish", serviceCoordinator, now);
            yield* mutatePlacementBoard(
              serviceScope,
              {
                action: "Create",
                personId: serviceVolunteer,
                schoolId,
                day: "Monday",
                workdays: 8,
                block: "1",
              },
              serviceCoordinator,
              now,
              `placement-${"4".repeat(64)}`,
            );
            yield* mutatePlacementBoard(
              serviceScope,
              {
                action: "SetDemand",
                schoolId,
                day: "Monday",
                block: "1",
                requiredVolunteers: 2,
              },
              serviceCoordinator,
              now,
              "unused",
            );
            const draft = yield* mutatePlacementBoard(
              serviceScope,
              { action: "GenerateProposal" },
              serviceCoordinator,
              now,
              proposalId,
            );
            const incompleteReview = yield* Effect.flip(
              mutatePlacementBoard(
                serviceScope,
                { action: "ConfirmProposal", proposalId, reviewedExceptionIds: [] },
                serviceCoordinator,
                now,
                "unused",
              ),
            );
            const exceptionIds = draft.proposal!.exceptions.map(
              (exception) => exception.exceptionId,
            );
            yield* mutatePlacementBoard(
              serviceScope,
              { action: "GenerateProposal" },
              serviceCoordinator,
              "2026-09-06T00:30:00.000Z",
              newerProposalId,
            );
            yield* mutatePlacementBoard(
              serviceScope,
              { action: "ConfirmProposal", proposalId, reviewedExceptionIds: exceptionIds },
              serviceCoordinator,
              "2026-09-06T01:00:00.000Z",
              "unused",
            );
            const confirmedStatus =
              yield* sql`SELECT status FROM school_service_proposals WHERE proposal_id=${proposalId}`;
            const scheduled = yield* mutatePlacementBoard(serviceScope, {
              action: "ScheduleService", proposalId, schoolId, day: "Monday", block: "1",
              serviceDate: "2026-09-07", startTime: "09:00", endTime: "11:00",
            }, serviceCoordinator, now, commitmentId);
            const invalidAttendance = yield* Effect.flip(mutateCoverageBoard(serviceScope, {
              action: "CompleteService", commitmentId, attendedPersonIds: [serviceVolunteer],
              evidenceSource: "School contact attendance register",
            }, serviceCoordinator, "2026-09-07T12:00:00.000Z", {
              absenceId: "unused", offerId: "unused", acknowledgementId: "unused",
              occurrenceId: SchoolServiceOccurrenceId.make("school-service-occurrence-" + "b".repeat(64)),
            }));
            const recorded = yield* mutateCoverageBoard(serviceScope, {
              action: "MarkUnfulfilledService", commitmentId, attendedPersonIds: [serviceVolunteer],
              reason: "One assistant short", evidenceSource: "School contact attendance register",
            }, serviceCoordinator, "2026-09-07T12:00:00.000Z", {
              absenceId: "unused", offerId: "unused", acknowledgementId: "unused",
              occurrenceId: SchoolServiceOccurrenceId.make("school-service-occurrence-" + "b".repeat(64)),
            });
            const outbox =
              yield* sql`SELECT status,attempts,payload_json->>'personId' AS "personId" FROM school_service_notification_outbox WHERE proposal_id=${proposalId}`;
            const audit =
              yield* sql`SELECT action FROM school_service_audit WHERE department_id=${serviceScope.departmentId} ORDER BY audit_id`;
            return {
              draft,
              incompleteReview,
              confirmedStatus,
              invalidAttendance,
              scheduled,
              recorded,
              outbox,
              audit,
            };
          }),
        ),
      ),
    );
    expect(observed.draft.proposal).toMatchObject({
      proposalId,
      status: "Draft",
      assignments: [{ personId: serviceVolunteer }],
      exceptions: [{ code: "DemandUnfilled", requiredVolunteers: 2, assignedVolunteers: 1 }],
    });
    expect(observed.incompleteReview).toMatchObject({
      code: "school-service.exception-review-invalid",
    });
    expect(observed.confirmedStatus).toEqual([{ status: "Confirmed" }]);
    expect(observed.invalidAttendance).toMatchObject({ code: "commitment.outcome-invalid" });
    expect(observed.scheduled.commitments[0]).toMatchObject({ commitmentId, requiredVolunteers: 2, decision: null });
    expect(observed.recorded.commitments[0]).toMatchObject({ commitmentId, decision: { outcome: "Unfulfilled", attendedPersonIds: [serviceVolunteer] } });
    expect(observed.recorded.occurrences).toMatchObject([
      { proposalId, occurredOn: "2026-09-07", attendedPersonIds: [serviceVolunteer] },
    ]);
    expect(observed.outbox).toEqual([
      { status: "Pending", attempts: 0, personId: serviceVolunteer },
    ]);
    expect(observed.audit.map(({ action }) => action)).toEqual([
      "SetDemand",
      "GenerateProposal",
      "GenerateProposal",
      "ConfirmProposal",
      "ScheduleService",
    ]);
  }, 15000);
  it("delivers a canonical roster envelope once and quarantines a forged envelope", async () => {
    let deliveredEffectId = "";
    const delivered = await runtime.runPromise(
      deliverNextSchoolServiceNotification(
        "service-worker:1",
        "2026-09-06T01:01:00.000Z",
        (request) =>
          Effect.sync(() => {
            deliveredEffectId = request.effectId;
          }),
      ),
    );
    const forgedEffectId = `school-service-notification:school-service-proposal-${"a".repeat(64)}:${coordinator}`;
    await runtime.runPromise(
      Database.use(
        (sql) =>
          sql`INSERT INTO school_service_notification_outbox(effect_id,proposal_id,person_id,payload_json) SELECT ${forgedEffectId},proposal_id,${coordinator},jsonb_set(jsonb_set(jsonb_set(payload_json,'{effectId}',to_jsonb(${forgedEffectId}::text)),'{personId}',to_jsonb(${coordinator}::text)),'{assignments}','[]'::jsonb) FROM school_service_notification_outbox WHERE effect_id=${deliveredEffectId}`,
      ),
    );
    const quarantined = await runtime.runPromise(
      deliverNextSchoolServiceNotification("service-worker:2", "2026-09-06T01:02:00.000Z", () =>
        Effect.die("forged envelope must not reach transport"),
      ),
    );
    const rows = await runtime.runPromise(
      Database.use(
        (sql) =>
          sql`SELECT effect_id AS "effectId",status,attempts,last_failure_tag AS "lastFailureTag" FROM school_service_notification_outbox ORDER BY status`,
      ),
    );
    expect(delivered).toMatchObject({ _tag: "Delivered" });
    expect(deliveredEffectId).toContain("school-service-notification:");
    expect(quarantined).toEqual({
      _tag: "Quarantined",
      effectId: forgedEffectId,
      failureTag: "AuthorityEnvelopeMismatch",
    });
    expect(rows).toMatchObject([
      { status: "Delivered", attempts: 1, lastFailureTag: null },
      { status: "Quarantined", attempts: 1, lastFailureTag: "AuthorityEnvelopeMismatch" },
    ]);
  }, 15000);
  it("keeps absence, offer response, acknowledgement, delivery, and closure facts separate", async () => {
    const coverageScope = {
      departmentId: DepartmentId.make("coverage-department"),
      semesterId: SemesterId.make("coverage-semester"),
    };
    const rosterPerson = PersonId.make("coverage-roster-person");
    const candidatePerson = PersonId.make("coverage-candidate-person");
    const coverageCoordinator = PersonId.make("coverage-coordinator");
    const proposalId = SchoolServiceProposalId.make(`school-service-proposal-${"f".repeat(64)}`);
    const newerProposalId = SchoolServiceProposalId.make(
      `school-service-proposal-${"e".repeat(64)}`,
    );
    const commitmentId = SchoolServiceCommitmentId.make(`school-service-commitment-${"1".repeat(64)}`);
    const absenceId = SchoolServiceAbsenceId.make(`school-service-absence-${"1".repeat(64)}`);
    const offerId = SchoolServiceSubstituteOfferId.make(
      `school-service-substitute-offer-${"2".repeat(64)}`,
    );
    const acknowledgementId = SchoolServiceCoverageAcknowledgementId.make(
      `school-service-coverage-acknowledgement-${"3".repeat(64)}`,
    );
    const occurrenceId = SchoolServiceOccurrenceId.make(
      `school-service-occurrence-${"4".repeat(64)}`,
    );
    const observed = await runtime.runPromise(
      Database.use((sql) =>
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO organization_departments(department_id,name,short_name,email,city) VALUES(${coverageScope.departmentId},'Coverage department','CD','coverage@example.invalid','Trondheim')`;
            yield* sql`INSERT INTO admission_period_departments(department_id,name) VALUES(${coverageScope.departmentId},'Coverage department')`;
            yield* sql`INSERT INTO admission_period_semesters VALUES(${coverageScope.semesterId},'2026-08-01T00:00:00Z','2026-12-31T00:00:00Z')`;
            yield* sql`INSERT INTO admission_periods VALUES('coverage-period',${coverageScope.departmentId},${coverageScope.semesterId},'2026-08-01T00:00:00Z','2026-12-31T00:00:00Z',0,'coverage-seed')`;
            yield* sql`INSERT INTO admission_period_fields_of_study VALUES('coverage-field',${coverageScope.departmentId},'Math',true)`;
            yield* sql`INSERT INTO person_profiles(person_id,first_name,last_name) VALUES(${rosterPerson},'Rosa','Roster'),(${candidatePerson},'Cato','Candidate'),(${coverageCoordinator},'Cora','Coordinator')`;
            const schools = yield* sql<{
              schoolId: number;
            }>`INSERT INTO schools_directory_schools(name,contact_person,email,phone,language,active) VALUES('Coverage school','Contact','coverage-school@example.invalid','12345678','Norwegian',true) RETURNING school_id::double precision AS "schoolId"`;
            const schoolId = SchoolId.make(schools[0]!.schoolId);
            yield* sql`INSERT INTO schools_directory_departments(school_id,department_id) VALUES(${schoolId},${coverageScope.departmentId})`;
            yield* sql`INSERT INTO organization_volunteer_affiliations(person_id,department_id,status,revision) VALUES(${candidatePerson},${coverageScope.departmentId},'Active',1)`;
            yield* sql`INSERT INTO admission_applicants(applicant_id,normalized_email,email,first_name,last_name,phone,gender,field_of_study_id,year_of_study) VALUES('coverage-applicant','coverage@applicant.invalid','coverage@applicant.invalid','Cato','Candidate','12345678',0,'coverage-field',2)`;
            yield* sql`INSERT INTO admission_applications(application_id,applicant_id,admission_period_id,department_id,field_of_study_id,year_of_study,submitted_at) VALUES('coverage-application','coverage-applicant','coverage-period',${coverageScope.departmentId},'coverage-field',2,${now})`;
            yield* sql`INSERT INTO applicant_account_invitations(invitation_id,application_id,applicant_id,token_digest,expires_at,state,issued_by,issued_at) VALUES('coverage-invitation','coverage-application','coverage-applicant',${"a".repeat(64)},'2027-01-01T00:00:00Z','Claimed',${coverageCoordinator},${now})`;
            yield* sql`INSERT INTO applicant_account_links(applicant_id,person_id,linked_at,invitation_id) VALUES('coverage-applicant',${candidatePerson},${now},'coverage-invitation')`;
            yield* sql`INSERT INTO admission_substitute_preferences(application_id,active,monday,tuesday,wednesday,thursday,friday,language,revision) VALUES('coverage-application',true,true,false,false,false,false,'Norwegian',1)`;
            yield* sql`INSERT INTO school_service_proposals(proposal_id,department_id,semester_id,status,revision,created_at,created_by_person_id,confirmed_at,confirmed_by_person_id,demand_snapshot,assignment_snapshot,exception_snapshot,reviewed_exception_ids) VALUES(${proposalId},${coverageScope.departmentId},${coverageScope.semesterId},'Confirmed',2,${now},${coverageCoordinator},${now},${coverageCoordinator},${sql.json([{ schoolId, day: "Monday", block: "1", requiredVolunteers: 1, revision: 1 }])},${sql.json([{ placementId: `placement-${"5".repeat(64)}`, personId: rosterPerson, firstName: "Rosa", lastName: "Roster", schoolId, schoolName: "Coverage school", day: "Monday", block: "1" }])},${sql.json([])},${sql.json([])})`;
            yield* lockPlacementDepartment(coverageScope.departmentId);
            yield* mutatePlacementBoard(coverageScope, { action: "ScheduleService", proposalId, schoolId, day: "Monday", block: "1", serviceDate: "2026-09-14", startTime: "09:00", endTime: "11:00" }, coverageCoordinator, now, commitmentId);
            yield* mutateCoverageBoard(
              coverageScope,
              {
                action: "ReportAbsenceForVolunteer",
                personId: rosterPerson,
                commitmentId,
              },
              coverageCoordinator,
              now,
              { absenceId, offerId, acknowledgementId, occurrenceId },
            );
            const dispatched = yield* mutateCoverageBoard(
              coverageScope,
              { action: "DispatchSubstituteOffer", absenceId, candidatePersonId: candidatePerson },
              coverageCoordinator,
              now,
              { absenceId, offerId, acknowledgementId, occurrenceId },
            );
            const blocked = yield* Effect.flip(
              mutateCoverageBoard(
                coverageScope,
                {
                  action: "CompleteService",
                  commitmentId,
                  attendedPersonIds: [candidatePerson],
                  evidenceSource: "School contact attendance register",
                },
                coverageCoordinator,
                "2026-09-14T12:00:00.000Z",
                { absenceId, offerId, acknowledgementId, occurrenceId },
              ),
            );
            yield* sql`
              UPDATE admission_substitute_preferences
              SET active=false,revision=revision+1
              WHERE application_id='coverage-application'
            `;
            yield* mutateOwnCoverage(
              coverageScope,
              { action: "RespondToOffer", offerId, response: "Accept" },
              candidatePerson,
              now,
              absenceId,
            );
            yield* mutateCoverageBoard(
              coverageScope,
              { action: "AcknowledgeCoverage", offerId },
              coverageCoordinator,
              now,
              { absenceId, offerId, acknowledgementId, occurrenceId },
            );
            const closed = yield* mutateCoverageBoard(
              coverageScope,
              {
                action: "CompleteService",
                commitmentId,
                attendedPersonIds: [candidatePerson],
                evidenceSource: "School contact attendance register",
              },
              coverageCoordinator,
              "2026-09-14T12:00:00.000Z",
              { absenceId, offerId, acknowledgementId, occurrenceId },
            );
            yield* sql`INSERT INTO school_service_proposals(proposal_id,department_id,semester_id,status,revision,created_at,created_by_person_id,confirmed_at,confirmed_by_person_id,demand_snapshot,assignment_snapshot,exception_snapshot,reviewed_exception_ids) VALUES(${newerProposalId},${coverageScope.departmentId},${coverageScope.semesterId},'Confirmed',2,'2026-09-06T01:00:00.000Z',${coverageCoordinator},'2026-09-06T01:00:00.000Z',${coverageCoordinator},${sql.json([])},${sql.json([{ placementId: `placement-${"7".repeat(64)}`, personId: rosterPerson, firstName: "Rosa", lastName: "Roster", schoolId, schoolName: "Coverage school", day: "Tuesday", block: "2" }])},${sql.json([])},${sql.json([])})`;
            const afterNewerProposal = yield* readCoverageBoard(coverageScope);
            const zeroId = SchoolServiceCommitmentId.make("school-service-commitment-" + "8".repeat(64));
            const cancelId = SchoolServiceCommitmentId.make("school-service-commitment-" + "9".repeat(64));
            const zeroAbsenceId = SchoolServiceAbsenceId.make("school-service-absence-" + "8".repeat(64));
            const cancelAbsenceId = SchoolServiceAbsenceId.make("school-service-absence-" + "9".repeat(64));
            for (const [commitmentId, serviceDate] of [[zeroId, "2026-09-21"], [cancelId, "2026-09-28"]] as const) {
              yield* mutatePlacementBoard(coverageScope, { action: "ScheduleService", proposalId, schoolId, day: "Monday", block: "1", serviceDate, startTime: "09:00", endTime: "11:00" }, coverageCoordinator, now, commitmentId);
            }
            for (const [commitmentId, nextAbsence] of [[zeroId, zeroAbsenceId], [cancelId, cancelAbsenceId]] as const) {
              yield* mutateCoverageBoard(coverageScope, { action: "ReportAbsenceForVolunteer", commitmentId, personId: rosterPerson }, coverageCoordinator, now,
                { absenceId: nextAbsence, offerId: "unused", acknowledgementId: "unused", occurrenceId: "unused" });
            }
            yield* sql`UPDATE admission_substitute_preferences SET active=true,revision=revision+1 WHERE application_id='coverage-application'`;
            const noShowOfferId = SchoolServiceSubstituteOfferId.make("school-service-substitute-offer-" + "8".repeat(64));
            const noShowAckId = SchoolServiceCoverageAcknowledgementId.make("school-service-coverage-acknowledgement-" + "8".repeat(64));
            yield* mutateCoverageBoard(coverageScope, { action: "DispatchSubstituteOffer", absenceId: zeroAbsenceId, candidatePersonId: candidatePerson },
              coverageCoordinator, now, { absenceId: zeroAbsenceId, offerId: noShowOfferId, acknowledgementId: noShowAckId, occurrenceId: "unused" });
            yield* mutateOwnCoverage(coverageScope, { action: "RespondToOffer", offerId: noShowOfferId, response: "Accept" }, candidatePerson, now, zeroAbsenceId);
            yield* mutateCoverageBoard(coverageScope, { action: "AcknowledgeCoverage", offerId: noShowOfferId },
              coverageCoordinator, now, { absenceId: zeroAbsenceId, offerId: noShowOfferId, acknowledgementId: noShowAckId, occurrenceId: "unused" });
            const zeroDecision = yield* mutateCoverageBoard(coverageScope, {
              action: "MarkUnfulfilledService", commitmentId: zeroId, attendedPersonIds: [],
              reason: "No assistants attended", evidenceSource: "School contact attendance register",
            }, coverageCoordinator, "2026-09-21T12:00:00.000Z",
            { absenceId: "unused", offerId: "unused", acknowledgementId: "unused", occurrenceId: "unused" });
            const cancelled = yield* mutateCoverageBoard(coverageScope, {
              action: "CancelService", commitmentId: cancelId, reason: "School closed that day",
              evidenceSource: "School contact cancellation message",
            }, coverageCoordinator, now,
            { absenceId: "unused", offerId: "unused", acknowledgementId: "unused", occurrenceId: "unused" });
            const repeated = yield* Effect.flip(mutateCoverageBoard(coverageScope, {
              action: "CancelService", commitmentId: zeroId, reason: "Changed mind",
              evidenceSource: "Coordinator note",
            }, coverageCoordinator, "2026-09-22T12:00:00.000Z",
            { absenceId: "unused", offerId: "unused", acknowledgementId: "unused", occurrenceId: "unused" }));
            const lateAbsence = yield* Effect.flip(mutateCoverageBoard(coverageScope, {
              action: "ReportAbsenceForVolunteer", commitmentId: cancelId, personId: rosterPerson,
            }, coverageCoordinator, now,
            { absenceId: "unused", offerId: "unused", acknowledgementId: "unused", occurrenceId: "unused" }));
            const ownCandidate = yield* readOwnCoverage(coverageScope, candidatePerson);
            return { dispatched, blocked, closed, afterNewerProposal, zeroDecision, cancelled, repeated, lateAbsence, ownCandidate, zeroAbsenceId, cancelAbsenceId };
          }),
        ),
      ),
    );
    const invalidScope = await runtime.runPromise(
      Effect.flip(
        readCoverageBoard({
          ...coverageScope,
          semesterId: SemesterId.make("coverage-missing-semester"),
        }),
      ),
    );
    await runtime.runPromise(
      Database.use(
        (sql) =>
          sql`UPDATE schools_directory_schools SET name='Renamed coverage school' WHERE name='Coverage school'`,
      ),
    );
    const failed = await runtime.runPromise(
      deliverNextSchoolServiceDispatchNotification(
        "coverage-worker:1",
        "2026-09-06T00:01:00.000Z",
        (request) =>
          Effect.fail(
            new SchoolServiceDispatchNotificationDeliveryError({ effectId: request.effectId }),
          ),
      ),
    );
    let deliveredEffectId = "";
    const delivery = await runtime.runPromise(
      deliverNextSchoolServiceDispatchNotification(
        "coverage-worker:2",
        "2026-09-06T00:02:00.000Z",
        (request) =>
          Effect.sync(() => {
            deliveredEffectId = request.effectId;
          }),
      ),
    );
    const retry = await runtime.runPromise(deliverNextSchoolServiceDispatchNotification(
      "coverage-worker:3", "2026-09-06T00:03:00.000Z", (request) => Effect.sync(() => { deliveredEffectId = request.effectId; }),
    ));
    expect(observed.dispatched.offers).toMatchObject([{ offerId, status: "Offered" }]);
    expect(observed.zeroDecision.commitments.find((entry) => entry.commitmentId === SchoolServiceCommitmentId.make("school-service-commitment-" + "8".repeat(64)))?.decision).toMatchObject({ outcome: "Unfulfilled", attendedPersonIds: [], occurrenceId: null });
    expect(observed.zeroDecision.closures).toContainEqual(expect.objectContaining({ absenceId: observed.zeroAbsenceId, outcome: "Uncovered", occurrenceId: null }));
    expect(observed.cancelled.commitments.find((entry) => entry.commitmentId === SchoolServiceCommitmentId.make("school-service-commitment-" + "9".repeat(64)))?.decision).toMatchObject({ outcome: "Cancelled", attendedPersonIds: [], occurrenceId: null });
    expect(observed.cancelled.closures.some((closure) => closure.absenceId === observed.cancelAbsenceId)).toBe(false);
    expect(observed.cancelled.occurrences).toHaveLength(1);
    expect(observed.repeated).toMatchObject({ code: "commitment.closed" });
    expect(observed.lateAbsence).toMatchObject({ code: "commitment.closed" });
    expect(observed.ownCandidate.commitments.map((entry) => entry.commitmentId)).toEqual([commitmentId, SchoolServiceCommitmentId.make("school-service-commitment-" + "8".repeat(64))]);
    expect(observed.blocked).toMatchObject({ code: "commitment.pending-offer" });
    expect(invalidScope).toMatchObject({ code: "scope.invalid" });
    expect(observed.closed.closures).toMatchObject([
      {
        absenceId,
        occurrenceId,
        scheduledPersonId: rosterPerson,
        outcome: "Covered",
        acknowledgementId,
        substitutePersonId: candidatePerson,
      },
    ]);
    expect(observed.closed.occurrences).toMatchObject([
      { occurrenceId, attendedPersonIds: [candidatePerson] },
    ]);
    expect(
      observed.afterNewerProposal.rosterAssignments.map((assignment) => assignment.proposalId),
    ).toEqual([newerProposalId, proposalId]);
    expect(failed).toMatchObject({
      _tag: "Failed",
      failureTag: "SchoolServiceDispatchNotificationDeliveryError",
      claim: { effectId: `school-service-substitute-dispatch:${offerId}`, attempts: 1 },
    });
    expect(delivery).toMatchObject({ _tag: "Delivered", claim: { attempts: 1 } });
    expect(retry).toMatchObject({ _tag: "Delivered", claim: { effectId: `school-service-substitute-dispatch:${offerId}`, attempts: 2 } });
    expect(deliveredEffectId).toBe(`school-service-substitute-dispatch:${offerId}`);
  }, 15000);
});

describe("placement schema ownership", () => {
  it("creates canonical placement and coverage tables in public even when auth is first in search_path", async () => {
    const pglite = new PGlite({ extensions: { btree_gist } });
    await pglite.waitReady;
    await pglite.exec("SET search_path TO auth,public");
    const isolated = makeControlledTestRuntime(DatabaseTest({ liveClient: pglite }));
    try {
      const rows = await isolated.runPromise(
        Database.use(
          (sql) => sql<{ name: string; publicExists: boolean; authExists: boolean }>`
        SELECT name, to_regclass('public.' || name) IS NOT NULL AS "publicExists",
          to_regclass('auth.' || name) IS NOT NULL AS "authExists"
        FROM (VALUES ('organization_volunteer_affiliations'), ('organization_volunteer_affiliation_audit'),
          ('assistant_placements'), ('assistant_placement_audit'), ('school_service_commitments'),
          ('school_service_decisions'), ('school_service_absences'),
          ('school_service_substitute_offers'), ('school_service_substitute_offer_responses'),
          ('school_service_substitute_offer_withdrawals'), ('school_service_coverage_acknowledgements'),
          ('school_service_dispatch_notification_outbox'), ('school_service_closures'),
          ('school_service_coverage_audit')) AS expected(name) ORDER BY name
      `,
        ),
      );
      expect(rows).toHaveLength(14);
      for (const row of rows) expect(row).toMatchObject({ publicExists: true, authExists: false });
    } finally {
      await isolated.dispose();
      await pglite.close();
    }
  }, 15000);
});
