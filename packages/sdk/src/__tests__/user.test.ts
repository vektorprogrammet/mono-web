import { afterAll, describe, expect, it } from "vitest";
import { Schema } from "effect";
import { SessionProjection, UserProfile } from "../schemas/user.js";
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

describe("SessionProjection", () => {
  const strictDecode = (payload: unknown) =>
    Schema.decodeUnknownSync(SessionProjection)(payload, { onExcessProperty: "error" });
  const expected = {
    sessionId: "session-1",
    createdAt: "2026-08-25T14:00:00.000Z",
    updatedAt: "2026-08-25T14:30:00.000Z",
    expiresAt: "2026-09-01T14:00:00.000Z",
    ipAddress: null,
    userAgent: "sdk-test",
    current: true,
  } as const;

  it("accepts the exact credential-free native session projection", () => {
    expect(strictDecode(expected)).toEqual(expected);
  });

  it("requires every safe session metadata field", () => {
    const { expiresAt: _, ...missingExpiry } = expected;
    expect(() => strictDecode(missingExpiry)).toThrow();
  });

  it("rejects identity and credential properties under strict decoding", () => {
    expect(() => strictDecode({ ...expected, personId: "person-1" })).toThrow();
    expect(() => strictDecode({ ...expected, token: "credential" })).toThrow();
  });
});
