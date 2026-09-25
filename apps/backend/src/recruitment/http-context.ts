/** Recruitment HTTP composition options and request actor resolution. */
import type { RecruitmentActor } from "@vektorprogrammet/domain/recruitment";
import { Effect } from "effect";
import { HttpSemanticFailure } from "../http-semantics.js";
import type { RecruitmentApiConfig } from "./config.js";
import { errorTag } from "./http-problem.js";

export interface RecruitmentApiHttpOptions<E = never, R = never> {
  readonly config: RecruitmentApiConfig;
  readonly resolveActor: (request: Request) => Effect.Effect<RecruitmentActor, E, R>;
}

/** An untagged actor-resolution failure is an invalid credential. */
export const actorFor = <E, R>(
  request: Request,
  input: RecruitmentApiHttpOptions<E, R>,
): Effect.Effect<RecruitmentActor, E | HttpSemanticFailure, R> =>
  Effect.catch(
    input.resolveActor(request),
    (cause): Effect.Effect<never, E | HttpSemanticFailure> =>
      Effect.fail(
        errorTag(cause) === undefined ? new HttpSemanticFailure("credential.invalid", 401) : cause,
      ),
  );
