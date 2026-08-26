import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import {
  InterviewQuestionDefinitionSchema,
  InterviewSchema,
  RecruitmentAssignmentBoardQuerySchema,
  RecruitmentAssignmentCommandSchema,
  RecruitmentInterview,
  RecruitmentInterviewQuestionSnapshot,
  RecruitmentInterviewQuestionSourceSchema,
  RecruitmentInvitationCapabilitySchema,
  RecruitmentInvitationRejectInputSchema,
  RecruitmentInvitationRequestNewTimeInputSchema,
  RecruitmentInvitationResponseMessageSchema,
  RecruitmentInvitationResponseObservationSchema,
  RecruitmentInvitationResponseResultSchema,
  RecruitmentInvitationResponseStateSchema,
  RecruitmentSchedulingInterviewSchema,
} from "./schema.js";
const sourceQuestion = (ordinal: number, questionId = `question-${ordinal}`) => ({
  questionId,
  ordinal,
  prompt: `Question ${ordinal}`,
  helpText: null,
  kind: "text" as const,
  alternatives: [],
});

it.effect("strictly validates native question sources and immutable snapshots", () =>
  Effect.gen(function* () {
    const source = [sourceQuestion(0), sourceQuestion(1)];
    expect(
      yield* Schema.decodeUnknownEffect(RecruitmentInterviewQuestionSourceSchema)(source, {
        onExcessProperty: "error",
      }),
    ).toEqual(source);
    for (const invalid of [
      [sourceQuestion(0), sourceQuestion(2)],
      [sourceQuestion(0), sourceQuestion(1, "question-0")],
      [{ ...sourceQuestion(0), kind: "radio", alternatives: [] }],
      [{ ...sourceQuestion(0), kind: "bogus" }],
      [{ ...sourceQuestion(0), extra: true }],
    ]) {
      expect(
        yield* Effect.flip(
          Schema.decodeUnknownEffect(RecruitmentInterviewQuestionSourceSchema)(invalid, {
            onExcessProperty: "error",
          }),
        ),
      ).toBeDefined();
    }
    expect(Object.keys(RecruitmentInterviewQuestionSnapshot.update.fields)).toEqual([]);
    expect(Object.keys(RecruitmentInterviewQuestionSnapshot.insert.fields)).toEqual([
      "interviewId",
      "questionId",
      "ordinal",
      "prompt",
      "helpText",
      "kind",
      "alternatives",
    ]);
    yield* Schema.decodeUnknownEffect(InterviewQuestionDefinitionSchema)(sourceQuestion(0), {
      onExcessProperty: "error",
    });
  }),
);

it("derives immutable Recruitment Models without generated revision inputs", () => {
  expect(Object.keys(InterviewSchema.insert.fields)).not.toContain("revision");
  expect(Object.keys(InterviewSchema.update.fields)).not.toContain("interviewSchemaId");
  expect(Object.keys(RecruitmentInterview.insert.fields)).not.toContain("revision");
  expect(Object.keys(RecruitmentInterview.update.fields)).not.toContain("applicationId");
});

it.effect("strictly decodes board status and assignment commands", () =>
  Effect.gen(function* () {
    const query = yield* Schema.decodeUnknownEffect(RecruitmentAssignmentBoardQuerySchema)(
      { status: "new" },
      { onExcessProperty: "error" },
    );
    expect(query.status).toBe("new");
    const command = yield* Schema.decodeUnknownEffect(RecruitmentAssignmentCommandSchema)(
      {
        commandId: "command-1",
        applicationId: "application-1",
        interviewerPersonId: "person-1",
        interviewSchemaId: "schema-1",
      },
      { onExcessProperty: "error" },
    );
    expect(command.applicationId).toBe("application-1");
    const failure = yield* Effect.flip(
      Schema.decodeUnknownEffect(RecruitmentAssignmentBoardQuerySchema)(
        { status: "pending" },
        { onExcessProperty: "error" },
      ),
    );
    expect(failure).toBeDefined();
  }),
);

it.effect("decodes only exact invitation capabilities and every response state", () =>
  Effect.gen(function* () {
    const capability = "aB09_-".padEnd(43, "x");
    expect(
      yield* Schema.decodeUnknownEffect(RecruitmentInvitationCapabilitySchema)(capability),
    ).toBe(capability);
    for (const state of ["Pending", "Accepted", "Rejected", "RequestedNewTime"] as const) {
      expect(
        yield* Schema.decodeUnknownEffect(RecruitmentInvitationResponseStateSchema)(state),
      ).toBe(state);
    }
    for (const invalid of [capability.slice(1), `${capability}x`, capability.replace("_", "=")]) {
      expect(
        yield* Effect.flip(
          Schema.decodeUnknownEffect(RecruitmentInvitationCapabilitySchema)(invalid),
        ),
      ).toBeDefined();
    }
  }),
);

it.effect(
  "normalizes response messages while confining exact and embedded capability sequences",
  () =>
    Effect.gen(function* () {
      const capabilitySequence = "A".repeat(43);
      const validNearbyMessage = "B".repeat(42);
      expect(
        yield* Schema.decodeUnknownEffect(RecruitmentInvitationResponseMessageSchema)(
          "  Please offer another time.  ",
        ),
      ).toBe("Please offer another time.");
      expect(
        yield* Schema.decodeUnknownEffect(RecruitmentInvitationResponseMessageSchema)(
          `  ${validNearbyMessage}  `,
        ),
      ).toBe(validNearbyMessage);
      for (const invalid of [
        "   ",
        "x".repeat(2_001),
        capabilitySequence,
        `Do not store (${capabilitySequence}) in this message`,
      ]) {
        expect(
          yield* Effect.flip(
            Schema.decodeUnknownEffect(RecruitmentInvitationResponseMessageSchema)(invalid),
          ),
        ).toBeDefined();
      }
    }),
);

it.effect("normalizes optional rejection messages without weakening new-time messages", () =>
  Effect.gen(function* () {
    const capabilitySequence = "A".repeat(43);
    expect(
      yield* Schema.decodeUnknownEffect(RecruitmentInvitationRejectInputSchema)(
        {},
        { onExcessProperty: "error" },
      ),
    ).toEqual({});
    expect(
      yield* Schema.decodeUnknownEffect(RecruitmentInvitationRejectInputSchema)(
        { message: "   " },
        { onExcessProperty: "error" },
      ),
    ).toEqual({});
    expect(
      yield* Schema.decodeUnknownEffect(RecruitmentInvitationRejectInputSchema)(
        { message: "  Cannot attend.  " },
        { onExcessProperty: "error" },
      ),
    ).toEqual({ message: "Cannot attend." });
    expect(
      yield* Effect.flip(
        Schema.decodeUnknownEffect(RecruitmentInvitationRequestNewTimeInputSchema)(
          { message: "   " },
          { onExcessProperty: "error" },
        ),
      ),
    ).toBeDefined();
    for (const message of [capabilitySequence, `Please use another time (${capabilitySequence})`]) {
      expect(
        yield* Effect.flip(
          Schema.decodeUnknownEffect(RecruitmentInvitationRejectInputSchema)(
            { message },
            { onExcessProperty: "error" },
          ),
        ),
      ).toBeDefined();
      expect(
        yield* Effect.flip(
          Schema.decodeUnknownEffect(RecruitmentInvitationRequestNewTimeInputSchema)(
            { message },
            { onExcessProperty: "error" },
          ),
        ),
      ).toBeDefined();
    }
  }),
);

it.effect("keeps applicant observations capability-free and response results strict", () =>
  Effect.gen(function* () {
    const observation = yield* Schema.decodeUnknownEffect(
      RecruitmentInvitationResponseObservationSchema,
    )(
      {
        scheduledAt: "2031-09-20T10:00:00.000Z",
        room: "A-101",
        campus: null,
        responseState: "Rejected",
        responseMessage: "Cannot attend.",
      },
      { onExcessProperty: "error" },
    );
    expect(Object.keys(observation).sort()).toEqual([
      "campus",
      "responseMessage",
      "responseState",
      "room",
      "scheduledAt",
    ]);
    expect(
      yield* Effect.flip(
        Schema.decodeUnknownEffect(RecruitmentInvitationResponseObservationSchema)(
          { ...observation, capability: "x".repeat(43) },
          { onExcessProperty: "error" },
        ),
      ),
    ).toBeDefined();
    const result = yield* Schema.decodeUnknownEffect(RecruitmentInvitationResponseResultSchema)(
      {
        _tag: "InvitationResponseRecorded",
        interviewRevision: 1,
        scheduleRevision: 1,
        responseRevision: 1,
        responseState: "Accepted",
        responseMessage: null,
        respondedAt: "2031-09-15T12:03:00.000Z",
        notificationState: "NotRequired",
      },
      { onExcessProperty: "error" },
    );
    expect(result._tag).toBe("InvitationResponseRecorded");
  }),
);

it.effect("rejects impossible response state and message pairs at every observation boundary", () =>
  Effect.gen(function* () {
    const applicantObservationBase = {
      scheduledAt: "2031-09-20T10:00:00.000Z",
      room: "A-101",
      campus: null,
    };
    for (const invalid of [
      {
        ...applicantObservationBase,
        responseState: "Pending",
        responseMessage: "impossible",
      },
      {
        ...applicantObservationBase,
        responseState: "RequestedNewTime",
        responseMessage: null,
      },
    ]) {
      expect(
        yield* Effect.flip(
          Schema.decodeUnknownEffect(RecruitmentInvitationResponseObservationSchema)(invalid, {
            onExcessProperty: "error",
          }),
        ),
      ).toBeDefined();
    }
    expect(
      yield* Effect.flip(
        Schema.decodeUnknownEffect(RecruitmentInvitationResponseResultSchema)(
          {
            _tag: "InvitationResponseRecorded",
            interviewRevision: 1,
            scheduleRevision: 1,
            responseRevision: 1,
            responseState: "Rejected",
            responseMessage: null,
            respondedAt: "2031-09-15T12:03:00.000Z",
            notificationState: "NotRequired",
          },
          { onExcessProperty: "error" },
        ),
      ),
    ).toBeDefined();
    expect(
      yield* Effect.flip(
        Schema.decodeUnknownEffect(RecruitmentSchedulingInterviewSchema)(
          {
            interviewId: "interview-1",
            applicationId: "application-1",
            departmentId: "department-1",
            interviewer: {
              personId: "person-1",
              displayName: "Ivar Interviewer",
              email: "interviewer@example.invalid",
              phone: "91111111",
            },
            applicant: {
              applicationId: "application-1",
              applicantId: "applicant-1",
              firstName: "Ada",
              lastName: "Applicant",
              email: "applicant@example.invalid",
              phone: "90000000",
            },
            revision: 1,
            schedule: null,
            responseState: null,
            responseMessage: "impossible",
            notificationState: null,
          },
          { onExcessProperty: "error" },
        ),
      ),
    ).toBeDefined();
  }),
);
