import { Data } from "effect";
import {
  mapOrganizationAuthorityToAdmissionPeriodActor,
  type OrganizationPersonAuthority,
} from "../organization/authority.js";
import type { DepartmentId } from "../organization/schema.js";

export class SubstituteFailure extends Data.TaggedError("SubstituteFailure")<{
  readonly code:
    | "authority.denied"
    | "resource.not-found"
    | "substitute.already-active"
    | "substitute.inactive"
    | "scope.invalid";
  readonly status: 400 | 403 | 404 | 422;
}> {}

/** Uses the canonical mapper, including inactive administrator and multi-membership semantics. */
export const substitutePermission = (
  authority: OrganizationPersonAuthority,
  departmentId: DepartmentId,
): "Denied" | "ReadOnly" | "Manage" => {
  const decision = mapOrganizationAuthorityToAdmissionPeriodActor(authority, departmentId);
  return decision._tag === "Deny"
    ? "Denied"
    : decision.value._tag === "Member"
      ? "ReadOnly"
      : "Manage";
};

