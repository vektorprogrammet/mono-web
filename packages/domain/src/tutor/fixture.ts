import { Cause, Effect, Exit, Result } from "effect";
import type {
  ConductInterviewV1,
  CounterexampleReceipt,
  Evidence,
  EvidenceCase,
  EventEnvelopeV1,
  StreamKey,
  ReasonCode,
} from "./schema.js";
import { decodeConductInterviewV1, decodeEvidence } from "./schema.js";
import {
  canonicalEvidenceBytes,
  canonicalEvidenceJson,
  renderEvidence,
  type EvidenceArtifact,
} from "./evidence.js";
import {
  conductInterview,
  createTutorState,
  foldEvents,
  projectFoldedState,
  type ConductInterviewResult,
  type TutorFailure,
  type TutorState,
} from "./tracer.js";

export const FIXTURE_ID = "tutor-event-envelope-0014";
export const FIXTURE_PERSON_ID = "person-synth-0014";
export const FIXTURE_DEPARTMENT_ID = "department-synth-0014";
export const FIXTURE_CORRELATION_ID = "corr-0014-tutor";
export const FIXTURE_COMMAND_ID = "cmd-0014-conduct";
export const MALFORMED_COMMAND_ID = "cmd-0014-malformed";
export const STALE_COMMAND_ID = "cmd-0014-stale";
export const TERMINAL_COMMAND_ID = "cmd-0014-terminal";
export const CONDUCTED_EVENT_ID = "evt-0014-004";
export const EFFECT_SOURCE_HASH = "2e1ddbebd9dd5cf0738ea08b2e832a7c39ae990f";
export const BASE_COMMIT = "f55fc050efecd03895b08f5417324c414c44dcf4";

const FIXTURE_STREAM: StreamKey = {
  personId: FIXTURE_PERSON_ID,
  cycle: {
    departmentId: FIXTURE_DEPARTMENT_ID,
    semester: { year: 2026, term: "Vår" },
  },
};

const SEED_EVENT_1 = {
  schemaVersion: 1,
  eventId: "evt-0014-001",
  stream: FIXTURE_STREAM,
  streamVersion: 1,
  eventType: "ApplicationReceived",
  payload: {},
  occurredAt: "2026-08-11T09:00:00Z",
  causationId: FIXTURE_ID,
  correlationId: FIXTURE_CORRELATION_ID,
} satisfies EventEnvelopeV1;

const SEED_EVENT_2 = {
  schemaVersion: 1,
  eventId: "evt-0014-002",
  stream: FIXTURE_STREAM,
  streamVersion: 2,
  eventType: "InterviewInvited",
  payload: {},
  occurredAt: "2026-08-11T09:01:00Z",
  causationId: FIXTURE_ID,
  correlationId: FIXTURE_CORRELATION_ID,
} satisfies EventEnvelopeV1;

const SEED_EVENT_3 = {
  schemaVersion: 1,
  eventId: "evt-0014-003",
  stream: FIXTURE_STREAM,
  streamVersion: 3,
  eventType: "InterviewAccepted",
  payload: {},
  occurredAt: "2026-08-11T09:02:00Z",
  causationId: FIXTURE_ID,
  correlationId: FIXTURE_CORRELATION_ID,
} satisfies EventEnvelopeV1;

export const FIXTURE_SEED_EVENTS: ReadonlyArray<EventEnvelopeV1> = [
  SEED_EVENT_1,
  SEED_EVENT_2,
  SEED_EVENT_3,
];

export const FIXTURE_COMMAND: ConductInterviewV1 = {
  schemaVersion: 1,
  commandId: FIXTURE_COMMAND_ID,
  correlationId: FIXTURE_CORRELATION_ID,
  stream: FIXTURE_STREAM,
  expectedVersion: 3,
  scores: {
    explanatoryPower: 8,
    roleModel: 9,
    suitability: 7,
    suitableAssistant: "Ja",
    answers: {
      "q-0014-a": "answer-a",
      "q-0014-b": "answer-b",
    },
  },
};

const OTHER_STREAM: StreamKey = {
  ...FIXTURE_STREAM,
  personId: "person-synth-0014-other",
};

const expectFailure = <A, E>(
  effect: Effect.Effect<A, E>,
): Effect.Effect<E, Error> =>
  Effect.exit(effect).pipe(
    Effect.flatMap((exit) => {
      if (Exit.isSuccess(exit)) {
        return Effect.fail(new Error("fixture expected effect failure"));
      }
      const failure = Cause.findError(exit.cause);
      return Result.isSuccess(failure)
        ? Effect.succeed(failure.success)
        : Effect.fail(new Error("fixture effect failed without a typed error"));
    }),
  );

const assert = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(message);
};

const descriptorCount = (state: TutorState): number => state.receipts.length;

const caseObservation = (
  caseId: string,
  status: EvidenceCase["status"],
  reasonCode: ReasonCode,
  commandId: string,
  state: TutorState,
): EvidenceCase => ({
  caseId,
  status,
  reasonCode,
  commandId,
  streamVersion: state.events.length,
  eventCount: state.events.length,
  descriptorCount: descriptorCount(state),
});

const preservedCounterexample = (
  caseId: string,
  expectedTag: TutorFailure["_tag"],
  expectedReasonCode: ReasonCode,
  failure: TutorFailure,
  state: TutorState,
): CounterexampleReceipt => {
  assert(failure._tag === expectedTag, `${caseId} tag mismatch`);
  assert(failure.reasonCode === expectedReasonCode, `${caseId} reason mismatch`);
  return {
    caseId,
    expectedReasonCode,
    observedReasonCode: failure.reasonCode,
    preservedEventCount: state.events.length,
    preservedDescriptorCount: descriptorCount(state),
  };
};

const statusCounts = (cases: ReadonlyArray<EvidenceCase>): Readonly<Record<string, number>> => {
  const counts: Record<string, number> = {};
  for (const observation of cases) {
    const previous = counts[observation.status];
    counts[observation.status] = previous === undefined ? 1 : previous + 1;
  }
  return counts;
};

const reasonCounts = (cases: ReadonlyArray<EvidenceCase>): Readonly<Record<string, number>> => {
  const counts: Record<string, number> = {};
  for (const observation of cases) {
    const previous = counts[observation.reasonCode];
    counts[observation.reasonCode] = previous === undefined ? 1 : previous + 1;
  }
  return counts;
};

export interface TutorFixtureRun {
  readonly passed: true;
  readonly scenarioCount: number;
  readonly statusCounts: Readonly<Record<string, number>>;
  readonly reasonCounts: Readonly<Record<string, number>>;
  readonly eventCount: 4;
  readonly descriptorCount: 1;
  readonly counterexampleReceipts: ReadonlyArray<CounterexampleReceipt>;
  readonly evidence: EvidenceArtifact;
}

export const runTutorFixture = (): Effect.Effect<TutorFixtureRun, unknown> =>
  Effect.gen(function* () {
  const seedState = yield* createTutorState(FIXTURE_SEED_EVENTS);
  const seedFolded = yield* foldEvents(seedState.events);
  const seedProjection = projectFoldedState(seedFolded);
  assert(seedProjection.status === "accepted", "seed projection must be accepted");
  assert(seedState.events.length === 3, "seed event count must be three");
  assert(descriptorCount(seedState) === 0, "seed descriptor count must be zero");

  const decodedCommand = yield* decodeConductInterviewV1(FIXTURE_COMMAND);
  assert(decodedCommand.commandId === FIXTURE_COMMAND_ID, "fixture command decode failed");

  const accepted = yield* conductInterview(seedState, FIXTURE_COMMAND);
  assert(accepted._tag === "AcceptedResult", "conduct command must be accepted");
  const acceptedState = accepted.state;
  assert(acceptedState.events.length === 4, "accepted event count must be four");
  assert(descriptorCount(acceptedState) === 1, "accepted descriptor count must be one");
  assert(
    accepted.observation.projection.status === "completed",
    "accepted projection must be completed",
  );
  assert(
    accepted.observation.eventId === CONDUCTED_EVENT_ID,
    "conducted event identity must be fixed",
  );
  assert(
    accepted.observation.descriptor.idempotencyKey === "post-commit:evt-0014-004",
    "descriptor key mismatch",
  );

  const malformedCommand: unknown = {
    ...FIXTURE_COMMAND,
    commandId: MALFORMED_COMMAND_ID,
    extraField: "reject",
  };
  const malformedFailure = yield* expectFailure(conductInterview(acceptedState, malformedCommand));
  assert(malformedFailure._tag === "DecodeError", "malformed command must be a decode error");
  assert(
    acceptedState.events.length === 4 && descriptorCount(acceptedState) === 1,
    "malformed changed state",
  );

  const staleCommand: unknown = {
    ...FIXTURE_COMMAND,
    commandId: STALE_COMMAND_ID,
    expectedVersion: 2,
  };
  const staleFailure = yield* expectFailure(conductInterview(acceptedState, staleCommand));
  assert(staleFailure._tag === "StaleState", "stale command must be stale");

  const terminalCommand: unknown = {
    ...FIXTURE_COMMAND,
    commandId: TERMINAL_COMMAND_ID,
    expectedVersion: 4,
  };
  const terminalFailure = yield* expectFailure(conductInterview(acceptedState, terminalCommand));
  assert(
    terminalFailure._tag === "InvalidTransition",
    "terminal command must be an invalid transition",
  );
  assert(terminalFailure.reasonCode === "TERMINAL_CONDUCTED", "terminal law reason mismatch");

  const duplicate = yield* conductInterview(acceptedState, FIXTURE_COMMAND);
  assert(duplicate._tag === "DuplicateResult", "identical command must be duplicate");
  assert(duplicate.state === acceptedState, "duplicate must preserve state identity");
  assert(
    duplicate.observationBytes === accepted.observationBytes,
    "duplicate observation bytes changed",
  );
  assert(
    acceptedState.events.length === 4 && descriptorCount(acceptedState) === 1,
    "duplicate appended state",
  );

  const duplicateConflictCommand: unknown = {
    ...FIXTURE_COMMAND,
    scores: { ...FIXTURE_COMMAND.scores, explanatoryPower: 7 },
  };
  const duplicateConflictFailure = yield* expectFailure(
    conductInterview(acceptedState, duplicateConflictCommand),
  );
  assert(
    duplicateConflictFailure._tag === "DuplicateCommandConflict",
    "changed duplicate command must conflict",
  );
  assert(
    acceptedState.events.length === 4 && descriptorCount(acceptedState) === 1,
    "duplicate conflict changed state",
  );

  const cases: ReadonlyArray<EvidenceCase> = [
    caseObservation("step-01-seed", "accepted", "SEED_ACCEPTED", FIXTURE_ID, seedState),
    caseObservation(
      "step-02-command-decode",
      "accepted",
      "COMMAND_DECODED",
      FIXTURE_COMMAND_ID,
      seedState,
    ),
    caseObservation(
      "step-03-conduct",
      "accepted",
      "INTERVIEW_CONDUCTED",
      FIXTURE_COMMAND_ID,
      acceptedState,
    ),
    caseObservation(
      "step-04-malformed",
      "rejected",
      malformedFailure.reasonCode,
      MALFORMED_COMMAND_ID,
      acceptedState,
    ),
    caseObservation(
      "step-05-stale",
      "stale",
      staleFailure.reasonCode,
      STALE_COMMAND_ID,
      acceptedState,
    ),
    caseObservation(
      "step-06-terminal",
      "terminal",
      terminalFailure.reasonCode,
      TERMINAL_COMMAND_ID,
      acceptedState,
    ),
    caseObservation(
      "step-07-duplicate",
      "duplicate",
      "DUPLICATE_IDEMPOTENT",
      FIXTURE_COMMAND_ID,
      acceptedState,
    ),
    caseObservation(
      "step-08-duplicate-conflict",
      "duplicate-conflict",
      duplicateConflictFailure.reasonCode,
      FIXTURE_COMMAND_ID,
      acceptedState,
    ),
    caseObservation(
      "step-09-evidence",
      "accepted",
      "EVIDENCE_REPEATABLE",
      FIXTURE_COMMAND_ID,
      acceptedState,
    ),
  ];
  const scenarioCount = cases.length;
  assert(scenarioCount === 9, "fixture must contain exactly nine journey cases");

  const crossStreamCommand: unknown = {
    ...FIXTURE_COMMAND,
    commandId: "cmd-0014-cross-stream",
    stream: OTHER_STREAM,
  };
  const crossStreamFailure = yield* expectFailure(
    conductInterview(acceptedState, crossStreamCommand),
  );
  const emptyStreamFailure = yield* expectFailure(foldEvents([]));
  const gapFailure = yield* expectFailure(
    foldEvents([SEED_EVENT_1, { ...SEED_EVENT_2, streamVersion: 3 }, SEED_EVENT_3]),
  );
  const canonicalSequenceFailure = yield* expectFailure(
    foldEvents([SEED_EVENT_1, { ...SEED_EVENT_2, eventType: "InterviewAccepted" }, SEED_EVENT_3]),
  );
  const occurredAtRewindFailure = yield* expectFailure(
    foldEvents([
      SEED_EVENT_1,
      { ...SEED_EVENT_2, occurredAt: "2026-08-11T08:59:00Z" },
      SEED_EVENT_3,
    ]),
  );
  const duplicateEventFailure = yield* expectFailure(
    foldEvents([
      SEED_EVENT_1,
      { ...SEED_EVENT_2, eventId: SEED_EVENT_1.eventId },
      SEED_EVENT_3,
    ]),
  );
  const eventStreamFailure = yield* expectFailure(
    foldEvents([SEED_EVENT_1, { ...SEED_EVENT_2, stream: OTHER_STREAM }, SEED_EVENT_3]),
  );
  const eventCorrelationFailure = yield* expectFailure(
    foldEvents([
      SEED_EVENT_1,
      { ...SEED_EVENT_2, correlationId: "corr-0014-other" },
      SEED_EVENT_3,
    ]),
  );
  const schemaVersionFailure = yield* expectFailure(
    foldEvents([{ ...SEED_EVENT_1, schemaVersion: 2 }]),
  );
  const invitedState = yield* createTutorState([SEED_EVENT_1, SEED_EVENT_2]);
  const invitedCommand: unknown = {
    ...FIXTURE_COMMAND,
    commandId: "cmd-0014-invited",
    expectedVersion: 2,
  };
  const invitedFailure = yield* expectFailure(conductInterview(invitedState, invitedCommand));
  const incompleteAnswerFailure = yield* expectFailure(
    conductInterview(acceptedState, {
      ...FIXTURE_COMMAND,
      commandId: "cmd-0014-incomplete-answer",
      scores: { ...FIXTURE_COMMAND.scores, answers: { "q-0014-a": "answer-a" } },
    }),
  );
  const invalidScoreFailure = yield* expectFailure(
    conductInterview(acceptedState, {
      ...FIXTURE_COMMAND,
      commandId: "cmd-0014-invalid-score",
      scores: { ...FIXTURE_COMMAND.scores, explanatoryPower: 11 },
    }),
  );

  const counterexampleReceipts: ReadonlyArray<CounterexampleReceipt> = [
    preservedCounterexample(
      "counterexample-cross-stream",
      "StreamMismatch",
      "STREAM_MISMATCH",
      crossStreamFailure,
      acceptedState,
    ),
    preservedCounterexample(
      "counterexample-empty-stream",
      "InvalidTransition",
      "EMPTY_STREAM",
      emptyStreamFailure,
      seedState,
    ),
    preservedCounterexample(
      "counterexample-gap",
      "OutOfOrderEvent",
      "STREAM_VERSION_GAP",
      gapFailure,
      seedState,
    ),
    preservedCounterexample(
      "counterexample-canonical-sequence",
      "InvalidTransition",
      "CANONICAL_SEQUENCE",
      canonicalSequenceFailure,
      seedState,
    ),
    preservedCounterexample(
      "counterexample-occurred-at-rewind",
      "OutOfOrderEvent",
      "OCCURRED_AT_REWIND",
      occurredAtRewindFailure,
      seedState,
    ),
    preservedCounterexample(
      "counterexample-duplicate-event",
      "DuplicateEvent",
      "DUPLICATE_EVENT_ID",
      duplicateEventFailure,
      seedState,
    ),
    preservedCounterexample(
      "counterexample-event-stream",
      "StreamMismatch",
      "STREAM_MISMATCH",
      eventStreamFailure,
      seedState,
    ),
    preservedCounterexample(
      "counterexample-event-correlation",
      "StreamMismatch",
      "STREAM_MISMATCH",
      eventCorrelationFailure,
      seedState,
    ),
    preservedCounterexample(
      "counterexample-schema-version",
      "DecodeError",
      "DECODE_ERROR",
      schemaVersionFailure,
      seedState,
    ),
    preservedCounterexample(
      "counterexample-invited",
      "InvalidTransition",
      "CONDUCT_REQUIRES_ACCEPTED",
      invitedFailure,
      invitedState,
    ),
    preservedCounterexample(
      "counterexample-answer-cardinality",
      "DecodeError",
      "DECODE_ERROR",
      incompleteAnswerFailure,
      acceptedState,
    ),
    preservedCounterexample(
      "counterexample-score-bound",
      "DecodeError",
      "DECODE_ERROR",
      invalidScoreFailure,
      acceptedState,
    ),
  ];

  const finalFolded = yield* foldEvents(acceptedState.events);
  const finalProjection = projectFoldedState(finalFolded);
  const finalDescriptor = accepted.observation.descriptor;
  const evidenceDocument: Evidence = {
    formatVersion: 1,
    specId: "0014",
    baseCommit: BASE_COMMIT,
    fixtureId: FIXTURE_ID,
    schemaVersion: 1,
    correlationId: FIXTURE_CORRELATION_ID,
    stream: FIXTURE_STREAM,
    cases,
    projection: finalProjection,
    eventIds: acceptedState.events.map((event) => event.eventId),
    effectDescriptors: [finalDescriptor],
    provenance: {
      effectSource: "local-effect-source",
      effectVersion: "4.0.0-beta.107",
      effectSourceHash: EFFECT_SOURCE_HASH,
      sourceCommandId: FIXTURE_COMMAND_ID,
      eventIds: acceptedState.events.map((event) => event.eventId),
      limits: [
        "pure-in-memory-tracer",
        "synthetic-input-only",
        "no-persistence-proof",
        "no-backend-parity-proof",
        "no-authorization-proof",
        "no-delivery-proof",
        "no-ui-proof",
        "no-deployment-proof",
        "no-provider-proof",
        "no-public-content-proof",
        "no-production-proof",
      ],
      counterexampleReceipts,
    },
  };

  yield* decodeEvidence(evidenceDocument);
  const firstArtifact = renderEvidence(evidenceDocument);
  const secondArtifact = renderEvidence(evidenceDocument);
  const independentlyEncodedJson = canonicalEvidenceJson(evidenceDocument);
  const independentlyEncodedBytes = canonicalEvidenceBytes(evidenceDocument);
  assert(
    firstArtifact.canonicalJson === secondArtifact.canonicalJson,
    "evidence canonical JSON changed",
  );
  assert(
    firstArtifact.canonicalJson === independentlyEncodedJson,
    "evidence JSON renderer disagrees",
  );
  assert(firstArtifact.digest === secondArtifact.digest, "evidence digest changed");
  assert(
    firstArtifact.bytes.length === secondArtifact.bytes.length,
    "evidence byte length changed",
  );
  assert(
    firstArtifact.bytes.every((byte, index) => byte === secondArtifact.bytes[index]),
    "evidence bytes changed",
  );
  assert(
    firstArtifact.bytes.length === independentlyEncodedBytes.length,
    "evidence bytes renderer disagrees",
  );
  assert(
    firstArtifact.bytes.every((byte, index) => byte === independentlyEncodedBytes[index]),
    "evidence bytes renderer disagrees",
  );
  assert(
    firstArtifact.canonicalJson.endsWith("}") && firstArtifact.bytes.at(-1) === 10,
    "evidence newline missing",
  );

  return {
    passed: true,
    scenarioCount,
    statusCounts: statusCounts(cases),
    reasonCounts: reasonCounts(cases),
    eventCount: 4,
    descriptorCount: 1,
    counterexampleReceipts,
    evidence: firstArtifact,
  };
  });

export type FixtureTransitionResult = ConductInterviewResult;
