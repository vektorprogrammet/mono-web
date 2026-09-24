import { Database } from "./service.js";
import { OnboardingFailure, type AccountProvisionInput } from "@vektorprogrammet/domain/onboarding";
import { Effect } from "effect";
import { nativePasswordHash } from "./password-codec.js";
import { createLocalAccountIssuer } from "better-auth";

export const hashOnboardingPassword = nativePasswordHash;

/** Runs on the caller's Database transaction, including Person/link/token consumption. */
export const provisionOnboardingAccount = (input: AccountProvisionInput) =>
  Database.use((sql) =>
    Effect.gen(function* () {
      const collision =
        yield* sql`SELECT id FROM auth."user" WHERE lower(email)=lower(${input.email})`;

      if (collision.length)
        return yield* Effect.fail(
          new OnboardingFailure({ code: "onboarding.sign-in-required", status: 409 }),
        );
      yield* sql`INSERT INTO public.person_profiles(person_id,first_name,last_name) VALUES(${input.personId},${input.firstName},${input.lastName})`;
      yield* sql`INSERT INTO public.person_contact_profiles(person_id,email,phone) VALUES(${input.personId},${input.email},${input.phone})`;
      yield* sql`INSERT INTO auth."user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES(${input.personId},${input.firstName + " " + input.lastName},${input.email.toLowerCase()},true,${input.now},${input.now})`;
      yield* sql`INSERT INTO auth."account"(id,"accountId","providerId","userId",password,issuer,"createdAt","updatedAt") VALUES(${input.personId + ":credential"},${input.personId},'credential',${input.personId},${input.passwordHash},${createLocalAccountIssuer("credential")},${input.now},${input.now})`;
    }),
  );
