import { deny, allow } from "../authz/decision.js";
import { Predicate } from "effect";
import { describe, expect, it } from "@effect/vitest";
import type { OrganizationPersonAuthority } from "../organization/authority.js";
import { TeamId, MembershipId, DepartmentId, PersonId } from "../organization/schema.js";
import {
  ContentScope,
  canPublishContent,
  canReviseDraft,
  contentScopeFor,
  resolveContentActor,
  ContentActor,
} from "./actor.js";

const editorId = PersonId.make("editor");

const departmentA = DepartmentId.make("department-a");

const departmentB = DepartmentId.make("department-b");

const editor: ContentActor = ContentActor.ContentEditor({
  personId: editorId,
  departmentIds: [departmentA],
});

describe("content editor scope", () => {
  it("allows only the editor's own draft inside an active department", () => {
    expect(
      canReviseDraft(editor, {
        createdByPersonId: editorId,
        currentVersionNumber: null,
        departmentIds: [departmentA],
      }),
    ).toBe(true);
    expect(
      canReviseDraft(editor, {
        createdByPersonId: editorId,
        currentVersionNumber: null,
        departmentIds: [departmentB],
      }),
    ).toBe(false);
    expect(
      canReviseDraft(editor, {
        createdByPersonId: PersonId.make("another-editor"),
        currentVersionNumber: null,
        departmentIds: [departmentA],
      }),
    ).toBe(false);
  });
  it("never grants publish or org-wide revision to a plain member", () => {
    expect(canPublishContent(editor, [departmentA])).toBe(false);
    expect(
      canReviseDraft(editor, {
        createdByPersonId: editorId,
        currentVersionNumber: null,
        departmentIds: [],
      }),
    ).toBe(false);
  });
});

describe("published article revision boundary", () => {
  const published = {
    createdByPersonId: editorId,
    currentVersionNumber: 1,
    departmentIds: [departmentA],
  } as const;

  it("blocks a member while leaders and administrators may revise", () => {
    expect(canReviseDraft(editor, published)).toBe(false);
    expect(
      canReviseDraft(
        ContentActor.ContentPublisher({
          personId: PersonId.make("leader"),
          departmentIds: [departmentA],
        }),
        published,
      ),
    ).toBe(true);
    expect(
      canReviseDraft(
        ContentActor.ContentAdministrator({ personId: PersonId.make("administrator") }),
        published,
      ),
    ).toBe(true);
  });
});

describe("content actor derivation", () => {
  const authority = (
    globalAdministrator: OrganizationPersonAuthority["globalAdministrator"],
    memberships: OrganizationPersonAuthority["memberships"],
  ): OrganizationPersonAuthority => ({
    personId: editorId,
    evaluatedAt: "2030-01-01T00:00:00.000Z",
    globalAdministrator,
    memberships,
    nationalBoardSeats: [],
    delegations: [],
  });

  it("scopes a publisher only to departments where a board leadership reaches", () => {
    const boardLeaderA = {
      membershipId: MembershipId.make("leader-a"),
      teamId: TeamId.make("styret-a"),
      departmentId: departmentA,
      active: true,
      unitLeader: true,
      unitKind: "DepartmentBoard",
      teamScope: "HomeDepartment",
      departmentIndependent: true,
    } as const;

    const memberB = {
      membershipId: MembershipId.make("member-b"),
      teamId: TeamId.make("team-b"),
      departmentId: departmentB,
      active: true,
      unitLeader: false,
      unitKind: "Team",
      teamScope: "HomeDepartment",
      departmentIndependent: true,
    } as const;

    expect(resolveContentActor(authority("Absent", [boardLeaderA, memberB]))).toEqual(
      allow(ContentActor.ContentPublisher({ personId: editorId, departmentIds: [departmentA] })),
    );
    // An ordinary team's leader edits own drafts like any member (O8-11).
    expect(
      resolveContentActor(authority("Absent", [{ ...boardLeaderA, unitKind: "Team" }, memberB])),
    ).toEqual(
      allow(
        ContentActor.ContentEditor({
          personId: editorId,
          departmentIds: [departmentA, departmentB],
        }),
      ),
    );
  });

  it("lets a scoped leader revise and publish only intersecting non-org-wide articles", () => {
    const publisher: ContentActor = ContentActor.ContentPublisher({
      personId: editorId,
      departmentIds: [departmentA],
    });

    const draft = (departmentIds: ReadonlyArray<DepartmentId>) => ({
      createdByPersonId: PersonId.make("another-editor"),
      currentVersionNumber: null,
      departmentIds,
    });

    expect(canReviseDraft(publisher, draft([departmentA]))).toBe(true);
    expect(canReviseDraft(publisher, draft([departmentA, departmentB]))).toBe(true);
    expect(canReviseDraft(publisher, draft([departmentB]))).toBe(false);
    expect(canReviseDraft(publisher, draft([]))).toBe(false);
    expect(canPublishContent(publisher, [departmentA])).toBe(true);
    expect(canPublishContent(publisher, [departmentB])).toBe(false);
    expect(canPublishContent(publisher, [])).toBe(false);
  });

  it("lets an active global administrator span org-wide and department content", () => {
    const decision = resolveContentActor(authority("Active", []));
    expect(decision._tag).toBe("Allow");

    if (Predicate.isTagged(decision, "Deny")) return;

    expect(contentScopeFor(decision.value)).toEqual(ContentScope.All());
    expect(
      canReviseDraft(decision.value, {
        createdByPersonId: PersonId.make("another-editor"),
        currentVersionNumber: 3,
        departmentIds: [],
      }),
    ).toBe(true);
    expect(canPublishContent(decision.value, [])).toBe(true);
    expect(canPublishContent(decision.value, [departmentB])).toBe(true);
  });

  it("keeps membership authority when an administrator grant has ended", () => {
    const decision = resolveContentActor(
      authority("Inactive", [
        {
          membershipId: MembershipId.make("active-member"),
          teamId: TeamId.make("team-a"),
          departmentId: departmentA,
          active: true,
          unitLeader: false,
          unitKind: "Team",
          teamScope: "HomeDepartment",
          departmentIndependent: false,
        },
      ]),
    );

    expect(decision).toEqual(
      allow(ContentActor.ContentEditor({ personId: editorId, departmentIds: [departmentA] })),
    );
    // Without a membership, the ended grant still names the denial.
    expect(resolveContentActor(authority("Inactive", []))).toEqual(deny("AuthorityInactive"));
  });
  it("distinguishes ended memberships from no authority records", () => {
    const ended = resolveContentActor(
      authority("Absent", [
        {
          membershipId: MembershipId.make("ended"),
          teamId: TeamId.make("team-a"),
          departmentId: departmentA,
          active: false,
          unitLeader: true,
          unitKind: "Team",
          teamScope: "HomeDepartment",
          departmentIndependent: false,
        },
      ]),
    );

    expect(ended).toEqual(deny("AuthorityInactive"));
    expect(resolveContentActor(authority("Absent", []))).toEqual(deny("NotInScope"));
  });

  it("keeps editor workspace scope inside active memberships", () => {
    expect(contentScopeFor(editor)).toEqual(
      ContentScope.DepartmentIds({ departmentIds: [departmentA] }),
    );
  });
});
