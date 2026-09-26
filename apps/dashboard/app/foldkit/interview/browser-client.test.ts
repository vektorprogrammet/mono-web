import { StrongETag } from "@vektorprogrammet/http-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { createBrowserInterviewClient } from "./browser-client";
import { INVITATION_INTERACTION_HEADER, InvitationBridgeFailureSchema } from "./bridge";

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



describe("browser invitation response bridge", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "location",
      new URL("https://dashboard.test/dashboard/interview-response/redacted/"),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends strict interaction binding and preserves no-content mutation responses", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json(resource))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = createBrowserInterviewClient(interactionId).recruitment;

    await Effect.runPromise(client.readInvitationResponse());
    await Effect.runPromise(client.confirmInvitation({ etag }));
    await Effect.runPromise(client.rejectInvitation({ etag, message: null }));
    await Effect.runPromise(
      client.requestNewInvitationTime({ etag, message: "Kan vi møtes torsdag?" }),
    );

    const bodies = await Promise.all(
      fetchMock.mock.calls.map(([, init]) => new Response(init?.body).json()),
    );

    expect(bodies).toEqual([
      { operation: "readInvitationResponse" },
      { operation: "confirmInvitation", etag },
      { operation: "rejectInvitation", etag, message: null },
      { operation: "requestNewInvitationTime", etag, message: "Kan vi møtes torsdag?" },
    ]);
    expect(
      fetchMock.mock.calls.every(
        ([url]) => new Request(url).url === "https://dashboard.test/dashboard/interview",
      ),
    ).toBe(true);
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
      Response.json({ ...resource, observation: { ...observation, invitationId: "forbidden" } }),
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
      Response.json(InvitationBridgeFailureSchema.cases.InvitationAlreadyResponded.make({
          message: "Invitation already responded",
        }), { status: 409 }),
    );

    const failure = await Effect.runPromise(
      createBrowserInterviewClient(interactionId)
        .recruitment.confirmInvitation({ etag })
        .pipe(Effect.flip),
    );

    expect(failure).toEqual(InvitationBridgeFailureSchema.cases.InvitationAlreadyResponded.make({
      message: "Invitation already responded",
    }));
  });

  it("maps malformed failures and unexpected success statuses to unavailable", async () => {
    const client = createBrowserInterviewClient(interactionId).recruitment;
    fetchMock
      .mockResolvedValueOnce(Response.json({ message: "unsafe persistence detail" }, { status: 503 }))
      .mockResolvedValueOnce(Response.json(resource, { status: 201 }));

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
