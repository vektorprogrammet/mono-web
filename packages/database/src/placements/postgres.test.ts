import {
  deliverNextSchoolServiceNotification,
  recoverStaleSchoolServiceNotifications,
  SchoolServiceNotificationDeliveryResult,
} from "./outbox.js";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { describe, expect, it, layer } from "@effect/vitest";
import { Database, type DatabaseOperations } from "../service.js";
import { DepartmentId, PersonId, SemesterId } from "@vektorprogrammet/domain/organization";
import {
  SchoolServiceAbsenceId,
  SchoolServiceCommitmentId,
  SchoolServiceCoverageId,
  SchoolServiceNotificationDeliveryError,
  SchoolServiceNotificationRequest,
  SchoolServiceOccurrenceId,
  SchoolServiceProposalId,
  type CoverageCommand,
  type OwnCoverageCommand,
} from "@vektorprogrammet/domain/placements";
import { SchoolId } from "@vektorprogrammet/domain/schools";
import {
  lockPlacementDepartment,
  mutateAffiliation,
  mutatePlacementBoard,
  readOwnAffiliation,
  readPlacementBoard,
} from "./postgres.js";
import {
  mutateCoverageBoard,
  mutateOwnCoverage,
  readCoverageBoard,
  readOwnCoverage,
} from "./coverage.js";
import { Effect, Exit } from "effect";
import { TestClock } from "effect/testing";
import { DatabaseTestLive } from "../test-support/platform.js";

const scope = {
  departmentId: DepartmentId.make("placement-department"),
  semesterId: SemesterId.make("placement-semester"),
};

const volunteer = PersonId.make("placement-volunteer");

const coordinator = PersonId.make("placement-coordinator");

const now = "2026-09-06T00:00:00.000Z";

layer(DatabaseTestLive(), { excludeTestServices: true, timeout: "30 seconds" })(
  "canonical placement persistence",
  (it) => {
    it.effect(
      "retains audited parent, distinct blocks and person across create/edit/remove and affiliation revocation",
      () =>
        Effect.gen(function* () {
          const observed = yield* Database.use((sql) =>
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

                const values = {
                  schoolId,
                  day: "Monday" as const,
                  workdays: 4,
                  block: "1" as const,
                };

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

                const otherDepartment = DepartmentId.make("placement-other-department");
                const otherSemester = SemesterId.make("placement-other-semester");
                yield* sql`INSERT INTO organization_departments(department_id,name,short_name,email,city) VALUES(${otherDepartment},'Other department','OD','other-placement@example.invalid','Bergen')`;
                yield* sql`INSERT INTO admission_period_semesters(semester_id,start_at,end_at) VALUES(${otherSemester},'2025-01-01T00:00:00Z','2025-06-30T00:00:00Z')`;
                yield* sql`INSERT INTO schools_directory_departments(school_id,department_id) VALUES(${schoolId},${otherDepartment})`;
                yield* sql`INSERT INTO organization_volunteer_affiliations(person_id,department_id,status,revision) VALUES(${coordinator},${scope.departmentId},'Active',1),(${volunteer},${otherDepartment},'Active',1)`;
                yield* sql`INSERT INTO assistant_placements(placement_id,person_id,department_id,semester_id,school_id,day,workdays,block,active,revision) VALUES
          (${"placement-" + "a1".repeat(32)},${coordinator},${scope.departmentId},${scope.semesterId},${schoolId},'Monday',4,'1',true,1),
          (${"placement-" + "a2".repeat(32)},${volunteer},${otherDepartment},${scope.semesterId},${schoolId},'Monday',4,'1',true,1),
          (${"placement-" + "a3".repeat(32)},${volunteer},${scope.departmentId},${otherSemester},${schoolId},'Monday',4,'1',true,1)`;
                const ownPlacements = (yield* readOwnCoverage(scope, volunteer)).placements;
                const otherPlacements = (yield* readOwnCoverage(scope, coordinator)).placements;

                return { board, audit, people, inactive, ownPlacements, otherPlacements };
              }),
            ),
          );

          expect(observed.ownPlacements.map((placement) => placement.placementId)).toEqual([
            "placement-" + "2".repeat(64),
          ]);
          expect(observed.otherPlacements.map((placement) => placement.placementId)).toEqual([
            "placement-" + "a1".repeat(32),
          ]);
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
        }),
      15000,
    );
    it.effect(
      "freezes reviewed demand into a confirmed roster and exact teaching occurrence",
      () =>
        Effect.gen(function* () {
          const serviceScope = {
            departmentId: DepartmentId.make("service-department"),
            semesterId: SemesterId.make("service-semester"),
          };

          const serviceVolunteer = PersonId.make("service-volunteer");
          const serviceCoordinator = PersonId.make("service-coordinator");

          const proposalId = SchoolServiceProposalId.make(
            `school-service-proposal-${"a".repeat(64)}`,
          );

          const newerProposalId = SchoolServiceProposalId.make(
            `school-service-proposal-${"c".repeat(64)}`,
          );

          const commitmentId = SchoolServiceCommitmentId.make(
            `school-service-commitment-${"b".repeat(64)}`,
          );

          const observed = yield* Database.use((sql) =>
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

                const scheduled = yield* mutatePlacementBoard(
                  serviceScope,
                  {
                    action: "ScheduleService",
                    proposalId,
                    schoolId,
                    day: "Monday",
                    block: "1",
                    serviceDate: "2026-09-07",
                    startTime: "09:00",
                    endTime: "11:00",
                  },
                  serviceCoordinator,
                  now,
                  commitmentId,
                );

                const serviceIds = {
                  absenceId: "unused",
                  coverageId: "unused",
                  occurrenceId: SchoolServiceOccurrenceId.make(
                    "school-service-occurrence-" + "b".repeat(64),
                  ),
                };

                // The derived attendance is the one scheduled volunteer, below the demand of two.
                const unmetDemand = yield* Effect.flip(
                  mutateCoverageBoard(
                    serviceScope,
                    {
                      action: "CompleteService",
                      commitmentId,
                      evidenceSource: "School contact attendance register",
                    },
                    serviceCoordinator,
                    "2026-09-07T12:00:00.000Z",
                    serviceIds,
                  ),
                );

                const recorded = yield* mutateCoverageBoard(
                  serviceScope,
                  {
                    action: "MarkUnfulfilledService",
                    commitmentId,
                    reason: "One assistant short",
                    evidenceSource: "School contact attendance register",
                  },
                  serviceCoordinator,
                  "2026-09-07T12:00:00.000Z",
                  serviceIds,
                );

                const outbox =
                  yield* sql`SELECT status,attempts,payload_json->>'personId' AS "personId" FROM school_service_notification_outbox WHERE proposal_id=${proposalId}`;

                const audit =
                  yield* sql`SELECT action FROM school_service_audit WHERE department_id=${serviceScope.departmentId} ORDER BY audit_id`;

                return {
                  draft,
                  incompleteReview,
                  confirmedStatus,
                  unmetDemand,
                  scheduled,
                  recorded,
                  outbox,
                  audit,
                };
              }),
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
          expect(observed.unmetDemand).toMatchObject({ code: "commitment.outcome-invalid" });
          expect(observed.scheduled.commitments[0]).toMatchObject({
            commitmentId,
            requiredVolunteers: 2,
            decision: null,
          });
          expect(observed.recorded.commitments[0]).toMatchObject({
            commitmentId,
            decision: { outcome: "Unfulfilled", attendedPersonIds: [serviceVolunteer] },
          });
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
        }),
      15000,
    );
    it.effect(
      "rejects a terminal decision that borrows an unrelated occurrence and leaves commitment open",
      () =>
        Effect.gen(function* () {
          const serviceScope = {
            departmentId: DepartmentId.make("service-department"),
            semesterId: SemesterId.make("service-semester"),
          };

          const proposalId = SchoolServiceProposalId.make(
            "school-service-proposal-" + "a".repeat(64),
          );

          const commitmentId = SchoolServiceCommitmentId.make(
            "school-service-commitment-" + "d".repeat(64),
          );

          const school = yield* Database.use(
            (sql) =>
              sql<{
                schoolId: number;
              }>`SELECT school_id::double precision AS "schoolId" FROM public.schools_directory_schools WHERE name='Service school'`,
          );

          yield* mutatePlacementBoard(
            serviceScope,
            {
              action: "ScheduleService",
              proposalId,
              schoolId: SchoolId.make(school[0]!.schoolId),
              day: "Monday",
              block: "1",
              serviceDate: "2026-09-21",
              startTime: "09:00",
              endTime: "11:00",
            },
            PersonId.make("service-coordinator"),
            now,
            commitmentId,
          );

          const borrowedOccurrence = yield* Effect.exit(
            Database.use((sql) =>
              sql.withTransaction(sql`
    INSERT INTO public.school_service_decisions(commitment_id,outcome,decided_at,decided_by_person_id,
      evidence_source,reason,attended_person_ids,occurrence_id)
    VALUES(${commitmentId},'Completed','2026-09-21T12:00:00.000Z',${PersonId.make("service-coordinator")},
      'School contact attendance register',NULL,${sql.json([PersonId.make("service-volunteer")])},
      ${SchoolServiceOccurrenceId.make("school-service-occurrence-" + "b".repeat(64))})
  `),
            ),
          );

          expect(Exit.isFailure(borrowedOccurrence)).toBe(true);

          const decisions = yield* Database.use(
            (sql) =>
              sql`SELECT commitment_id FROM public.school_service_decisions WHERE commitment_id=${commitmentId}`,
          );

          expect(decisions).toEqual([]);
        }),
      15000,
    );
    it.effect(
      "delivers a canonical roster envelope once and quarantines a forged envelope",
      () =>
        Effect.gen(function* () {
          let deliveredEffectId = "";

          const delivered = yield* deliverNextSchoolServiceNotification(
            "service-worker:1",
            "2026-09-06T01:01:00.000Z",
            (request) =>
              Effect.sync(() => {
                deliveredEffectId = request.effectId;
              }),
          );

          const forgedEffectId = `school-service-notification:school-service-proposal-${"a".repeat(64)}:${coordinator}`;
          yield* Database.use(
            (sql) =>
              sql`INSERT INTO school_service_notification_outbox(effect_id,proposal_id,person_id,payload_json) SELECT ${forgedEffectId},proposal_id,${coordinator},jsonb_set(jsonb_set(jsonb_set(payload_json,'{effectId}',to_jsonb(${forgedEffectId}::text)),'{personId}',to_jsonb(${coordinator}::text)),'{assignments}','[]'::jsonb) FROM school_service_notification_outbox WHERE effect_id=${deliveredEffectId}`,
          );

          const quarantined = yield* deliverNextSchoolServiceNotification(
            "service-worker:2",
            "2026-09-06T01:02:00.000Z",
            () => Effect.die("forged envelope must not reach transport"),
          );

          const rows = yield* Database.use(
            (sql) =>
              sql`SELECT effect_id AS "effectId",status,attempts,last_failure_tag AS "lastFailureTag" FROM school_service_notification_outbox ORDER BY status`,
          );

          expect(delivered).toHaveProperty("_tag", "Delivered");
          expect(deliveredEffectId).toContain("school-service-notification:");
          expect(quarantined).toEqual(
            SchoolServiceNotificationDeliveryResult.Quarantined({
              effectId: forgedEffectId,
              failureTag: "AuthorityEnvelopeMismatch",
            }),
          );
          expect(rows).toMatchObject([
            { status: "Delivered", attempts: 1, lastFailureTag: null },
            { status: "Quarantined", attempts: 1, lastFailureTag: "AuthorityEnvelopeMismatch" },
          ]);
        }),
      15000,
    );
    it.effect(
      "records absences and who covered them, derives attendance, and closes each absence",
      () =>
        Effect.gen(function* () {
          const coverageScope = {
            departmentId: DepartmentId.make("coverage-department"),
            semesterId: SemesterId.make("coverage-semester"),
          };

          const rosterPerson = PersonId.make("coverage-roster-person");
          const secondRosterPerson = PersonId.make("coverage-second-roster-person");
          const substitutePerson = PersonId.make("coverage-substitute-person");
          const placedAssistant = PersonId.make("coverage-placed-assistant");
          const outsider = PersonId.make("coverage-outsider");
          const coverageCoordinator = PersonId.make("coverage-coordinator");

          const proposalId = SchoolServiceProposalId.make(
            `school-service-proposal-${"f".repeat(64)}`,
          );

          const newerProposalId = SchoolServiceProposalId.make(
            `school-service-proposal-${"e".repeat(64)}`,
          );

          const commitment = (digit: string) =>
            SchoolServiceCommitmentId.make(`school-service-commitment-${digit.repeat(64)}`);

          const ids = (digit: string) => ({
            absenceId: SchoolServiceAbsenceId.make(`school-service-absence-${digit.repeat(64)}`),
            coverageId: SchoolServiceCoverageId.make(`school-service-coverage-${digit.repeat(64)}`),
            occurrenceId: SchoolServiceOccurrenceId.make(
              `school-service-occurrence-${digit.repeat(64)}`,
            ),
          });

          // Completed with coverage, unfulfilled with attendance, unfulfilled without, and cancelled.
          const covered = commitment("1");
          const short = commitment("2");
          const empty = commitment("3");
          const cancelled = commitment("4");
          const absence = ids("1").absenceId;
          const evidenceSource = "School contact attendance register";

          const coordinate = (command: CoverageCommand, digit: string, at = now) =>
            mutateCoverageBoard(coverageScope, command, coverageCoordinator, at, ids(digit));

          const own = (person: PersonId, command: OwnCoverageCommand, digit: string) =>
            mutateOwnCoverage(coverageScope, command, person, now, ids(digit));

          const observed = yield* Database.use((sql) =>
            sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`INSERT INTO organization_departments(department_id,name,short_name,email,city) VALUES(${coverageScope.departmentId},'Coverage department','CD','coverage@example.invalid','Trondheim')`;
                yield* sql`INSERT INTO admission_period_departments(department_id,name) VALUES(${coverageScope.departmentId},'Coverage department')`;
                yield* sql`INSERT INTO admission_period_semesters VALUES(${coverageScope.semesterId},'2026-08-01T00:00:00Z','2026-12-31T00:00:00Z')`;
                yield* sql`INSERT INTO admission_periods VALUES('coverage-period',${coverageScope.departmentId},${coverageScope.semesterId},'2026-08-01T00:00:00Z','2026-12-31T00:00:00Z',0,'coverage-seed')`;
                yield* sql`INSERT INTO admission_period_fields_of_study VALUES('coverage-field',${coverageScope.departmentId},'Math',true)`;
                yield* sql`INSERT INTO person_profiles(person_id,first_name,last_name) VALUES(${rosterPerson},'Rosa','Roster'),(${secondRosterPerson},'Sam','Scheduled'),(${substitutePerson},'Cato','Candidate'),(${placedAssistant},'Pia','Placed'),(${outsider},'Otto','Outsider'),(${coverageCoordinator},'Cora','Coordinator')`;

                const schools = yield* sql<{
                  schoolId: number;
                }>`INSERT INTO schools_directory_schools(name,contact_person,email,phone,language,active) VALUES('Coverage school','Contact','coverage-school@example.invalid','12345678','Norwegian',true) RETURNING school_id::double precision AS "schoolId"`;

                const schoolId = SchoolId.make(schools[0]!.schoolId);
                yield* sql`INSERT INTO schools_directory_departments(school_id,department_id) VALUES(${schoolId},${coverageScope.departmentId})`;
                // The substitute is an admitted applicant whose recorded outcome is Substitute.
                yield* sql`INSERT INTO admission_applicants(applicant_id,normalized_email,email,first_name,last_name,phone,gender,field_of_study_id,year_of_study) VALUES('coverage-applicant','coverage@applicant.invalid','coverage@applicant.invalid','Cato','Candidate','12345678',0,'coverage-field',2)`;
                yield* sql`INSERT INTO admission_applications(application_id,applicant_id,admission_period_id,department_id,field_of_study_id,year_of_study,submitted_at) VALUES('coverage-application','coverage-applicant','coverage-period',${coverageScope.departmentId},'coverage-field',2,${now})`;
                yield* sql`INSERT INTO applicant_account_invitations(invitation_id,application_id,applicant_id,token_digest,expires_at,state,issued_by,issued_at) VALUES('coverage-invitation','coverage-application','coverage-applicant',${"a".repeat(64)},'2027-01-01T00:00:00Z','Claimed',${coverageCoordinator},${now})`;
                yield* sql`INSERT INTO applicant_account_links(applicant_id,person_id,linked_at,invitation_id) VALUES('coverage-applicant',${substitutePerson},${now},'coverage-invitation')`;
                yield* sql`INSERT INTO admission_application_outcomes(application_id,revision,outcome,decided_by_person_id,decided_at) VALUES('coverage-application',1,'Substitute',${coverageCoordinator},${now})`;
                yield* lockPlacementDepartment(coverageScope.departmentId);

                // Roster members and one more assistant hold placements in the semester.
                for (const [personId, day, placementDigit] of [
                  [rosterPerson, "Monday", "5"],
                  [secondRosterPerson, "Monday", "6"],
                  [placedAssistant, "Tuesday", "7"],
                ] as const) {
                  const pending = yield* mutateAffiliation(
                    yield* readOwnAffiliation(personId, coverageScope.departmentId),
                    "Request",
                    personId,
                    now,
                  );

                  yield* mutateAffiliation(pending, "Establish", coverageCoordinator, now);
                  yield* mutatePlacementBoard(
                    coverageScope,
                    { action: "Create", personId, schoolId, day, workdays: 4, block: "1" },
                    coverageCoordinator,
                    now,
                    `placement-${placementDigit.repeat(64)}`,
                  );
                }

                yield* sql`INSERT INTO school_service_proposals(proposal_id,department_id,semester_id,status,revision,created_at,created_by_person_id,confirmed_at,confirmed_by_person_id,demand_snapshot,assignment_snapshot,exception_snapshot,reviewed_exception_ids) VALUES(${proposalId},${coverageScope.departmentId},${coverageScope.semesterId},'Confirmed',2,${now},${coverageCoordinator},${now},${coverageCoordinator},${sql.json([{ schoolId, day: "Monday", block: "1", requiredVolunteers: 2, revision: 1 }])},${sql.json(
                  [
                    {
                      placementId: `placement-${"5".repeat(64)}`,
                      personId: rosterPerson,
                      firstName: "Rosa",
                      lastName: "Roster",
                      schoolId,
                      schoolName: "Coverage school",
                      day: "Monday",
                      block: "1",
                    },
                    {
                      placementId: `placement-${"6".repeat(64)}`,
                      personId: secondRosterPerson,
                      firstName: "Sam",
                      lastName: "Scheduled",
                      schoolId,
                      schoolName: "Coverage school",
                      day: "Monday",
                      block: "1",
                    },
                  ],
                )},${sql.json([])},${sql.json([])})`;

                for (const [commitmentId, serviceDate] of [
                  [covered, "2026-09-14"],
                  [short, "2026-09-21"],
                  [empty, "2026-09-28"],
                  [cancelled, "2026-10-05"],
                ] as const) {
                  yield* mutatePlacementBoard(
                    coverageScope,
                    {
                      action: "ScheduleService",
                      proposalId,
                      schoolId,
                      day: "Monday",
                      block: "1",
                      serviceDate,
                      startTime: "09:00",
                      endTime: "11:00",
                    },
                    coverageCoordinator,
                    now,
                    commitmentId,
                  );
                }

                yield* coordinate(
                  {
                    action: "ReportAbsenceForVolunteer",
                    personId: rosterPerson,
                    commitmentId: covered,
                  },
                  "1",
                );

                const absentView = yield* readOwnCoverage(coverageScope, rosterPerson);

                const record = (coveringPersonId: PersonId) =>
                  ({ action: "RecordCoverage", absenceId: absence, coveringPersonId }) as const;

                const ineligible = yield* Effect.flip(coordinate(record(outsider), "a"));
                const selfCover = yield* Effect.flip(coordinate(record(rosterPerson), "a"));

                const scheduledCover = yield* Effect.flip(
                  coordinate(record(secondRosterPerson), "a"),
                );

                const foreignAbsence = yield* Effect.flip(
                  own(secondRosterPerson, record(substitutePerson), "a"),
                );

                const bySubstitute = yield* own(rosterPerson, record(substitutePerson), "a");
                const substituteView = yield* readOwnCoverage(coverageScope, substitutePerson);
                const replaced = yield* coordinate(record(placedAssistant), "b");

                const withdrawn = yield* own(
                  rosterPerson,
                  { action: "WithdrawCoverage", absenceId: absence },
                  "c",
                );

                const nothingToWithdraw = yield* Effect.flip(
                  own(rosterPerson, { action: "WithdrawCoverage", absenceId: absence }, "c"),
                );

                const recoveredBoard = yield* coordinate(record(substitutePerson), "d");

                const reservations = yield* sql<{ sourceKind: string; personId: string }>`
          SELECT source_kind AS "sourceKind", person_id AS "personId"
          FROM school_service_person_reservations WHERE commitment_id=${covered} ORDER BY person_id`;

                const completed = yield* coordinate(
                  { action: "CompleteService", commitmentId: covered, evidenceSource },
                  "1",
                  "2026-09-14T12:00:00.000Z",
                );

                const closedCoverage = yield* Effect.flip(
                  coordinate({ action: "WithdrawCoverage", absenceId: absence }, "e"),
                );

                yield* coordinate(
                  {
                    action: "ReportAbsenceForVolunteer",
                    personId: rosterPerson,
                    commitmentId: short,
                  },
                  "2",
                );

                const shortCompletion = yield* Effect.flip(
                  coordinate(
                    { action: "CompleteService", commitmentId: short, evidenceSource },
                    "2",
                    "2026-09-21T12:00:00.000Z",
                  ),
                );

                const unfulfilled = yield* coordinate(
                  {
                    action: "MarkUnfulfilledService",
                    commitmentId: short,
                    reason: "One assistant short",
                    evidenceSource,
                  },
                  "2",
                  "2026-09-21T12:00:00.000Z",
                );

                yield* coordinate(
                  {
                    action: "ReportAbsenceForVolunteer",
                    personId: rosterPerson,
                    commitmentId: empty,
                  },
                  "3",
                );
                yield* coordinate(
                  {
                    action: "ReportAbsenceForVolunteer",
                    personId: secondRosterPerson,
                    commitmentId: empty,
                  },
                  "5",
                );

                const nobody = yield* coordinate(
                  {
                    action: "MarkUnfulfilledService",
                    commitmentId: empty,
                    reason: "No assistants attended",
                    evidenceSource,
                  },
                  "3",
                  "2026-09-28T12:00:00.000Z",
                );

                const repeated = yield* Effect.flip(
                  coordinate(
                    {
                      action: "CancelService",
                      commitmentId: empty,
                      reason: "Changed mind",
                      evidenceSource: "Coordinator note",
                    },
                    "3",
                    "2026-09-29T12:00:00.000Z",
                  ),
                );

                yield* coordinate(
                  {
                    action: "ReportAbsenceForVolunteer",
                    personId: rosterPerson,
                    commitmentId: cancelled,
                  },
                  "4",
                );
                yield* coordinate(
                  {
                    action: "RecordCoverage",
                    absenceId: ids("4").absenceId,
                    coveringPersonId: substitutePerson,
                  },
                  "4",
                );

                const coveringBeforeCancel = yield* readOwnCoverage(
                  coverageScope,
                  substitutePerson,
                );

                const cancelledBoard = yield* coordinate(
                  {
                    action: "CancelService",
                    commitmentId: cancelled,
                    reason: "School closed that day",
                    evidenceSource: "School contact cancellation message",
                  },
                  "4",
                );

                const coveringAfterCancel = yield* readOwnCoverage(coverageScope, substitutePerson);
                const absentAfterCancel = yield* readOwnCoverage(coverageScope, rosterPerson);

                const lateAbsence = yield* Effect.flip(
                  coordinate(
                    {
                      action: "ReportAbsenceForVolunteer",
                      personId: secondRosterPerson,
                      commitmentId: cancelled,
                    },
                    "6",
                  ),
                );

                const cancelledReservations = yield* sql<{ count: number }>`
          SELECT count(*)::integer AS count FROM school_service_person_reservations
          WHERE commitment_id=${cancelled}`;

                yield* sql`INSERT INTO school_service_proposals(proposal_id,department_id,semester_id,status,revision,created_at,created_by_person_id,confirmed_at,confirmed_by_person_id,demand_snapshot,assignment_snapshot,exception_snapshot,reviewed_exception_ids) VALUES(${newerProposalId},${coverageScope.departmentId},${coverageScope.semesterId},'Confirmed',2,'2026-09-06T01:00:00.000Z',${coverageCoordinator},'2026-09-06T01:00:00.000Z',${coverageCoordinator},${sql.json([{ schoolId, day: "Monday", block: "2", requiredVolunteers: 1, revision: 1 }])},${sql.json([{ placementId: `placement-${"8".repeat(64)}`, personId: rosterPerson, firstName: "Rosa", lastName: "Roster", schoolId, schoolName: "Coverage school", day: "Monday", block: "2" }])},${sql.json([])},${sql.json([])})`;

                const afterNewerProposal = yield* readCoverageBoard(coverageScope);

                const scheduleNewer = (serviceDate: string, startTime: string, digit: string) =>
                  mutatePlacementBoard(
                    coverageScope,
                    {
                      action: "ScheduleService",
                      proposalId: newerProposalId,
                      schoolId,
                      day: "Monday",
                      block: "2",
                      serviceDate,
                      startTime,
                      endTime: "12:00",
                    },
                    coverageCoordinator,
                    now,
                    commitment(digit),
                  );

                // Rosa still holds the covered commitment's interval, although she was absent from it.
                const overlappingSchedule = yield* Effect.flip(
                  scheduleNewer("2026-09-14", "10:00", "a"),
                );

                const adjacentSchedule = yield* scheduleNewer("2026-09-14", "11:00", "a");
                // Cancellation released every person reserved for the cancelled commitment.
                const releasedBoard = yield* scheduleNewer("2026-10-05", "09:00", "c");

                const audit = yield* sql<{ action: string; actor: string }>`
          SELECT action, actor_person_id AS actor FROM school_service_coverage_audit
          WHERE department_id=${coverageScope.departmentId} ORDER BY audit_id`;

                return {
                  absentView,
                  ineligible,
                  selfCover,
                  scheduledCover,
                  foreignAbsence,
                  bySubstitute,
                  substituteView,
                  replaced,
                  withdrawn,
                  nothingToWithdraw,
                  recoveredBoard,
                  reservations,
                  completed,
                  closedCoverage,
                  shortCompletion,
                  unfulfilled,
                  nobody,
                  repeated,
                  cancelledBoard,
                  coveringBeforeCancel,
                  coveringAfterCancel,
                  absentAfterCancel,
                  lateAbsence,
                  cancelledReservations,
                  afterNewerProposal,
                  overlappingSchedule,
                  adjacentSchedule,
                  releasedBoard,
                  audit,
                };
              }),
            ),
          );

          const invalidScope = yield* Effect.flip(
            readCoverageBoard({
              ...coverageScope,
              semesterId: SemesterId.make("coverage-missing-semester"),
            }),
          );

          // A decided commitment accepts no further coverage, even from SQL outside the service.
          const lateCoverage = yield* Effect.exit(
            Database.use((sql) =>
              sql.withTransaction(
                sql`INSERT INTO school_service_coverage_records(coverage_id,absence_id,covering_person_id,coverer_kind,recorded_by_person_id,recorded_at)
        VALUES(${ids("f").coverageId},${ids("2").absenceId},${placedAssistant},'Assistant',${coverageCoordinator},${now})`,
              ),
            ),
          );

          const coverer = (
            personId: PersonId,
            firstName: string,
            lastName: string,
            kind: string,
          ) => ({
            personId,
            firstName,
            lastName,
            kind,
          });

          expect(observed.absentView.coverers).toEqual([
            coverer(substitutePerson, "Cato", "Candidate", "Substitute"),
            coverer(placedAssistant, "Pia", "Placed", "Assistant"),
            coverer(secondRosterPerson, "Sam", "Scheduled", "Assistant"),
          ]);
          expect(observed.ineligible).toMatchObject({ code: "coverage.coverer-ineligible" });
          expect(observed.selfCover).toMatchObject({ code: "coverage.coverer-ineligible" });
          expect(observed.scheduledCover).toMatchObject({ code: "coverage.coverer-unavailable" });
          expect(observed.foreignAbsence).toMatchObject({
            code: "coverage.owner-invalid",
            status: 403,
          });
          expect(observed.bySubstitute.coverage).toMatchObject([
            {
              coverageId: ids("a").coverageId,
              absenceId: absence,
              coveringPersonId: substitutePerson,
              coveringFirstName: "Cato",
              covererKind: "Substitute",
              recordedByPersonId: rosterPerson,
            },
          ]);
          expect(observed.substituteView.commitments.map((entry) => entry.commitmentId)).toEqual([
            covered,
          ]);
          expect(observed.substituteView.coverers).toEqual([]);
          expect(observed.replaced.coverage).toMatchObject([
            {
              coverageId: ids("b").coverageId,
              coveringPersonId: placedAssistant,
              covererKind: "Assistant",
            },
          ]);
          expect(observed.withdrawn.coverage).toEqual([]);
          expect(observed.nothingToWithdraw).toMatchObject({ code: "coverage.not-recorded" });
          expect(observed.recoveredBoard.coverage).toMatchObject([
            { coverageId: ids("d").coverageId, coveringPersonId: substitutePerson },
          ]);
          expect(observed.reservations).toEqual([
            { sourceKind: "Scheduled", personId: rosterPerson },
            { sourceKind: "Scheduled", personId: secondRosterPerson },
            { sourceKind: "Coverage", personId: substitutePerson },
          ]);

          const decisionOf = (
            board: { commitments: ReadonlyArray<{ commitmentId: string; decision: unknown }> },
            commitmentId: string,
          ) => board.commitments.find((entry) => entry.commitmentId === commitmentId)?.decision;

          expect(decisionOf(observed.completed, covered)).toMatchObject({
            outcome: "Completed",
            attendedPersonIds: [secondRosterPerson, substitutePerson],
            occurrenceId: ids("1").occurrenceId,
          });
          expect(observed.completed.occurrences).toMatchObject([
            {
              occurrenceId: ids("1").occurrenceId,
              attendedPersonIds: [secondRosterPerson, substitutePerson],
            },
          ]);
          expect(observed.completed.closures).toMatchObject([
            {
              absenceId: absence,
              occurrenceId: ids("1").occurrenceId,
              scheduledPersonId: rosterPerson,
              outcome: "Covered",
              coverageId: ids("d").coverageId,
              coveringPersonId: substitutePerson,
            },
          ]);
          expect(observed.closedCoverage).toMatchObject({ code: "commitment.closed" });
          expect(observed.shortCompletion).toMatchObject({ code: "commitment.outcome-invalid" });
          expect(decisionOf(observed.unfulfilled, short)).toMatchObject({
            outcome: "Unfulfilled",
            attendedPersonIds: [secondRosterPerson],
            occurrenceId: ids("2").occurrenceId,
          });
          expect(observed.unfulfilled.closures).toContainEqual(
            expect.objectContaining({
              absenceId: ids("2").absenceId,
              outcome: "Uncovered",
              coverageId: null,
              coveringPersonId: null,
            }),
          );
          expect(decisionOf(observed.nobody, empty)).toMatchObject({
            outcome: "Unfulfilled",
            attendedPersonIds: [],
            occurrenceId: null,
          });
          expect(
            observed.nobody.closures.filter(
              (closure) =>
                closure.absenceId === ids("3").absenceId ||
                closure.absenceId === ids("5").absenceId,
            ),
          ).toMatchObject([
            { outcome: "Uncovered", occurrenceId: null },
            { outcome: "Uncovered", occurrenceId: null },
          ]);
          expect(observed.repeated).toMatchObject({ code: "commitment.closed" });
          expect(decisionOf(observed.cancelledBoard, cancelled)).toMatchObject({
            outcome: "Cancelled",
            attendedPersonIds: [],
            occurrenceId: null,
          });
          expect(
            observed.cancelledBoard.closures.some(
              (closure) => closure.absenceId === ids("4").absenceId,
            ),
          ).toBe(false);
          // A cancelled service ends the coverer's duty; the absent person keeps the record with the absence.
          expect(
            observed.coveringBeforeCancel.commitments.map((entry) => entry.commitmentId),
          ).toEqual([covered, cancelled]);
          expect(
            observed.coveringAfterCancel.commitments.map((entry) => entry.commitmentId),
          ).toEqual([covered]);
          expect(observed.coveringAfterCancel.coverage.map((record) => record.coverageId)).toEqual([
            ids("d").coverageId,
          ]);
          expect(observed.absentAfterCancel.coverage.map((record) => record.coverageId)).toEqual([
            ids("d").coverageId,
            ids("4").coverageId,
          ]);
          expect(observed.lateAbsence).toMatchObject({ code: "commitment.closed" });
          expect(observed.cancelledReservations).toEqual([{ count: 0 }]);
          expect(
            observed.afterNewerProposal.rosterAssignments.map(
              (assignment) => assignment.proposalId,
            ),
          ).toEqual([newerProposalId, proposalId, proposalId]);
          expect(observed.overlappingSchedule).toMatchObject({ code: "commitment.duplicate" });
          expect(observed.adjacentSchedule.commitments).toContainEqual(
            expect.objectContaining({ startTime: "11:00", endTime: "12:00", block: "2" }),
          );
          expect(observed.releasedBoard.commitments).toContainEqual(
            expect.objectContaining({ serviceDate: "2026-10-05", startTime: "09:00", block: "2" }),
          );
          expect(observed.audit).toEqual([
            { action: "ReportAbsence", actor: coverageCoordinator },
            { action: "RecordCoverage", actor: rosterPerson },
            { action: "RecordCoverage", actor: coverageCoordinator },
            { action: "WithdrawCoverage", actor: rosterPerson },
            { action: "RecordCoverage", actor: coverageCoordinator },
            { action: "CompleteService", actor: coverageCoordinator },
            { action: "ReportAbsence", actor: coverageCoordinator },
            { action: "MarkUnfulfilledService", actor: coverageCoordinator },
            { action: "ReportAbsence", actor: coverageCoordinator },
            { action: "ReportAbsence", actor: coverageCoordinator },
            { action: "MarkUnfulfilledService", actor: coverageCoordinator },
            { action: "ReportAbsence", actor: coverageCoordinator },
            { action: "RecordCoverage", actor: coverageCoordinator },
            { action: "CancelService", actor: coverageCoordinator },
          ]);
          expect(invalidScope).toMatchObject({ code: "scope.invalid" });
          expect(Exit.isFailure(lateCoverage)).toBe(true);
        }),
      15000,
    );
  },
);

describe("placement schema ownership", () => {
  it.live(
    "creates canonical placement and coverage tables in public even when auth is first in search_path",
    () =>
      Effect.gen(function* () {
        const pglite = yield* Effect.acquireRelease(
          Effect.promise(() => PGlite.create({ extensions: { btree_gist } })),
          (pglite) => Effect.promise(() => pglite.close()),
        );

        yield* Effect.promise(() => pglite.exec("SET search_path TO auth,public"));

        // The isolated database capability is released before its PGlite closes.
        const rows = yield* Effect.provide(
          Database.use(
            (sql) => sql<{ name: string; publicExists: boolean; authExists: boolean }>`
      SELECT name, to_regclass('public.' || name) IS NOT NULL AS "publicExists",
        to_regclass('auth.' || name) IS NOT NULL AS "authExists"
      FROM (VALUES ('organization_volunteer_affiliations'), ('organization_volunteer_affiliation_audit'),
        ('assistant_placements'), ('assistant_placement_audit'), ('school_service_commitments'),
        ('school_service_decisions'), ('school_service_absences'),
        ('school_service_coverage_records'), ('school_service_person_reservations'),
        ('school_service_closures'), ('school_service_coverage_audit')) AS expected(name) ORDER BY name
    `,
          ),
          DatabaseTestLive({ liveClient: pglite }),
        );

        expect(rows).toHaveLength(11);

        for (const row of rows)
          expect(row).toMatchObject({ publicExists: true, authExists: false });
      }),
    15000,
  );
});

describe("claim-fenced school service delivery", () => {
  // Later than every claim below: stale recovery by another worker takes the active claim.
  const staleCutoff = "2026-09-06T02:00:00.000Z";

  const outboxRow = (sql: DatabaseOperations, effectId: string) =>
    sql<{
      status: string;
      attempts: number;
      claimId: string | null;
      lastFailureTag: string | null;
      deliveredAt: string | null;
    }>`SELECT status,attempts,claim_id AS "claimId",last_failure_tag AS "lastFailureTag",CASE WHEN delivered_at IS NULL THEN NULL ELSE to_char(delivered_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS "deliveredAt" FROM public.school_service_notification_outbox WHERE effect_id=${effectId}`;

  const seedRosterNotification = Effect.gen(function* () {
    const sql = yield* Database;
    const departmentId = DepartmentId.make("claim-department");
    const semesterId = SemesterId.make("claim-semester");
    const volunteerId = PersonId.make("claim-volunteer");
    const coordinatorId = PersonId.make("claim-coordinator");
    const proposalId = SchoolServiceProposalId.make(`school-service-proposal-${"c".repeat(64)}`);
    const confirmedAt = "2026-09-06T01:00:00.000Z";
    const effectId = `school-service-notification:${proposalId}:${volunteerId}`;

    const assignments = [
      {
        placementId: `placement-${"c".repeat(64)}`,
        personId: volunteerId,
        firstName: "Vera",
        lastName: "Volunteer",
        schoolId: SchoolId.make(1),
        schoolName: "Claim school",
        day: "Monday" as const,
        block: "1" as const,
      },
    ];

    yield* sql`INSERT INTO organization_departments(department_id,name,short_name,email,city) VALUES(${departmentId},'Claim department','CLD','claim@example.invalid','Oslo')`;
    yield* sql`INSERT INTO admission_period_semesters(semester_id,start_at,end_at) VALUES(${semesterId},'2026-08-01T00:00:00Z','2026-12-31T00:00:00Z')`;
    yield* sql`INSERT INTO person_profiles(person_id,first_name,last_name) VALUES(${volunteerId},'Vera','Volunteer'),(${coordinatorId},'Cora','Coordinator')`;
    yield* sql`INSERT INTO school_service_proposals(proposal_id,department_id,semester_id,status,revision,created_at,created_by_person_id,confirmed_at,confirmed_by_person_id,demand_snapshot,assignment_snapshot,exception_snapshot) VALUES(${proposalId},${departmentId},${semesterId},'Confirmed',2,${confirmedAt},${coordinatorId},${confirmedAt},${coordinatorId},${sql.json([])},${sql.json(assignments)},${sql.json([])})`;
    yield* sql`INSERT INTO school_service_notification_outbox(effect_id,proposal_id,person_id,payload_json) VALUES(${effectId},${proposalId},${volunteerId},${sql.json(
      SchoolServiceNotificationRequest.make({
        effectId,
        proposalId,
        personId: volunteerId,
        departmentId,
        semesterId,
        assignments,
        confirmedAt,
      }),
    )})`;

    return effectId;
  });

  it.live(
    "reports lost roster notification claims as ClaimLost and dates delivery by acknowledgement",
    () =>
      Effect.gen(function* () {
        const evidence = yield* Effect.gen(function* () {
          const sql = yield* Database;
          const effectId = yield* seedRosterNotification;

          const loseClaim = recoverStaleSchoolServiceNotifications(staleCutoff).pipe(
            Effect.provideService(Database, sql),
            Effect.orDie,
          );

          const failedAfterLoss = yield* deliverNextSchoolServiceNotification(
            "claim-worker:1",
            "2026-09-06T01:01:00.000Z",
            (request) =>
              loseClaim.pipe(
                Effect.andThen(
                  Effect.fail(
                    new SchoolServiceNotificationDeliveryError({ effectId: request.effectId }),
                  ),
                ),
              ),
          );

          const afterFailedLoss = yield* outboxRow(sql, effectId);

          const deliveredAfterLoss = yield* deliverNextSchoolServiceNotification(
            "claim-worker:2",
            "2026-09-06T01:02:00.000Z",
            () => loseClaim,
          );

          const afterDeliveredLoss = yield* outboxRow(sql, effectId);

          // The provider acknowledges seven seconds after the claim.
          const delivered = yield* Effect.gen(function* () {
            yield* TestClock.setTime(Date.parse("2026-09-06T01:03:00.000Z"));

            return yield* deliverNextSchoolServiceNotification(
              "claim-worker:3",
              "2026-09-06T01:03:00.000Z",
              () => TestClock.adjust("7 seconds"),
            );
          }).pipe(Effect.provide(TestClock.layer()));

          const afterDelivery = yield* outboxRow(sql, effectId);

          return {
            effectId,
            failedAfterLoss,
            afterFailedLoss,
            deliveredAfterLoss,
            afterDeliveredLoss,
            delivered,
            afterDelivery,
          };
        }).pipe(Effect.provide(DatabaseTestLive()));

        const claimLost = SchoolServiceNotificationDeliveryResult.ClaimLost({
          effectId: evidence.effectId,
        });

        expect(evidence.failedAfterLoss).toEqual(claimLost);
        expect(evidence.afterFailedLoss).toEqual([
          {
            status: "Failed",
            attempts: 1,
            claimId: null,
            lastFailureTag: "StaleClaim",
            deliveredAt: null,
          },
        ]);
        expect(evidence.deliveredAfterLoss).toEqual(claimLost);
        expect(evidence.afterDeliveredLoss).toEqual([
          {
            status: "Failed",
            attempts: 2,
            claimId: null,
            lastFailureTag: "StaleClaim",
            deliveredAt: null,
          },
        ]);
        expect(evidence.delivered._tag).toBe("Delivered");
        expect(evidence.delivered).toMatchObject({
          claim: { effectId: evidence.effectId, attempts: 3 },
        });
        expect(evidence.afterDelivery).toEqual([
          {
            status: "Delivered",
            attempts: 3,
            claimId: null,
            lastFailureTag: null,
            deliveredAt: "2026-09-06T01:03:07.000Z",
          },
        ]);
      }),
    15000,
  );

  it.live(
    "does not report a quarantine after its claim was taken in the claim transaction",
    () =>
      Effect.gen(function* () {
        const evidence = yield* Effect.gen(function* () {
          const sql = yield* Database;
          const effectId = yield* seedRosterNotification;

          // Another claimant overwrites the claim before validation quarantines the row.
          yield* sql.unsafe(`
      CREATE FUNCTION public.claim_fence_take_claim() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.status = 'Processing' THEN NEW.claim_id := NEW.claim_id || ':taken'; END IF;
        RETURN NEW;
      END;
      $$
    `);
          yield* sql.unsafe(`
      CREATE TRIGGER claim_fence_take_claim
        BEFORE UPDATE ON public.school_service_notification_outbox
        FOR EACH ROW EXECUTE FUNCTION public.claim_fence_take_claim()
    `);

          const result = yield* deliverNextSchoolServiceNotification(
            "claim-worker:4",
            "2026-09-06T01:01:00.000Z",
            () => Effect.die("a taken claim must not reach transport"),
          );

          const row = yield* outboxRow(sql, effectId);

          return { effectId, result, row };
        }).pipe(Effect.provide(DatabaseTestLive()));

        expect(evidence.result).toEqual(
          SchoolServiceNotificationDeliveryResult.ClaimLost({ effectId: evidence.effectId }),
        );
        expect(evidence.row).toEqual([
          {
            status: "Pending",
            attempts: 0,
            claimId: null,
            lastFailureTag: null,
            deliveredAt: null,
          },
        ]);
      }),
    15000,
  );
});
