/**
 * Social events: department and semester scoped team social events.
 *
 * @since 0.3.0
 */
import {
  CreateSocialEventRequest,
  SocialEventAudience,
  SocialEventId,
  SocialEventListResource,
  SocialEventObservedAt,
  SocialEventResource,
  SocialEventScope,
  SocialEventScopeResource,
} from "@vektorprogrammet/domain";
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { personNativeAccess, withAccessSpec } from "./access.js";
import { PersonCredential } from "./credential.js";
import { IdempotencyKey, problemUnion, rpcProblems } from "./problem.js";

export {
  CreateSocialEventRequest,
  SocialEventAudience,
  SocialEventId,
  SocialEventListResource,
  SocialEventObservedAt,
  SocialEventResource,
  SocialEventScope,
  SocialEventScopeResource,
};

export const SocialEventsReadScopeProblem = problemUnion("SocialEventsReadScopeProblem", [
  "credential.missing",
  "credential.invalid",
  "authority.denied",
  "internal.error",
  "dependency.unavailable",
  "organization.unavailable",
]);

export const SocialEventsListProblem = problemUnion("SocialEventsListProblem", [
  "credential.missing",
  "credential.invalid",
  "authority.denied",
  "scope.invalid",
  "internal.error",
  "dependency.unavailable",
  "organization.unavailable",
]);

export const SocialEventsCreateProblem = problemUnion("SocialEventsCreateProblem", [
  "credential.missing",
  "credential.invalid",
  "authority.denied",
  "idempotency.in-flight",
  "idempotency.digest-conflict",
  "idempotency.response-expired",
  "validation.failed",
  "scope.invalid",
  "internal.error",
  "dependency.unavailable",
  "organization.unavailable",
  "idempotency.unavailable",
  "transaction.conflict",
]);

/** The caller's authorized departments and canonical semesters. */
export const ReadSocialEventScope = Rpc.make("social-events.readScope", {
  success: SocialEventScopeResource,
  error: rpcProblems(SocialEventsReadScopeProblem),
})
  .middleware(PersonCredential)
  .pipe(
    withAccessSpec(
      personNativeAccess({
        capability: "social-events.read-scope",
        canonicalScopeResolver: "social-events.scope",
        decisionTime: "SnapshotRead",
      }),
    ),
  );

/** The social events of one authorized department and semester. */
export const ListSocialEvents = Rpc.make("social-events.list", {
  payload: SocialEventScope,
  success: SocialEventListResource,
  error: rpcProblems(SocialEventsListProblem),
})
  .middleware(PersonCredential)
  .pipe(
    withAccessSpec(
      personNativeAccess({
        capability: "social-events.read",
        canonicalScopeResolver: "social-events.list",
        decisionTime: "SnapshotRead",
      }),
    ),
  );

/** Creates, or replays by its idempotency key, one social event. */
export const CreateSocialEvent = Rpc.make("social-events.create", {
  payload: Schema.Struct({ idempotencyKey: IdempotencyKey, request: CreateSocialEventRequest }),
  success: SocialEventResource,
  error: rpcProblems(SocialEventsCreateProblem),
})
  .middleware(PersonCredential)
  .pipe(
    withAccessSpec(
      personNativeAccess({
        capability: "social-events.create",
        canonicalScopeResolver: "social-events.create",
        decisionTime: "Transaction",
      }),
    ),
  );

export class SocialEventsRpcs extends RpcGroup.make(
  ReadSocialEventScope,
  ListSocialEvents,
  CreateSocialEvent,
) {}
