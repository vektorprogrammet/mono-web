import { Result, Array, Match, Data, Predicate } from "effect";
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

export const ContentActor = Data.taggedEnum<ContentActor>();

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
    return allow<ContentActor>(ContentActor.ContentAdministrator({ personId: authority.personId }));
  }

  if (authority.globalAdministrator === "Inactive") {
    return deny<ContentActor>("AuthorityInactive");
  }

  let hasMembershipRecord = false;
  const activeMemberships: Array<OrganizationAuthorityMembership> = [];

  for (const membership of authority.memberships) {
    hasMembershipRecord = true;

    if (membership.active) activeMemberships.push(membership);
  }

  if (activeMemberships.length === 0) {
    return deny<ContentActor>(hasMembershipRecord ? "AuthorityInactive" : "NotInScope");
  }

  const leaderDepartmentIds = [
    ...new Set(
      Array.filterMap(activeMemberships, (membership) =>
        membership.teamLeader ? Result.succeed(membership.departmentId) : Result.failVoid,
      ),
    ),
  ].sort(compareDepartmentId);

  if (leaderDepartmentIds.length > 0) {
    return allow<ContentActor>(
      ContentActor.ContentPublisher({
        personId: authority.personId,
        departmentIds: leaderDepartmentIds,
      }),
    );
  }

  const departmentIds = [
    ...new Set(activeMemberships.map((membership) => membership.departmentId)),
  ].sort(compareDepartmentId);

  return allow<ContentActor>(
    ContentActor.ContentEditor({ personId: authority.personId, departmentIds }),
  );
};

/** The department intersection a publisher may see and revise. */
export type ContentScope =
  | { readonly _tag: "All" }
  | { readonly _tag: "DepartmentIds"; readonly departmentIds: ReadonlyArray<DepartmentId> };

export const ContentScope = Data.taggedEnum<ContentScope>();

export const contentScopeFor = (actor: ContentActor): ContentScope => {
  return Match.value(actor).pipe(
    Match.withReturnType<ContentScope>(),
    Match.tag("ContentAdministrator", () => {
      return ContentScope.All();
    }),
    Match.tag("ContentPublisher", (actor) => {
      return ContentScope.DepartmentIds({ departmentIds: actor.departmentIds });
    }),
    Match.tag("ContentEditor", (actor) => {
      return ContentScope.DepartmentIds({ departmentIds: actor.departmentIds });
    }),
    Match.exhaustive,
  );
};

/** Whether the actor may set sticky or run publish/unpublish transitions. */
export const canPublishContent = (
  actor: ContentActor,
  articleDepartmentIds: ReadonlyArray<DepartmentId>,
): boolean => {
  if (Predicate.isTagged(actor, "ContentAdministrator")) return true;

  if (!Predicate.isTagged(actor, "ContentPublisher")) return false;

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
  if (Predicate.isTagged(actor, "ContentAdministrator")) return true;

  if (Predicate.isTagged(actor, "ContentEditor")) {
    const editor = actor;

    return (
      draft.currentVersionNumber === null &&
      draft.createdByPersonId === editor.personId &&
      draft.departmentIds.length > 0 &&
      draft.departmentIds.every((departmentId) =>
        authorityDepartmentIds(actor).includes(departmentId),
      )
    );
  }

  // Publisher: any non-org-wide draft intersecting the leader's departments.
  if (draft.departmentIds.length === 0) return false;

  return draft.departmentIds.some((departmentId) => actor.departmentIds.includes(departmentId));
};

const authorityDepartmentIds = (actor: ContentActor): ReadonlyArray<DepartmentId> =>
  Predicate.isTagged(actor, "ContentAdministrator") ? [] : actor.departmentIds;
