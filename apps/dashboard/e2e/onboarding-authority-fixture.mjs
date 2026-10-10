import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { admissionJourneyClock } from "../../../tools/e2e/journey-clock.ts";

// Used only by the registered onboarding driver, against its private disposable database.
export const seedOnboardingAuthority = async (pool, environment, departmentId) => {
  const { fromNow } = admissionJourneyClock();
  const start = fromNow(-20);
  const ended = fromNow(-1);
  const future = fromNow(20);
  const roles = ["current", "ended", "wrongDepartment", "member", "global"];

  const persons = Object.fromEntries(roles.map((role) => [role, {
    personId: `onboarding-r6-${role}`,
    firstName: "Onboarding", lastName: role,
    email: `onboarding-r6-${role.toLowerCase()}@example.invalid`,
    password: "synthetic-onboarding-r6-password",
  }]));

  const seeded = spawnSync("bun", ["run", "identity:seed"], {
    cwd: fileURLToPath(new URL("../../../packages/database/", import.meta.url)),
    env: { ...environment, IDENTITY_SEED_PG_URL: environment.JOURNEY_SEED_PG_URL,
      IDENTITY_SEED_PERSONS: JSON.stringify(Object.values(persons)) },
    encoding: "utf8",
  });

  assert.equal(seeded.status, 0, "R6 identity fixture must use real native password accounts");
  const otherDepartmentId = "onboarding-r6-other-department";
  await pool.query(`INSERT INTO organization_departments
    (department_id,name,short_name,email,city,active,independent,revision)
    VALUES($1,'R6 Other department','R6 Other','r6-other@example.invalid','Other',true,true,0)`,
  [otherDepartmentId]);

  for (const [index, role] of roles.entries()) {
    const person = persons[role];
    const home = role === "wrongDepartment" ? otherDepartmentId : departmentId;
    const teamId = `onboarding-r6-${role}-team`;
    await pool.query(`INSERT INTO person_contact_profiles(person_id,email,phone,revision)
      VALUES($1,$2,'12345678',0) ON CONFLICT(person_id) DO NOTHING`, [person.personId, person.email]);
    await pool.query(`INSERT INTO organization_teams(team_id,department_id,name,kind,active,revision)
      VALUES($1,$2,$3,'Team',true,0)`, [teamId, home, `R6 ${role}`]);
    await pool.query(`INSERT INTO organization_memberships
      (membership_id,person_id,team_id,start_at,position_id,is_team_leader,is_suspended,revision)
      VALUES($1,$2,$3,$4,'member',false,false,0)`,
    [`onboarding-r6-${role}-membership`, person.personId, teamId, start]);

    if (["current", "ended", "wrongDepartment"].includes(role)) {
      // Onboarding's generic issuance reach is admissions.outcomes, not outcome-decide/announce
      // delegation and not placements.coordinate. This does not grant placement management.
      await pool.query(`INSERT INTO organization_delegations
        (delegation_id,name,team_id,capability,area,area_department_id,holders,start_at,end_at,revision)
        VALUES($1,$2,$3,'admissions.outcomes','Department',$4,'AllMembers',$5,$6,0)`,
      [`delegation-${String(index + 1).repeat(64)}`, `R6 issuance ${role}`, teamId, home,
        start, role === "ended" ? ended : future]);
    }

    if (role === "global") {
      await pool.query(`INSERT INTO organization_global_administrator_grants
        (grant_id,person_id,start_at,revision) VALUES('onboarding-r6-global-grant',$1,$2,0)`,
      [person.personId, start]);
    }
  }

  const counts = await pool.query(`SELECT
    (SELECT count(*)::int FROM auth."user" WHERE id = ANY($1::text[])) AS users,
    (SELECT count(*)::int FROM organization_delegations WHERE team_id LIKE 'onboarding-r6-%'
      AND capability='placements.coordinate') AS placement_delegations,
    (SELECT count(*)::int FROM organization_memberships WHERE person_id=$2
      AND position_id='interviewer') AS member_interviewer_appointments`,
  [Object.values(persons).map((person) => person.personId), persons.member.personId]);

  assert.equal(counts.rows[0].users, 5);
  assert.equal(counts.rows[0].placement_delegations, 0);
  assert.equal(counts.rows[0].member_interviewer_appointments, 0);

  return { persons, otherDepartmentId };
};
