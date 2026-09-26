import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { scanIndex } from "../src/check.js";
import {
  sourcePathSafetyReason,
  sourceTextSafetyReason,
  unsafeEnvSourceTextReason,
  unsafeSqlSourceTextReason,
} from "../src/source-safety.js";

const repoRoot = join(import.meta.dir, "../../..");

const withGitFixture = (run: (root: string) => void): void => {
  const root = mkdtempSync("/tmp/source-safety-git-");

  try {
    execFileSync("git", ["-C", root, "init", "-q"]);
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const put = (root: string, path: string, contents: string | Uint8Array): void => {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
};

const stage = (root: string): void => {
  execFileSync("git", ["-C", root, "add", "--all"]);
};

describe("paths", () => {
  test("blocks credential, backup, and database path classes", () => {
    for (const path of [
      "config/credentials.json",
      "keys/server.pem",
      "var/backups/db.sql",
      "payloads/request.ndjson",
      "apps/example/config/jwt/private.pem",
      "apps/example/config/jwt/public.pem",
    ]) {
      expect(sourcePathSafetyReason(path)).toBe("UNSAFE_SOURCE");
    }

    for (const path of [
      ".env",
      ".env.local",
      "apps/homepage/.env.example",
      "apps/example/.env.test",
      "migrations/0001.sql",
      "var/logs/.gitkeep",
      "composer.lock",
      "tests/AppBundle/Service/CompanyEmailMakerTest.php",
      "apps/example/src/App/Interview/Infrastructure/Subscriber/InterviewSubscriber.php",
      "apps/homepage/src/routes/_home.team.bergen.styret.tsx",
    ]) {
      expect(sourcePathSafetyReason(path)).toBeNull();
    }
  });

  test("admits only exactly reviewed paths that resemble a blocked class", () => {
    for (const [path, unsafe] of [
      ["apps/backend/test/database.ts", false],
      ["tools/verification/credential-race.ts", false],
      ["patches/effect@4.0.0-rc.116.patch", false],
      ["apps/backend/test/database.sql", true],
      ["apps/backend/test/database-seed.ts", true],
      ["tools/verification/credentials.json", true],
      ["patches/person@university.no.patch", true],
      ["vendor/patches/effect@4.0.0.patch/credentials.json", true],
    ] as const) {
      expect(sourcePathSafetyReason(path) !== null).toBe(unsafe);
    }
  });

  test("admits the database package's module guides, and no other file under their names", () => {
    for (const [path, unsafe] of [
      ["packages/database/AGENTS.md", false],
      ["packages/database/src/placements/CLAUDE.md", false],
      ["packages/database/src/placements/notes.md", true],
      ["packages/database/src/placements/backups/AGENTS.md", true],
      ["packages/database/dumps/AGENTS.md", true],
    ] as const) {
      expect(sourcePathSafetyReason(path) !== null).toBe(unsafe);
    }
  });

  test("blocks personal data and credentials embedded in a path", () => {
    expect(sourcePathSafetyReason("exports/alice@university.no.csv")).toBe("UNSAFE_SOURCE");
    expect(sourcePathSafetyReason("notes/+47 912 34 567.txt")).toBe("UNSAFE_SOURCE");
    expect(sourcePathSafetyReason("notes/ghp_abcdefghijklmnop")).toBe("UNSAFE_SOURCE");
  });
});

describe("dotenv", () => {
  test("allows explicit test environment sentinels", () => {
    const envBytes = new TextEncoder().encode(
      "APP_ENV=test\nAPP_SECRET=test_app_secret_for_testing_only\nDATABASE_URL=sqlite:///:memory:\nJWT_PASSPHRASE=\n",
    );

    expect(sourceTextSafetyReason("apps/example/.env.test", envBytes)).toBeNull();
  });

  test("admits sentinels only in .env.test and rejects concrete values", () => {
    expect(
      unsafeEnvSourceTextReason(
        "APP_SECRET=test_app_secret_for_testing_only",
        "apps/example/.env.production",
      ),
    ).toBe("UNSAFE_SOURCE");
    expect(
      unsafeEnvSourceTextReason(
        "APP.SECRET=test_app_secret_for_testing_only",
        "apps/example/.env.test",
      ),
    ).toBe("UNSAFE_SOURCE");
    expect(unsafeEnvSourceTextReason("CLIENT.SECRET=", "apps/example/.env.test")).toBeNull();
    expect(unsafeEnvSourceTextReason("APP_ENV=@placeholder@", "apps/example/.env.test")).toBe(
      "UNSAFE_SOURCE",
    );
    expect(
      unsafeEnvSourceTextReason("APP_SECRET=${PRODUCTION_SECRET}", "apps/example/.env.production"),
    ).toBe("UNSAFE_SOURCE");
    expect(unsafeEnvSourceTextReason("APP_SECRET=", "apps/example/.env.production")).toBeNull();
  });
});

describe("SQL", () => {
  test("admits only exact reviewed migration bytes and rejects digest drift", () => {
    for (const migrationPath of [
      "packages/database/migrations/0027-native-oauth-provider.sql",
      "packages/database/migrations/0029-native-http-semantics.sql",
      "packages/database/migrations/0059-school-service-person-intervals.sql",
    ]) {
      const migration = readFileSync(join(repoRoot, migrationPath));
      const migrationText = new TextDecoder().decode(migration);
      expect(unsafeSqlSourceTextReason(migrationText)).toBe("UNSAFE_SOURCE");
      expect(sourceTextSafetyReason(migrationPath, migration)).toBeNull();
      expect(
        sourceTextSafetyReason(
          migrationPath,
          new TextEncoder().encode(`${migrationText}\n-- digest drift\n`),
        ),
      ).toBe("UNSAFE_SOURCE");
    }
  });

  test("accepts DDL comparisons without digest admission", () => {
    const migrationPath =
      "packages/database/migrations/0012-native-recruitment-invitation-response.sql";

    const migration = readFileSync(join(repoRoot, migrationPath));

    expect(sourceTextSafetyReason(migrationPath, migration)).toBeNull();
    expect(
      unsafeSqlSourceTextReason(
        "CREATE TABLE outbox (payload_json jsonb CHECK (jsonb_typeof(payload_json) = 'object'));",
      ),
    ).toBeNull();
    expect(
      unsafeSqlSourceTextReason("SELECT user_id FROM users WHERE user_id = current_user;"),
    ).toBeNull();
  });

  test("rejects sensitive UPDATE SET and procedural assignments", () => {
    for (const statement of [
      "UPDATE outbox SET payload_json = '{\"responseMessage\":\"concrete\"}'::jsonb WHERE effect_id = 'effect-1';",
      "api_token := 'concrete-token';",
      "SET password TO 'concrete-password';",
      "SET LOCAL api_token TO 'concrete-token';",
      "SELECT @password = 'concrete-password';",
      "password = 'concrete-password';",
      `CREATE FUNCTION rotate_credentials(should_rotate boolean) RETURNS void
       LANGUAGE plpgsql AS $procedure$
       BEGIN
         password = 'concrete-password';
         IF should_rotate THEN
           api_token = 'concrete-token';
         END IF;
       END;
       $procedure$;`,
    ]) {
      expect(unsafeSqlSourceTextReason(statement)).toBe("UNSAFE_SOURCE");
    }

    for (const comparison of [
      "SELECT user_id FROM users WHERE password = $1;",
      "SELECT user_id FROM users JOIN credentials ON credentials.password = $1;",
      "CREATE TABLE credential_check (password text, confirmation text, CHECK (password = confirmation));",
      `DO $procedure$
       BEGIN
         IF password = $1 THEN
           NULL;
         END IF;
       END;
       $procedure$;`,
    ]) {
      expect(unsafeSqlSourceTextReason(comparison)).toBeNull();
    }
  });

  test("allows strict parameterized INSERT SELECT recordsets", () => {
    expect(
      unsafeSqlSourceTextReason(`
        INSERT INTO person_contact_profiles (person_id, email, revision)
        SELECT seed_row.person_id, seed_row.email, seed_row.revision
        FROM jsonb_to_recordset($1::jsonb) AS seed_row(
          person_id text,
          email text,
          revision integer
        )
        WHERE TRUE
        ON CONFLICT (person_id) DO NOTHING;
      `),
    ).toBeNull();
    const seedPath = "apps/dashboard/e2e/native-team-interest-mailing-list-seed.sql";
    expect(sourceTextSafetyReason(seedPath, readFileSync(join(repoRoot, seedPath)))).toBeNull();
  });

  test("rejects literal, VALUES, stacked, and malformed recordset INSERTs", () => {
    const safeRecordset = `
      INSERT INTO person_profiles (person_id)
      SELECT seed_row.person_id
      FROM jsonb_to_recordset($1::jsonb) AS seed_row(person_id text);
    `;

    for (const statement of [
      "INSERT INTO person_profiles (person_id) VALUES ('person-literal');",
      "INSERT INTO person_profiles (person_id) VALUES ($1);",
      `INSERT INTO person_profiles (person_id, first_name)
       SELECT seed_row.person_id, 'Literal'
       FROM jsonb_to_recordset($1::jsonb) AS seed_row(person_id text, first_name text);`,
      `INSERT INTO person_profiles (person_id)
       SELECT seed_row.person_id
       FROM jsonb_to_recordset('[{"person_id":"person-literal"}]'::jsonb)
         AS seed_row(person_id text);`,
      `${safeRecordset}
       /* stacked literal DML must not inherit the first statement's authority */
       INSERT INTO person_profiles (person_id) VALUES ('person-literal');`,
      `${safeRecordset}
       UPDATE users SET password = 'concrete-password';`,
      "/*!50000 INSERT INTO person_profiles (person_id) VALUES ('person-literal') */;",
      `INSERT/**/INTO person_profiles (person_id)
       SELECT seed_row.person_id
       FROM jsonb_to_recordset($1::jsonb) AS seed_row(person_id text, email text);`,
      `INSERT INTO person_profiles (person_id)
       SELECT other_row.person_id
       FROM jsonb_to_recordset($1::jsonb) AS seed_row(person_id text);`,
      `INSERT INTO person_profiles (person_id)
       SELECT seed_row.person_id
       FROM jsonb_to_recordset($1::jsonb) AS seed_row(person_id text;`,
    ]) {
      expect(unsafeSqlSourceTextReason(statement)).toBe("UNSAFE_SOURCE");
    }
  });

  test("allows real migration DDL and placeholders but rejects literal secrets and personal data", () => {
    const migrationPath = "packages/database/migrations/tutor/0001-tutor-event-store.sql";
    expect(
      sourceTextSafetyReason(migrationPath, readFileSync(join(repoRoot, migrationPath))),
    ).toBeNull();
    expect(unsafeSqlSourceTextReason("UPDATE users SET password = '${PASSWORD}';")).toBeNull();
    expect(
      unsafeSqlSourceTextReason("UPDATE users SET password = '${PASSWORD}'; # password = 'secret'"),
    ).toBeNull();

    for (const statement of [
      "UPDATE users SET `password` /*!50000 = 'correct-horse-battery-staple' */;",
      "UPDATE users SET \"auth.secret\" /*!50000 = 'correct-horse-battery-staple' */;",
      "UPDATE users SET password = '/*correct-horse-battery-staple*/';",
      "UPDATE users SET password = '--correct-horse-battery-staple';",
      "SET @JWT_PASSPHRASE := 'correct-horse-battery-staple';",
      "UPDATE users SET [password] = 'correct-horse-battery-staple';",
      "UPDATE users SET password /*!50000\n-- ignored\n= 'correct-horse-battery-staple'\n*/;",
      "/*!50000 SET password = 'secret' /* nested */ */;",
      "/* unterminated password = 'secret';",
      "INSERT INTO users (email) VALUES ('alice@university.no');",
      "UPDATE users SET (\"password\", \"display_name\") = ('correct-horse-battery-staple', 'Alice');",
      "UPDATE users SET ((`password`), [display_name]) = ('concrete-password', 'Alice');",
    ]) {
      expect(unsafeSqlSourceTextReason(statement)).toBe("UNSAFE_SOURCE");
    }
  });
});

describe("index scan", () => {
  test("rejects unsafe staged paths, dotenv, SQL, and invalid UTF-8", () => {
    for (const [path, contents] of [
      ["apps/example/.env.test", "DATABASE_URL=mysql://vektor:concrete-secret@db/app\n"],
      ["apps/example/.env.production", "APP_SECRET=@correct-horse-battery-staple@\n"],
      [
        "packages/database/migrations/0100-malicious.sql",
        "INSERT INTO users (email) VALUES ('alice@university.no');\n",
      ],
      ["var/backups/latest.dump", "binary"],
      ["apps/example/.env.test", new Uint8Array([0x41, 0xff, 0xfe])],
    ] as const) {
      withGitFixture((root) => {
        put(root, "README.md", "safe\n");
        put(root, path, contents);
        stage(root);
        expect(scanIndex(root)).toEqual({
          files: 2,
          findings: [
            {
              path,
              reason: contents instanceof Uint8Array ? "INVALID_UTF8" : "UNSAFE_SOURCE",
            },
          ],
        });
      });
    }
  });

  test("checks the staged bytes, not the working tree", () => {
    withGitFixture((root) => {
      const path = "apps/example/.env.production";

      put(root, path, "APP_SECRET=\n");
      stage(root);
      put(root, path, "APP_SECRET=concrete-unstaged-secret\n");
      expect(scanIndex(root).findings).toEqual([]);

      stage(root);
      put(root, path, "APP_SECRET=\n");
      expect(scanIndex(root).findings).toEqual([{ path, reason: "UNSAFE_SOURCE" }]);
    });
  });
});
