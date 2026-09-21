/** Spec 0092 component check only; does not run the complete preview scenario. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { DatabaseLive } from "../../packages/database/src/layers.js";
import { OrganizationLive } from "@vektorprogrammet/database/organization";
import { Organization } from "../../packages/domain/src/organization/service.js";
import { PersonId } from "../../packages/domain/src/organization/schema.js";
import { OrganizationCommandId } from "../../packages/domain/src/organization/administration-schema.js";
import {
  assertDisposablePostgresUrl,
  assertPreviewScenarioCompatibility,
  assertUniqueContactDepartmentSlugs,
  nativePreviewDepartmentCommands,
  nativePreviewTeamCommand,
  prepareDisposableScenarioTarget,
} from "./preview-scenario.js";

const requireDatabase = createRequire(
  new URL("../../packages/database/package.json", import.meta.url),
);
const { Effect, Layer, Redacted } = requireDatabase("effect");
const { Pool } = requireDatabase("pg");
const url = process.argv[2];
assert.ok(url, "explicit disposable PostgreSQL URL required");
assertDisposablePostgresUrl(url);
const pool = new Pool({ connectionString: url, max: 1 });
try {
  const initial = await pool.query(
    "SELECT to_regclass('public.organization_departments') AS relation",
  );
  assert.equal(initial.rows[0].relation, null, "component check requires a fresh owned database");
  await assertPreviewScenarioCompatibility(pool);
  const organizationLayer = OrganizationLive.pipe(
    Layer.provide(DatabaseLive({ url: Redacted.make(url), maxConnections: 1 })),
  );
  const actor = {
    _tag: "OrganizationAdministrator",
    personId: PersonId.make("component-0092"),
  } as const;
  const run = (operation: ReturnType<typeof Organization.use>) =>
    Effect.runPromise(operation.pipe(Effect.provide(organizationLayer)));
  const readDepartments = () =>
    run(Organization.use((organization) => organization.listDepartments));
  const imported = await run(
    Organization.use((organization) =>
      organization.importLegacyOrganization({
        sourceRepository: "component-0092",
        sourceRevision: "1",
        snapshotId: "component-0092",
        transformationRevision: "1",
        departments: [
          {
            id: 1,
            name: "Trondheim",
            shortName: "Trondheim",
            email: "trondheim@example.invalid",
            city: "Trondheim",
            active: true,
          },
        ],
        teams: [],
        memberships: [],
      }),
    ),
  );
  assert.equal(imported.quarantined.length, 0);
  for (const command of nativePreviewDepartmentCommands) {
    const created = await run(
      Organization.use((organization) => organization.createDepartment(command, actor)),
    );
    assert.equal(created.committed, true);
  }
  const team = await run(
    Organization.use((organization) => organization.createTeam(nativePreviewTeamCommand, actor)),
  );
  assert.equal(team.committed, true);
  const departments = await readDepartments();
  assert.equal(departments.length, 4);
  assert.ok(
    departments.some((department: { departmentId: string }) => department.departmentId === "1"),
  );
  assertUniqueContactDepartmentSlugs(departments);
  for (const command of nativePreviewDepartmentCommands) {
    const replay = await run(
      Organization.use((organization) => organization.createDepartment(command, actor)),
    );
    assert.equal(replay.committed, false);
  }
  const teamReplay = await run(
    Organization.use((organization) => organization.createTeam(nativePreviewTeamCommand, actor)),
  );
  assert.equal(teamReplay.committed, false);
  assert.deepEqual(await readDepartments(), departments);
  await assertPreviewScenarioCompatibility(pool);
  const columns = await pool.query(`SELECT column_name, data_type FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'organization_command_receipts' AND column_name = 'command_id'`);
  assert.deepEqual(columns.rows, [{ column_name: "command_id", data_type: "text" }]);

  // Previous command authority is deliberately introduced only in this owned fixture.
  const previous = {
    ...nativePreviewDepartmentCommands[0]!,
    commandId: OrganizationCommandId.make("preview-0072-dept-ntnu-cmd"),
    name: "Trondheim",
    shortName: "Trondheim",
    email: "trondheim@example.invalid",
  };
  const profilesBefore = await pool.query(
    "SELECT * FROM public.person_profiles ORDER BY person_id",
  );
  const assertRejectedBeforeSeed = async (marker: "department row" | "command receipt") => {
    await assert.rejects(prepareDisposableScenarioTarget(url), {
      message: new RegExp(
        `^incompatible pre-0092 preview scenario: ${marker}; no mutation performed(?:\\n|$)`,
      ),
    });
    const profilesAfter = await pool.query(
      "SELECT * FROM public.person_profiles ORDER BY person_id",
    );
    assert.deepEqual(profilesAfter.rows, profilesBefore.rows);
  };
  // A superseded team receipt is incompatible even without the old department.
  await run(
    Organization.use((organization) =>
      organization.createTeam(
        {
          ...nativePreviewTeamCommand,
          commandId: OrganizationCommandId.make("preview-0072-team-rekruttering-command"),
        },
        actor,
      ),
    ),
  );
  await assertRejectedBeforeSeed("command receipt");
  await run(Organization.use((organization) => organization.createDepartment(previous, actor)));
  await assertRejectedBeforeSeed("department row");
  process.stdout.write(
    JSON.stringify({
      component: "0092",
      activeDepartments: departments.map(
        (department: { shortName: string }) => department.shortName,
      ),
      commandReplay: true,
      oldRowRejectedBeforeSeed: true,
      oldReceiptRejectedBeforeSeed: true,
      commandIdColumn: columns.rows[0],
      fullScenarioVerified: false,
    }) + "\n",
  );
} finally {
  await pool.end();
}
