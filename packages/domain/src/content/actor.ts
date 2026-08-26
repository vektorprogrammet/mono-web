import { allow, deny, type Decision } from "../authz/decision.js";
import type {
  OrganizationAuthorityMembership,
  OrganizationPersonAuthority,
} from "../organization/authority.js";
import type { DepartmentId, PersonId } from "../organization/schema.js";

/** The content actor derived from one Organization projection at one instant. */
export type ContentActor =
  | { readonly _tag: "ContentAdministrator"; readonly personId: PersonId }
  | {
      readonly _tag: "ContentPublisher";
      readonly personId: PersonId;
      readonly departmentIds: ReadonlyArray<DepartmentId>;
    }
  | {
      readonly _tag: "ContentEditor";
      readonly personId: PersonId;
      readonly departmentIds: ReadonlyArray<DepartmentId>;
    };

export type ContentActorDenial = "AuthorityInactive" | "NotInScope";

const compareDepartmentId = (left: DepartmentId, right: DepartmentId): number =>
  left === right ? 0 : left < right ? -1 : 1;

/**
 * Maps the complete Organization projection onto the content actor (spec 0062
 * §Actor model). Pure over its input; leadership never widens scope and an
 * administrator grant never combines with membership scoping.
 */
export const resolveContentActor = (
  authority: OrganizationPersonAuthority,
): Decision<ContentActor> => {
  if (authority.globalAdministrator === "Active") {
    return allow<ContentActor>({ _tag: "ContentAdministrator", personId: authority.personId });
  }
  let hasMembershipRecord = false;
  const activeDepartmentIds = new Set<DepartmentId>();
  for (const membership of authority.memberships as ReadonlyArray<OrganizationAuthorityMembership>) {
    hasMembershipRecord = true;
    if (!membership.active) continue;
    activeDepartmentIds.add(membership.departmentId);
  }
  if (activeDepartmentIds.size === 0) {
    return deny<ContentActor>(hasMembershipRecord ? "AuthorityInactive" : "NotInScope");
  }
  const departmentIds = [...activeDepartmentIds].sort(compareDepartmentId);
  if (authority.memberships.some((membership) => membership.active && membership.teamLeader)) {
    return allow<ContentActor>({
      _tag: "ContentPublisher",
      personId: authority.personId,
      departmentIds,
    });
  }
  return allow<ContentActor>({
    _tag: "ContentEditor",
    personId: authority.personId,
    departmentIds,
  });
};

/** The department intersection a publisher may see and revise. */
export const contentScopeFor = (
  actor: ContentActor,
):
  | { readonly _tag: "All" }
  | { readonly _tag: "DepartmentIds"; readonly departmentIds: ReadonlyArray<DepartmentId> } => {
  switch (actor._tag) {
    case "ContentAdministrator":
      return { _tag: "All" };
    case "ContentPublisher":
      return { _tag: "DepartmentIds", departmentIds: actor.departmentIds };
    case "ContentEditor":
      return { _tag: "All" };
  }
};

/** Whether the actor may set sticky or run publish/unpublish transitions. */
export const canPublishContent = (
  actor: ContentActor,
  articleDepartmentIds: ReadonlyArray<DepartmentId>,
): boolean => {
  if (actor._tag === "ContentAdministrator") return true;
  if (actor._tag !== "ContentPublisher") return false;
  // A leader may not publish org-wide (empty-department) articles.
  if (articleDepartmentIds.length === 0) return false;
  return articleDepartmentIds.some((departmentId) => actor.departmentIds.includes(departmentId));
};

/**
 * Draft ownership boundary (spec 0062): editors revise only their own drafts
 * carrying at least one department within their active memberships; leaders
 * revise any draft scoped to their departments; administrators span all.
 */
export const canReviseDraft = (
  actor: ContentActor,
  draft: {
    readonly createdByPersonId: PersonId;
    readonly currentVersionNumber: number | null;
    readonly departmentIds: ReadonlyArray<DepartmentId>;
  },
): boolean => {
  if (actor._tag === "ContentAdministrator") return true;
  if (actor._tag === "ContentEditor") {
    const editor = actor;
    return (
      draft.createdByPersonId === editor.personId &&
      draft.departmentIds.length > 0 &&
      draft.departmentIds.every((departmentId) =>
        authorityDepartmentIds(actor).includes(departmentId),
      )
    );
  }
  // Publisher: any non-org-wide draft intersecting the leader's departments.
  if (draft.departmentIds.length === 0) return false;
  return draft.departmentIds.some((departmentId) =>
    actor.departmentIds.includes(departmentId as never),
  );
};

const authorityDepartmentIds = (actor: ContentActor): ReadonlyArray<DepartmentId> =>
  actor._tag === "ContentAdministrator" ? [] : actor.departmentIds;
