// Run with `node --test`: the Oxlint RuleTester parses through raw transfer, which Bun lacks.
import { describe, it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";

import { noLeadershipReachRule } from "./no-leadership-reach.ts";

RuleTester.describe = describe;
RuleTester.it = it;

new RuleTester().run("no-leadership-reach", noLeadershipReachRule, {
  valid: [
    // Negative controls: the interpreter's questions, and the words in other roles.
    'reaches(authority, "admissions.periods", ReachTarget.Department({ departmentId }))',
    "const leader = persons.leader",
    "const unitLeader = true",
    'const row = { unitLeader: false, unitKind: "Team" }',
    "sql`SELECT membership.is_suspended FROM organization_memberships AS membership`",
  ],
  invalid: [
    {
      code: "authority.memberships.some((membership) => membership.active && membership.unitLeader)",
      errors: [{ messageId: "leadershipRead" }],
    },
    {
      code: "const departments = memberships.flatMap(({ unitLeader, departmentId }) => unitLeader ? [departmentId] : [])",
      errors: [{ messageId: "leadershipRead" }],
    },
    {
      code: "sql`SELECT 1 FROM organization_memberships WHERE is_team_leader`",
      errors: [{ messageId: "leadershipRead" }],
    },
    {
      code: 'pool.query("SELECT is_team_leader FROM organization_memberships")',
      errors: [{ messageId: "leadershipRead" }],
    },
  ],
});
