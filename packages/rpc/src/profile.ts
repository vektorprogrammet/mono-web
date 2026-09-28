/**
 * Profile: the caller's own profile.
 *
 * Its operations are listed in docs/specs/rpc-only.md; the HTTP contract they replace is
 * `packages/http-api/src/profile.ts` at the base commit named there.
 *
 * @since 0.3.0
 */
import { RpcGroup } from "effect/unstable/rpc";

export class ProfileRpcs extends RpcGroup.make() {}
