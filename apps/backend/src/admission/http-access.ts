/** Admission authorization helpers shared by read and command handlers. */
import type { AdmissionPeriodActor } from "@vektorprogrammet/domain/admission-period";
import { ResourceId, ResourceKind, Scope } from "@vektorprogrammet/domain/authz";
import {
  ReadReturningAssistantOptionsEndpoint,
  RegisterReturningAssistantEndpoint,
  reflectAccessSpec,
} from "@vektorprogrammet/http-api";
import { Effect, Option, Predicate } from "effect";
import { resolveRequestPersonAuthorityInTransaction } from "../authority.js";
import { authorizePersonNativeOperation, genericContext } from "../native-operation.js";
import type { AdmissionApiHttpOptions } from "./http-context.js";

export const admissionGrantScopes = (actor: AdmissionPeriodActor) =>
  Predicate.isTagged(actor, "GlobalAdmin")
    ? ([Scope.Global()] as const)
    : Predicate.isTagged(actor, "DepartmentLeader")
      ? ([Scope.Department({ departmentId: actor.departmentId })] as const)
      : [];

export const returningPersonResource = (personId: string) =>
  Scope.Resource({
    resource: {
      kind: ResourceKind.make("person-profile"),
      id: ResourceId.make(personId),
    },
  });

export const returningAuthorization = (
  request: Request,
  input: AdmissionApiHttpOptions,
  endpoint:
    | typeof ReadReturningAssistantOptionsEndpoint
    | typeof RegisterReturningAssistantEndpoint,
) =>
  Effect.gen(function* () {
    const authorization = yield* resolveRequestPersonAuthorityInTransaction(request, {
      now: input.config.now,
    });

    yield* authorizePersonNativeOperation({
      spec: Option.getOrThrow(reflectAccessSpec(endpoint)),
      credential: authorization.credential,
      personId: authorization.authority.personId,
      resolution: {
        selection: "ExactlyOne",
        contexts: [
          genericContext({
            domainId: "admissions",
            resourceKind: "person-profile",
            resourceId: authorization.authority.personId,
            facts: { ownerPersonId: authorization.authority.personId },
            authorityVersion: "admissions:returning-assistant",
          }),
        ],
      },
      grantScopes: [returningPersonResource(authorization.authority.personId)],
      now: authorization.authorizationInstant,
    });

    return authorization;
  });
