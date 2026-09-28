/**
 * Organization: departments, teams, fields of study, team interest, mailing lists, delegations, lifecycle.
 *
 * Its operations are listed in docs/specs/rpc-only.md; the HTTP contract they replace is
 * `packages/http-api/src/organization.ts` at the base commit named there.
 *
 * @since 0.3.0
 */
import { RpcGroup } from "effect/unstable/rpc";

export class OrganizationRpcs extends RpcGroup.make() {}
