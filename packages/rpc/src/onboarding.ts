/**
 * Onboarding: coordinator invitations and claims.
 *
 * Its operations are listed in docs/specs/rpc-only.md; the HTTP contract they replace is
 * `packages/http-api/src/onboarding.ts` at the base commit named there.
 *
 * @since 0.3.0
 */
import { RpcGroup } from "effect/unstable/rpc";

export class OnboardingRpcs extends RpcGroup.make() {}
