import { Effect, Layer } from "effect";
import { Admissions } from "../admissions/service.js";
import { Database } from "../database/service.js";
import { Organization } from "../organization/service.js";
import { Profile } from "../profile/service.js";
import { assignApplicant, readAssignmentBoard } from "./postgres.js";
import { Recruitment } from "./service.js";

/** Live Recruitment authority; all supporting capabilities remain explicit. */
export const RecruitmentLive = Layer.effect(
  Recruitment,
  Effect.gen(function* () {
    const database = yield* Database;
    const admissions = yield* Admissions;
    const organization = yield* Organization;
    const profile = yield* Profile;
    return Recruitment.of({
      readAssignmentBoard: (query, context) =>
        readAssignmentBoard(query, context).pipe(
          Effect.provideService(Database, database),
          Effect.provideService(Admissions, admissions),
          Effect.provideService(Organization, organization),
          Effect.provideService(Profile, profile),
        ),
      assignApplicant: (command, context) =>
        assignApplicant(command, context).pipe(
          Effect.provideService(Database, database),
          Effect.provideService(Admissions, admissions),
          Effect.provideService(Organization, organization),
          Effect.provideService(Profile, profile),
        ),
    });
  }),
);
