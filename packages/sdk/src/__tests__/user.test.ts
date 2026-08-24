import { describe, expect, it } from "vitest"
import { Effect, Schema } from "effect"
import { UserProfile } from "../schemas/user.js"

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
    } as const
    const profile = await Effect.runPromise(
      Schema.decodeUnknownEffect(UserProfile)(expected),
    )

    expect(profile).toEqual(expected)
  })
})
