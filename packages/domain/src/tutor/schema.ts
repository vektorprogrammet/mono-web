import { Effect, Schema } from "effect";

const IdentifierSchema = Schema.NonEmptyString;
const PositiveIntegerSchema = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
const ScoreValueSchema = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10 }));
const Rfc3339Schema = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
);

export const DepartmentIdSchema = IdentifierSchema;
export type DepartmentId = typeof DepartmentIdSchema.Type;

export const PersonIdSchema = IdentifierSchema;
export type PersonId = typeof PersonIdSchema.Type;

export const SemesterTermSchema = Schema.Union([Schema.Literal("Vår"), Schema.Literal("Høst")]);
export type SemesterTerm = typeof SemesterTermSchema.Type;

export const SemesterSchema = Schema.Struct({
  year: Schema.Int,
  term: SemesterTermSchema,
});
export type Semester = typeof SemesterSchema.Type;

export const CycleSchema = Schema.Struct({
  departmentId: DepartmentIdSchema,
  semester: SemesterSchema,
});
export type Cycle = typeof CycleSchema.Type;

export const StreamKeySchema = Schema.Struct({
  personId: PersonIdSchema,
  cycle: CycleSchema,
});
export type StreamKey = typeof StreamKeySchema.Type;

export const SuitabilitySchema = Schema.Union([
  Schema.Literal("Ja"),
  Schema.Literal("Kanskje"),
  Schema.Literal("Nei"),
]);
export type Suitability = typeof SuitabilitySchema.Type;

export const AnswersSchema = Schema.Struct({
  "q-0014-a": Schema.String,
  "q-0014-b": Schema.String,
});
export type Answers = typeof AnswersSchema.Type;

const ScoreFields = {
  explanatoryPower: ScoreValueSchema,
  roleModel: ScoreValueSchema,
  suitability: ScoreValueSchema,
  suitableAssistant: SuitabilitySchema,
  answers: AnswersSchema,
};

export const InterviewScoreSchema = Schema.Struct(ScoreFields);
export type InterviewScore = typeof InterviewScoreSchema.Type;

export const ConductedInterviewScoreSchema = Schema.Struct({
  ...ScoreFields,
  conductedAt: Rfc3339Schema,
});
export type ConductedInterviewScore = typeof ConductedInterviewScoreSchema.Type;

const EventEnvelopeFields = {
  schemaVersion: Schema.Literal(1),
  eventId: IdentifierSchema,
  stream: StreamKeySchema,
  streamVersion: PositiveIntegerSchema,
  occurredAt: Rfc3339Schema,
  causationId: IdentifierSchema,
  correlationId: IdentifierSchema,
};

export const EmptyEventPayloadSchema = Schema.Struct({});
export type EmptyEventPayload = typeof EmptyEventPayloadSchema.Type;

export const InterviewConductedPayloadSchema = Schema.Struct({
  scores: ConductedInterviewScoreSchema,
});
export type InterviewConductedPayload = typeof InterviewConductedPayloadSchema.Type;

const ApplicationReceivedEventSchema = Schema.Struct({
  ...EventEnvelopeFields,
  eventType: Schema.Literal("ApplicationReceived"),
  payload: EmptyEventPayloadSchema,
});
const InterviewInvitedEventSchema = Schema.Struct({
  ...EventEnvelopeFields,
  eventType: Schema.Literal("InterviewInvited"),
  payload: EmptyEventPayloadSchema,
});
const InterviewAcceptedEventSchema = Schema.Struct({
  ...EventEnvelopeFields,
  eventType: Schema.Literal("InterviewAccepted"),
  payload: EmptyEventPayloadSchema,
});
const InterviewConductedEventSchema = Schema.Struct({
  ...EventEnvelopeFields,
  eventType: Schema.Literal("InterviewConducted"),
  payload: InterviewConductedPayloadSchema,
});

export const EventEnvelopeV1Schema = Schema.Union([
  ApplicationReceivedEventSchema,
  InterviewInvitedEventSchema,
  InterviewAcceptedEventSchema,
  InterviewConductedEventSchema,
]);
export type EventEnvelopeV1 = typeof EventEnvelopeV1Schema.Type;

export const EventTypeSchema = Schema.Union([
  Schema.Literal("ApplicationReceived"),
  Schema.Literal("InterviewInvited"),
  Schema.Literal("InterviewAccepted"),
  Schema.Literal("InterviewConducted"),
]);
export type EventType = typeof EventTypeSchema.Type;

export const ConductInterviewV1Schema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  commandId: IdentifierSchema,
  correlationId: IdentifierSchema,
  stream: StreamKeySchema,
  expectedVersion: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  ),
  scores: InterviewScoreSchema,
});
export type ConductInterviewV1 = typeof ConductInterviewV1Schema.Type;

export class TutorDecodeError extends Error {
  readonly _tag = "DecodeError";
  readonly reasonCode = "DECODE_ERROR";

  constructor(readonly subject: "command" | "event" | "evidence") {
    super(`closed ${subject} schema rejected input`);
    this.name = "TutorDecodeError";
  }
}

export const decodeConductInterviewV1 = (input: unknown) =>
  Schema.decodeUnknownEffect(ConductInterviewV1Schema, { onExcessProperty: "error" })(input).pipe(
    Effect.mapError(() => new TutorDecodeError("command")),
  );

export const decodeEventEnvelopeV1 = (input: unknown) =>
  Schema.decodeUnknownEffect(EventEnvelopeV1Schema, { onExcessProperty: "error" })(input).pipe(
    Effect.mapError(() => new TutorDecodeError("event")),
  );

export const DescriptorSchema = Schema.Struct({
  descriptorVersion: Schema.Literal(1),
  kind: Schema.Literal("InterviewConductedDescriptor"),
  sourceEventId: IdentifierSchema,
  causationId: IdentifierSchema,
  correlationId: IdentifierSchema,
  idempotencyKey: IdentifierSchema,
});
export type Descriptor = typeof DescriptorSchema.Type;

export const ProjectionStatusSchema = Schema.Union([
  Schema.Literal("received"),
  Schema.Literal("invited"),
  Schema.Literal("accepted"),
  Schema.Literal("completed"),
]);
export type ProjectionStatus = typeof ProjectionStatusSchema.Type;
export const LawRefSchema = Schema.Union([
  Schema.Literal("T-INT-1"),
  Schema.Literal("S-INT-1"),
  Schema.Literal("T-INT-2"),
  Schema.Literal("R-APP-1"),
]);
export type LawRef = typeof LawRefSchema.Type;

export const ReasonCodeSchema = Schema.Union([
  Schema.Literal("EMPTY_STREAM"),
  Schema.Literal("DECODE_ERROR"),
  Schema.Literal("STREAM_MISMATCH"),
  Schema.Literal("STALE_VERSION"),
  Schema.Literal("CONDUCT_REQUIRES_ACCEPTED"),
  Schema.Literal("TERMINAL_CONDUCTED"),
  Schema.Literal("CANONICAL_SEQUENCE"),
  Schema.Literal("STREAM_VERSION_GAP"),
  Schema.Literal("OCCURRED_AT_REWIND"),
  Schema.Literal("DUPLICATE_EVENT_ID"),
  Schema.Literal("DUPLICATE_COMMAND_CONFLICT"),
  Schema.Literal("SEED_ACCEPTED"),
  Schema.Literal("COMMAND_DECODED"),
  Schema.Literal("INTERVIEW_CONDUCTED"),
  Schema.Literal("DUPLICATE_IDEMPOTENT"),
  Schema.Literal("EVIDENCE_REPEATABLE"),
]);
export type ReasonCode = typeof ReasonCodeSchema.Type;

export const ProjectionSchema = Schema.Struct({
  projectionVersion: Schema.Literal(1),
  stream: StreamKeySchema,
  streamVersion: PositiveIntegerSchema,
  status: ProjectionStatusSchema,
  eventTypes: Schema.Array(EventTypeSchema),
  conductedAt: Schema.optional(Rfc3339Schema),
  lawRefs: Schema.Array(LawRefSchema),
});

export type Projection = typeof ProjectionSchema.Type;

export const EvidenceCaseStatusSchema = Schema.Union([
  Schema.Literal("accepted"),
  Schema.Literal("rejected"),
  Schema.Literal("stale"),
  Schema.Literal("terminal"),
  Schema.Literal("duplicate"),
  Schema.Literal("duplicate-conflict"),
]);
export type EvidenceCaseStatus = typeof EvidenceCaseStatusSchema.Type;

export const EvidenceCaseSchema = Schema.Struct({
  caseId: IdentifierSchema,
  status: EvidenceCaseStatusSchema,
  reasonCode: ReasonCodeSchema,
  commandId: IdentifierSchema,
  streamVersion: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  ),
  eventCount: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  descriptorCount: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  ),
});
export type EvidenceCase = typeof EvidenceCaseSchema.Type;

export const CounterexampleReceiptSchema = Schema.Struct({
  caseId: IdentifierSchema,
  expectedReasonCode: ReasonCodeSchema,
  observedReasonCode: ReasonCodeSchema,
  preservedEventCount: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  ),
  preservedDescriptorCount: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  ),
});
export type CounterexampleReceipt = typeof CounterexampleReceiptSchema.Type;

export const ProvenanceSchema = Schema.Struct({
  effectSource: Schema.Literal("local-effect-source"),
  effectVersion: Schema.Literal("4.0.0-beta.107"),
  effectSourceHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)),
  sourceCommandId: IdentifierSchema,
  eventIds: Schema.Array(IdentifierSchema),
  limits: Schema.Array(IdentifierSchema),
  counterexampleReceipts: Schema.Array(CounterexampleReceiptSchema),
});
export type Provenance = typeof ProvenanceSchema.Type;

export const EvidenceSchema = Schema.Struct({
  formatVersion: Schema.Literal(1),
  specId: Schema.Literal("0014"),
  baseCommit: IdentifierSchema,
  fixtureId: IdentifierSchema,
  schemaVersion: Schema.Literal(1),
  correlationId: IdentifierSchema,
  stream: StreamKeySchema,
  cases: Schema.Array(EvidenceCaseSchema),
  projection: ProjectionSchema,
  eventIds: Schema.Array(IdentifierSchema),
  effectDescriptors: Schema.Array(DescriptorSchema),
  provenance: ProvenanceSchema,
});
export type Evidence = typeof EvidenceSchema.Type;

export const decodeEvidence = (input: unknown) =>
  Schema.decodeUnknownEffect(EvidenceSchema, { onExcessProperty: "error" })(input).pipe(
    Effect.mapError(() => new TutorDecodeError("evidence")),
  );
