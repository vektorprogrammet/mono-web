import { StrongETag } from "@vektorprogrammet/http-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { ProfileBridgeFailure } from "./bridge";
import { createBrowserProfileClient } from "./browser-client";
import { commandsFor } from "./command";
import { FailedProfileSave } from "./message";

const command = {
  commandId: "profile-command-1",
  etag: StrongETag.make(`"vkr2.${"A".repeat(43)}"`),
  firstName: "Ada",
};

describe("browser profile save", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports the typed failure that the profile route answers", async () => {
    const conflict = ProfileBridgeFailure.cases.Conflict.make({
      message: "Profilen er endret av en annen. Last siden på nytt for å se de nyeste verdiene.",
    });

    fetchMock.mockResolvedValueOnce(Response.json(conflict, { status: 409 }));

    const message = await Effect.runPromise(
      commandsFor(createBrowserProfileClient()).SaveProfile({ requestId: 1, command }).effect,
    );

    expect(message).toEqual(FailedProfileSave({ requestId: 1, failure: conflict }));
  });
});
