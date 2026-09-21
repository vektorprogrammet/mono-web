import { Data } from "effect";
import {
  mapOrganizationAuthorityToAdmissionPeriodActor,
  type OrganizationPersonAuthority,
} from "../organization/authority.js";
import type { DepartmentId } from "../organization/schema.js";
import type { Affiliation, OwnAffiliationCommand } from "./schema.js";

export class PlacementFailure extends Data.TaggedError("PlacementFailure")<{
  readonly code:
    | "authority.denied"
    | "resource.not-found"
    | "scope.invalid"
    | "affiliation.transition-invalid"
    | "affiliation.inactive"
    | "placement.overlap"
    | "placement.inactive";
  readonly status: 403 | 404 | 409 | 422;
}> {}

export const canManagePlacements = (
  authority: OrganizationPersonAuthority,
  departmentId: DepartmentId,
): boolean => {
  const decision = mapOrganizationAuthorityToAdmissionPeriodActor(authority, departmentId);
  return decision._tag === "Allow" && decision.value._tag !== "Member";
};

export const nextAffiliationStatus = (
  status: Affiliation["status"],
  action: OwnAffiliationCommand["action"] | "Establish" | "Reject" | "Revoke",
): Affiliation["status"] | null => {
  if (action === "Request" && (status === "Absent" || status === "Inactive")) return "Pending";
  if (action === "Establish" && status === "Pending") return "Active";
  if ((action === "Withdraw" || action === "Reject") && status === "Pending") return "Inactive";
  if (action === "Revoke" && status === "Active") return "Inactive";
  return null;
};
