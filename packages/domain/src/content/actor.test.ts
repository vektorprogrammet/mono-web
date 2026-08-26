import { describe, expect, it } from "@effect/vitest";
import type { DepartmentId, PersonId } from "../organization/schema.js";
import { canReviseDraft, type ContentActor } from "./actor.js";

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
});
