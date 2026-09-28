/** Recruitment actors: the board actor of one person's organization authority. */
import { InactiveActor } from "@vektorprogrammet/domain/admission-period";
import {
  RecruitmentInactiveActor,
  RecruitmentRoleDenied,
  type RecruitmentActor,
} from "@vektorprogrammet/domain/recruitment";
import { Cause, Effect, Schema } from "effect";
import type { Headers } from "effect/unstable/http";
import { recruitmentBoardActorFrom, resolveRequestPersonAuthority } from "../authority.js";
import { credentialRequestOf } from "../rpc/credential.js";
import type { NativeRpcOptions } from "../rpc/options.js";

/** One recruitment RPC call: the request headers, the decoded payload, and the handler options. */
export interface RecruitmentCall<Payload> {
  readonly headers: Headers.Headers;
  readonly payload: Payload;
  readonly options: NativeRpcOptions;
}

const isRecruitmentActorDenial = Schema.is(
  Schema.Union([InactiveActor, RecruitmentInactiveActor, RecruitmentRoleDenied]),
);

/**
 * The recruitment board actor of the request's person: the one department where the person is an
 * active member or administrator, or the global administrator.
 *
 * @remarks
 * It resolves the request's person and organization authority at `now`, or at the Clock's instant
 * without it, and maps the authority to its board actor. The mapping throws only its denials,
 * which become failures; anything else that it throws is an unknown failure, which the recruitment
 * problems answer as internal.error.
 */
export const recruitmentBoardActor = (input: {
  readonly headers: Headers.Headers;
  readonly now: (() => string) | undefined;
}) =>
  resolveRequestPersonAuthority(credentialRequestOf(input.headers), { now: input.now }).pipe(
    Effect.flatMap((authority) =>
      Effect.try({
        try: (): RecruitmentActor => recruitmentBoardActorFrom(authority),
        catch: (cause) => (isRecruitmentActorDenial(cause) ? cause : new Cause.UnknownError(cause)),
      }),
    ),
  );
