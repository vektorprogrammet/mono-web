import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import {
  CreateDepartmentCommandSchema,
  OrganizationMemberSchema,
  OrganizationAdministratorSchema,
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
import { DepartmentId, PersonId } from "./schema.js";

const departmentCommand = CreateDepartmentCommandSchema.make({
  commandId: OrganizationCommandId.make("organization-domain-department-command"),
  name: "Department of Domain Tests",
  shortName: "DDT",
  email: "domain@example.invalid",
  address: null,
  city: "Bergen",
  latitude: null,
  longitude: null,
});

it.effect("strictly decodes every create command and rejects generated or unknown fields", () =>
  Effect.gen(function* () {
    const decodedDepartment = yield* decodeCreateDepartmentCommand(departmentCommand);
    expect(decodedDepartment).toEqual(departmentCommand);

    const unknown = yield* Effect.flip(
      decodeCreateDepartmentCommand({
        ...departmentCommand,
        departmentId: DepartmentId.make("caller-selected"),
      }),
    );

    expect(unknown._tag).toBe("OrganizationDecodeError");
    expect(unknown.message).toContain("departmentId");

    yield* Schema.decodeUnknownEffect(CreateTeamCommandSchema)(
      CreateTeamCommandSchema.make({
        commandId: OrganizationCommandId.make("organization-domain-team-command"),
        departmentId: DepartmentId.make("department-reference"),
        name: "Team",
        email: null,
        description: null,
        shortDescription: null,
        acceptApplication: null,
        deadline: null,
        active: true,
      }),
      { onExcessProperty: "error" },
    );
    yield* Schema.decodeUnknownEffect(CreateFieldOfStudyCommandSchema)(
      CreateFieldOfStudyCommandSchema.make({
        commandId: OrganizationCommandId.make("organization-domain-field-command"),
        name: "Computer Science",
        shortName: "CS",
        departmentId: null,
      }),
      { onExcessProperty: "error" },
    );

    const generated = yield* Effect.exit(
      Schema.decodeUnknownEffect(CreateFieldOfStudyCommandSchema)(
        {
          ...CreateFieldOfStudyCommandSchema.make({
            commandId: OrganizationCommandId.make("organization-domain-field-generated-command"),
            name: "Physics",
            shortName: "PHY",
            departmentId: null,
          }),
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

  const reordered = Object.fromEntries(Object.entries(departmentCommand).toReversed());

  if (!Schema.is(CreateDepartmentCommandSchema)(reordered))
    throw new TypeError("Invalid reordered department command");

  expect(organizationCommandDigest(departmentCommand)).toBe(organizationCommandDigest(reordered));
  expect(organizationCommandDigest({ ...departmentCommand, name: "Changed" })).not.toBe(
    organizationCommandDigest(departmentCommand),
  );
});

it.effect("allows administrators and returns a typed denial for members", () =>
  Effect.gen(function* () {
    const personId = PersonId.make("organization-domain-actor");
    yield* authorizeOrganizationActor(OrganizationAdministratorSchema.make({ personId }));

    const denied = yield* Effect.flip(
      authorizeOrganizationActor(OrganizationMemberSchema.make({ personId })),
    );

    expect(denied._tag).toBe("OrganizationRoleDenied");
    expect(denied.actorPersonId).toBe(personId);
    expect(denied.requiredRole).toBe("OrganizationAdministrator");
  }),
);
