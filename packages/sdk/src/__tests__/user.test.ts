import { afterAll, describe, expect, it } from "vitest";
import { Schema } from "effect";
import { SessionActor, UserProfile } from "../schemas/user.js";
import { makeTestRuntime } from "../../test/runtime.js";

const testRuntime = makeTestRuntime();
afterAll(() => testRuntime.dispose());

describe("UserProfile", () => {
  it("decodes the exact native profile actor projection", async () => {
    const expected = {
      personId: "person-team-leader-0028",
      firstName: "Teamleder",
      lastName: "0028",
      email: "recruitment-leader-0028@example.invalid",
      phone: "+47 900 00 000",
      role: "ROLE_TEAM_LEADER",
      nameRevision: 4,
      contactRevision: 6,
    } as const;
    const profile = await testRuntime.runPromise(Schema.decodeUnknownEffect(UserProfile)(expected));

    expect(profile).toEqual(expected);
  });
});

describe("SessionActor", () => {
  const strictDecode = (payload: unknown) =>
    Schema.decodeUnknownSync(SessionActor)(payload, { onExcessProperty: "error" });

  it("accepts the backend /api/me/session payload with expiresAt", () => {
    expect(strictDecode({ personId: "x", expiresAt: "2026-08-25T14:54:13.221Z" })).toEqual({
      personId: "x",
      expiresAt: "2026-08-25T14:54:13.221Z",
    });
  });

  it("accepts the backend session payload when expiresAt is absent", () => {
    expect(strictDecode({ personId: "x" })).toEqual({ personId: "x" });
  });

  it("still rejects unknown session properties under strict decoding", () => {
    expect(() => strictDecode({ personId: "x", actor: true })).toThrow();
  });
});
