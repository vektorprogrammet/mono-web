import {
  Recruitment,
  RecruitmentInterviewId,
  RecruitmentInvitationId,
  RecruitmentInvitationResponseObservationSchema,
  type RecruitmentShape,
} from "@vektorprogrammet/domain/recruitment";
import { DepartmentId, PersonId } from "@vektorprogrammet/domain/organization";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { RecruitmentApiConfig } from "./config.js";
import type { RecruitmentApiHttpOptions } from "./http.js";
import { makeRecruitmentTestHttp as makeRecruitmentApiHttp } from "../test/native-http.js";
import { runTestPromise } from "../../test/runtime.js";

const token = "recruitment-token";
const config: RecruitmentApiConfig = {
  tokens: new Map([
    [
      token,
      {
        actor: {
          _tag: "DepartmentLeader",
          personId: PersonId.make("leader-1"),
          departmentId: DepartmentId.make("department-1"),
          active: true,
        },
      },
    ],
  ]),
  maxBodyBytes: 4096,
  now: () => "2031-09-15T12:00:00.000Z",
  nextInterviewId: () => RecruitmentInterviewId.make("interview-1"),
  nextInvitationId: () => RecruitmentInvitationId.make("invitation-1"),
  nextResponseCapability: () => "A".repeat(43),
};

const invitationCapability = "A".repeat(43);
const invitationHeaders = {
  "X-Recruitment-Invitation-Capability": invitationCapability,
};
const invitationObservation = Schema.decodeUnknownSync(
  RecruitmentInvitationResponseObservationSchema,
)({
  scheduledAt: "2031-09-20T10:00:00.000Z",
  room: "A101",
  campus: "Gløshaugen",
  responseState: "Pending",
  responseMessage: null,
});

const backend = makeRecruitmentApiHttp({
  config,
  resolveActor: async () => config.tokens.get(token)!.actor,
  run: async <A>(): Promise<A> => undefined as A,
});

const request = (path: string, init?: RequestInit): Promise<Response> =>
  backend.fetch(new Request(`http://backend.test${path}`, init));

const makePublicBackend = () => {
  const calls: Array<{
    readonly operation: string;
    readonly arguments: ReadonlyArray<unknown>;
  }> = [];
  const recruitment: RecruitmentShape = {
    readAssignmentBoard: () => Effect.die("unexpected staff method"),
    assignApplicant: () => Effect.die("unexpected staff method"),
    readSchedulingBoard: () => Effect.die("unexpected staff method"),
    scheduleInterview: () => Effect.die("unexpected staff method"),
    readInterviewConduct: () => Effect.die("unexpected conduct method"),
    finalizeInterview: () => Effect.die("unexpected conduct method"),
    cancelInterview: () => Effect.die("unexpected conduct method"),
    readInvitationResponse: (capability) =>
      Effect.sync(() => {
        calls.push({
          operation: "readInvitationResponse",
          arguments: [capability],
        });
        return invitationObservation;
      }),
    confirmInvitation: (capability, context) =>
      Effect.sync(() => {
        calls.push({
          operation: "confirmInvitation",
          arguments: [capability, context],
        });
        return undefined as never;
      }),
    rejectInvitation: (capability, input, context) =>
      Effect.sync(() => {
        calls.push({
          operation: "rejectInvitation",
          arguments: [capability, input, context],
        });
        return undefined as never;
      }),
    requestNewInvitationTime: (capability, input, context) =>
      Effect.sync(() => {
        calls.push({
          operation: "requestNewInvitationTime",
          arguments: [capability, input, context],
        });
        return undefined as never;
      }),
  };
  const run = ((effect: Effect.Effect<unknown, unknown, Recruitment>): Promise<unknown> =>
    runTestPromise(
      effect.pipe(Effect.provideService(Recruitment, recruitment)),
    )) as RecruitmentApiHttpOptions["run"];
  return {
    calls,
    backend: makeRecruitmentApiHttp({
      config,
      resolveActor: async () => config.tokens.get(token)!.actor,
      run,
    }),
  };
};

describe("native recruitment HTTP boundary", () => {
  it("requires the exact board status query and credentials", async () => {
    const missingStatus = await request("/api/admin/recruitment/assignment-board");
    const rejectingBackend = makeRecruitmentApiHttp({
      config,
      resolveActor: async () => {
        throw Object.assign(new Error("UnauthenticatedActor"), { _tag: "UnauthenticatedActor" });
      },
      run: async <A>(): Promise<A> => undefined as A,
    });
    const missingCredentials = await rejectingBackend.fetch(
      new Request("http://backend.test/api/admin/recruitment/assignment-board?status=new"),
    );

    expect(missingStatus.status).toBe(422);
    expect(missingCredentials.status).toBe(401);
    expect(missingCredentials.headers.get("cache-control")).toBe("no-store");
  });

  it("serves all public invitation routes without an Identity token", async () => {
    const { backend: publicBackend, calls } = makePublicBackend();
    const publicRequest = (path: string, init?: RequestInit): Promise<Response> =>
      publicBackend.fetch(new Request(`http://backend.test${path}`, init));

    const read = await publicRequest("/api/recruitment/invitation-response", {
      headers: invitationHeaders,
    });
    const confirm = await publicRequest("/api/recruitment/invitation-response/confirm", {
      method: "POST",
      headers: {
        ...invitationHeaders,
        "content-type": "application/json",
      },
      body: "{}",
    });
    const reject = await publicRequest("/api/recruitment/invitation-response/reject", {
      method: "POST",
      headers: {
        ...invitationHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify({ message: "  I cannot attend  " }),
    });
    const rejectWithoutMessage = await publicRequest(
      "/api/recruitment/invitation-response/reject",
      {
        method: "POST",
        headers: {
          ...invitationHeaders,
          "content-type": "application/json",
        },
        body: "{}",
      },
    );
    const rejectBlankMessage = await publicRequest("/api/recruitment/invitation-response/reject", {
      method: "POST",
      headers: {
        ...invitationHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify({ message: "   " }),
    });
    const requestNewTime = await publicRequest(
      "/api/recruitment/invitation-response/request-new-time",
      {
        method: "POST",
        headers: {
          ...invitationHeaders,
          "content-type": "application/json",
        },
        body: JSON.stringify({ message: "  Could we meet Thursday?  " }),
      },
    );

    const readPayload = await read.text();
    expect({
      status: read.status,
      body: JSON.parse(readPayload) as unknown,
    }).toEqual({ status: 200, body: invitationObservation });
    const commandPayloads: string[] = [];
    for (const response of [
      confirm,
      reject,
      rejectWithoutMessage,
      rejectBlankMessage,
      requestNewTime,
    ]) {
      commandPayloads.push(await response.text());
      expect(response.status).toBe(204);
      expect(commandPayloads.at(-1)).toBe("");
      expect(response.headers.get("content-type")).toBeNull();
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    const returnedPayloads = [readPayload, ...commandPayloads].join("");
    expect(returnedPayloads).not.toContain(invitationCapability);
    expect(returnedPayloads).not.toContain("/api/interview-responses");
    expect(calls).toEqual([
      {
        operation: "readInvitationResponse",
        arguments: [invitationCapability],
      },
      {
        operation: "confirmInvitation",
        arguments: [invitationCapability, { now: "2031-09-15T12:00:00.000Z" }],
      },
      {
        operation: "rejectInvitation",
        arguments: [
          invitationCapability,
          { message: "I cannot attend" },
          { now: "2031-09-15T12:00:00.000Z" },
        ],
      },
      {
        operation: "rejectInvitation",
        arguments: [invitationCapability, {}, { now: "2031-09-15T12:00:00.000Z" }],
      },
      {
        operation: "rejectInvitation",
        arguments: [invitationCapability, {}, { now: "2031-09-15T12:00:00.000Z" }],
      },
      {
        operation: "requestNewInvitationTime",
        arguments: [
          invitationCapability,
          { message: "Could we meet Thursday?" },
          { now: "2031-09-15T12:00:00.000Z" },
        ],
      },
    ]);
  });

  it("confines capability-shaped response messages before Recruitment", async () => {
    const { backend: publicBackend, calls } = makePublicBackend();
    const send = (path: string, message: string): Promise<Response> =>
      publicBackend.fetch(
        new Request(`http://backend.test${path}`, {
          method: "POST",
          headers: {
            ...invitationHeaders,
            "content-type": "application/json",
          },
          body: JSON.stringify({ message }),
        }),
      );
    const capabilitySequence = "Z".repeat(43);
    const invalidResponses = await Promise.all([
      send("/api/recruitment/invitation-response/reject", capabilitySequence),
      send("/api/recruitment/invitation-response/reject", `Cannot attend (${capabilitySequence})`),
      send("/api/recruitment/invitation-response/request-new-time", capabilitySequence),
      send(
        "/api/recruitment/invitation-response/request-new-time",
        `Please reschedule (${capabilitySequence})`,
      ),
    ]);

    for (const response of invalidResponses) {
      expect({
        status: response.status,
        body: await response.json(),
      }).toEqual({
        status: 422,
        body: { error: { tag: "RecruitmentDecodeError" } },
      });
    }
    expect(calls).toEqual([]);

    const validNearbyMessage = "B".repeat(42);
    const rejectNearby = await send(
      "/api/recruitment/invitation-response/reject",
      validNearbyMessage,
    );
    const rejectOrdinary = await send(
      "/api/recruitment/invitation-response/reject",
      "Cannot attend this time.",
    );
    const rejectBlank = await send("/api/recruitment/invitation-response/reject", "   ");
    const requestNearby = await send(
      "/api/recruitment/invitation-response/request-new-time",
      validNearbyMessage,
    );
    const requestOrdinary = await send(
      "/api/recruitment/invitation-response/request-new-time",
      "Could we meet Thursday?",
    );
    for (const response of [
      rejectNearby,
      rejectOrdinary,
      rejectBlank,
      requestNearby,
      requestOrdinary,
    ]) {
      expect(response.status).toBe(204);
      expect(await response.text()).toBe("");
    }
    expect(calls).toEqual([
      {
        operation: "rejectInvitation",
        arguments: [
          invitationCapability,
          { message: validNearbyMessage },
          { now: "2031-09-15T12:00:00.000Z" },
        ],
      },
      {
        operation: "rejectInvitation",
        arguments: [
          invitationCapability,
          { message: "Cannot attend this time." },
          { now: "2031-09-15T12:00:00.000Z" },
        ],
      },
      {
        operation: "rejectInvitation",
        arguments: [invitationCapability, {}, { now: "2031-09-15T12:00:00.000Z" }],
      },
      {
        operation: "requestNewInvitationTime",
        arguments: [
          invitationCapability,
          { message: validNearbyMessage },
          { now: "2031-09-15T12:00:00.000Z" },
        ],
      },
      {
        operation: "requestNewInvitationTime",
        arguments: [
          invitationCapability,
          { message: "Could we meet Thursday?" },
          { now: "2031-09-15T12:00:00.000Z" },
        ],
      },
    ]);
  });

  it("strictly rejects malformed public headers, queries, and bodies before Recruitment", async () => {
    const { backend: publicBackend, calls } = makePublicBackend();
    const publicRequest = (path: string, init?: RequestInit): Promise<Response> =>
      publicBackend.fetch(new Request(`http://backend.test${path}`, init));
    const jsonHeaders = {
      ...invitationHeaders,
      "content-type": "application/json",
    };
    const capabilityResponses = await Promise.all([
      publicRequest("/api/recruitment/invitation-response"),
      publicRequest("/api/recruitment/invitation-response", {
        headers: {
          "X-Recruitment-Invitation-Capability": "A".repeat(42),
        },
      }),
    ]);
    const decodeResponses = await Promise.all([
      publicRequest("/api/recruitment/invitation-response?unexpected=true", {
        headers: invitationHeaders,
      }),
      publicRequest("/api/recruitment/invitation-response/confirm", {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ unexpected: true }),
      }),
      publicRequest("/api/recruitment/invitation-response/reject", {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ message: null }),
      }),
      publicRequest("/api/recruitment/invitation-response/reject", {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          message: "Cannot attend",
          unexpected: true,
        }),
      }),
      publicRequest("/api/recruitment/invitation-response/request-new-time", {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({}),
      }),
      publicRequest("/api/recruitment/invitation-response/request-new-time", {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          message: "Thursday",
          unexpected: true,
        }),
      }),
    ]);

    for (const response of capabilityResponses) {
      expect({
        status: response.status,
        body: await response.json(),
      }).toEqual({
        status: 404,
        body: { error: { tag: "RecruitmentInvitationNotFound" } },
      });
    }
    for (const response of decodeResponses) {
      expect({
        status: response.status,
        body: await response.json(),
      }).toEqual({
        status: 422,
        body: { error: { tag: "RecruitmentDecodeError" } },
      });
    }
    expect(calls).toEqual([]);
  });

  it("enforces the maximum body size on every public POST route", async () => {
    const { backend: publicBackend, calls } = makePublicBackend();
    const oversizedBody = JSON.stringify({
      message: "x".repeat(config.maxBodyBytes),
    });
    const responses = await Promise.all(
      [
        "/api/recruitment/invitation-response/confirm",
        "/api/recruitment/invitation-response/reject",
        "/api/recruitment/invitation-response/request-new-time",
      ].map((path) =>
        publicBackend.fetch(
          new Request(`http://backend.test${path}`, {
            method: "POST",
            headers: {
              ...invitationHeaders,
              "content-type": "application/json",
            },
            body: oversizedBody,
          }),
        ),
      ),
    );

    for (const response of responses) {
      expect({
        status: response.status,
        body: await response.json(),
      }).toEqual({
        status: 413,
        body: { error: { tag: "RequestBodyTooLarge" } },
      });
    }
    expect(calls).toEqual([]);
  });

  it("strictly decodes the public read response before returning it", async () => {
    const invalidBackend = makeRecruitmentApiHttp({
      config,
      resolveActor: async () => config.tokens.get(token)!.actor,
      run: async <A>(): Promise<A> =>
        ({
          ...invitationObservation,
          capability: invitationCapability,
          legacyPath: "/api/interview-responses",
        }) as A,
    });
    const response = await invalidBackend.fetch(
      new Request("http://backend.test/api/recruitment/invitation-response", {
        headers: invitationHeaders,
      }),
    );

    const payload = await response.text();
    expect(payload).not.toContain(invitationCapability);
    expect(payload).not.toContain("/api/interview-responses");
    expect({
      status: response.status,
      body: JSON.parse(payload) as unknown,
    }).toEqual({
      status: 503,
      body: { error: { tag: "RecruitmentPersistenceError" } },
    });
  });

  it("rejects excess command properties before executing Recruitment", async () => {
    const response = await request("/api/admin/recruitment/interviews/assign", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        commandId: "command-1",
        applicationId: "application-1",
        interviewerPersonId: "person-1",
        interviewSchemaId: "schema-1",
        unexpected: true,
      }),
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: { tag: "RecruitmentDecodeError" } });
  });

  it("rejects malformed UTF-8 and oversized command bodies before Recruitment", async () => {
    const malformed = await request("/api/admin/recruitment/interviews/assign", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: new Uint8Array([0xc3, 0x28]),
    });
    const oversized = await request("/api/admin/recruitment/interviews/assign", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ commandId: "x".repeat(config.maxBodyBytes) }),
    });

    expect({ status: malformed.status, body: await malformed.json() }).toEqual({
      status: 422,
      body: { error: { tag: "RecruitmentDecodeError" } },
    });
    expect({ status: oversized.status, body: await oversized.json() }).toEqual({
      status: 413,
      body: { error: { tag: "RequestBodyTooLarge" } },
    });
  });

  it.each([
    ["RecruitmentInactiveActor", "RecruitmentInactiveActor", 403],
    ["RecruitmentRoleDenied", "RecruitmentRoleDenied", 403],
    ["RecruitmentScopeDenied", "RecruitmentScopeDenied", 403],
    ["RecruitmentInterviewerNotEligible", "RecruitmentInterviewerNotEligible", 403],
    ["RecruitmentAdmissionPeriodNotFound", "RecruitmentAdmissionPeriodNotFound", 404],
    ["RecruitmentApplicationNotFound", "RecruitmentApplicationNotFound", 404],
    ["RecruitmentInterviewSchemaNotFound", "RecruitmentInterviewSchemaNotFound", 404],
    ["RecruitmentInvitationNotFound", "RecruitmentInvitationNotFound", 404],
    ["RecruitmentApplicationAlreadyAssigned", "RecruitmentApplicationAlreadyAssigned", 409],
    ["RecruitmentAmbiguousAdmissionPeriod", "RecruitmentAmbiguousAdmissionPeriod", 409],
    ["RecruitmentAssignmentCommandConflict", "RecruitmentAssignmentCommandConflict", 409],
    ["RecruitmentInvitationAlreadyResponded", "RecruitmentInvitationAlreadyResponded", 409],
    ["RecruitmentInterviewSchemaInactive", "RecruitmentInterviewSchemaInactive", 422],
    ["RecruitmentPersistenceError", "RecruitmentPersistenceError", 503],
    ["ProfileNotFound", "RecruitmentPersistenceError", 503],
    ["ProfileDecodeError", "RecruitmentPersistenceError", 503],
    ["ProfilePersistenceError", "RecruitmentPersistenceError", 503],
    ["OrganizationDecodeError", "RecruitmentPersistenceError", 503],
    ["OrganizationPersistenceError", "RecruitmentPersistenceError", 503],
    ["AdmissionPeriodPersistenceError", "RecruitmentPersistenceError", 503],
    ["RecruitmentInvalidContext", "RecruitmentPersistenceError", 503],
  ] as const)(
    "normalizes %s to %s at HTTP %i without leaking details",
    async (sourceTag, expectedTag, expectedStatus) => {
      const failedBackend = makeRecruitmentApiHttp({
        config,
        resolveActor: async () => config.tokens.get(token)!.actor,
        run: async <A>(): Promise<A> => {
          throw Object.assign(new Error(sourceTag), { _tag: sourceTag });
        },
      });
      const response = await failedBackend.fetch(
        new Request("http://backend.test/api/admin/recruitment/assignment-board?status=new", {
          headers: { authorization: `Bearer ${token}` },
        }),
      );

      expect({ status: response.status, body: await response.json() }).toEqual({
        status: expectedStatus,
        body: { error: { tag: expectedTag } },
      });
    },
  );
});
