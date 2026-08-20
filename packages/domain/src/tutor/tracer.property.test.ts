import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { FIXTURE_COMMAND, FIXTURE_SEED_EVENTS } from "./fixture.js";
import { ConductInterviewV1Schema, type ConductInterviewV1 } from "./schema.js";
import { conductInterview, createTutorState } from "./tracer.js";

const propertyOptions = {
  fastCheck: { seed: 26082027, numRuns: 150 },
} as const;

const acceptedCommand = (generated: ConductInterviewV1): ConductInterviewV1 => ({
  ...generated,
  stream: FIXTURE_COMMAND.stream,
  correlationId: FIXTURE_COMMAND.correlationId,
  expectedVersion: FIXTURE_SEED_EVENTS.length,
});

it.effect.prop(
  "schema-generated scores preserve accepted, duplicate, and terminal invariants",
  { generated: ConductInterviewV1Schema },
  ({ generated }) =>
    Effect.gen(function* () {
      const initial = yield* createTutorState(FIXTURE_SEED_EVENTS);
      const command = acceptedCommand(generated);
      const accepted = yield* conductInterview(initial, command);

      expect(accepted._tag).toBe("AcceptedResult");
      expect(accepted.state.events).toHaveLength(initial.events.length + 1);
      expect(accepted.state.receipts).toHaveLength(1);
      expect(accepted.observation.streamVersion).toBe(initial.events.length + 1);

      const duplicate = yield* conductInterview(accepted.state, command);
      expect(duplicate._tag).toBe("DuplicateResult");
      expect(duplicate.state).toBe(accepted.state);
      expect(duplicate.observationBytes).toBe(accepted.observationBytes);

      const terminalCommand = {
        ...command,
        commandId: `${command.commandId}-terminal`,
        expectedVersion: accepted.state.events.length,
      };
      const terminalFailure = yield* Effect.flip(conductInterview(accepted.state, terminalCommand));
      expect(terminalFailure.reasonCode).toBe("TERMINAL_CONDUCTED");
      expect(accepted.state.events).toHaveLength(initial.events.length + 1);
    }),
  propertyOptions,
);

it.effect.prop(
  "a reused command ID with a changed body fails without changing state",
  { generated: ConductInterviewV1Schema },
  ({ generated }) =>
    Effect.gen(function* () {
      const initial = yield* createTutorState(FIXTURE_SEED_EVENTS);
      const command = acceptedCommand(generated);
      const accepted = yield* conductInterview(initial, command);
      const stateBefore = JSON.stringify(accepted.state);
      const changed = {
        ...command,
        scores: {
          ...command.scores,
          explanatoryPower: (command.scores.explanatoryPower + 1) % 11,
        },
      };

      const failure = yield* Effect.flip(conductInterview(accepted.state, changed));
      expect(failure.reasonCode).toBe("DUPLICATE_COMMAND_CONFLICT");
      expect(JSON.stringify(accepted.state)).toBe(stateBefore);
    }),
  propertyOptions,
);

it.effect.prop(
  "a stale expected version fails without changing state",
  { generated: ConductInterviewV1Schema },
  ({ generated }) =>
    Effect.gen(function* () {
      const initial = yield* createTutorState(FIXTURE_SEED_EVENTS);
      const stateBefore = JSON.stringify(initial);
      const command = {
        ...acceptedCommand(generated),
        expectedVersion: FIXTURE_SEED_EVENTS.length - 1,
      };

      const failure = yield* Effect.flip(conductInterview(initial, command));
      expect(failure.reasonCode).toBe("STALE_VERSION");
      expect(JSON.stringify(initial)).toBe(stateBefore);
    }),
  propertyOptions,
);
