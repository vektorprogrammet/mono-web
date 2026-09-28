/** The caller of a receipt RPC: the Person that its credential names, at one instant. */
import { UnauthenticatedActor } from "@vektorprogrammet/domain/receipt";
import { Effect, Predicate } from "effect";
import type { Headers } from "effect/unstable/http";
import {
  resolveRequestCredentialAtInstant,
  resolveRequestCredentialInTransaction,
  resolveRequestPersonAtInstant,
} from "../authority.js";
import { credentialRequestOf } from "../rpc/credential.js";
import type { NativeRpcOptions } from "../rpc/options.js";

/** One receipt RPC call: the headers that it carries, and the options of the composition. */
export interface ReceiptCaller {
  readonly headers: Headers.Headers;
  readonly options: NativeRpcOptions;
}

/** Resolves the current Person credential through the caller's transaction at one instant. */
export const authorizationPrincipalInTransaction = ({ headers, options }: ReceiptCaller) =>
  resolveRequestCredentialInTransaction(credentialRequestOf(headers), "OAuthUserBearer", {
    now: options.now,
  }).pipe(
    Effect.flatMap((authenticated) =>
      Predicate.isTagged(authenticated.credential.principal, "Person")
        ? Effect.succeed({
            personId: authenticated.credential.principal.personId,
            authorizationInstant: authenticated.authorizationInstant,
          })
        : Effect.fail(UnauthenticatedActor.make({ message: "authentication required" })),
    ),
  );

/** The Person that the credential names, and one authorization instant; no role or authority. */
export const authorizationPrincipal = ({ headers, options }: ReceiptCaller) =>
  resolveRequestPersonAtInstant(credentialRequestOf(headers), { now: options.now });

/** The Person or service principal that the credential names, at one instant. */
export const approvalCredential = ({ headers, options }: ReceiptCaller) =>
  resolveRequestCredentialAtInstant(credentialRequestOf(headers), "Either", { now: options.now });
