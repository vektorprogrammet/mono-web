import { Admissions } from "../admissions/service.js";
import { type DatabaseShape } from "../database/service.js";
import { Organization } from "../organization/service.js";
import { DepartmentId, PersonId } from "../organization/schema.js";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { readInterviewConductInTransaction } from "./conduct-postgres.js";
import { RecruitmentInterviewId } from "./schema.js";

it.effect("denies an incomplete interview to a co-interviewer before loading detail data", () =>
  Effect.gen(function* () {
    const departmentId = DepartmentId.make("department-1");
    const coInterviewerPersonId = PersonId.make("co-interviewer-1");
    const statements: Array<string> = [];
    const database = ((
      strings: TemplateStringsArray,
      ..._values: ReadonlyArray<unknown>
    ): Effect.Effect<ReadonlyArray<unknown>> => {
      const statement = strings.join("?").replaceAll(/\s+/gu, " ").trim();
      statements.push(statement);
      if (statement === "" || statement === "FOR UPDATE") return Effect.succeed([]);
      if (statement.includes("applicant_account_links")) {
        return Effect.succeed([
          {
            applicantId: "applicant-1",
            departmentId,
            linkedApplicantPersonId: null,
          },
        ]);
      }
      if (statement.includes("FROM public.admission_applicants WHERE")) {
        return Effect.succeed([]);
      }
      if (statement.includes("FROM recruitment_interviews WHERE")) {
        return Effect.succeed([
          {
            interviewId: "interview-1",
            applicationId: "application-1",
            departmentId,
            interviewerPersonId: "primary-interviewer-1",
            coInterviewerPersonId,
            interviewSchemaId: "schema-1",
            assignedByPersonId: "leader-1",
            assignedAt: "2031-09-15T12:00:00.000Z",
            revision: 1,
          },
        ]);
      }
      if (statement.includes("recruitment_interview_conducts")) {
        return Effect.succeed([]);
      }
      throw new Error(`unexpected statement: ${statement}`);
    }) as unknown as DatabaseShape;

    const failure = yield* Effect.flip(
      readInterviewConductInTransaction(
        RecruitmentInterviewId.make("interview-1"),
        {
          actor: {
            _tag: "Member",
            personId: coInterviewerPersonId,
            departmentId,
            active: true,
          },
          now: "2031-09-15T12:00:00.000Z",
        },
        database,
      ).pipe(
        Effect.provideService(Admissions, {} as never),
        Effect.provideService(Organization, {
          resolvePersonAuthority: () =>
            Effect.succeed({
              memberships: [{ departmentId, active: true }],
            }),
        } as never),
      ),
    );

    expect(failure._tag).toBe("RecruitmentScopeDenied");
    expect(
      statements.some((statement) => statement.includes("recruitment_interview_schedules")),
    ).toBe(false);
  }),
);
