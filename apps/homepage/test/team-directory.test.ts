import {
  DepartmentJsonSchema,
  TeamApplicationIntakeListItem,
  TeamJsonSchema,
} from "@vektorprogrammet/http-api";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { contactDepartmentSlug } from "../src/lib/contact-message";
import { projectTeamDirectory } from "../src/lib/team-directory";

const department = (overrides: Partial<typeof DepartmentJsonSchema.Encoded> = {}) =>
  Schema.decodeSync(DepartmentJsonSchema)({
    departmentId: "department-aas",
    name: "Vektorprogrammet Ås",
    shortName: "Ås",
    email: "aas@example.com",
    address: null,
    city: "Ås",
    latitude: null,
    longitude: null,
    slackChannel: null,
    logoPath: null,
    active: true,
    revision: 0,
    ...overrides,
  });

const team = (overrides: Partial<typeof TeamJsonSchema.Encoded> = {}) =>
  Schema.decodeSync(TeamJsonSchema)({
    teamId: "team-it",
    departmentId: "department-aas",
    name: "IT",
    email: "it@example.com",
    description: null,
    shortDescription: "Utvikler nettsiden.",
    acceptApplication: true,
    deadline: null,
    active: true,
    revision: 0,
    ...overrides,
  });

const intake = (overrides: Partial<typeof TeamApplicationIntakeListItem.Encoded> = {}) =>
  Schema.decodeSync(TeamApplicationIntakeListItem)({
    teamId: "team-it",
    open: true,
    deadline: null,
    ...overrides,
  });

describe("team directory projection", () => {
  it("links only a team whose intake read reports it open", () => {
    const deadline = "2031-09-30T21:59:00.000Z";

    const directory = projectTeamDirectory(
      [department()],
      [
        team({ teamId: "it/ås 1", name: "IT" }),
        team({ teamId: "team-closed", name: "Økonomi", deadline }),
        team({ teamId: "team-unlisted", name: "Sosialt" }),
      ],
      [
        intake({ teamId: "it/ås 1", deadline }),
        intake({ teamId: "team-closed", open: false, deadline }),
      ],
    );

    expect(directory?.intakeAvailable).toBe(true);
    expect(
      directory?.departments[0]?.teams.map(({ name, applyHref, deadline }) => ({
        name,
        applyHref,
        deadline,
      })),
    ).toEqual([
      { name: "IT", applyHref: "/team/it%2F%C3%A5s%201/soknad", deadline },
      { name: "Økonomi", applyHref: null, deadline: null },
      { name: "Sosialt", applyHref: null, deadline: null },
    ]);
  });

  it("links no team when the intake read failed", () => {
    const directory = projectTeamDirectory([department()], [team()], null);

    expect(directory?.intakeAvailable).toBe(false);
    expect(directory?.departments[0]?.teams).toMatchObject([
      { teamId: "team-it", applyHref: null, deadline: null },
    ]);
  });

  it("keeps only active teams of active departments", () => {
    const directory = projectTeamDirectory(
      [
        department(),
        department({
          departmentId: "department-bergen",
          name: "Vektorprogrammet Bergen",
          shortName: "Bergen",
          active: false,
        }),
      ],
      [
        team({ teamId: "team-active" }),
        team({ teamId: "team-inactive", active: false }),
        team({ teamId: "team-bergen", departmentId: "department-bergen" }),
      ],
      [
        intake({ teamId: "team-active" }),
        intake({ teamId: "team-inactive" }),
        intake({ teamId: "team-bergen" }),
      ],
    );

    expect(directory?.departments.map(({ departmentId }) => departmentId)).toEqual([
      "department-aas",
    ]);
    expect(directory?.departments[0]?.teams.map(({ teamId }) => teamId)).toEqual(["team-active"]);
  });

  it("routes a department by the contact page slug", () => {
    const aas = department();

    expect(projectTeamDirectory([aas], [], [])?.departments[0]?.slug).toBe(
      contactDepartmentSlug(aas),
    );
  });

  it("refuses active departments that share or lack a route slug", () => {
    const aas = department();
    const ambiguous = { departmentId: "department-aas-2", shortName: "Aas" };

    expect(projectTeamDirectory([aas, department(ambiguous)], [], [])).toBeUndefined();
    expect(projectTeamDirectory([department({ shortName: "!!!" })], [], [])).toBeUndefined();
    expect(
      projectTeamDirectory([aas, department({ ...ambiguous, active: false })], [], []),
    ).toBeDefined();
  });
});
