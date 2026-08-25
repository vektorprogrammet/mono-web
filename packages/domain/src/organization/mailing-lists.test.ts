import { expect, it } from "@effect/vitest";
import { DepartmentId, PersonId } from "./schema.js";
import {
  projectOrganizationMailingLists,
  type MailingListsProjectInput,
} from "./mailing-lists.js";

const departmentA = DepartmentId.make("department-a");
const departmentB = DepartmentId.make("department-b");

const person = (id: string) => PersonId.make(id);

const contactFor = (personId: string, email: string) => [person(personId), { name: personId, email }] as const;

const baseInput = (overrides?: Partial<MailingListsProjectInput>): MailingListsProjectInput => ({
  type: "assistants",
  authorizedDepartmentIds: [departmentA],
  membersByDepartment: new Map(),
  assistantsByDepartment: new Map(),
  contacts: new Map(),
  ...overrides,
});

it("projects assistants-only lists from the assistant-history seam", () => {
  const lists = projectOrganizationMailingLists(
    baseInput({
      assistantsByDepartment: new Map([
        [departmentA, [person("p-2"), person("p-1")]],
      ]),
      contacts: new Map([contactFor("p-1", "one@example.invalid"), contactFor("p-2", "two@example.invalid")]),
    }),
  );
  expect(lists).toEqual([
    { name: `assistants-${departmentA}`, emails: ["one@example.invalid", "two@example.invalid"] },
  ]);
});

it("projects team lists from active memberships", () => {
  const lists = projectOrganizationMailingLists(
    baseInput({
      type: "team",
      membersByDepartment: new Map([[departmentA, [person("t-1")]]]),
      contacts: new Map([contactFor("t-1", "team@example.invalid")]),
    }),
  );
  expect(lists).toEqual([{ name: `team-${departmentA}`, emails: ["team@example.invalid"] }]);
});

it("merges all with assistants-first dedup by person", () => {
  const lists = projectOrganizationMailingLists(
    baseInput({
      type: "all",
      assistantsByDepartment: new Map([[departmentA, [person("shared"), person("a-1")]]]),
      membersByDepartment: new Map([[departmentA, [person("t-9"), person("shared")]]]),
      contacts: new Map([
        contactFor("a-1", "assistant@example.invalid"),
        contactFor("shared", "shared@example.invalid"),
        contactFor("t-9", "teammate@example.invalid"),
      ]),
    }),
  );
  // Members order by personId; shared appears once despite two sources.
  expect(lists).toEqual([
    {
      name: `all-${departmentA}`,
      emails: ["assistant@example.invalid", "shared@example.invalid", "teammate@example.invalid"],
    },
  ]);
});

it("emits an empty list for a department with zero eligible members", () => {
  const lists = projectOrganizationMailingLists(baseInput());
  expect(lists).toEqual([{ name: `assistants-${departmentA}`, emails: [] }]);
});

it("silently drops persons without a resolvable contact profile", () => {
  const lists = projectOrganizationMailingLists(
    baseInput({
      assistantsByDepartment: new Map([[departmentA, [person("with"), person("without")]]]),
      contacts: new Map([contactFor("with", "kept@example.invalid")]),
    }),
  );
  expect(lists).toEqual([{ name: `assistants-${departmentA}`, emails: ["kept@example.invalid"] }]);
});

it("orders lists by name across departments and narrows by requested department", () => {
  const lists = projectOrganizationMailingLists(
    baseInput({
      authorizedDepartmentIds: [departmentB, departmentA],
      assistantsByDepartment: new Map([
        [departmentA, [person("a")]],
        [departmentB, [person("b")]],
      ]),
      contacts: new Map([contactFor("a", "a@example.invalid"), contactFor("b", "b@example.invalid")]),
    }),
  );
  expect(lists.map((list) => list.name)).toEqual([
    `assistants-${departmentA}`,
    `assistants-${departmentB}`,
  ]);

  const narrowed = projectOrganizationMailingLists(
    baseInput({
      authorizedDepartmentIds: [departmentB, departmentA],
      departmentId: departmentB,
      assistantsByDepartment: new Map([
        [departmentA, [person("a")]],
        [departmentB, [person("b")]],
      ]),
      contacts: new Map([contactFor("a", "a@example.invalid"), contactFor("b", "b@example.invalid")]),
    }),
  );
  expect(narrowed.map((list) => list.name)).toEqual([`assistants-${departmentB}`]);
});

it("is deterministic: identical inputs yield byte-identical output (law 2)", () => {
  const input = baseInput({
    type: "all",
    assistantsByDepartment: new Map([[departmentA, [person("z"), person("a")]]]),
    membersByDepartment: new Map([[departmentA, [person("m")]]]),
    contacts: new Map([
      contactFor("z", "z@example.invalid"),
      contactFor("a", "a@example.invalid"),
      contactFor("m", "m@example.invalid"),
    ]),
  });
  expect(JSON.stringify(projectOrganizationMailingLists(input))).toBe(
    JSON.stringify(projectOrganizationMailingLists(input)),
  );
});
