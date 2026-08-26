import { describe, expect, it } from "@effect/vitest";
import type { OrganizationPersonAuthority } from "../organization/authority.js";
import type { DepartmentId, PersonId } from "../organization/schema.js";
import {
  canPublishContent,
  canReviseDraft,
  contentScopeFor,
  resolveContentActor,
  type ContentActor,
} from "./actor.js";

const editorId = "editor" as PersonId;
const departmentA = "department-a" as DepartmentId;
const departmentB = "department-b" as DepartmentId;
const editor: ContentActor = {
  _tag: "ContentEditor",
  personId: editorId,
  departmentIds: [departmentA],
};

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
        createdByPersonId: "another-editor" as PersonId,
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

describe("content actor derivation", () => {
  const authority = (
    globalAdministrator: OrganizationPersonAuthority["globalAdministrator"],
    memberships: OrganizationPersonAuthority["memberships"],
  ): OrganizationPersonAuthority => ({
    personId: editorId,
    evaluatedAt: "2030-01-01T00:00:00.000Z" as OrganizationPersonAuthority["evaluatedAt"],
    globalAdministrator,
    memberships,
  });

  it("scopes a publisher only to departments where the active membership is leadership", () => {
    const decision = resolveContentActor(
      authority("Absent", [
        {
          membershipId: "leader-a" as never,
          teamId: "team-a" as never,
          departmentId: departmentA,
          active: true,
          teamLeader: true,
        },
        {
          membershipId: "member-b" as never,
          teamId: "team-b" as never,
          departmentId: departmentB,
          active: true,
          teamLeader: false,
        },
      ]),
    );

    expect(decision).toEqual({
      _tag: "Allow",
      value: {
        _tag: "ContentPublisher",
        personId: editorId,
        departmentIds: [departmentA],
      },
    });
  });
  it("lets a scoped leader revise and publish only intersecting non-org-wide articles", () => {
    const publisher: ContentActor = {
      _tag: "ContentPublisher",
      personId: editorId,
      departmentIds: [departmentA],
    };
    const draft = (departmentIds: ReadonlyArray<DepartmentId>) => ({
      createdByPersonId: "another-editor" as PersonId,
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
    if (decision._tag === "Deny") return;

    expect(contentScopeFor(decision.value)).toEqual({ _tag: "All" });
    expect(
      canReviseDraft(decision.value, {
        createdByPersonId: "another-editor" as PersonId,
        currentVersionNumber: 3,
        departmentIds: [],
      }),
    ).toBe(true);
    expect(canPublishContent(decision.value, [])).toBe(true);
    expect(canPublishContent(decision.value, [departmentB])).toBe(true);
  });

  it("denies an inactive administrator grant instead of widening through memberships", () => {
    const decision = resolveContentActor(
      authority("Inactive", [
        {
          membershipId: "active-member" as never,
          teamId: "team-a" as never,
          departmentId: departmentA,
          active: true,
          teamLeader: false,
        },
      ]),
    );

    expect(decision).toEqual({ _tag: "Deny", reason: "AuthorityInactive" });
  });
  it("distinguishes ended memberships from no authority records", () => {
    const ended = resolveContentActor(
      authority("Absent", [
        {
          membershipId: "ended" as never,
          teamId: "team-a" as never,
          departmentId: departmentA,
          active: false,
          teamLeader: true,
        },
      ]),
    );
    expect(ended).toEqual({ _tag: "Deny", reason: "AuthorityInactive" });
    expect(resolveContentActor(authority("Absent", []))).toEqual({
      _tag: "Deny",
      reason: "NotInScope",
    });
  });

  it("keeps editor workspace scope inside active memberships", () => {
    expect(contentScopeFor(editor)).toEqual({
      _tag: "DepartmentIds",
      departmentIds: [departmentA],
    });
  });
});
