import { Context, Effect } from "effect";

/**
 * Evidence that `ContactSsrSecurity` compared the presented homepage token with the configured
 * one for this request. Only the ingress middleware provides it, so the Contact guard never holds
 * a second credential source.
 */
export const ContactBackendAdmission = Context.Reference<boolean>(
  "@vektorprogrammet/backend/contact/backend-admission",
  { defaultValue: () => false },
);

/**
 * The deferred Contact guard. It fails closed, as a defect, when the ingress comparison did not
 * run for this request: absent configuration and a handler mounted without the middleware both
 * leave the marker unset.
 */
export const requireContactBackendAdmission = Effect.gen(function* () {
  if (!(yield* ContactBackendAdmission)) {
    return yield* Effect.die(
      new TypeError("Contact guard ran without a ContactSsrSecurity backend-token admission"),
    );
  }
});
