import {
  CancelInterviewResultSchema,
  FinalizeInterviewResultSchema,
  Recruitment,
  RecruitmentInterviewConductObservationSchema,
  type RecruitmentShape,
} from "@vektorprogrammet/domain/recruitment";
import { DepartmentId, PersonId } from "@vektorprogrammet/domain/organization";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { RecruitmentApiConfig } from "./config.js";
import { makeRecruitmentTestHttp as makeRecruitmentApiHttp } from "../test/native-http.js";
import { runTestPromise } from "../../test/runtime.js";

const actor = {
  _tag: "Member" as const,
  personId: PersonId.make("person-1"),
  departmentId: DepartmentId.make("department-1"),
  active: true,
};
const config: RecruitmentApiConfig = {
  tokens: new Map(),
  maxBodyBytes: 4096,
  now: () => "2031-09-15T12:00:00.000Z",
  nextInterviewId: () => "interview-1" as never,
  nextInvitationId: () => "invitation-1" as never,
  nextResponseCapability: () => "A".repeat(43),
};
const observation = Schema.decodeUnknownSync(RecruitmentInterviewConductObservationSchema)({
  interviewId: "interview-1",
  applicationId: "application-1",
  applicant: { applicantId: "applicant-1", firstName: "Ada", lastName: "Lovelace" },
  schedule: {
    interviewId: "interview-1",
    scheduledAt: "2031-09-20T10:00:00.000Z",
    room: "A101",
    campus: null,
    mapLink: null,
    message: "Interview",
    scheduledByPersonId: "person-1",
    committedAt: "2031-09-15T12:00:00.000Z",
    scheduleRevision: 1,
  },
  invitationResponse: "Accepted",
  questions: [],
  answers: [],
  score: null,
  completionState: "NotCompleted",
  cancellationState: "NotCancelled",
  finalizedAt: null,
  cancelledAt: null,
  revision: 1,
  canFinalize: true,
  canCancel: true,
});
const finalizeResult = Schema.decodeUnknownSync(FinalizeInterviewResultSchema)({
  observation: {
    _tag: "InterviewFinalized",
    commandId: "command-1",
    interviewId: "interview-1",
    interviewRevision: 2,
    finalizedAt: "2031-09-15T12:00:00.000Z",
    completionState: "Completed",
    cancellationState: "NotCancelled",
  },
  replayed: false,
});
const cancelResult = Schema.decodeUnknownSync(CancelInterviewResultSchema)({
  observation: {
    _tag: "InterviewCancelled",
    commandId: "cancel-1",
    interviewId: "interview-1",
    interviewRevision: 2,
    cancelledAt: "2031-09-15T12:00:00.000Z",
    completionState: "NotCompleted",
    cancellationState: "Cancelled",
  },
  replayed: false,
});

const makeBackend = (failure?: string) => {
  const calls: string[] = [];
  const recruitment = {
    readInterviewConduct: () => {
      calls.push("read");
      return failure === undefined
        ? Effect.succeed(observation)
        : Effect.fail(Object.assign(new Error(failure), { _tag: failure }));
    },
    finalizeInterview: () => {
      calls.push("finalize");
      return Effect.succeed(finalizeResult);
    },
    cancelInterview: () => {
      calls.push("cancel");
      return Effect.succeed(cancelResult);
    },
  } as unknown as RecruitmentShape;
  const run = ((effect: Effect.Effect<unknown, unknown, Recruitment>): Promise<unknown> =>
    runTestPromise(effect.pipe(Effect.provideService(Recruitment, recruitment)))) as never;
  return {
    calls,
    backend: makeRecruitmentApiHttp({
      config,
      resolveActor: async () => actor,
      resolveConductContext: async () => ({
        actor,
        authorizationInstant: "2031-09-15T11:00:00.000Z",
      }),
      run,
    }),
  };
};

describe("strict recruitment conduct HTTP boundary", () => {
  it("rejects malformed path, query, body, and path/body identity before Recruitment", async () => {
    const { backend, calls } = makeBackend();
    const request = (path: string, init?: RequestInit) =>
      backend.fetch(new Request(`http://backend.test${path}`, init));
    const json = { "content-type": "application/json" };
    const responses = await Promise.all([
      request("/api/admin/recruitment/interviews//conduct"),
      request("/api/admin/recruitment/interviews/interview-1/conduct?unexpected=true"),
      request("/api/admin/recruitment/interviews/interview-1/finalize", {
        method: "POST",
        headers: json,
        body: JSON.stringify({
          commandId: "command-1",
          interviewId: "interview-2",
          expectedRevision: 1,
          answers: [],
          score: { explanatoryPower: 0, roleModel: 0, suitability: 0 },
        }),
      }),
      request("/api/admin/recruitment/interviews/interview-1/cancel", {
        method: "POST",
        headers: json,
        body: JSON.stringify({
          commandId: "cancel-1",
          interviewId: "interview-1",
          expectedRevision: 1,
          unexpected: true,
        }),
      }),
    ]);
    expect(calls).toEqual([]);
    for (const response of responses) {
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ error: { tag: "RecruitmentDecodeError" } });
    }
  });

  it("serves exact conduct observations and command results without leaking persistence details", async () => {
    const { backend, calls } = makeBackend();
    const read = await backend.fetch(
      new Request("http://backend.test/api/admin/recruitment/interviews/interview-1/conduct"),
    );
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual(observation);
    const finalize = await backend.fetch(
      new Request("http://backend.test/api/admin/recruitment/interviews/interview-1/finalize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commandId: "command-1",
          interviewId: "interview-1",
          expectedRevision: 1,
          answers: [],
          score: { explanatoryPower: 0, roleModel: 10, suitability: 5 },
        }),
      }),
    );
    expect(finalize.status).toBe(200);
    expect(await finalize.json()).toEqual(finalizeResult);
    const cancel = await backend.fetch(
      new Request("http://backend.test/api/admin/recruitment/interviews/interview-1/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commandId: "cancel-1",
          interviewId: "interview-1",
          expectedRevision: 1,
        }),
      }),
    );
    expect(cancel.status).toBe(200);
    expect(await cancel.json()).toEqual(cancelResult);
    expect(calls).toEqual(["read", "finalize", "cancel"]);
  });

  it.each([
    ["RecruitmentInterviewStaleRevision", 409],
    ["RecruitmentInterviewAlreadyFinalized", 409],
    ["RecruitmentInvitationNotAccepted", 409],
    ["RecruitmentConductValidationError", 422],
    ["InterviewQuestionsUnavailable", 503],
    ["RecruitmentPersistenceError", 503],
  ] as const)("maps %s to HTTP %i with a safe body", async (tag, status) => {
    const { backend } = makeBackend(tag);
    const response = await backend.fetch(
      new Request("http://backend.test/api/admin/recruitment/interviews/interview-1/conduct"),
    );
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: { tag } });
  });
});
