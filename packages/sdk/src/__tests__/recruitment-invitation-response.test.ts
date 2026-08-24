import { Schema } from "effect";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  RecruitmentDecodeSdkError,
  RecruitmentInvitationAlreadyRespondedError,
  RecruitmentInvitationNotFoundError,
  RecruitmentPersistenceSdkError,
} from "../errors.js";
import { createClient } from "../promise.js";
import {
  RecruitmentInvitationCapabilitySchema,
  RecruitmentInvitationResponseMessageSchema,
  RecruitmentInvitationRejectInputSchema,
  RecruitmentInvitationRequestNewTimeInputSchema,
  RecruitmentInvitationResponseObservationSchema,
} from "../schemas/recruitment.js";

const capabilityValue = "A".repeat(43);
const capability = Schema.decodeUnknownSync(
  RecruitmentInvitationCapabilitySchema,
)(capabilityValue);
const observation = {
  scheduledAt: "2031-09-20T10:00:00.000Z",
  room: "A101",
  campus: "Gløshaugen",
  responseState: "Pending",
  responseMessage: null,
} as const;

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("native Recruitment invitation response SDK", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("strictly models capability, message, and observation boundaries", () => {
    expect(capability).toBe(capabilityValue);
    expect(
      Schema.decodeUnknownSync(
        RecruitmentInvitationResponseMessageSchema,
      )("  Please use another time  "),
    ).toBe("Please use another time");
    const validNearbyMessage = "B".repeat(42);
    expect(
      Schema.decodeUnknownSync(
        RecruitmentInvitationResponseMessageSchema,
      )(`  ${validNearbyMessage}  `),
    ).toBe(validNearbyMessage);
    expect(() =>
      Schema.decodeUnknownSync(
        RecruitmentInvitationCapabilitySchema,
      )("A".repeat(42)),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(
        RecruitmentInvitationCapabilitySchema,
      )(`${"A".repeat(42)}=`),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(
        RecruitmentInvitationResponseMessageSchema,
      )("   "),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(
        RecruitmentInvitationResponseMessageSchema,
      )("x".repeat(2_001)),
    ).toThrow();
    for (const message of [
      capabilityValue,
      `Do not store (${capabilityValue}) in this response`,
    ]) {
      expect(() =>
        Schema.decodeUnknownSync(
          RecruitmentInvitationResponseMessageSchema,
        )(message),
      ).toThrow();
    }
    expect(
      Schema.decodeUnknownSync(
        RecruitmentInvitationRejectInputSchema,
      )({}),
    ).toEqual({});
    expect(
      Schema.decodeUnknownSync(
        RecruitmentInvitationRejectInputSchema,
      )({ message: "   " }),
    ).toEqual({});
    expect(
      Schema.decodeUnknownSync(
        RecruitmentInvitationRejectInputSchema,
      )({ message: "  Cannot attend  " }),
    ).toEqual({ message: "Cannot attend" });
    expect(() =>
      Schema.decodeUnknownSync(
        RecruitmentInvitationRejectInputSchema,
      )(
        { message: "x".repeat(2_001) },
        { onExcessProperty: "error" },
      ),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(
        RecruitmentInvitationRejectInputSchema,
      )({ unexpected: true }, { onExcessProperty: "error" }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(
        RecruitmentInvitationRequestNewTimeInputSchema,
      )({ message: "   " }, { onExcessProperty: "error" }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(
        RecruitmentInvitationRequestNewTimeInputSchema,
      )(
        { message: "Another time", unexpected: true },
        { onExcessProperty: "error" },
      ),
    ).toThrow();
    for (const message of [
      capabilityValue,
      `Please use another time (${capabilityValue})`,
    ]) {
      expect(() =>
        Schema.decodeUnknownSync(
          RecruitmentInvitationRejectInputSchema,
        )({ message }, { onExcessProperty: "error" }),
      ).toThrow();
      expect(() =>
        Schema.decodeUnknownSync(
          RecruitmentInvitationRequestNewTimeInputSchema,
        )({ message }, { onExcessProperty: "error" }),
      ).toThrow();
    }
    expect(() =>
      Schema.decodeUnknownSync(
        RecruitmentInvitationResponseObservationSchema,
      )({ ...observation, capability: capabilityValue }, {
        onExcessProperty: "error",
      }),
    ).toThrow();
    expect(
      Schema.decodeUnknownSync(
        RecruitmentInvitationResponseObservationSchema,
      )({
        ...observation,
        responseState: "Rejected",
        responseMessage: "  Cannot attend  ",
      }).responseMessage,
    ).toBe("Cannot attend");
    expect(
      Schema.decodeUnknownSync(
        RecruitmentInvitationResponseObservationSchema,
      )({
        ...observation,
        responseState: "Rejected",
        responseMessage: null,
      }).responseMessage,
    ).toBeNull();
    for (const [responseState, responseMessage] of [
      ["Pending", "Impossible"],
      ["Accepted", "Impossible"],
      ["RequestedNewTime", null],
      ["Rejected", "   "],
    ] as const) {
      expect(() =>
        Schema.decodeUnknownSync(
          RecruitmentInvitationResponseObservationSchema,
        )(
          { ...observation, responseState, responseMessage },
          { onExcessProperty: "error" },
        ),
      ).toThrow();
    }
  });

  it("uses only native routes, a dedicated capability header, and exact bodies", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, observation))
      .mockResolvedValue(new Response(null, { status: 204 }));
    const client = createClient("http://api.test", { cookie: "better-auth.session_token=must-not-be-sent" });

    const readResult =
      await client.recruitmentInvitationResponses.read(capability);
    expect(readResult).toEqual(observation);
    expect(JSON.stringify(readResult)).not.toContain(capabilityValue);
    expect(JSON.stringify(readResult)).not.toContain(
      "/api/interview-responses",
    );
    await client.recruitmentInvitationResponses.confirm(capability);
    await client.recruitmentInvitationResponses.reject(capability, {
      message: "  I cannot attend  ",
    });
    await client.recruitmentInvitationResponses.reject(capability);
    await client.recruitmentInvitationResponses.reject(capability, {
      message: "   ",
    });
    await client.recruitmentInvitationResponses.requestNewTime(capability, {
      message: "  Could we meet Thursday?  ",
    });

    const calls = fetchMock.mock.calls as Array<[string, RequestInit]>;
    expect(
      calls.map(([url, init]) => ({
        url,
        method: init.method,
        capability: new Headers(init.headers).get(
          "X-Recruitment-Invitation-Capability",
        ),
        cookie: new Headers(init.headers).get("cookie"),
        body: init.body,
      })),
    ).toEqual([
      {
        url: "http://api.test/api/recruitment/invitation-response",
        method: "GET",
        capability: capabilityValue,
        cookie: null,
        body: undefined,
      },
      {
        url: "http://api.test/api/recruitment/invitation-response/confirm",
        method: "POST",
        capability: capabilityValue,
        cookie: null,
        body: "{}",
      },
      {
        url: "http://api.test/api/recruitment/invitation-response/reject",
        method: "POST",
        capability: capabilityValue,
        cookie: null,
        body: JSON.stringify({ message: "I cannot attend" }),
      },
      {
        url: "http://api.test/api/recruitment/invitation-response/reject",
        method: "POST",
        capability: capabilityValue,
        cookie: null,
        body: "{}",
      },
      {
        url: "http://api.test/api/recruitment/invitation-response/reject",
        method: "POST",
        capability: capabilityValue,
        cookie: null,
        body: "{}",
      },
      {
        url:
          "http://api.test/api/recruitment/invitation-response/request-new-time",
        method: "POST",
        capability: capabilityValue,
        cookie: null,
        body: JSON.stringify({ message: "Could we meet Thursday?" }),
      },
    ]);
    expect(
      calls.every(
        ([url]) =>
          !url.includes("/api/interview-responses") &&
          !url.includes(capabilityValue),
      ),
    ).toBe(true);
    expect(client).not.toHaveProperty("interviewResponses");
  });

  it("keeps malformed capabilities opaque and rejects invalid commands before fetch", async () => {
    const client = createClient("http://api.test");

    await expect(
      client.recruitmentInvitationResponses.read(
        "A".repeat(42) as never,
      ),
    ).rejects.toBeInstanceOf(RecruitmentInvitationNotFoundError);
    await expect(
      client.recruitmentInvitationResponses.reject(capability, {
        message: "No",
        unexpected: true,
      } as never),
    ).rejects.toBeInstanceOf(RecruitmentDecodeSdkError);
    await expect(
      client.recruitmentInvitationResponses.reject(capability, {
        message: null,
      } as never),
    ).rejects.toBeInstanceOf(RecruitmentDecodeSdkError);
    await expect(
      client.recruitmentInvitationResponses.requestNewTime(capability, {
        message: "   ",
      }),
    ).rejects.toBeInstanceOf(RecruitmentDecodeSdkError);
    await expect(
      client.recruitmentInvitationResponses.requestNewTime(capability, {
        message: "x".repeat(2_001),
      }),
    ).rejects.toBeInstanceOf(RecruitmentDecodeSdkError);
    for (const message of [
      capabilityValue,
      `Please reschedule (${capabilityValue})`,
    ]) {
      await expect(
        client.recruitmentInvitationResponses.reject(capability, { message }),
      ).rejects.toBeInstanceOf(RecruitmentDecodeSdkError);
      await expect(
        client.recruitmentInvitationResponses.requestNewTime(capability, { message }),
      ).rejects.toBeInstanceOf(RecruitmentDecodeSdkError);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("strictly decodes observations, typed failures, and exact 204 responses", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, { ...observation, unexpected: true }),
      )
      .mockResolvedValueOnce(
        jsonResponse(404, {
          error: { tag: "RecruitmentInvitationNotFound" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(409, {
          error: { tag: "RecruitmentInvitationAlreadyResponded" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(422, { error: { tag: "RecruitmentDecodeError" } }),
      )
      .mockResolvedValueOnce(
        jsonResponse(503, {
          error: { tag: "RecruitmentPersistenceError" },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(
        jsonResponse(404, {
          error: {
            tag: "RecruitmentInvitationNotFound",
            unexpected: true,
          },
        }),
      );
    const client = createClient("http://api.test");

    await expect(
      client.recruitmentInvitationResponses.read(capability),
    ).rejects.toBeInstanceOf(RecruitmentDecodeSdkError);
    await expect(
      client.recruitmentInvitationResponses.read(capability),
    ).rejects.toBeInstanceOf(RecruitmentInvitationNotFoundError);
    await expect(
      client.recruitmentInvitationResponses.confirm(capability),
    ).rejects.toBeInstanceOf(
      RecruitmentInvitationAlreadyRespondedError,
    );
    await expect(
      client.recruitmentInvitationResponses.reject(capability, {
        message: "Cannot attend",
      }),
    ).rejects.toBeInstanceOf(RecruitmentDecodeSdkError);
    await expect(
      client.recruitmentInvitationResponses.read(capability),
    ).rejects.toBeInstanceOf(RecruitmentPersistenceSdkError);
    await expect(
      client.recruitmentInvitationResponses.confirm(capability),
    ).rejects.toBeInstanceOf(RecruitmentDecodeSdkError);
    await expect(
      client.recruitmentInvitationResponses.read(capability),
    ).rejects.toBeInstanceOf(RecruitmentDecodeSdkError);
  });
});
