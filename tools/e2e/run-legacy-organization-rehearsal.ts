import * as BunServices from "@effect/platform-bun/BunServices";
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseLive } from "@vektorprogrammet/database/live";
import { reachedDepartments, ReachedDepartments } from "@vektorprogrammet/domain/authz";
import { databaseSchemaRevision } from "@vektorprogrammet/database/migrations";
import {
  decodePersonCohort,
  importPersonCohort as importPersonCohortEffect,
  type PersonCohortReport,
} from "@vektorprogrammet/database/person-cohort";
import {
  importReviewedOrganizationCohort as importReviewedOrganizationCohortEffect,
  resolveOrganizationPersonAuthorityForRead,
} from "@vektorprogrammet/database/organization";
import {
  OrganizationReview,
  organizationSnapshotDigest,
  reviewedOrganizationTargetId,
  PersonId,
  type ReviewedOrganizationSnapshot,
} from "@vektorprogrammet/domain/organization";
import { Effect, flow, Layer, Predicate, Redacted, Schema } from "effect";
import type { Pool } from "pg";
import { buildLegacyReferences, seedLegacyReferences } from "./legacy-cutover-references";
import { buildLegacyOrganizationSnapshot } from "./legacy-organization-snapshot";
import { buildLegacyPersonSnapshot } from "./legacy-person-snapshot";
import { readLegacySourceSnapshot, type LegacySourceSnapshot } from "./legacy-source-snapshot";
import { CutoverStageFailure, runLegacyServiceCutover } from "./run-legacy-service-cutover";
import {
  digest,
  repositoryRoot,
  runLocal,
  targetFingerprint,
  withOrganizationDatabases,
  type RehearsalTarget,
} from "./legacy-organization-rehearsal-runtime";

const importPersonCohort = flow(importPersonCohortEffect, Effect.runPromise);

const importReviewedOrganizationCohort = flow(
  importReviewedOrganizationCohortEffect,
  Effect.runPromise,
);

let stage = "Options";

const asOf = "2026-09-24T12:00:00Z";

const repository = "vektorprogrammet/vektorprogrammet";

// Eleven InnoDB tables; source names and nullable relations are the legacy main shape.
// These records are invented. This program never reads a backup or a live database.
const fixtureSql = `
CREATE DATABASE vektor CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE vektor;
CREATE TABLE user (
  id INT PRIMARY KEY, is_active TINYINT NOT NULL, firstName VARCHAR(255), lastName VARCHAR(255),
  email VARCHAR(255), phone VARCHAR(255), user_name VARCHAR(255), companyEmail VARCHAR(255), password VARCHAR(255)
) ENGINE=InnoDB;
CREATE TABLE department (
  id INT PRIMARY KEY, name VARCHAR(255) NOT NULL, short_name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL, address VARCHAR(255), city VARCHAR(255) NOT NULL,
  latitude VARCHAR(255), longitude VARCHAR(255), slackChannel VARCHAR(255), logo_path VARCHAR(255), active TINYINT NOT NULL
) ENGINE=InnoDB;
CREATE TABLE semester (id INT PRIMARY KEY, semesterTime VARCHAR(255) NOT NULL, year VARCHAR(4) NOT NULL) ENGINE=InnoDB;
CREATE TABLE school (
  id INT PRIMARY KEY, name VARCHAR(255) NOT NULL, contactPerson VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL, phone VARCHAR(255) NOT NULL, international TINYINT NOT NULL, active TINYINT NOT NULL
) ENGINE=InnoDB;
CREATE TABLE department_school (department_id INT NOT NULL,school_id INT NOT NULL,PRIMARY KEY(department_id,school_id)) ENGINE=InnoDB;
CREATE TABLE assistant_history (
  id INT PRIMARY KEY,user_id INT,department_id INT,semester_id INT,school_id INT,
  workdays VARCHAR(255),bolk VARCHAR(255),day VARCHAR(255)
) ENGINE=InnoDB;
CREATE TABLE team (id INT PRIMARY KEY,department_id INT,name VARCHAR(255),active TINYINT) ENGINE=InnoDB;
CREATE TABLE position (id INT PRIMARY KEY,name VARCHAR(255)) ENGINE=InnoDB;
CREATE TABLE team_membership (
  id INT PRIMARY KEY,user_id INT,team_id INT,position_id INT,startSemester_id INT,endSemester_id INT,
  isTeamLeader TINYINT,isSuspended TINYINT,deletedTeamName VARCHAR(255)
) ENGINE=InnoDB;
CREATE TABLE executive_board (id INT PRIMARY KEY,name VARCHAR(255)) ENGINE=InnoDB;
CREATE TABLE executive_board_membership (
  id INT PRIMARY KEY,user_id INT,board_id INT,positionName VARCHAR(255),startSemester_id INT,endSemester_id INT
) ENGINE=InnoDB;
INSERT INTO user VALUES
${Array.from({ length: 18 }, (_, index) => {
  const id = index + 1;

  return (
    `(${id},${id === 9 ? 0 : 1},'FixtureGiven${id}','FixtureFamily${id}',` +
    `'${id === 10 ? "invalid-email" : `person${id}@example.invalid`}','12345678',NULL,NULL,NULL)`
  );
}).join(",\n")};
INSERT INTO department VALUES
 (1,'Synthetic department','SYN','department@example.invalid',NULL,'Synthetic city',NULL,NULL,NULL,NULL,1),
 (2,'Inactive department','OFF','inactive@example.invalid',NULL,'Synthetic city',NULL,NULL,NULL,NULL,0);
INSERT INTO semester VALUES (1,'Vår','2026'),(2,'Høst','2026'),(3,'Vår','2027');
INSERT INTO school VALUES (1,'Synthetic school','Synthetic contact','school@example.invalid','12345678',0,1);
INSERT INTO department_school VALUES (1,1);
INSERT INTO assistant_history VALUES (301,1,1,1,1,'8','Bolk 1','Mandag');
INSERT INTO team VALUES (1,1,'Synthetic active team',1),(2,1,'Synthetic inactive team',0),
 (3,2,'Synthetic inactive department team',1),(4,NULL,'Synthetic unresolved team',1);
INSERT INTO position VALUES (1,'Leder'),(2,'Medlem');
INSERT INTO executive_board VALUES (1,'Synthetic national board');
INSERT INTO team_membership VALUES
 (101,1,1,1,2,NULL,1,0,NULL),
 (102,2,1,1,2,NULL,0,0,NULL),
 (103,3,1,2,2,NULL,1,1,NULL),
 (104,4,1,2,3,NULL,1,0,NULL),
 (105,5,1,2,1,1,1,0,NULL),
 (106,6,NULL,2,1,1,1,0,'Named deleted synthetic team'),
 (108,8,1,2,2,NULL,2,0,NULL),
 (109,9,1,2,2,NULL,1,0,NULL),
 (110,10,1,2,2,NULL,1,0,NULL),
 (111,11,NULL,2,2,NULL,1,0,NULL),
 (112,12,1,999,2,NULL,1,0,NULL),
 (113,13,1,2,2,NULL,1,0,NULL),
 (114,14,3,2,2,NULL,1,0,NULL),
 (115,15,1,2,2,NULL,1,2,NULL),
 (116,16,2,2,2,NULL,1,0,NULL),
 (117,NULL,1,2,2,NULL,1,0,NULL),
 (118,18,4,2,2,NULL,1,0,NULL),
 (119,0,1,-1,2,NULL,1,0,NULL);
INSERT INTO executive_board_membership VALUES (201,7,1,'Global administrator',2,NULL);
CREATE USER 'legacy_organization_reader'@'localhost';
GRANT SELECT ON vektor.* TO 'legacy_organization_reader'@'localhost';
`;

const sourceRevision = (source: LegacySourceSnapshot): string => {
  const {
    credentials: _credentials,
    receipts: _receipts,
    paymentAccounts: _paymentAccounts,
    ...selected
  } = source;

  return digest(selected);
};

const reviewFor = (source: LegacySourceSnapshot): OrganizationReview => {
  assert.ok(source.teamMemberships && source.executiveBoardMemberships);

  const membership = (
    sourceKind: "TeamMembership" | "BoardMembership",
    row: { readonly id: number | string },
  ) => {
    const sourceId = String(row.id);

    const common = {
      sourceKind,
      sourceId,
      sourceRowDigest: digest(row),
      evidenceRef: `synthetic-interval:${sourceKind}:${sourceId}`,
    };

    if (sourceId === "113") return { ...common, decision: "Excluded" };

    if (sourceId === "104")
      return { ...common, decision: "Future", startAt: "2027-01-01T00:00:00Z", endAt: null };

    if (sourceId === "105" || sourceId === "106")
      return {
        ...common,
        decision: "Historical",
        startAt: "2026-01-01T00:00:00Z",
        endAt: "2026-07-01T00:00:00Z",
      };

    return { ...common, decision: "Current", startAt: "2026-08-01T00:00:00Z", endAt: null };
  };

  return Schema.decodeUnknownSync(OrganizationReview)({
    sourceRevision: sourceRevision(source),
    sourceWatermark: "synthetic-source-2026-09-24",
    asOf,
    attestedBy: "synthetic-reviewer",
    evidenceRef: "synthetic-organization-review-only",
    memberships: [
      ...source.teamMemberships.map((row) => membership("TeamMembership", row)),
      ...source.executiveBoardMemberships.map((row) => membership("BoardMembership", row)),
    ],
  });
};

const rehash = (snapshot: ReviewedOrganizationSnapshot): ReviewedOrganizationSnapshot => ({
  ...snapshot,
  snapshotDigest: organizationSnapshotDigest(snapshot),
});

const assertAuthority = async (target: RehearsalTarget, leaderActive = true): Promise<void> => {
  await Effect.runPromise(
    Effect.gen(function* () {
      for (let id = 1; id <= 18; id++) {
        const authority = yield* resolveOrganizationPersonAuthorityForRead(
          PersonId.make(`legacy-person-${id}`),
          asOf,
        );

        assert.equal(
          authority.globalAdministrator,
          "Absent",
          `Person ${id} gained global authority`,
        );
        assert.deepEqual(
          authority.memberships.flatMap((membership) =>
            membership.active && membership.unitLeader ? [membership.departmentId] : [],
          ),
          id === 1 && leaderActive ? ["legacy-department:1"] : [],
          `Person ${id} gained incorrect leadership`,
        );
        // Import classifies no team as a board: no imported person reaches a department (O8-11).
        assert.deepEqual(
          reachedDepartments(authority, "admissions.periods"),
          ReachedDepartments.Departments({ departmentIds: [] }),
          `Person ${id} gained department reach`,
        );
      }
    }).pipe(
      Effect.provide(
        DatabaseLive({
          url: Redacted.make(target.url),
          applicationName: "organization-native-authority-proof",
          maxConnections: 2,
        }).pipe(Layer.provide(BunServices.layer)),
      ),
    ),
  );
};

const assertCanonical = async (pool: Pool): Promise<void> => {
  assert.deepEqual(
    (
      await pool.query(`
    SELECT person_id,is_team_leader,is_suspended,position_name,
      to_char(start_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS start_at,
      to_char(end_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS end_at,
      deleted_team_name
    FROM public.organization_memberships ORDER BY person_id
  `)
    ).rows,
    [
      [1, true, false, "Leder", "2026-08-01", null, null],
      [14, true, false, "Medlem", "2026-08-01", null, null],
      [16, true, false, "Medlem", "2026-08-01", null, null],
      [2, false, false, "Leder", "2026-08-01", null, null],
      [3, true, true, "Medlem", "2026-08-01", null, null],
      [4, true, false, "Medlem", "2027-01-01", null, null],
      [5, true, false, "Medlem", "2026-01-01", "2026-07-01", null],
      [6, true, false, "Medlem", "2026-01-01", "2026-07-01", "Named deleted synthetic team"],
      [7, false, false, "Global administrator", "2026-08-01", null, null],
    ].map(([id, leadership, suspended, position, start, end, deleted]) => ({
      person_id: `legacy-person-${id}`,
      is_team_leader: leadership,
      is_suspended: suspended,
      position_name: position,
      start_at: `${start}T00:00:00.000000Z`,
      end_at: end === null ? null : `${end}T00:00:00.000000Z`,
      deleted_team_name: deleted,
    })),
  );
  assert.deepEqual(
    (
      await pool.query(`
    SELECT department_id FROM public.organization_departments ORDER BY department_id
  `)
    ).rows,
    [{ department_id: "legacy-department:1" }, { department_id: "legacy-department:2" }],
  );
  assert.deepEqual(
    (
      await pool.query(`
    SELECT b.name,m.person_id FROM public.organization_memberships m
    JOIN public.organization_national_boards b ON b.board_id=m.board_id
  `)
    ).rows,
    [{ name: "Synthetic national board", person_id: "legacy-person-7" }],
  );
};

const forbiddenFacts = async (pool: Pool): Promise<Record<string, number>> => {
  const tables = (
    await pool.query<{ name: string }>(`
    SELECT format('%I.%I',schemaname,tablename) AS name FROM pg_tables
    WHERE schemaname IN ('public','auth') AND
      (tablename LIKE '%audit%' OR tablename LIKE '%outbox%' OR tablename LIKE '%grant%'
       OR tablename LIKE '%command_receipt%' OR tablename='service_principals')
      AND NOT (schemaname='auth' AND tablename='identity_security_audit') ORDER BY 1
  `)
  ).rows;

  const counts: Record<string, number> = {};

  for (const { name } of tables) {
    counts[name] = Number(
      (await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${name}`)).rows[0]!
        .count,
    );
    assert.equal(counts[name], 0, `Import fabricated facts in ${name}`);
  }

  return counts;
};

const appendOnly = async (pool: Pool): Promise<void> => {
  for (const [table, column] of [
    ["organization_cohort_snapshots", "snapshot_id"],
    ["organization_cohort_imports", "source_id"],
    ["organization_cohort_occurrences", "reason"],
  ] as const) {
    for (const statement of [
      `UPDATE public.${table} SET ${column}=${column}`,
      `DELETE FROM public.${table}`,
      `TRUNCATE public.${table} CASCADE`,
    ]) {
      const client = await pool.connect();

      try {
        await client.query("BEGIN");
        await assert.rejects(
          client.query(statement),
          /append.only|immutable|not (allowed|permitted)/i,
        );
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    }
  }
};

const rehearse = async () =>
  withOrganizationDatabases(fixtureSql, async ({ sourceUrl, mysql, target, temporaryRoot }) => {
    stage = "ActualElevenTableReader";
    const source = await readLegacySourceSnapshot(sourceUrl, "Include", "NotRequested");
    const omittedSource = await readLegacySourceSnapshot(sourceUrl, "NotRequested", "NotRequested");
    assert.equal(source.teamMemberships?.length, 18);
    assert.deepEqual(
      source.teamMemberships?.find((row) => String(row.id) === "119"),
      {
        id: 119,
        userId: 0,
        teamId: 1,
        positionId: -1,
        startSemesterId: 2,
        endSemesterId: null,
        isTeamLeader: 1,
        isSuspended: 0,
        deletedTeamName: null,
      },
    );
    assert.equal(source.executiveBoardMemberships?.length, 1);
    assert.equal("teams" in omittedSource, false);
    assert.notEqual(sourceRevision(omittedSource), sourceRevision(source));
    const review = reviewFor(source);
    await mysql("UPDATE vektor.user SET password='synthetic-credential-change' WHERE id=1");
    const changedCredential = await readLegacySourceSnapshot(sourceUrl, "Include", "NotRequested");
    assert.notEqual(digest(source.credentials), digest(changedCredential.credentials));
    assert.equal(sourceRevision(changedCredential), review.sourceRevision);
    await mysql("UPDATE vektor.user SET password=NULL WHERE id=1");
    const writer = new URL(sourceUrl);
    writer.username = "root";
    await assert.rejects(
      readLegacySourceSnapshot(writer.toString(), "Include", "NotRequested"),
      /Grants/,
    );

    const primary = await target("organization_reviewed");

    const options = {
      sourceUrl,
      targetUrl: primary.url,
      targetDatabase: primary.database,
      snapshotId: "synthetic-organization-2026",
      attestedBy: "synthetic-reviewer",
      passwordlessPolicy: "ProvisionRecovery" as const,
      currentAssignments: "NotRequested" as const,
      organization: review,
    };

    const pristine = await targetFingerprint(primary.pool);
    const refusals: string[] = [];

    const refuseReview = async (
      name: string,
      candidate: OrganizationReview,
      expectedStage: "OrganizationProjection" | "OrganizationImport" = "OrganizationProjection",
    ) => {
      stage = name;
      await assert.rejects(
        runLegacyServiceCutover({ ...options, organization: candidate }),
        (cause: unknown) => cause instanceof CutoverStageFailure && cause.stage === expectedStage,
      );
      assert.equal(await targetFingerprint(primary.pool), pristine, `${name} left partial facts`);
      refusals.push(name);
    };

    await refuseReview("missing-review-entry", {
      ...review,
      memberships: review.memberships.slice(1),
    });
    await refuseReview("duplicate-review-entry", {
      ...review,
      memberships: [...review.memberships, review.memberships[0]!],
    });
    await refuseReview("unknown-review-entry", {
      ...review,
      memberships: [...review.memberships, { ...review.memberships[0]!, sourceId: "999" }],
    });
    await refuseReview("raw-digest-mismatch", {
      ...review,
      memberships: review.memberships.map((entry, index) =>
        index === 0 ? { ...entry, sourceRowDigest: "0".repeat(64) } : entry,
      ),
    });
    await refuseReview("source-revision-mismatch", { ...review, sourceRevision: "0".repeat(64) });

    for (const decision of ["Historical", "Future"] as const)
      await refuseReview(`invalid-${decision}-interval`, {
        ...review,
        memberships: review.memberships.map((entry, index) =>
          index === 0 && entry.decision !== "Excluded" ? { ...entry, decision } : entry,
        ),
      });
    await refuseReview("reversed-interval", {
      ...review,
      memberships: review.memberships.map((entry, index) =>
        index === 0 && entry.decision !== "Excluded"
          ? { ...entry, endAt: "2025-01-01T00:00:00Z" }
          : entry,
      ),
    });
    await refuseReview(
      "no-accepted-appointments",
      {
        ...review,
        memberships: review.memberships.map((entry) => ({
          sourceKind: entry.sourceKind,
          sourceId: entry.sourceId,
          sourceRowDigest: entry.sourceRowDigest,
          decision: "Excluded",
          evidenceRef: entry.evidenceRef,
        })),
      },
      "OrganizationImport",
    );
    await mysql("UPDATE vektor.team_membership SET isSuspended=1 WHERE id=101");
    await refuseReview("changed-selected-source", review);
    await mysql("UPDATE vektor.team_membership SET isSuspended=0 WHERE id=101");

    stage = "LaterAccountFailureRollsBackWholeCutover";
    await primary.pool.query(`
    CREATE FUNCTION auth.fail_organization_rehearsal() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic later-stage failure'; END; $$;
    CREATE TRIGGER fail_organization_rehearsal BEFORE INSERT ON auth.account_cohort_imports
    FOR EACH ROW EXECUTE FUNCTION auth.fail_organization_rehearsal();
  `);
    await assert.rejects(
      runLegacyServiceCutover(options),
      (cause: unknown) => cause instanceof CutoverStageFailure && cause.stage === "AccountImport",
    );
    assert.equal(
      await targetFingerprint(primary.pool),
      pristine,
      "Later account failure leaked Organization or Person facts",
    );
    await primary.pool.query(
      `DROP TRIGGER fail_organization_rehearsal ON auth.account_cohort_imports; DROP FUNCTION auth.fail_organization_rehearsal();`,
    );

    stage = "ActualOperatorCLI";
    const reviewFile = join(temporaryRoot, "organization review.json");
    await writeFile(reviewFile, JSON.stringify(review), { mode: 0o600, flag: "wx" });

    const cli = [
      process.execPath,
      "--no-env-file",
      join(repositoryRoot, "tools/e2e/run-legacy-service-cutover.ts"),
      "--source-url-env=REHEARSAL_SOURCE_URL",
      "--target-url-env=REHEARSAL_TARGET_URL",
      `--target-database=${primary.database}`,
      `--snapshot-id=${options.snapshotId}`,
      `--attested-by=${options.attestedBy}`,
      "--passwordless-policy=provision-recovery",
      "--current-assignments=none",
      `--organization=${reviewFile}`,
    ];

    const environment = { REHEARSAL_SOURCE_URL: sourceUrl, REHEARSAL_TARGET_URL: primary.url };

    const refuseCLI = async (name: string, command: ReadonlyArray<string>) => {
      await assert.rejects(runLocal(command, undefined, environment));
      assert.equal(await targetFingerprint(primary.pool), pristine, name);
      refusals.push(name);
    };

    await refuseCLI("missing-organization-choice", cli.slice(0, -1));
    await refuseCLI("duplicate-organization-choice", [...cli, cli.at(-1)!]);
    await chmod(reviewFile, 0o644);
    await refuseCLI("public-review-file", cli);
    await chmod(reviewFile, 0o600);
    const link = join(temporaryRoot, "review-link.json");
    await symlink(reviewFile, link);
    await refuseCLI("symlink-review-file", [...cli.slice(0, -1), `--organization=${link}`]);
    const cliOutput = await runLocal(cli, undefined, environment);

    const cliReport = Schema.decodeUnknownSync(
      Schema.Struct({
        source: Schema.Struct({ revision: Schema.String }),
        organization: Schema.Struct({
          accepted: Schema.Int,
          quarantined: Schema.Int,
          input: Schema.Int,
          excluded: Schema.Int,
        }),
      }),
    )(JSON.parse(cliOutput));

    assert.equal(cliReport.source.revision, review.sourceRevision);
    assert.deepEqual(cliReport.organization, {
      accepted: 9,
      quarantined: 9,
      input: 19,
      excluded: 1,
    });

    for (const user of source.users)
      for (const value of [user.email, user.firstName, user.lastName, user.phone])
        if (Predicate.isString(value) && value)
          assert.equal(cliOutput.includes(value), false, "CLI leaked personal fields");

    stage = "CanonicalTitlesIntervalsAndNativeAuthority";
    const first = await runLegacyServiceCutover(options);
    assert.ok(first.organization !== "NotRequested");
    assert.deepEqual(
      (
        await primary.pool.query(
          "SELECT result,reason,target_id FROM public.organization_cohort_occurrences WHERE source_kind='TeamMembership' AND source_id='119'",
        )
      ).rows,
      [{ result: "Quarantined", reason: "InvalidRow", target_id: null }],
    );
    assert.equal(first.person.accepted, 16);
    assert.equal(first.historicalService.accepted, 1);
    await assertCanonical(primary.pool);
    await assertAuthority(primary);
    const noFabricatedFacts = await forbiddenFacts(primary.pool);
    await appendOnly(primary.pool);
    const committed = await targetFingerprint(primary.pool);
    await runLegacyServiceCutover(options);
    assert.equal(await targetFingerprint(primary.pool), committed);
    await assert.rejects(
      runLegacyServiceCutover({
        ...options,
        organization: { ...review, evidenceRef: "changed-review" },
      }),
    );
    assert.equal(await targetFingerprint(primary.pool), committed);

    stage = "ExactPersonBinding";
    const references = buildLegacyReferences(source);

    const identity = {
      sourceRepository: repository,
      sourceRevision: review.sourceRevision,
      snapshotId: options.snapshotId,
    };

    const people = buildLegacyPersonSnapshot(source.users, {
      sourceRevision: review.sourceRevision,
      snapshotId: options.snapshotId,
      transformationRevision: first.source.transformationRevision,
      attestedBy: options.attestedBy,
    });

    const project = (report: PersonCohortReport, personSnapshot = people) =>
      buildLegacyOrganizationSnapshot(source, report, personSnapshot, review, {
        snapshotId: options.snapshotId,
        transformationRevision: first.source.transformationRevision,
        referenceDigest: references.referenceDigest,
      });

    const provenance = await target("organization_provenance");
    await seedLegacyReferences(provenance.pool, identity, references);
    const personReport = await importPersonCohort(provenance.pool, people);
    const projected = project(personReport);
    const before = await targetFingerprint(provenance.pool);

    for (const candidate of [
      { ...projected, referenceDigest: "0".repeat(64) },
      { ...projected, personSnapshotKey: "0".repeat(64) },
    ]) {
      await assert.rejects(importReviewedOrganizationCohort(provenance.pool, rehash(candidate)));
      assert.equal(await targetFingerprint(provenance.pool), before);
    }

    const leaderOccurrence = projected.occurrences.find((row) => row.sourceId === "101")!;

    const wrongMapping = rehash({
      ...projected,
      mappings: {
        ...projected.mappings,
        persons: projected.mappings.persons.map((mapping) =>
          mapping.sourceUserId === "legacy-user:1"
            ? { ...mapping, personId: PersonId.make("legacy-person-2") }
            : mapping,
        ),
      },
    });

    const client = await provenance.pool.connect();

    try {
      await client.query("BEGIN");
      const wrong = await importReviewedOrganizationCohort(provenance.pool, wrongMapping, client);
      assert.equal(
        wrong.occurrences.find((row) => row.occurrenceId === leaderOccurrence.occurrenceId)?.reason,
        "PersonReconciliationMissing",
      );
      assert.equal(
        (
          await client.query(
            "SELECT count(*)::text AS count FROM public.organization_memberships WHERE membership_id=$1",
            [reviewedOrganizationTargetId("TeamMembership", repository, "101")],
          )
        ).rows[0].count,
        "0",
      );
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }

    assert.equal(await targetFingerprint(provenance.pool), before);

    stage = "SnapshotLocalPersonOccurrenceCollision";
    const collision = await target("organization_person_collision");
    await seedLegacyReferences(collision.pool, identity, references);

    const priorPerson = decodePersonCohort({
      ...people,
      snapshotId: "prior-person-snapshot",
      occurrences: people.occurrences.filter((row) => row.occurrenceId === "legacy-user-row-1"),
      mappings: people.mappings.filter((row) => row.sourceUserId === "legacy-user:1"),
    });

    assert.equal((await importPersonCohort(collision.pool, priorPerson)).accepted, 1);

    const collidingPeople = decodePersonCohort({
      ...people,
      occurrences: people.occurrences
        .filter((row) => row.occurrenceId === "legacy-user-row-2")
        .map((row) => ({ ...row, occurrenceId: "legacy-user-row-1" })),
      mappings: people.mappings.filter((row) => row.sourceUserId === "legacy-user:2"),
    });

    const collidingReport = await importPersonCohort(collision.pool, collidingPeople);
    assert.equal(collidingReport.accepted, 1);
    const collisionProjection = project(collidingReport, collidingPeople);

    const collided = await importReviewedOrganizationCohort(
      collision.pool,
      rehash({
        ...collisionProjection,
        mappings: {
          ...collisionProjection.mappings,
          persons: [
            ...collisionProjection.mappings.persons,
            projected.mappings.persons.find((row) => row.sourceUserId === "legacy-user:1")!,
          ],
        },
      }),
    );

    assert.equal(collided.accepted, 1);
    assert.equal(
      collided.occurrences.find((row) => row.occurrenceId === leaderOccurrence.occurrenceId)
        ?.reason,
      "PersonReconciliationMissing",
    );
    assert.deepEqual(
      (await collision.pool.query("SELECT person_id FROM public.organization_memberships")).rows,
      [{ person_id: "legacy-person-2" }],
    );
    await assertAuthority(collision, false);

    stage = "ValidCrossSnapshotPersonReplay";
    const personReplay = await target("organization_person_replay");
    await seedLegacyReferences(personReplay.pool, identity, references);
    assert.equal(
      (
        await importPersonCohort(
          personReplay.pool,
          decodePersonCohort({ ...people, snapshotId: "earlier-accepted-people" }),
        )
      ).accepted,
      16,
    );

    const laterPeople = decodePersonCohort({
      ...people,
      occurrences: people.occurrences.map((row) => ({
        ...row,
        occurrenceId: `later:${row.occurrenceId}`,
      })),
    });

    const laterReport = await importPersonCohort(personReplay.pool, laterPeople);
    assert.deepEqual(
      laterReport.occurrences
        .filter((row) => row.disposition === "Accepted")
        .map((row) => row.reason),
      Array(16).fill("ExactReplay"),
    );
    assert.equal(
      (await importReviewedOrganizationCohort(personReplay.pool, project(laterReport, laterPeople)))
        .accepted,
      9,
    );
    await assertCanonical(personReplay.pool);
    await assertAuthority(personReplay);

    stage = "UnownedTargetCollision";
    // The matching native team is deliberately not source-owned. It must not be adopted,
    // even though its fields match. Board and deleted-team appointments remain importable.
    const teamId = reviewedOrganizationTargetId("Team", repository, "1");
    await provenance.pool.query(
      "INSERT INTO public.organization_teams(team_id,department_id,name,active) VALUES($1,$2,$3,true)",
      [teamId, "legacy-department:1", "Synthetic active team"],
    );
    const targetConflict = await importReviewedOrganizationCohort(provenance.pool, projected);
    assert.equal(
      targetConflict.occurrences.find((row) => row.occurrenceId === leaderOccurrence.occurrenceId)
        ?.reason,
      "TargetConflict",
    );
    assert.equal(
      (
        await provenance.pool.query(
          "SELECT count(*)::text AS count FROM public.organization_cohort_imports WHERE target_id=$1",
          [teamId],
        )
      ).rows[0].count,
      "0",
    );
    assert.equal(
      (
        await provenance.pool.query(
          "SELECT count(*)::text AS count FROM public.organization_memberships WHERE person_id='legacy-person-1'",
        )
      ).rows[0].count,
      "0",
    );

    await mysql(
      "INSERT INTO vektor.team_membership SELECT 120,user_id,team_id,position_id,startSemester_id,endSemester_id,isTeamLeader,isSuspended,deletedTeamName FROM vektor.team_membership WHERE id=101",
    );

    const duplicateReview = reviewFor(
      await readLegacySourceSnapshot(sourceUrl, "Include", "NotRequested"),
    );

    const duplicated = await target("organization_duplicate_target");

    const duplicateResult = await runLegacyServiceCutover({
      ...options,
      targetUrl: duplicated.url,
      targetDatabase: duplicated.database,
      organization: duplicateReview,
    });

    assert.ok(duplicateResult.organization !== "NotRequested");
    assert.equal(duplicateResult.organization.accepted, 8);
    assert.equal(duplicateResult.organization.reasons.DuplicateTarget, 2);
    await assertAuthority(duplicated, false);
    await mysql("DELETE FROM vektor.team_membership WHERE id=120");

    stage = "ImmutableSourceAndTransformation";
    await mysql("UPDATE vektor.team_membership SET user_id=2 WHERE id=101");
    const repointedSource = await readLegacySourceSnapshot(sourceUrl, "Include", "NotRequested");
    const repointed = reviewFor(repointedSource);
    await assert.rejects(runLegacyServiceCutover({ ...options, organization: repointed }));
    await assert.rejects(
      runLegacyServiceCutover({
        ...options,
        snapshotId: "later-source-conflict",
        organization: repointed,
      }),
      (cause: unknown) => cause instanceof CutoverStageFailure && cause.stage === "ReferenceSeed",
    );

    assert.equal(await targetFingerprint(primary.pool), committed);
    await mysql("UPDATE vektor.team_membership SET user_id=1 WHERE id=101");
    await assert.rejects(
      importReviewedOrganizationCohort(
        primary.pool,
        rehash({ ...projected, transformationRevision: "different-transform" }),
      ),
    );
    assert.equal(await targetFingerprint(primary.pool), committed);

    stage = "NativeEditAndConcurrentReplay";
    await primary.pool.query(`
    UPDATE public.organization_memberships SET end_at='2026-09-01T00:00:00Z',revision=revision+1 WHERE person_id='legacy-person-1';
    UPDATE public.organization_memberships SET is_suspended=true,position_name='Native edited title',revision=revision+1 WHERE person_id='legacy-person-2';
  `);
    const nativeEdited = await targetFingerprint(primary.pool);

    const replayed = await Promise.all([
      runLegacyServiceCutover(options),
      runLegacyServiceCutover(options),
    ]);

    assert.deepEqual(replayed[0]!.organization, first.organization);
    assert.deepEqual(replayed[1]!.organization, first.organization);
    assert.equal(await targetFingerprint(primary.pool), nativeEdited);
    await assertAuthority(primary, false);
    await forbiddenFacts(primary.pool);

    stage = "ConcurrentFirstImport";
    const concurrent = await target("organization_concurrent");

    const concurrentOptions = {
      ...options,
      targetUrl: concurrent.url,
      targetDatabase: concurrent.database,
    };

    const imported = await Promise.all([
      runLegacyServiceCutover(concurrentOptions),
      runLegacyServiceCutover(concurrentOptions),
    ]);

    assert.deepEqual(imported[0]!.organization, imported[1]!.organization);
    await assertCanonical(concurrent.pool);
    await assertAuthority(concurrent);
    assert.equal(
      (
        await concurrent.pool.query(
          "SELECT count(*)::text AS count FROM public.organization_cohort_snapshots",
        )
      ).rows[0].count,
      "1",
    );
    await forbiddenFacts(concurrent.pool);

    stage = "ExplicitOrganizationOmission";
    const omitted = await target("organization_omitted");

    const omittedReport = await runLegacyServiceCutover({
      ...options,
      targetUrl: omitted.url,
      targetDatabase: omitted.database,
      organization: "NotRequested",
    });

    assert.equal(omittedReport.organization, "NotRequested");
    assert.equal(omittedReport.person.accepted, 16);
    assert.equal(omittedReport.historicalService.accepted, 1);
    assert.deepEqual(
      (
        await omitted.pool.query(`SELECT
    (SELECT count(*) FROM public.organization_memberships)::text AS appointments,
    (SELECT count(*) FROM public.organization_cohort_snapshots)::text AS snapshots
  `)
      ).rows[0],
      { appointments: "0", snapshots: "0" },
    );
    await assertAuthority(omitted, false);
    await forbiddenFacts(omitted.pool);

    stage = "OrganizationWithoutHistoricalService";
    await mysql("DELETE FROM vektor.assistant_history");

    const organizationOnlySource = await readLegacySourceSnapshot(
      sourceUrl,
      "Include",
      "NotRequested",
    );

    assert.equal(organizationOnlySource.history.length, 0);
    const organizationOnly = await target("organization_without_history");

    const organizationOnlyOptions = {
      ...options,
      targetUrl: organizationOnly.url,
      targetDatabase: organizationOnly.database,
    };

    const organizationOnlyReport = await runLegacyServiceCutover({
      ...organizationOnlyOptions,
      organization: reviewFor(organizationOnlySource),
    });

    assert.ok(organizationOnlyReport.organization !== "NotRequested");
    assert.equal(organizationOnlyReport.organization.accepted, 9);
    assert.equal(organizationOnlyReport.historicalService.stage, "NotImported");
    await assertCanonical(organizationOnly.pool);
    await assertAuthority(organizationOnly);
    await forbiddenFacts(organizationOnly.pool);

    stage = "EmptyRequestedOrganization";
    // Keep another selected cohort present, so this proves the Organization guard, not
    // merely the existing all-source-cohorts-empty guard.
    await mysql(
      "INSERT INTO vektor.assistant_history VALUES (301,1,1,1,1,'8','Bolk 1','Mandag'); DELETE FROM vektor.team_membership; DELETE FROM vektor.executive_board_membership",
    );
    const emptyOrganization = await readLegacySourceSnapshot(sourceUrl, "Include", "NotRequested");
    const beforeEmpty = await targetFingerprint(organizationOnly.pool);
    await assert.rejects(
      runLegacyServiceCutover({
        ...organizationOnlyOptions,
        organization: reviewFor(emptyOrganization),
      }),
      (cause: unknown) =>
        cause instanceof CutoverStageFailure && cause.stage === "OrganizationProjection",
    );
    assert.equal(await targetFingerprint(organizationOnly.pool), beforeEmpty);
    refusals.push("empty-requested-organization");

    return {
      scope: "FaithfulSyntheticElevenTableMariaDBToDisposablePostgreSQL",
      establishesProductionParity: false,
      establishesLiveOrganizationReconciliation: false,
      source: {
        revision: review.sourceRevision,
        omittedRevision: sourceRevision(omittedSource),
        fixtureDigest: digest(fixtureSql),
        reviewDigest: digest(review),
        watermark: review.sourceWatermark,
        asOf,
        tables: 11,
        occurrences: review.memberships.length,
        transformationRevision: first.source.transformationRevision,
        selectOnlyReader: true,
        credentialsExcludedFromRevision: true,
      },
      target: {
        schemaRevision: databaseSchemaRevision,
        counts: {
          Accepted: first.organization.accepted,
          Quarantined: first.organization.quarantined,
          Excluded: first.organization.excluded,
        },
        acceptedPeople: first.person.accepted,
      },
      refusals,
      observations: {
        positiveOperatorCLI: true,
        canonicalNonnumericPeople: true,
        canonicalDepartments: true,
        intervalsSuspensionTitlesAndDeletedTeam: true,
        nativeScopedLeaderOnly: true,
        inactiveTeamAndDepartmentDeny: true,
        exactPersonBinding: true,
        occurrenceCollisionRefused: true,
        acceptedCrossSnapshotPersonReplay: true,
        targetNotAdopted: true,
        sourceIdentityImmutable: true,
        firstAndConcurrentImport: true,
        nativeEditsSurviveConcurrentReplay: true,
        wholeCutoverRollbackAfterOrganization: true,
        appendOnlyEvidence: true,
        explicitOmission: true,
        malformedForeignKeyQuarantined: true,
        organizationWithoutHistoricalService: true,
        emptyRequestedOrganizationRefused: true,
      },
      privacy: {
        forbiddenFacts: noFabricatedFacts,
        rawPersonalFieldsPrinted: 0,
        credentialsPrinted: 0,
        evidenceDirectoryMode: "0700",
        evidenceFileMode: "0600",
      },
      productionResourcesUsed: false,
      externalProviderActions: false,
    };
  });

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);

  if (args.length === 1 && args[0] === "--help") {
    console.log(
      "Usage: bun --no-env-file tools/e2e/run-legacy-organization-rehearsal.ts --evidence-dir=<new-directory>\nRuns synthetic, private socket-only MariaDB/PostgreSQL. No backup, production, or provider access.",
    );

    return;
  }

  const output = args.length === 1 ? /^--evidence-dir=(.+)$/.exec(args[0]!)?.[1] : undefined;

  if (!output) throw new Error("Use --help or --evidence-dir=<new-directory>");
  const evidenceDirectory = resolve(output);
  await mkdir(evidenceDirectory, { mode: 0o700 });
  await chmod(evidenceDirectory, 0o700);
  const report = await rehearse();
  const evidenceFile = join(evidenceDirectory, "report.json");
  await writeFile(
    evidenceFile,
    JSON.stringify({ ...report, ownedDatabasesCleaned: true }, null, 2) + "\n",
    { mode: 0o600, flag: "wx" },
  );

  for (const [path, mode] of [
    [evidenceDirectory, 0o700],
    [evidenceFile, 0o600],
  ] as const) {
    const metadata = await lstat(path);
    assert.equal(metadata.isSymbolicLink(), false);
    assert.equal(metadata.uid, process.getuid?.());
    assert.equal(metadata.mode & 0o777, mode);
  }

  console.log(
    JSON.stringify(
      {
        scope: report.scope,
        sourceRevision: report.source.revision,
        counts: report.target.counts,
        evidence: "owner-only-report.json",
        ownedDatabasesCleaned: true,
      },
      null,
      2,
    ),
  );
};

if (process.argv[1] === fileURLToPath(import.meta.url))
  await main().catch(() => {
    console.error(`Synthetic organization rehearsal failed at ${stage}; details redacted`);
    process.exitCode = 1;
  });
