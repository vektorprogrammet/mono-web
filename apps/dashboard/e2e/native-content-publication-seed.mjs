import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const databaseRoot = fileURLToPath(new URL("../../../packages/database/", import.meta.url));
const databaseRequire = createRequire(
  new URL("../../../packages/database/package.json", import.meta.url),
);
const { Pool } = databaseRequire("pg");
const postgresUrl = process.env.CONTENT_E2E_PG_URL;
const dashboardOrigin = process.env.CONTENT_E2E_DASHBOARD_ORIGIN ?? "http://127.0.0.1:45261";
if (postgresUrl === undefined) throw new Error("CONTENT_E2E_PG_URL is required");

const parsedUrl = new URL(postgresUrl);
assert.ok(
  parsedUrl.protocol === "postgres:" || parsedUrl.protocol === "postgresql:",
  "Content seed requires PostgreSQL",
);
assert.ok(
  ["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsedUrl.hostname),
  "Content seed is restricted to loopback PostgreSQL",
);
assert.match(
  decodeURIComponent(parsedUrl.pathname.slice(1)),
  /^content_e2e_0062$/u,
  "Content seed requires the disposable content_e2e_0062 database",
);

export const contentJourneyPersons = {
  administrator: {
    personId: "content-e2e-0062-administrator",
    firstName: "Ada",
    lastName: "Administrator",
    email: "administrator.content.0062@example.invalid",
    password: "content-admin-0062-password",
  },
  leaderDepartmentA: {
    personId: "content-e2e-0062-leader-a",
    firstName: "Line",
    lastName: "Leder",
    email: "leader.content.0062@example.invalid",
    password: "content-leader-0062-password",
  },
  authorDepartmentA: {
    personId: "content-e2e-0062-author-a",
    firstName: "Erik",
    lastName: "Forfatter",
    email: "author.content.0062@example.invalid",
    password: "content-author-0062-password",
  },
  memberDepartmentB: {
    personId: "content-e2e-0062-member-b",
    firstName: "Bodil",
    lastName: "Beta",
    email: "member-b.content.0062@example.invalid",
    password: "content-member-0062-password",
  },
  endedOnlyMember: {
    personId: "content-e2e-0062-ended-only",
    firstName: "Ingrid",
    lastName: "Inaktiv",
    email: "ended.content.0062@example.invalid",
    password: "content-ended-0062-password",
  },
  noAuthority: {
    personId: "content-e2e-0062-no-authority",
    firstName: "Nils",
    lastName: "Utenrolle",
    email: "no-authority.content.0062@example.invalid",
    password: "content-none-0062-password",
  },
};

export const contentJourneyDepartments = {
  alpha: "content-e2e-0062-department-alpha",
  beta: "content-e2e-0062-department-beta",
};

const persons = Object.values(contentJourneyPersons);
const personIds = persons.map((person) => person.personId);
const departmentIds = Object.values(contentJourneyDepartments);
const teamIds = ["content-e2e-0062-team-alpha", "content-e2e-0062-team-beta"];
const membershipIds = [
  "content-e2e-0062-membership-leader-alpha",
  "content-e2e-0062-membership-author-alpha",
  "content-e2e-0062-membership-member-b",
  "content-e2e-0062-membership-ended-alpha",
];

const identitySeed = spawnSync("bun", ["run", "identity:seed"], {
  cwd: databaseRoot,
  env: {
    ...process.env,
    IDENTITY_SEED_PG_URL: postgresUrl,
    IDENTITY_SEED_PERSONS: JSON.stringify(persons),
    BETTER_AUTH_URL: dashboardOrigin,
  },
  encoding: "utf8",
});
assert.equal(
  identitySeed.status,
  0,
  `identity:seed failed:\n${identitySeed.stdout}\n${identitySeed.stderr}`,
);

const pool = new Pool({
  connectionString: postgresUrl,
  options: "-c search_path=public",
  max: 1,
  application_name: "native-content-publication-seed-0062",
});
const client = await pool.connect();
try {
  await client.query("BEGIN");
  // Dependency order cleanup: content rows, then organization state.
  await client.query("DELETE FROM content_publication_audit");
  await client.query("DELETE FROM content_publication_command_receipts");
  await client.query("DELETE FROM content_article_departments");
  await client.query("DELETE FROM content_article_versions");
  await client.query("DELETE FROM content_articles");
  await client.query("DELETE FROM organization_memberships WHERE membership_id = ANY($1::text[])", [
    membershipIds,
  ]);
  await client.query("DELETE FROM organization_global_administrator_grants WHERE grant_id = $1", [
    "content-e2e-0062-administrator-grant",
  ]);
  await client.query("DELETE FROM organization_teams WHERE team_id = ANY($1::text[])", [teamIds]);
  await client.query("DELETE FROM organization_departments WHERE department_id = ANY($1::text[])", [
    departmentIds,
  ]);

  await client.query(
    `INSERT INTO organization_departments (
      department_id, name, short_name, email, city, active, revision
    ) VALUES
      ($1, 'Avdeling Alfa', 'ALFA', 'alpha.content.0062@example.invalid', 'Oslo', TRUE, 0),
      ($2, 'Avdeling Beta', 'BETA', 'beta.content.0062@example.invalid', 'Bergen', TRUE, 0)`,
    departmentIds,
  );
  await client.query(
    `INSERT INTO organization_teams (team_id, department_id, name, active, revision)
     VALUES
       ($1, $3, 'Team Alfa', TRUE, 0),
       ($2, $4, 'Team Beta', TRUE, 0)`,
    [teamIds[0], teamIds[1], departmentIds[0], departmentIds[1]],
  );
  await client.query(
    `INSERT INTO person_contact_profiles (person_id, email, phone, revision)
     SELECT seed.person_id, seed.email, seed.phone, 0
     FROM unnest($1::text[], $2::text[], $3::text[]) AS seed(person_id, email, phone)
     ON CONFLICT (person_id) DO UPDATE
     SET email = EXCLUDED.email, phone = EXCLUDED.phone`,
    [personIds, persons.map((person) => person.email), persons.map((_, i) => `+47 907 20 06${i}`)],
  );
  await client.query(
    `INSERT INTO organization_global_administrator_grants (
      grant_id, person_id, start_at, end_at, revision
    ) VALUES ($1, $2, '2020-01-01T00:00:00.000Z', NULL, 0)`,
    ["content-e2e-0062-administrator-grant", contentJourneyPersons.administrator.personId],
  );
  await client.query(
    `INSERT INTO organization_memberships (
      membership_id, person_id, team_id, deleted_team_name, start_at, end_at,
      position_id, is_team_leader, is_suspended, revision
    ) VALUES
      ($1::text, $5::text, $9::text, NULL, '2020-01-01T00:00:00.000Z', NULL,
       'member', TRUE, FALSE, 0),
      ($2::text, $6::text, $9::text, NULL, '2020-01-01T00:00:00.000Z', NULL,
       'member', FALSE, FALSE, 0),
      ($3::text, $7::text, $10::text, NULL, '2020-01-01T00:00:00.000Z', NULL,
       'member', FALSE, FALSE, 0),
      ($4::text, $8::text, $9::text, NULL, '2020-01-01T00:00:00.000Z',
       '2025-01-01T00:00:00.000Z', 'member', FALSE, FALSE, 0)`,
    [
      membershipIds[0],
      contentJourneyPersons.leaderDepartmentA.personId,
      membershipIds[1],
      contentJourneyPersons.authorDepartmentA.personId,
      membershipIds[2],
      contentJourneyPersons.memberDepartmentB.personId,
      membershipIds[3],
      contentJourneyPersons.endedOnlyMember.personId,
      teamIds[0],
      teamIds[1],
    ],
  );

  // Article fixtures (spec §Disposable seed and evidence plan):
  //   1. draft in dept A by author (staff arc target)
  //   2. published in dept A
  //   3. published org-wide (empty departments)
  //   4. published sticky multi-department (A+B)
  //   5. two-version republication case in dept A: version 1 already committed
  await client.query(
    `INSERT INTO content_articles (
      title, slug, body_html, sticky, created_by_person_id, current_version_number
    ) VALUES
      ('Kladd fra forfatter', 'kladd-fra-forfatter', '<p>Kladdetekst</p>', FALSE,
       ${"'" + contentJourneyPersons.authorDepartmentA.personId + "'"}, NULL),
      ('Publisert alfa', 'publisert-alfa', '<p>Alfatekst</p>', FALSE,
       '${contentJourneyPersons.administrator.personId}', 1),
      ('Orgomfattende nyhet', 'orgomfattende-nyhet', '<p>Felles tekst</p>', FALSE,
       '${contentJourneyPersons.administrator.personId}', 1),
      ('Festet fleravdeling', 'festet-fleravdeling', '<p>Festet tekst</p>', TRUE,
       '${contentJourneyPersons.administrator.personId}', 1),
      ('To versjoner', 'to-versjoner', '<p>Versjon én tekst</p>', FALSE,
       '${contentJourneyPersons.authorDepartmentA.personId}', 1)`,
  );
  const articleRows = await client.query(
    `SELECT article_id::int AS id, slug FROM content_articles ORDER BY article_id`,
  );
  const bySlug = new Map(articleRows.rows.map((row) => [row.slug, row.id]));
  await client.query(
    `INSERT INTO content_article_versions (
      article_id, version_number, title, slug, body_html, sticky,
      published_at, published_by_person_id
    ) VALUES
      ($1::bigint, 1, 'Publisert alfa', 'publisert-alfa', '<p>Alfatekst</p>', FALSE,
       '2031-06-01T00:00:00Z', $5::text),
      ($2::bigint, 1, 'Orgomfattende nyhet', 'orgomfattende-nyhet', '<p>Felles tekst</p>', FALSE,
       '2031-06-02T00:00:00Z', $5::text),
      ($3::bigint, 1, 'Festet fleravdeling', 'festet-fleravdeling', '<p>Festet tekst</p>', TRUE,
       '2031-06-03T00:00:00Z', $5::text),
      ($4::bigint, 1, 'To versjoner', 'to-versjoner', '<p>Versjon én tekst</p>'::text, FALSE,
       '2031-06-04T00:00:00Z', $6::text)`,
    [
      bySlug.get("publisert-alfa"),
      bySlug.get("orgomfattende-nyhet"),
      bySlug.get("festet-fleravdeling"),
      bySlug.get("to-versjoner"),
      contentJourneyPersons.administrator.personId,
      contentJourneyPersons.authorDepartmentA.personId,
    ],
  );
  await client.query(
    `INSERT INTO content_article_departments (article_id, department_id) VALUES
      ($1::bigint, $4::text),
      ($2::bigint, $4::text),
      ($2::bigint, $5::text),
      ($3::bigint, $4::text)`,
    [
      bySlug.get("publisert-alfa"),
      bySlug.get("festet-fleravdeling"),
      bySlug.get("to-versjoner"),
      departmentIds[0],
      departmentIds[1],
    ],
  );
  await client.query("COMMIT");

  const evidence = await client.query(
    `SELECT
      (SELECT count(*)::int FROM auth."user" WHERE id = ANY($1::text[])) AS persons,
      (SELECT count(*)::int FROM organization_departments WHERE department_id = ANY($2::text[]))
        AS departments,
      (SELECT count(*)::int FROM organization_memberships WHERE membership_id = ANY($3::text[]))
        AS memberships,
      (SELECT count(*)::int FROM content_articles) AS articles,
      (SELECT count(*)::int FROM content_article_versions) AS versions,
      (SELECT count(*)::int FROM content_article_departments) AS department_links,
      (SELECT count(*)::int FROM content_articles WHERE current_version_number IS NOT NULL)
        AS published_articles,
      (SELECT count(*)::int FROM content_articles WHERE sticky) AS sticky_articles`,
    [personIds, departmentIds, membershipIds],
  );
  assert.deepEqual(evidence.rows[0], {
    persons: 6,
    departments: 2,
    memberships: 2,
    articles: 5,
    versions: 4,
    department_links: 4,
    published_articles: 4,
    sticky_articles: 1,
  });
  process.stdout.write(`${JSON.stringify({ passed: true, ...evidence.rows[0] })}\n`);
} catch (cause) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw cause;
} finally {
  client.release();
  await pool.end();
}
