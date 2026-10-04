import { Data, Schema } from "effect";
import { PublicApplicationIdSchema } from "../application/schema.js";

export class OnboardingFailure extends Data.TaggedError("OnboardingFailure")<{
  readonly code:
    | "onboarding.claim-invalid"
    | "onboarding.sign-in-required"
    | "onboarding.already-linked"
    | "resource.not-found";
  readonly status: 400 | 404 | 409;
}> {}

/** No invitation may replace custody without current admitted standing. */
export class OnboardingNotAdmitted extends Schema.TaggedError<OnboardingNotAdmitted>()(
  "OnboardingNotAdmitted",
  { applicationId: PublicApplicationIdSchema },
) {}
