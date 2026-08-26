import { Effect } from "effect";
import type { Transport } from "../../transport.js";
import type { InternalSdkError } from "../../errors.js";
import { Sponsor } from "../../schemas/common.js";

export interface PublicMiscDomain {
  sponsors(): Effect.Effect<readonly Sponsor[], InternalSdkError>;
}

export function createPublicMiscDomain(transport: Transport): PublicMiscDomain {
  return {
    sponsors() {
      return transport
        .getCollection("/api/sponsors", Sponsor)
        .pipe(Effect.map(({ items }) => items));
    },
  };
}
