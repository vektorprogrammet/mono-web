/**
 * Integration tests for createClient.
 * Verifies the shape of the returned object and that all methods are promise-returning functions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createClient, ProfileRejectionError, ValidationError } from "../promise.js";

describe("createClient", () => {
  beforeEach(() => {
    // Stub fetch so domain method calls don't fail at the network level
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns an object with all expected domain namespaces", () => {
    const client = createClient("http://api.test");
    expect(client).toHaveProperty("auth");
    expect(client).toHaveProperty("me");
    expect(client).toHaveProperty("receipts");
    expect(client).toHaveProperty("admin");
    expect(client).toHaveProperty("public");
  });

  it("admin namespace has expected sub-domains", () => {
    const client = createClient("http://api.test");
    expect(client.admin).toHaveProperty("receipts");
    expect(client.admin).toHaveProperty("applications");
    expect(client.admin).toHaveProperty("interviews");
    expect(client.admin).toHaveProperty("users");
    expect(client.admin).toHaveProperty("scheduling");
    expect(client.admin).toHaveProperty("teams");
    expect(client.admin).toHaveProperty("organization");
  });

  it("public namespace has expected domains", () => {
    const client = createClient("http://api.test");
    expect(client.public).toHaveProperty("organization");
    expect(typeof client.public.organization.listDepartments).toBe("function");
    expect(typeof client.public.organization.listFieldOfStudies).toBe("function");
    expect(typeof client.public.organization.listTeams).toBe("function");
    expect(typeof client.public.sponsors).toBe("function");
  });

  it("strictly reads safe current-session metadata with the exact Cookie header", async () => {
    const rawCookie =
      "theme=dark; better-auth.session_token=session-value; invitation_capability=opaque";
    const session = {
      sessionId: "session-1",
      createdAt: "2026-08-25T14:00:00.000Z",
      updatedAt: "2026-08-25T14:30:00.000Z",
      expiresAt: "2026-09-01T14:00:00.000Z",
      ipAddress: "127.0.0.1",
      userAgent: "sdk-test",
      current: true,
    };
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(session),
    } as Response);
    const client = createClient("http://api.test", { cookie: rawCookie });

    await expect(client.me.session()).resolves.toEqual(session);
    expect(fetch).toHaveBeenCalledWith(
      "http://api.test/api/session",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Cookie: rawCookie }),
      }),
    );
  });

  it("rejects a session projection containing identity or credential fields", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          sessionId: "session-1",
          createdAt: "2026-08-25T14:00:00.000Z",
          updatedAt: "2026-08-25T14:30:00.000Z",
          expiresAt: "2026-09-01T14:00:00.000Z",
          ipAddress: null,
          userAgent: null,
          current: true,
          personId: "person-1",
        }),
    } as Response);
    const client = createClient("http://api.test", {
      cookie: "better-auth.session_token=session-value",
    });

    await expect(client.me.session()).rejects.toBeInstanceOf(ValidationError);
  });

  it("uses the server's canonical current-user profile route", async () => {
    const client = createClient("http://api.test");
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            personId: "person-ada",
            firstName: "Ada",
            lastName: "Lovelace",
            email: "ada@example.invalid",
            phone: "+47 900 00 000",
            role: "ROLE_TEAM_MEMBER",
            nameRevision: 2,
            contactRevision: 3,
          }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            personId: "person-ada",
            firstName: "Ada",
            lastName: "Lovelace",
            email: "ada@example.invalid",
            phone: "+47 900 00 000",
            role: "ROLE_TEAM_MEMBER",
            nameRevision: 3,
            contactRevision: 4,
          }),
      } as Response);

    await client.me.profile();
    await client.me.updateProfile({
      _tag: "UpdateOwnProfile",
      commandId: "command-profile-update",
      expectedNameRevision: 2,
      expectedContactRevision: 3,
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.invalid",
      phone: "+47 900 00 000",
    });

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "http://api.test/api/me",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "http://api.test/api/me",
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it.each(["AuthorityInactive", "NotInScope"] as const)(
    "preserves the typed profile scope denial %s",
    async (tag) => {
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: () => Promise.resolve({ error: { tag } }),
      } as Response);
      const client = createClient("http://api.test", {
        cookie: "better-auth.session_token=session-value",
      });
      const failure = await client.me.profile().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ProfileRejectionError);
      expect(failure).toMatchObject({
        name: "ProfileRejectionError",
        profileTag: tag,
      });
    },
  );

  it("domain methods are promise-returning functions", () => {
    const client = createClient("http://api.test");
    // All methods should be functions
    for (const key of Object.keys(client.auth)) {
      expect(typeof (client.auth as any)[key]).toBe("function");
    }
    for (const key of Object.keys(client.me)) {
      expect(typeof (client.me as any)[key]).toBe("function");
    }
    for (const key of Object.keys(client.receipts)) {
      expect(typeof (client.receipts as any)[key]).toBe("function");
    }
  });
});
