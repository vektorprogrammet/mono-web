import { Result, Schema } from "effect";
import { dual } from "effect/Function";
import { PersonId } from "../organization/schema.js";

export const AccountAccess = Schema.Struct({
  personId: PersonId,
  disabled: Schema.Boolean,
  revision: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
});

export type AccountAccess = typeof AccountAccess.Type;

export class AccountAccessFailure extends Schema.TaggedError<AccountAccessFailure>()(
  "AccountAccessFailure",
  {
    code: Schema.Literals(["NotFound", "Stale", "SelfDisable", "LastAdministrator", "Invalid"]),
  },
) {}

/** Enabled <-> Disabled. A repeated state needs replay, not a new transition. */
export const transitionAccountAccess: {
  (
    input: { readonly disabled: boolean; readonly expectedRevision: number },
    context: { readonly actorPersonId: PersonId; readonly anotherUsableAdministrator: boolean },
  ): (current: AccountAccess) => Result.Result<AccountAccess, AccountAccessFailure>;
  (
    current: AccountAccess,
    input: { readonly disabled: boolean; readonly expectedRevision: number },
    context: { readonly actorPersonId: PersonId; readonly anotherUsableAdministrator: boolean },
  ): Result.Result<AccountAccess, AccountAccessFailure>;
} = dual(
  3,
  (
    current: AccountAccess,
    input: { readonly disabled: boolean; readonly expectedRevision: number },
    context: { readonly actorPersonId: PersonId; readonly anotherUsableAdministrator: boolean },
  ): Result.Result<AccountAccess, AccountAccessFailure> => {
    if (current.revision !== input.expectedRevision)
      return Result.fail(AccountAccessFailure.make({ code: "Stale" }));

    if (input.disabled && current.personId === context.actorPersonId)
      return Result.fail(AccountAccessFailure.make({ code: "SelfDisable" }));

    if (input.disabled && !context.anotherUsableAdministrator)
      return Result.fail(AccountAccessFailure.make({ code: "LastAdministrator" }));

    if (input.disabled === current.disabled)
      return Result.fail(AccountAccessFailure.make({ code: "Invalid" }));

    return Result.succeed({ ...current, disabled: input.disabled, revision: current.revision + 1 });
  },
);
