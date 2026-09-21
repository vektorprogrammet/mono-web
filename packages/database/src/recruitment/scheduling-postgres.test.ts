import { Admissions } from "@vektorprogrammet/domain/admissions";
import { Database, type DatabaseShape } from "../service.js";
import { Organization } from "@vektorprogrammet/domain/organization";
import { DepartmentId, PersonId } from "@vektorprogrammet/domain/organization";
import { Profile } from "@vektorprogrammet/domain/profile";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { readSchedulingBoard } from "./scheduling-postgres.js";

it.effect("limits ordinary co-interviewer board visibility to completed interviews", () =>
  Effect.gen(function* () {
    const statements: Array<string> = [];
    const database = ((
      strings: TemplateStringsArray,
      ..._values: ReadonlyArray<unknown>
    ): Effect.Effect<ReadonlyArray<unknown>> => {
      statements.push(strings.join("?").replaceAll(/\s+/gu, " ").trim());
      return Effect.succeed([]);
    }) as unknown as DatabaseShape;
    const departmentId = DepartmentId.make("department-1");

    const board = yield* readSchedulingBoard({
      actor: {
        _tag: "DepartmentLeader",
        personId: PersonId.make("leader-1"),
        departmentId,
        active: true,
      },
      now: "2031-09-15T12:00:00.000Z",
    }).pipe(
      Effect.provideService(Database, database),
      Effect.provideService(Admissions, {} as never),
      Effect.provideService(Organization, {} as never),
      Effect.provideService(Profile, {} as never),
    );

    expect(board).toEqual({ departmentId, interviews: [] });
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain(
      "i.co_interviewer_person_id = ? AND EXISTS ( SELECT 1 FROM public.recruitment_interview_conducts conduct WHERE conduct.interview_id = i.interview_id )",
    );
  }),
);
