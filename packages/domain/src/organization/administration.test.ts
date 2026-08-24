import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import {
  CreateFieldOfStudyCommandSchema,
  CreateTeamCommandSchema,
  OrganizationCommandId,
} from "./administration-schema.js";
import {
  authorizeOrganizationActor,
  decodeCreateDepartmentCommand,
  departmentIdForCommand,
  fieldOfStudyIdForCommand,
  organizationCommandDigest,
  organizationEntityDigest,
  teamIdForCommand,
} from "./administration.js";
import { Department, FieldOfStudy, PersonId, Team } from "./schema.js";

const keys = (fields: object): ReadonlyArray<string> => Object.keys(fields).sort();

const departmentCommand = {
  _tag: "CreateDepartment" as const,
  commandId: OrganizationCommandId.make("organization-domain-department-command"),
  name: "Department of Domain Tests",
  shortName: "DDT",
  email: "domain@example.invalid",
  address: null,
  city: "Bergen",
  latitude: null,
  longitude: null,
};

it("derives native create and update variants from canonical Organization Models", () => {
  expect(keys(Department.jsonCreate.fields)).toEqual([
    "address",
    "city",
    "email",
    "latitude",
    "longitude",
    "name",
    "shortName",
  ]);
  expect(keys(Department.jsonUpdate.fields)).toEqual([
    "active",
    "address",
    "city",
    "email",
    "latitude",
    "logoPath",
    "longitude",
    "name",
    "shortName",
    "slackChannel",
  ]);
  expect(keys(Team.jsonCreate.fields)).toEqual([
    "acceptApplication",
    "active",
    "deadline",
    "departmentId",
    "description",
    "email",
    "name",
    "shortDescription",
  ]);
  expect(keys(Team.jsonUpdate.fields)).not.toContain("departmentId");
  expect(keys(FieldOfStudy.fields)).toEqual([
    "active",
    "departmentId",
    "fieldOfStudyId",
    "name",
    "revision",
    "shortName",
  ]);
  expect(keys(FieldOfStudy.insert.fields)).toEqual([
    "active",
    "departmentId",
    "fieldOfStudyId",
    "name",
    "shortName",
  ]);
  expect(keys(FieldOfStudy.update.fields)).toEqual(["active", "name", "shortName"]);
  expect(keys(FieldOfStudy.json.fields)).toEqual([
    "active",
    "departmentId",
    "fieldOfStudyId",
    "name",
    "revision",
    "shortName",
  ]);
  expect(keys(FieldOfStudy.jsonCreate.fields)).toEqual(["departmentId", "name", "shortName"]);
  expect(keys(FieldOfStudy.jsonUpdate.fields)).toEqual(["active", "name", "shortName"]);
});

it.effect("strictly decodes every create command and rejects generated or unknown fields", () =>
  Effect.gen(function* () {
    const decodedDepartment = yield* decodeCreateDepartmentCommand(departmentCommand);
    expect(decodedDepartment).toEqual(departmentCommand);

    const unknown = yield* Effect.flip(
      decodeCreateDepartmentCommand({ ...departmentCommand, departmentId: "caller-selected" }),
    );
    expect(unknown._tag).toBe("OrganizationDecodeError");
    expect(unknown.message).toContain("departmentId");

    yield* Schema.decodeUnknownEffect(CreateTeamCommandSchema)(
      {
        _tag: "CreateTeam",
        commandId: "organization-domain-team-command",
        departmentId: "department-reference",
        name: "Team",
        email: null,
        description: null,
        shortDescription: null,
        acceptApplication: null,
        deadline: null,
        active: true,
      },
      { onExcessProperty: "error" },
    );
    yield* Schema.decodeUnknownEffect(CreateFieldOfStudyCommandSchema)(
      {
        _tag: "CreateFieldOfStudy",
        commandId: "organization-domain-field-command",
        name: "Computer Science",
        shortName: "CS",
        departmentId: null,
      },
      { onExcessProperty: "error" },
    );

    const generated = yield* Effect.exit(
      Schema.decodeUnknownEffect(CreateFieldOfStudyCommandSchema)(
        {
          _tag: "CreateFieldOfStudy",
          commandId: "organization-domain-field-generated-command",
          name: "Physics",
          shortName: "PHY",
          departmentId: null,
          active: false,
          revision: 4,
        },
        { onExcessProperty: "error" },
      ),
    );
    expect(generated._tag).toBe("Failure");
  }),
);

it("derives stable, kind-separated IDs from the complete SHA-256 digest", () => {
  const commandId = departmentCommand.commandId;
  const departmentId = departmentIdForCommand(commandId);
  const teamId = teamIdForCommand(commandId);
  const fieldOfStudyId = fieldOfStudyIdForCommand(commandId);

  expect(departmentId).toBe(`department-${organizationEntityDigest("Department", commandId)}`);
  expect(departmentId).toBe(
    "department-6e6c26388ef84be972f09a7c0b500c1b506e03eb440b84a604f1c75bb7859339",
  );
  expect(teamId).toBe(`team-${organizationEntityDigest("Team", commandId)}`);
  expect(fieldOfStudyId).toBe(
    `field-of-study-${organizationEntityDigest("FieldOfStudy", commandId)}`,
  );
  expect(departmentId).toMatch(/^department-[a-f0-9]{64}$/);
  expect(teamId).toMatch(/^team-[a-f0-9]{64}$/);
  expect(fieldOfStudyId).toMatch(/^field-of-study-[a-f0-9]{64}$/);
  expect(departmentId).not.toBe(teamId);
  expect(departmentId).not.toBe(fieldOfStudyId);
  expect(teamId).not.toBe(fieldOfStudyId);
  expect(departmentIdForCommand(commandId)).toBe(departmentId);

  const reordered = {
    longitude: null,
    latitude: null,
    city: departmentCommand.city,
    address: null,
    email: departmentCommand.email,
    shortName: departmentCommand.shortName,
    name: departmentCommand.name,
    commandId,
    _tag: "CreateDepartment" as const,
  };
  expect(organizationCommandDigest(departmentCommand)).toBe(
    organizationCommandDigest(reordered),
  );
  expect(organizationCommandDigest({ ...departmentCommand, name: "Changed" })).not.toBe(
    organizationCommandDigest(departmentCommand),
  );
});

it.effect("allows administrators and returns a typed denial for members", () =>
  Effect.gen(function* () {
    const personId = PersonId.make("organization-domain-actor");
    yield* authorizeOrganizationActor({
      _tag: "OrganizationAdministrator",
      personId,
    });
    const denied = yield* Effect.flip(
      authorizeOrganizationActor({ _tag: "OrganizationMember", personId }),
    );
    expect(denied._tag).toBe("OrganizationRoleDenied");
    expect(denied.actorPersonId).toBe(personId);
    expect(denied.requiredRole).toBe("OrganizationAdministrator");
  }),
);
