import { expect, layer } from "@effect/vitest";
import { Database } from "../service.js";
import { DatabaseTestLive } from "../test-support/platform.js";
import { DepartmentId, PersonId, SemesterId } from "@vektorprogrammet/domain/organization";
import { SchoolId } from "@vektorprogrammet/domain/schools";
import { DateTime, Effect, Layer } from "effect";
import { Placements, type PlacementMutation } from "@vektorprogrammet/domain/placements";
import { PlacementsLive } from "./service.js";

const databaseLayer = DatabaseTestLive();

const suiteLayer = Layer.merge(databaseLayer, PlacementsLive.pipe(Layer.provide(databaseLayer)));

const now = "2026-09-06T00:00:00.000Z";

const scope = {
  departmentId: DepartmentId.make("command-department"),
  semesterId: SemesterId.make("command-semester"),
};

const personId = PersonId.make("command-volunteer");

const command = (mutation: PlacementMutation, commandId = "a".repeat(64)) =>
  Placements.use((placements) =>
    placements.execute({ mutation, actor: personId, now, commandId }, () => Effect.void),
  );

const seedAdmission = Effect.fnUntraced(function* (departmentId: DepartmentId) {
  const sql = yield* Database;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const at = DateTime.makeUnsafe(now);
      const opensAt = DateTime.formatIso(DateTime.add(at, { days: -30 }));
      const closesAt = DateTime.formatIso(DateTime.add(at, { days: 30 }));
      const applicationId = departmentId + "-application";
      const applicantId = departmentId + "-applicant";
      const periodId = departmentId + "-period";
      const fieldId = departmentId + "-field";
      yield* sql`INSERT INTO admission_period_departments(department_id,name) VALUES(${departmentId},'Synthetic placement admission')`;
      yield* sql`INSERT INTO admission_periods(admission_period_id,department_id,semester_id,start_at,end_at,last_command_id) VALUES(${periodId},${departmentId},${scope.semesterId},${opensAt},${closesAt},'placement-seed')`;
      yield* sql`INSERT INTO admission_period_fields_of_study(field_of_study_id,department_id,name) VALUES(${fieldId},${departmentId},'Math')`;
      yield* sql`INSERT INTO admission_applicants(applicant_id,normalized_email,email,first_name,last_name,phone,gender,field_of_study_id,year_of_study) VALUES(${applicantId},${departmentId + "@example.invalid"},${departmentId + "@example.invalid"},'Vera','Volunteer','12345678',0,${fieldId},2)`;
      yield* sql`INSERT INTO admission_applications(application_id,applicant_id,admission_period_id,department_id,field_of_study_id,year_of_study,submitted_at) VALUES(${applicationId},${applicantId},${periodId},${departmentId},${fieldId},2,${opensAt})`;
      const interviewId = applicationId + "-interview";
      const schemaId = applicationId + "-schema";
      const assignedAt = DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(now), { hours: -2 }));
      const scheduledAt = DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(now), { hours: -1 }));
      yield* sql`INSERT INTO recruitment_interview_schemas(interview_schema_id,name,question_count) VALUES(${schemaId},'Synthetic onboarding interview',1)`;
      yield* sql`INSERT INTO recruitment_interview_schema_questions(interview_schema_id,question_id,ordinal,prompt,kind,alternatives) VALUES(${schemaId},'explanation',0,'Explain how you would help a pupil.','text','[]'::jsonb)`;
      yield* sql`INSERT INTO recruitment_interviews(interview_id,application_id,department_id,interviewer_person_id,interview_schema_id,assigned_by_person_id,assigned_at,revision) VALUES(${interviewId},${applicationId},${departmentId},${PersonId.make("command-interviewer")},${schemaId},${PersonId.make("command-interviewer")},${assignedAt},2)`;
      yield* sql`INSERT INTO recruitment_interview_question_snapshots(interview_id,question_id,ordinal,prompt,kind,alternatives) SELECT ${interviewId},question_id,ordinal,prompt,kind,alternatives FROM recruitment_interview_schema_questions WHERE interview_schema_id=${schemaId}`;
      yield* sql`INSERT INTO recruitment_interview_schedules(interview_id,scheduled_at,room,campus,message,scheduled_by_person_id,committed_at,schedule_revision) VALUES(${interviewId},${scheduledAt},'A1','Synthetic campus','Welcome',${PersonId.make("command-interviewer")},${assignedAt},1)`;
      yield* sql`INSERT INTO recruitment_invitations(invitation_id,interview_id,schedule_revision,capability_sha256,response_state,response_revision,responded_at,created_at) VALUES(${interviewId + "-invitation"},${interviewId},1,repeat(md5(${interviewId}),2),'Accepted',1,${assignedAt},${assignedAt})`;
      yield* sql`INSERT INTO recruitment_invitation_response_audit(invitation_id,interview_id,schedule_revision,response_revision,response_state,responded_at) VALUES(${interviewId + "-invitation"},${interviewId},1,1,'Accepted',${assignedAt})`;
      yield* sql`INSERT INTO recruitment_interview_conducts(interview_id,answers,explanatory_power,role_model,suitability,finalized_by_person_id,finalized_at,interview_revision,recommendation) VALUES(${interviewId},'[{"questionId":"explanation","answer":"Work through a concrete example with the pupil."}]'::jsonb,7,8,9,${PersonId.make("command-interviewer")},${now},2,'Ja')`;
      yield* sql`INSERT INTO applicant_account_invitations(invitation_id,application_id,applicant_id,token_digest,expires_at,state,issued_by,issued_at) VALUES(${applicationId + "-account-invitation"},${applicationId},${applicantId},repeat(md5(${applicationId}),2),${closesAt},'Claimed',${PersonId.make("command-interviewer")},${now})`;
      yield* sql`INSERT INTO applicant_account_links(applicant_id,person_id,linked_at,invitation_id) VALUES(${applicantId},${personId},${now},${applicationId + "-account-invitation"})`;
    }),
  );
});

const seed = Database.use((sql) =>
  Effect.gen(function* () {
    yield* sql`INSERT INTO organization_departments(department_id,name,short_name,email,city) VALUES(${scope.departmentId},'Command department','CMD','command@example.invalid','Trondheim')`;
    const at = DateTime.makeUnsafe(now);
    yield* sql`INSERT INTO admission_period_semesters(semester_id,start_at,end_at) VALUES(${scope.semesterId},${DateTime.formatIso(DateTime.add(at, { days: -30 }))},${DateTime.formatIso(DateTime.add(at, { days: 30 }))})`;
    yield* sql`INSERT INTO person_profiles(person_id,first_name,last_name) VALUES(${personId},'Command','Volunteer'),('command-interviewer','Ivar','Interviewer')`;
    yield* seedAdmission(scope.departmentId);
  }),
);

const suiteSeed = Layer.effectDiscard(seed);

layer(suiteSeed.pipe(Layer.provideMerge(suiteLayer)), {
  excludeTestServices: true,
  timeout: "30 seconds",
})("complete placement commands on the caller transaction", (it) => {
  it.effect(
    "checks the current affiliation before writing, and does not audit a rejected precondition",
    () =>
      Effect.gen(function* () {
        const result = yield* Database.use((sql) =>
          sql.withTransaction(
            Effect.gen(function* () {
              const placements = yield* Placements;

              const requested = yield* placements.execute(
                {
                  mutation: { mode: "affiliation", scope, command: { action: "Request" } },
                  actor: personId,
                  now,
                  commandId: "b".repeat(64),
                },
                (current) =>
                  "status" in current && current.status === "Absent" && current.revision === 0
                    ? Effect.void
                    : Effect.fail("wrong-initial-affiliation"),
              );

              const rejected = yield* Effect.flip(
                placements.execute(
                  {
                    mutation: { mode: "affiliation", scope, command: { action: "Withdraw" } },
                    actor: personId,
                    now,
                    commandId: "c".repeat(64),
                  },
                  (current) => Effect.fail({ code: "precondition.failed", current }),
                ),
              );

              const current = yield* placements.readOwnAffiliation(personId, scope.departmentId);

              const audits =
                yield* sql`SELECT revision,action FROM organization_volunteer_affiliation_audit WHERE person_id=${personId} ORDER BY revision`;

              return { requested, rejected, current, audits };
            }),
          ),
        );

        expect(result.requested).toMatchObject({ status: "Pending", revision: 1 });
        expect(result.rejected).toMatchObject({
          code: "precondition.failed",
          current: { status: "Pending", revision: 1 },
        });
        expect(result.current).toMatchObject({ status: "Pending", revision: 1 });
        expect(result.audits).toEqual([{ revision: 1, action: "Request" }]);
      }),
  );

  it.effect(
    "rolls business facts, audit, and notifications back when the caller cannot finish its receipt",
    () =>
      Effect.gen(function* () {
        const scope = {
          departmentId: DepartmentId.make("rollback-department"),
          semesterId: SemesterId.make("command-semester"),
        };

        const schoolId = yield* Database.use((sql) =>
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`INSERT INTO organization_departments(department_id,name,short_name,email,city) VALUES(${scope.departmentId},'Rollback department','RBK','rollback@example.invalid','Trondheim')`;
              yield* seedAdmission(scope.departmentId);
              yield* command({ mode: "affiliation", scope, command: { action: "Request" } });

              const rows = yield* sql<{
                schoolId: number;
              }>`INSERT INTO schools_directory_schools(name,contact_person,email,phone,language,active) VALUES('Command school','Contact','school@example.invalid','12345678','Norwegian',true) RETURNING school_id::double precision AS "schoolId"`;

              const id = SchoolId.make(rows[0]!.schoolId);
              yield* sql`INSERT INTO schools_directory_departments(school_id,department_id) VALUES(${id},${scope.departmentId})`;
              yield* command({
                mode: "board",
                scope,
                command: { action: "Affiliation", personId, transition: "Establish" },
              });
              yield* command({
                mode: "board",
                scope,
                command: {
                  action: "Create",
                  personId,
                  schoolId: id,
                  day: "Monday",
                  block: "1",
                  workdays: 4,
                },
              });
              yield* command({
                mode: "board",
                scope,
                command: {
                  action: "SetDemand",
                  schoolId: id,
                  day: "Monday",
                  block: "1",
                  requiredVolunteers: 1,
                },
              });

              return id;
            }),
          ),
        );

        const failure = yield* Effect.flip(
          Database.use((sql) =>
            sql.withTransaction(
              Effect.gen(function* () {
                const proposal = yield* command(
                  { mode: "board", scope, command: { action: "GenerateProposal" } },
                  "d".repeat(64),
                );

                if (!("proposal" in proposal) || proposal.proposal === null)
                  return yield* Effect.fail("proposal-missing");
                yield* command({
                  mode: "board",
                  scope,
                  command: {
                    action: "ConfirmProposal",
                    proposalId: proposal.proposal.proposalId,
                    reviewedExceptionIds: [],
                  },
                });

                return yield* Effect.fail("receipt-write-failed");
              }),
            ),
          ),
        );

        expect(failure).toBe("receipt-write-failed");

        const observed = yield* Database.use((sql) =>
          Effect.gen(function* () {
            const board = yield* Placements.use((placements) => placements.readBoard(scope));

            const audits =
              yield* sql`SELECT action FROM school_service_audit WHERE department_id=${scope.departmentId} ORDER BY action`;

            const notifications =
              yield* sql`SELECT effect_id FROM school_service_notification_outbox WHERE proposal_id=${`school-service-proposal-${"d".repeat(64)}`}`;

            return { board, audits, notifications };
          }),
        );

        expect(observed.board.placements).toMatchObject([
          { placementId: `placement-${"a".repeat(64)}`, schoolId, active: true },
        ]);
        expect(observed.board.proposal).toBeNull();
        expect(observed.audits).toEqual([{ action: "SetDemand" }]);
        expect(observed.notifications).toEqual([]);
      }),
  );
});
