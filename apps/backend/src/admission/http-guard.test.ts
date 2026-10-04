import { expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { genericContext } from "../native-operation.js";
import { admissionsGuards } from "./http.js";
import { authorizeAt, type AdmissionDecision } from "./http-guard.js";
import { admissionOutcomesGuards } from "./outcome-http.js";

const openPeriods = "admissions.listOpenAdmissionPeriods";

const anonymousDecision = (operation: string): AdmissionDecision => ({
  kind: "Anonymous",
  operation,
  resolution: {
    selection: "AllMatching",
    contexts: [genericContext({ domainId: "admissions", authorityVersion: "guard-test" })],
  },
  now: "2026-10-01T10:00:00.000Z",
});

it.effect("an anonymous guard authorizes its own operation's decision", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      authorizeAt(admissionsGuards[openPeriods], anonymousDecision(openPeriods)),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
  }),
);

it.effect("a guard that runs outside any decision point is a defect", () =>
  Effect.gen(function* () {
    const exits = yield* Effect.all([
      Effect.exit(admissionsGuards[openPeriods]()),
      Effect.exit(admissionsGuards["admissions.createAdmissionPeriod"]()),
      Effect.exit(admissionOutcomesGuards["admissionOutcomes.announceOutcome"]()),
    ]);

    expect(exits.map(Exit.hasDies)).toStrictEqual([true, true, true]);
  }),
);

it.effect("a guard refuses the decision of another operation or of another kind", () =>
  Effect.gen(function* () {
    const exits = yield* Effect.all([
      Effect.exit(
        authorizeAt(
          admissionsGuards[openPeriods],
          anonymousDecision("admissions.listApplicationOptions"),
        ),
      ),
      Effect.exit(
        authorizeAt(
          admissionsGuards["admissions.createAdmissionPeriod"],
          anonymousDecision("admissions.createAdmissionPeriod"),
        ),
      ),
    ]);

    expect(exits.map(Exit.hasDies)).toStrictEqual([true, true]);
  }),
);
