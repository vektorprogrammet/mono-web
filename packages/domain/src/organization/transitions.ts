import { compareRfc3339Instants } from "../time.js";
import { isMembershipInterval, isRfc3339, type Membership } from "./schema.js";
import { dual } from "effect/Function";

export const membershipIsActiveAt: {
  (at: string): (membership: Membership) => boolean;
  (membership: Membership, at: string): boolean;
} = dual(2, (membership: Membership, at: string): boolean => {
  if (!isRfc3339(at) || !isMembershipInterval(membership)) return false;

  return (
    compareRfc3339Instants(at, membership.startAt) >= 0 &&
    (membership.endAt === null || compareRfc3339Instants(at, membership.endAt) < 0) &&
    !membership.isSuspended
  );
});
