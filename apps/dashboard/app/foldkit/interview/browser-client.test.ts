import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { createBrowserInterviewClient } from "./browser-client";

const observation = {
  scheduledAt: "2031-09-20T13:30:00.000Z",
  room: "K-101",
  campus: "Gløshaugen",
  responseState: "Pending",
  responseMessage: null,
} as const;

const jsonResponse = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("browser invitation response bridge", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses capability-free bridge operations for the complete invitation domain", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(observation))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = createBrowserInterviewClient().recruitmentInvitationResponses;

    await Effect.runPromise(client.read());
    await Effect.runPromise(client.confirm());
    await Effect.runPromise(client.reject({ message: null }));
    await Effect.runPromise(client.requestNewTime({ message: "Kan vi møtes torsdag?" }));

    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies).toEqual([
      { operation: "readInvitationResponse" },
      { operation: "confirmInvitation" },
      { operation: "rejectInvitation", message: null },
      { operation: "requestNewInvitationTime", message: "Kan vi møtes torsdag?" },
    ]);
    expect(fetchMock.mock.calls.every(([, init]) => init?.credentials === "same-origin")).toBe(
      true,
    );
  });

  it("strictly decodes the applicant observation", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...observation, invitationId: "forbidden" }));
    const failure = await Effect.runPromise(
      createBrowserInterviewClient().recruitmentInvitationResponses.read().pipe(Effect.flip),
    );

    expect(failure._tag).toBe("InvitationUnavailable");
  });

  it("preserves a safe typed bridge failure", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          _tag: "InvitationAlreadyResponded",
          message: "Invitation already responded",
        },
        409,
      ),
    );
    const failure = await Effect.runPromise(
      createBrowserInterviewClient().recruitmentInvitationResponses.confirm().pipe(Effect.flip),
    );

    expect(failure).toEqual({
      _tag: "InvitationAlreadyResponded",
      message: "Invitation already responded",
    });
  });

  it("maps malformed failures and unexpected success statuses to unavailable", async () => {
    const client = createBrowserInterviewClient().recruitmentInvitationResponses;
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ message: "unsafe persistence detail" }, 503))
      .mockResolvedValueOnce(jsonResponse(observation, 201));

    const malformed = await Effect.runPromise(client.read().pipe(Effect.flip));
    const unexpected = await Effect.runPromise(client.read().pipe(Effect.flip));

    expect(malformed._tag).toBe("InvitationUnavailable");
    expect(unexpected._tag).toBe("InvitationUnavailable");
  });
});
