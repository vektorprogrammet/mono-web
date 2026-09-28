/**
 * Team applications: applications to one team and its intake.
 *
 * Its operations are listed in docs/specs/rpc-only.md; the HTTP contract they replace is
 * `packages/http-api/src/team-application.ts` at the base commit named there.
 *
 * @since 0.3.0
 */
import { RpcGroup } from "effect/unstable/rpc";

export class TeamApplicationsRpcs extends RpcGroup.make() {}
