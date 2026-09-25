import { Predicate, Data } from "effect";
import type { SubstituteCommand, SubstituteEntry } from "./schema.js";
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

/** Returns the existing lifecycle rejection, or null when the command is legal. */
export const substituteCommandFailure = (
  entry: SubstituteEntry,
  command: SubstituteCommand,
): SubstituteFailure | null => {
  if (command.action === "activate" && entry.active)
    return new SubstituteFailure({ code: "substitute.already-active", status: 400 });

  if (command.action !== "activate" && !entry.active)
    return new SubstituteFailure({ code: "substitute.inactive", status: 400 });

  return null;
};

/** Uses the canonical mapper, so multi-membership and ended-grant semantics match admission. */
export const substitutePermission = (
  authority: OrganizationPersonAuthority,
  departmentId: DepartmentId,
): "Denied" | "ReadOnly" | "Manage" => {
  const decision = mapOrganizationAuthorityToAdmissionPeriodActor(authority, departmentId);

  return Predicate.isTagged(decision, "Deny")
    ? "Denied"
    : Predicate.isTagged(decision.value, "Member")
      ? "ReadOnly"
      : "Manage";
};
