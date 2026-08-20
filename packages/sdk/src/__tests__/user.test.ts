import { describe, expect, it } from "vitest"
import { Effect, Schema } from "effect"
import { UserProfile } from "../schemas/user.js"

describe("UserProfile", () => {
  it("decodes a Symfony profile that omits nullable accountNumber", async () => {
    const profile = await Effect.runPromise(
      Schema.decodeUnknownEffect(UserProfile)({
        id: 1,
        firstName: "Teamleder",
        lastName: "0028",
        userName: "recruitment-leader-0028",
        email: "recruitment-leader-0028@example.invalid",
        phone: "00000000",
        gender: 0,
        fieldOfStudy: null,
        role: "ROLE_TEAM_LEADER",
        profilePhoto: "images/defaultProfile.png",
      }),
    )

    expect(profile.accountNumber).toBeNull()
  })
})
