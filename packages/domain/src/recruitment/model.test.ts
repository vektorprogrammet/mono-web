import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import {
  InterviewSchema,
  RecruitmentAssignmentBoardQuerySchema,
  RecruitmentAssignmentCommandSchema,
  RecruitmentInterview,
  RecruitmentInvitationCapabilitySchema,
  RecruitmentInvitationRejectInputSchema,
  RecruitmentInvitationRequestNewTimeInputSchema,
  RecruitmentInvitationResponseMessageSchema,
  RecruitmentInvitationResponseObservationSchema,
  RecruitmentInvitationResponseResultSchema,
  RecruitmentInvitationResponseStateSchema,
  RecruitmentSchedulingInterviewSchema,
} from "./schema.js";

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
    expect(yield* Schema.decodeUnknownEffect(RecruitmentInvitationCapabilitySchema)(capability)).toBe(
      capability,
    );
    for (const state of ["Pending", "Accepted", "Rejected", "RequestedNewTime"] as const) {
      expect(yield* Schema.decodeUnknownEffect(RecruitmentInvitationResponseStateSchema)(state)).toBe(
        state,
      );
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

it.effect("trims non-empty response messages and rejects blank or oversized values", () =>
  Effect.gen(function* () {
    expect(
      yield* Schema.decodeUnknownEffect(RecruitmentInvitationResponseMessageSchema)(
        "  Please offer another time.  ",
      ),
    ).toBe("Please offer another time.");
    for (const invalid of ["   ", "x".repeat(2_001)]) {
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
          Schema.decodeUnknownEffect(RecruitmentInvitationResponseObservationSchema)(
            invalid,
            { onExcessProperty: "error" },
          ),
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
