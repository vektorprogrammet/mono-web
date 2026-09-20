import { Database, type DatabaseShape } from "../database/service.js";
import { PersonId } from "../organization/schema.js";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { RecruitmentInterviewId } from "./schema.js";
import {
  readRecruitmentInterviewHttpSourcePostgres,
  readRecruitmentPersonAuthorityHttpSourcesPostgres,
} from "./http-postgres.js";

describe("recruitment HTTP persistence", () => {
  it.effect("reads ordered person authority sources in one PostgreSQL statement", () =>
    Effect.gen(function* () {
      const statements: Array<string> = [];
      const parameters: Array<ReadonlyArray<unknown>> = [];
      const database = ((
        strings: TemplateStringsArray,
        ...values: ReadonlyArray<unknown>
      ): Effect.Effect<ReadonlyArray<unknown>> => {
        statements.push(strings.join("?").replaceAll(/\s+/gu, " ").trim());
        parameters.push(values);
        return Effect.succeed([
          { kind: "GlobalAdministrator", identity: "grant-1", revisions: [2] },
          { kind: "Membership", identity: "membership-1", revisions: [3, 5, 7] },
        ]);
      }) as unknown as DatabaseShape;
      const personId = PersonId.make("person-1");

      const sources = yield* readRecruitmentPersonAuthorityHttpSourcesPostgres(personId).pipe(
        Effect.provideService(Database, database),
      );

      expect(sources).toEqual([
        { kind: "GlobalAdministrator", identity: "grant-1", revisions: [2] },
        { kind: "Membership", identity: "membership-1", revisions: [3, 5, 7] },
      ]);
      expect(statements).toHaveLength(1);
      expect(statements[0]).toContain("organization_global_administrator_grants");
      expect(statements[0]).toContain("organization_memberships");
      expect(statements[0]).toContain("UNION ALL");
      expect(statements[0]).toContain("ORDER BY kind_order, identity");
      expect(parameters).toEqual([[personId, personId]]);
    }),
  );

  it.effect("includes co-interviewer designation in the canonical interview HTTP source", () =>
    Effect.gen(function* () {
      const statements: Array<string> = [];
      const database = ((
        strings: TemplateStringsArray,
        ..._values: ReadonlyArray<unknown>
      ): Effect.Effect<ReadonlyArray<unknown>> => {
        const statement = strings.join("?").replaceAll(/\s+/gu, " ").trim();
        statements.push(statement);
        if (statement.includes('co_interviewer_person_id AS "coInterviewerPersonId"')) {
          return Effect.succeed([
            {
              interviewId: "interview-1",
              departmentId: "department-1",
              interviewerPersonId: "person-1",
              coInterviewerPersonId: "person-2",
              interviewRevision: 3,
            },
          ]);
        }
        if (statement.includes("applicant_account_links")) {
          return Effect.succeed([
            {
              applicantId: "applicant-1",
              departmentId: "department-1",
              linkedApplicantPersonId: null,
            },
          ]);
        }
        if (statement.includes("organization_global_administrator_grants")) {
          return Effect.succeed([]);
        }
        throw new Error(`unexpected statement: ${statement}`);
      }) as unknown as DatabaseShape;

      const source = yield* readRecruitmentInterviewHttpSourcePostgres(
        RecruitmentInterviewId.make("interview-1"),
        PersonId.make("actor-1"),
      ).pipe(Effect.provideService(Database, database));

      expect(source).toEqual({
        interviewId: "interview-1",
        departmentId: "department-1",
        interviewerPersonId: "person-1",
        coInterviewerPersonId: "person-2",
        interviewRevision: 3,
        linkedApplicantPersonId: null,
        authority: [],
      });
      expect(statements[0]).toContain('co_interviewer_person_id AS "coInterviewerPersonId"');
    }),
  );
});
