import type { DepartmentId, PersonId, SemesterId } from "./schema.js";
import { compareRfc3339Instants } from "../time.js";

/**
 * Spec 0060: the native mailing-list projection. Pure derivation over injected
 * member rows and Profile contacts — zero persistence, no ambient lookups,
 * one authorizationInstant already applied by whoever produced the inputs.
 */

export type MailingListType = "assistants" | "team" | "all";

/** Profile contact read result keyed by person identity. */
export interface MailingListContact {
  readonly name: string;
  readonly email: string;
}

export interface MailingListsProjectInput {
  readonly type: MailingListType;
  readonly authorizedDepartmentIds: ReadonlyArray<DepartmentId>;
  readonly departmentId?: DepartmentId;
  readonly semesterId?: SemesterId;
  /** Team members active across the requested semester, grouped by department. */
  readonly membersByDepartment: ReadonlyMap<DepartmentId, ReadonlyArray<PersonId>>;
  /** Assistant-history facts grouped by department (Admissions-owned source seam). */
  readonly assistantsByDepartment: ReadonlyMap<DepartmentId, ReadonlyArray<PersonId>>;
  readonly contacts: ReadonlyMap<PersonId, MailingListContact>;
}

export interface MailingList {
  readonly name: string;
  readonly emails: ReadonlyArray<string>;
}

/**
 * A half-open membership interval covers a semester when it started at or
 * before the semester's end and has not ended before the semester's start.
 */
export const membershipCoversSemester = (
  membership: { readonly startAt: string; readonly endAt: string | null },
  semester: { readonly startAt: string; readonly endAt: string },
): boolean =>
  compareRfc3339Instants(membership.startAt, semester.endAt) <= 0 &&
  (membership.endAt === null || compareRfc3339Instants(semester.startAt, membership.endAt) <= 0);

const mergeFirstSeen = (
  assistants: ReadonlyArray<PersonId>,
  teamMembers: ReadonlyArray<PersonId>,
): ReadonlyArray<PersonId> => {
  const seen = new Set<string>();
  const merged: Array<PersonId> = [];
  for (const person of [...assistants, ...teamMembers]) {
    const key = String(person);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(person);
  }
  return merged;
};

export const projectOrganizationMailingLists = (
  input: MailingListsProjectInput,
): ReadonlyArray<MailingList> => {
  const scopedDepartments =
    input.departmentId === undefined
      ? input.authorizedDepartmentIds
      : input.authorizedDepartmentIds.filter((authorized) => authorized === input.departmentId);

  const lists: Array<MailingList> = [];
  for (const departmentId of scopedDepartments) {
    const teamMembers = input.membersByDepartment.get(departmentId) ?? [];
    const assistants = input.assistantsByDepartment.get(departmentId) ?? [];
    let selected: ReadonlyArray<PersonId>;
    switch (input.type) {
      case "assistants":
        selected = [...assistants];
        break;
      case "team":
        selected = [...teamMembers];
        break;
      case "all":
        selected = mergeFirstSeen(assistants, teamMembers);
        break;
    }
    const ordered = [...selected].sort((left, right) => String(left).localeCompare(String(right)));
    const seenEmails = new Set<string>();
    const emails: Array<string> = [];
    for (const personId of ordered) {
      const contact = input.contacts.get(personId);
      if (contact === undefined) continue;
      if (seenEmails.has(contact.email)) continue;
      seenEmails.add(contact.email);
      emails.push(contact.email);
    }
    lists.push({ name: `${input.type}-${departmentId}`, emails });
  }
  return lists.sort((left, right) => left.name.localeCompare(right.name));
};
