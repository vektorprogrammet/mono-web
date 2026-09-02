import { StrongETag } from "@vektorprogrammet/http-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { createBrowserInterviewClient } from "./browser-client";
import { INVITATION_INTERACTION_HEADER } from "./bridge";

const observation = {
  scheduledAt: "2031-09-20T13:30:00.000Z",
  room: "K-101",
  campus: "Gløshaugen",
  responseState: "Pending",
  responseMessage: null,
} as const;
const etag = StrongETag.make(`"vkr2.${"A".repeat(43)}"`);
const resource = { observation, etag };

const interactionId = "a".repeat(32);

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

  it("sends the strict interaction binding on every capability-free bridge operation", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(resource))
      .mockResolvedValueOnce(jsonResponse(resource))
      .mockResolvedValueOnce(jsonResponse(resource))
      .mockResolvedValueOnce(jsonResponse(resource));
    const client = createBrowserInterviewClient(interactionId).recruitment;

    await Effect.runPromise(client.readInvitationResponse());
    await Effect.runPromise(client.confirmInvitation({ etag }));
    await Effect.runPromise(client.rejectInvitation({ etag, message: null }));
    await Effect.runPromise(
      client.requestNewInvitationTime({ etag, message: "Kan vi møtes torsdag?" }),
    );

    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies).toEqual([
      { operation: "readInvitationResponse" },
      { operation: "confirmInvitation", etag },
      { operation: "rejectInvitation", etag, message: null },
      { operation: "requestNewInvitationTime", etag, message: "Kan vi møtes torsdag?" },
    ]);
    expect(fetchMock.mock.calls.every(([, init]) => init?.credentials === "same-origin")).toBe(
      true,
    );
    expect(
      fetchMock.mock.calls.every(
        ([, init]) =>
          new Headers(init?.headers).get(INVITATION_INTERACTION_HEADER) === interactionId,
      ),
    ).toBe(true);
  });

  it("strictly decodes the applicant observation", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ...resource, observation: { ...observation, invitationId: "forbidden" } }),
    );
    const failure = await Effect.runPromise(
      createBrowserInterviewClient(interactionId)
        .recruitment.readInvitationResponse()
        .pipe(Effect.flip),
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
      createBrowserInterviewClient(interactionId)
        .recruitment.confirmInvitation({ etag })
        .pipe(Effect.flip),
    );

    expect(failure).toEqual({
      _tag: "InvitationAlreadyResponded",
      message: "Invitation already responded",
    });
  });

  it("maps malformed failures and unexpected success statuses to unavailable", async () => {
    const client = createBrowserInterviewClient(interactionId).recruitment;
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ message: "unsafe persistence detail" }, 503))
      .mockResolvedValueOnce(jsonResponse(resource, 201));

    const malformed = await Effect.runPromise(client.readInvitationResponse().pipe(Effect.flip));
    const unexpected = await Effect.runPromise(client.readInvitationResponse().pipe(Effect.flip));

    expect(malformed._tag).toBe("InvitationUnavailable");
    expect(unexpected._tag).toBe("InvitationUnavailable");
  });

  it("rejects a malformed interaction binding before bridge fetch", () => {
    expect(() => createBrowserInterviewClient("not-an-interaction")).toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
