/**
 * Contact: anonymous contact messages from the homepage server.
 *
 * Its operations are listed in docs/specs/rpc-only.md; the HTTP contract they replace is
 * `packages/http-api/src/contact.ts` at the base commit named there.
 *
 * @since 0.3.0
 */
import { RpcGroup } from "effect/unstable/rpc";

export class ContactRpcs extends RpcGroup.make() {}
