/** Recruitment HTTP composition options. */
import type {
  InactiveActor,
  UnauthenticatedActor,
} from "@vektorprogrammet/domain/admission-period";
import type { IdentityEngineError } from "@vektorprogrammet/domain/identity";
import type {
  OrganizationDecodeError,
  OrganizationPersistenceError,
} from "@vektorprogrammet/domain/organization";
import type {
  RecruitmentActor,
  RecruitmentInactiveActor,
  RecruitmentRoleDenied,
} from "@vektorprogrammet/domain/recruitment";
import type { Cause, Effect } from "effect";
import type { RecruitmentApiConfig } from "./config.js";

/** Every way a request's recruitment board actor can fail to resolve. */
export type RecruitmentActorFailure =
  | IdentityEngineError
  | UnauthenticatedActor
  | OrganizationDecodeError
  | OrganizationPersistenceError
  | InactiveActor
  | RecruitmentInactiveActor
  | RecruitmentRoleDenied
  | Cause.UnknownError;

export interface RecruitmentApiHttpOptions<R = never> {
  readonly config: RecruitmentApiConfig;
  readonly resolveActor: (
    request: Request,
  ) => Effect.Effect<RecruitmentActor, RecruitmentActorFailure, R>;
}
