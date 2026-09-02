import { Database, type DatabaseShape } from "../database/service.js";
import { PersonId } from "../organization/schema.js";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { readRecruitmentPersonAuthorityHttpSourcesPostgres } from "./http-postgres.js";

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
});
