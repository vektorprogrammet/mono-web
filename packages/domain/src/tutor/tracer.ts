import { Effect } from "effect";
import {
  type ConductInterviewV1,
  decodeConductInterviewV1,
  decodeEventEnvelopeV1,
  type Descriptor,
  type EventEnvelopeV1,
  type EventType,
  type Projection,
  type ProjectionStatus,
  type StreamKey,
  type TutorDecodeError,
} from "./schema.js";
import { canonicalJson } from "./evidence.js";

export const FIXTURE_CONDUCTED_AT = "2026-08-11T09:03:00Z";

export class StreamMismatch extends Error {
  readonly _tag = "StreamMismatch";
  readonly reasonCode = "STREAM_MISMATCH";

  constructor(readonly detail: "COMMAND_STREAM" | "COMMAND_CORRELATION" | "EVENT_STREAM" | "EVENT_CORRELATION" | "STATE_STREAM") {
    super(`stream identity rejected (${detail})`);
    this.name = "StreamMismatch";
  }
}

export class StaleState extends Error {
  readonly _tag = "StaleState";
  readonly reasonCode = "STALE_VERSION";

  constructor(readonly expectedVersion: number, readonly currentVersion: number) {
    super("expected stream version is stale");
    this.name = "StaleState";
  }
}

export class InvalidTransition extends Error {
  readonly _tag = "InvalidTransition";

  constructor(
    readonly reasonCode:
      | "EMPTY_STREAM"
      | "CANONICAL_SEQUENCE"
      | "CONDUCT_REQUIRES_ACCEPTED"
      | "TERMINAL_CONDUCTED",
    readonly lawRef: "T-INT-1" | "T-INT-2" | undefined,
  ) {
    super(`transition rejected (${reasonCode})`);
    this.name = "InvalidTransition";
  }
}

export class OutOfOrderEvent extends Error {
  readonly _tag = "OutOfOrderEvent";

  constructor(readonly reasonCode: "STREAM_VERSION_GAP" | "OCCURRED_AT_REWIND") {
    super(`event order rejected (${reasonCode})`);
    this.name = "OutOfOrderEvent";
  }
}

export class DuplicateEvent extends Error {
  readonly _tag = "DuplicateEvent";
  readonly reasonCode = "DUPLICATE_EVENT_ID";

  constructor(readonly eventId: string) {
    super("duplicate event identity rejected");
    this.name = "DuplicateEvent";
  }
}

export class DuplicateCommandConflict extends Error {
  readonly _tag = "DuplicateCommandConflict";
  readonly reasonCode = "DUPLICATE_COMMAND_CONFLICT";

  constructor(readonly commandId: string) {
    super("duplicate command body conflict");
    this.name = "DuplicateCommandConflict";
  }
}

export type TutorFailure =
  | TutorDecodeError
  | StreamMismatch
  | StaleState
  | InvalidTransition
  | OutOfOrderEvent
  | DuplicateEvent
  | DuplicateCommandConflict;

export interface FoldedState {
  readonly stream: StreamKey;
  readonly correlationId: string;
  readonly events: ReadonlyArray<EventEnvelopeV1>;
  readonly nextEventType: EventType | "Terminal";
}

export interface CommandObservation {
  readonly outcome: "accepted";
  readonly commandId: string;
  readonly eventId: string;
  readonly streamVersion: number;
  readonly eventCount: number;
  readonly descriptorCount: 1;
  readonly projection: Projection;
  readonly descriptor: Descriptor;
}

export interface CommandReceipt {
  readonly commandId: string;
  readonly commandBytes: string;
  readonly observationBytes: string;
  readonly observation: CommandObservation;
}

export interface TutorState {
  readonly stream: StreamKey;
  readonly events: ReadonlyArray<EventEnvelopeV1>;
  readonly receipts: ReadonlyArray<CommandReceipt>;
}

export interface AcceptedResult {
  readonly _tag: "AcceptedResult";
  readonly state: TutorState;
  readonly observation: CommandObservation;
  readonly observationBytes: string;
}

export interface DuplicateResult {
  readonly _tag: "DuplicateResult";
  readonly state: TutorState;
  readonly observation: CommandObservation;
  readonly observationBytes: string;
}

export type ConductInterviewResult = AcceptedResult | DuplicateResult;

const streamEqual = (left: StreamKey, right: StreamKey): boolean =>
  left.personId === right.personId &&
  left.cycle.departmentId === right.cycle.departmentId &&
  left.cycle.semester.year === right.cycle.semester.year &&
  left.cycle.semester.term === right.cycle.semester.term;

const expectedEventType = (index: number): EventType | "Terminal" => {
  switch (index) {
    case 0:
      return "ApplicationReceived";
    case 1:
      return "InterviewInvited";
    case 2:
      return "InterviewAccepted";
    case 3:
      return "InterviewConducted";
    default:
      return "Terminal";
  }
};

export const foldEvents = (inputs: ReadonlyArray<unknown>): Effect.Effect<FoldedState, TutorFailure> =>
  Effect.gen(function* () {
    if (inputs.length === 0) {
      return yield* Effect.fail(new InvalidTransition("EMPTY_STREAM", undefined));
    }

    const events: Array<EventEnvelopeV1> = [];
    const eventIds = new Set<string>();
    let stream: StreamKey | undefined;
    let correlationId: string | undefined;
    let previousOccurredAt: string | undefined;

    for (const input of inputs) {
      const event = yield* decodeEventEnvelopeV1(input);
      const index = events.length;
      const expectedVersion = index + 1;
      const expectedType = expectedEventType(index);

      if (eventIds.has(event.eventId)) {
        return yield* Effect.fail(new DuplicateEvent(event.eventId));
      }
      if (event.streamVersion !== expectedVersion) {
        return yield* Effect.fail(new OutOfOrderEvent("STREAM_VERSION_GAP"));
      }
      if (previousOccurredAt !== undefined && event.occurredAt < previousOccurredAt) {
        return yield* Effect.fail(new OutOfOrderEvent("OCCURRED_AT_REWIND"));
      }
      if (stream === undefined) {
        stream = event.stream;
        correlationId = event.correlationId;
      } else if (!streamEqual(stream, event.stream)) {
        return yield* Effect.fail(new StreamMismatch("EVENT_STREAM"));
      } else if (event.correlationId !== correlationId) {
        return yield* Effect.fail(new StreamMismatch("EVENT_CORRELATION"));
      }
      if (expectedType === "Terminal" || event.eventType !== expectedType) {
        return yield* Effect.fail(new InvalidTransition("CANONICAL_SEQUENCE", "T-INT-1"));
      }

      eventIds.add(event.eventId);
      events.push(event);
      previousOccurredAt = event.occurredAt;
    }

    const firstEvent = events[0];
    if (firstEvent === undefined || stream === undefined || correlationId === undefined) {
      return yield* Effect.fail(new InvalidTransition("EMPTY_STREAM", undefined));
    }

    return {
      stream,
      correlationId,
      events,
      nextEventType: expectedEventType(events.length),
    };
  });

export const createTutorState = (inputs: ReadonlyArray<unknown>): Effect.Effect<TutorState, TutorFailure> =>
  Effect.map(foldEvents(inputs), (folded) => ({
    stream: folded.stream,
    events: folded.events,
    receipts: [],
  }));

const projectionStatus = (eventType: EventType): ProjectionStatus => {
  switch (eventType) {
    case "ApplicationReceived":
      return "received";
    case "InterviewInvited":
      return "invited";
    case "InterviewAccepted":
      return "accepted";
    case "InterviewConducted":
      return "completed";
  }
};

export const projectFoldedState = (folded: FoldedState): Projection => {
  const lastEvent = folded.events[folded.events.length - 1];
  if (lastEvent === undefined) {
    throw new Error("cannot project an empty folded state");
  }

  const base: Omit<Projection, "conductedAt"> = {
    projectionVersion: 1,
    stream: folded.stream,
    streamVersion: folded.events.length,
    status: projectionStatus(lastEvent.eventType),
    eventTypes: folded.events.map((event) => event.eventType),
    lawRefs: ["T-INT-1", "S-INT-1", "T-INT-2", "R-APP-1"],
  };

  if (lastEvent.eventType === "InterviewConducted") {
    return {
      ...base,
      conductedAt: lastEvent.payload.scores.conductedAt,
    };
  }
  return base;
};

const conductEvent = (command: ConductInterviewV1, folded: FoldedState): EventEnvelopeV1 => ({
  schemaVersion: 1,
  eventId: `evt-0014-${String(folded.events.length + 1).padStart(3, "0")}`,
  stream: command.stream,
  streamVersion: folded.events.length + 1,
  eventType: "InterviewConducted",
  payload: {
    scores: {
      ...command.scores,
      conductedAt: FIXTURE_CONDUCTED_AT,
    },
  },
  occurredAt: FIXTURE_CONDUCTED_AT,
  causationId: command.commandId,
  correlationId: command.correlationId,
});

const observationFor = (
  command: ConductInterviewV1,
  event: EventEnvelopeV1,
  projection: Projection,
  descriptor: Descriptor,
): CommandObservation => ({
  outcome: "accepted",
  commandId: command.commandId,
  eventId: event.eventId,
  streamVersion: projection.streamVersion,
  eventCount: projection.streamVersion,
  descriptorCount: 1,
  projection,
  descriptor,
});

export const conductInterview = (
  state: TutorState,
  input: unknown,
): Effect.Effect<ConductInterviewResult, TutorFailure> =>
  Effect.gen(function* () {
    const command = yield* decodeConductInterviewV1(input);
    const commandBytes = canonicalJson(command);
    const receipt = state.receipts.find((candidate) => candidate.commandId === command.commandId);

    if (receipt !== undefined) {
      if (receipt.commandBytes === commandBytes) {
        return {
          _tag: "DuplicateResult",
          state,
          observation: receipt.observation,
          observationBytes: receipt.observationBytes,
        };
      }
      return yield* Effect.fail(new DuplicateCommandConflict(command.commandId));
    }

    const folded = yield* foldEvents(state.events);
    if (!streamEqual(state.stream, folded.stream)) {
      return yield* Effect.fail(new StreamMismatch("STATE_STREAM"));
    }
    if (!streamEqual(command.stream, folded.stream)) {
      return yield* Effect.fail(new StreamMismatch("COMMAND_STREAM"));
    }
    if (command.correlationId !== folded.correlationId) {
      return yield* Effect.fail(new StreamMismatch("COMMAND_CORRELATION"));
    }
    if (command.expectedVersion !== folded.events.length) {
      return yield* Effect.fail(new StaleState(command.expectedVersion, folded.events.length));
    }
    if (folded.nextEventType === "Terminal") {
      return yield* Effect.fail(new InvalidTransition("TERMINAL_CONDUCTED", "T-INT-2"));
    }
    if (folded.nextEventType !== "InterviewConducted") {
      return yield* Effect.fail(new InvalidTransition("CONDUCT_REQUIRES_ACCEPTED", "T-INT-1"));
    }

    const event = conductEvent(command, folded);
    const nextEvents = [...folded.events, event];
    const nextFolded = yield* foldEvents(nextEvents);
    const projection = projectFoldedState(nextFolded);
    const descriptor: Descriptor = {
      descriptorVersion: 1,
      kind: "InterviewConductedDescriptor",
      sourceEventId: event.eventId,
      causationId: command.commandId,
      correlationId: command.correlationId,
      idempotencyKey: `post-commit:${event.eventId}`,
    };
    const observation = observationFor(command, event, projection, descriptor);
    const observationBytes = canonicalJson(observation);
    const nextState: TutorState = {
      stream: nextFolded.stream,
      events: nextFolded.events,
      receipts: [
        ...state.receipts,
        {
          commandId: command.commandId,
          commandBytes,
          observationBytes,
          observation,
        },
      ],
    };

    return {
      _tag: "AcceptedResult",
      state: nextState,
      observation,
      observationBytes,
    };
  });

