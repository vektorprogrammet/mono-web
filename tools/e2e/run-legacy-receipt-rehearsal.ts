import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Buffer } from "node:buffer";
import process from "node:process";
import { postgresProgram } from "@monoweb/postgres";
import { databaseSchemaRevision } from "@vektorprogrammet/database/migrations";
import { storeReceiptImportResult } from "@vektorprogrammet/database/receipt/postgres";
import { DatabaseRuntimeLive } from "@vektorprogrammet/database/runtime";
import {
  importLegacyReceipt,
  receiptOutboxRequest,
  ReceiptReview,
  receiptSourceRevision,
  receiptSourceRowDigest,
  type ReceiptSourceRow,
} from "@vektorprogrammet/domain/receipt";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Effect, Match, Redacted, Schema } from "effect";
import type { Pool } from "pg";
import * as PaymentCustody from "@vektorprogrammet/backend/receipt/payment-account";
import * as FileCustody from "@vektorprogrammet/backend/receipt/filesystem";
import {
  decodeSnapshot,
  prepareReceiptSnapshot,
  rowDigest,
} from "@vektorprogrammet/backend/receipt/import-snapshot";
import { buildLegacyReferences } from "./legacy-cutover-references";
import {
  legacyReceiptBaseSourceRevision,
  legacyReceiptRows,
  legacyReceiptTransformationRevision,
} from "./legacy-receipt-snapshot";
import { readLegacySourceSnapshot } from "./legacy-source-snapshot";
import { runLegacyServiceCutover } from "./run-legacy-service-cutover";
import {
  digest,
  repositoryRoot,
  runLocal,
  runLocalResult,
  targetFingerprint,
  withOrganizationDatabases,
  type LocalCommandResult,
  type RehearsalTarget,
} from "./legacy-organization-rehearsal-runtime";

let stage = "Options";

const repository = "vektorprogrammet/vektorprogrammet";

const personSnapshotId = "synthetic-receipt-person-2026";

const sourceWatermark = "synthetic-source-2026-09-24";

const account = "8601.11.17947";

const normalizedAccount = "86011117947";

const alternateAccount = "12345678903";

const description = "PRIVATE-SYNTHETIC-RECEIPT-DESCRIPTION";

const pdf = Buffer.from("%PDF-1.4\nsynthetic receipt bytes\n%%EOF\n");

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

const jpeg = Buffer.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 255, 217]);

const sha256 = (bytes: string | Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

// The entire source is invented. No backup, provider, or supplied database is accepted.
// DATETIME zero values and DOUBLE fractions deliberately preserve malformed legacy facts.
const receiptFixtures = [
  { id: 1, status: "pending", path: "pending.pdf" },
  { id: 2, status: "rejected", path: "rejected.png" },
  { id: 3, status: "refunded", path: "refunded.jpeg" },
  { id: 4, path: "excluded-missing.pdf" },
  { id: 5, amount: "-1.25" },
  { id: 6, status: "unknown" },
  { id: 7, date: "0000-00-00 00:00:00" },
  { id: 8, visual: "DUPLICATE" },
  { id: 9, visual: "DUPLICATE" },
  { id: 10, user: 999 },
  { id: 11, user: 3 },
  { id: 12, user: 4 },
  { id: 13, path: "missing.pdf" },
  { id: 14, path: "../outside.pdf" },
  { id: 15, path: "outside-link.pdf" },
  { id: 16, path: "bad-digest.pdf" },
  { id: 17, path: "bad-size.pdf" },
  { id: 18, path: "bad-signature.pdf" },
  { id: 19, path: "oversized.pdf" },
  { id: 20, user: null },
  { id: 21, user: 5 },
  { id: 22, visual: null },
  { id: 23, amount: "1.234" },
  { id: 24 }, // Same-label native Person is not accepted ownership evidence.
  { id: 25 }, // Native department identity without the reviewed source mapping.
  { id: 26 }, // Missing occurrence evidence despite an existing native Person.
  { id: 27, submitted: "0000-00-00 00:00:00" },
] satisfies ReadonlyArray<{
  id: number;
  status?: string;
  path?: string;
  amount?: string;
  date?: string;
  visual?: string | null;
  user?: number | null;
  submitted?: string;
}>;

const fixtureSql = `
CREATE DATABASE vektor CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE vektor;
SET sql_mode='';
CREATE TABLE user (
 id INT PRIMARY KEY,is_active TINYINT NOT NULL,firstName VARCHAR(255),lastName VARCHAR(255),
 email VARCHAR(255),phone VARCHAR(255),user_name VARCHAR(255),companyEmail VARCHAR(255),
 password VARCHAR(255),accountNumber VARCHAR(45)
) ENGINE=InnoDB;
CREATE TABLE department (
 id INT PRIMARY KEY,name VARCHAR(255) NOT NULL,short_name VARCHAR(255) NOT NULL,
 email VARCHAR(255) NOT NULL,address VARCHAR(255),city VARCHAR(255) NOT NULL,
 latitude VARCHAR(255),longitude VARCHAR(255),slackChannel VARCHAR(255),logo_path VARCHAR(255),active TINYINT NOT NULL
) ENGINE=InnoDB;
CREATE TABLE semester(id INT PRIMARY KEY,semesterTime VARCHAR(255) NOT NULL,year VARCHAR(4) NOT NULL) ENGINE=InnoDB;
CREATE TABLE school(id INT PRIMARY KEY,name VARCHAR(255) NOT NULL,contactPerson VARCHAR(255) NOT NULL,
 email VARCHAR(255) NOT NULL,phone VARCHAR(255) NOT NULL,international TINYINT NOT NULL,active TINYINT NOT NULL) ENGINE=InnoDB;
CREATE TABLE department_school(department_id INT NOT NULL,school_id INT NOT NULL,PRIMARY KEY(department_id,school_id)) ENGINE=InnoDB;
CREATE TABLE assistant_history(id INT PRIMARY KEY,user_id INT,department_id INT,semester_id INT,school_id INT,
 workdays VARCHAR(255),bolk VARCHAR(255),day VARCHAR(255)) ENGINE=InnoDB;
CREATE TABLE receipt(id INT PRIMARY KEY,user_id INT,visual_id VARCHAR(255),\`sum\` DOUBLE NOT NULL,
 description VARCHAR(5000) NOT NULL,receiptDate DATETIME NOT NULL,submitDate DATETIME,
 status VARCHAR(255) NOT NULL,refundDate DATETIME,picture_path VARCHAR(255)) ENGINE=InnoDB;
INSERT INTO user VALUES
 (1,1,'FixtureGiven','FixtureFamily','fixture1@example.invalid','12345678',NULL,NULL,NULL,'${account}'),
 (2,1,'FixtureGiven','FixtureFamily','fixture2@example.invalid','12345678',NULL,NULL,NULL,'${account}'),
 (3,1,'Invalid','Owner','invalid-email','12345678',NULL,NULL,NULL,'${account}'),
 (4,1,'Missing','Account','fixture4@example.invalid','12345678',NULL,NULL,NULL,NULL),
 (5,1,'Invalid','Account','fixture5@example.invalid','12345678',NULL,NULL,NULL,'not-an-account');
INSERT INTO department VALUES(1,'Synthetic department','SYN','department@example.invalid',NULL,'Synthetic city',NULL,NULL,NULL,NULL,1);
INSERT INTO semester VALUES(1,'Vår','2026');
INSERT INTO school VALUES(1,'Synthetic school','Synthetic contact','school@example.invalid','12345678',0,1);
INSERT INTO department_school VALUES(1,1);
INSERT INTO assistant_history VALUES(301,1,1,1,1,'8','Bolk 1','Mandag');
INSERT INTO receipt VALUES
${receiptFixtures
  .map((row) => {
    const visual = row.visual === null ? "NULL" : `'${row.visual ?? `RECEIPT-${row.id}`}'`;
    const user = row.user === null ? "NULL" : String(row.user ?? 1);

    return (
      `(${row.id},${user},${visual},${row.amount ?? "12.34"},'${description}-${row.id}',` +
      `'${row.date ?? "2026-08-20 00:00:00"}','${row.submitted ?? "2026-08-21 12:00:00"}',` +
      `'${row.status ?? "pending"}','2026-09-01 00:00:00','${row.path ?? `row-${row.id}.pdf`}')`
    );
  })
  .join(",\n")};
CREATE USER 'legacy_organization_reader'@'localhost';
GRANT SELECT ON vektor.* TO 'legacy_organization_reader'@'localhost';
`;

const Summary = Schema.Struct({
  snapshotKey: Schema.String,
  replay: Schema.Boolean,
  input: Schema.Int,
  accepted: Schema.Int,
  quarantined: Schema.Int,
  excluded: Schema.Int,
  reconciled: Schema.Int,
  pending: Schema.Int,
  complete: Schema.Boolean,
  occurrences: Schema.Array(
    Schema.Struct({
      sourcePrimaryKey: Schema.String,
      disposition: Schema.Literals(["Accepted", "Quarantined", "Excluded"]),
      reasons: Schema.Array(Schema.String),
    }),
  ),
});

type Summary = typeof Summary.Type;

type Roots = { archive: string; staging: string; committed: string };

type StoredReceipt = {
  receipt_id: string;
  visual_id: string;
  owner_person_id: string;
  department_id: string;
  amount_ore: string;
  status: string;
  approved_at: string | null;
  description: string;
  payment_account_ciphertext: string;
  file_ref: string;
  file_object_key: string;
  file_content_type: "application/pdf" | "image/png" | "image/jpeg";
  file_byte_length: number;
  file_sha256: string;
  revision: number;
};

const privateJson = async (path: string, value: Schema.Json): Promise<void> => {
  await writeFile(path, JSON.stringify(value) + "\n", { mode: 0o600 });
  await chmod(path, 0o600);
};

const tree = async (root: string): Promise<Record<string, string>> => {
  const entries: Record<string, string> = {};

  const walk = async (directory: string): Promise<void> => {
    for (const item of await readdir(directory, { withFileTypes: true }).catch(
      (cause: NodeJS.ErrnoException) => {
        if (cause.code === "ENOENT") return [];
        throw cause;
      },
    )) {
      const path = join(directory, item.name);

      if (item.isDirectory()) await walk(path);
      else
        entries[relative(root, path)] = item.isSymbolicLink()
          ? "symlink"
          : sha256(await readFile(path));
    }
  };

  await walk(root);

  return entries;
};

const receipts = async (pool: Pool): Promise<StoredReceipt[]> =>
  (
    await pool.query<StoredReceipt>(`
 SELECT receipt_id,visual_id,owner_person_id,department_id,amount_ore::text AS amount_ore,status,
 to_char(approved_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS approved_at,
 description,payment_account_ciphertext,file_ref,file_object_key,file_content_type,file_byte_length,file_sha256,revision
 FROM public.economy_receipts ORDER BY visual_id
`)
  ).rows;

const noInventedEffects = async (pool: Pool): Promise<Record<string, number>> => {
  const tables = (
    await pool.query<{ name: string }>(`
    SELECT format('%I.%I',schemaname,tablename) AS name FROM pg_tables
    WHERE schemaname='public' AND (tablename LIKE '%audit%' OR tablename LIKE '%outbox%'
      OR tablename LIKE '%grant%' OR tablename LIKE '%settlement%' OR tablename LIKE '%transfer%'
      OR tablename LIKE '%command_receipt%' OR tablename LIKE 'economy_%authorities') ORDER BY 1
  `)
  ).rows;

  const result: Record<string, number> = {};

  for (const { name } of tables) {
    result[name] = Number(
      (await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${name}`)).rows[0]!
        .count,
    );
    assert.equal(result[name], 0, "Receipt import fabricated native authority or effects");
  }

  return result;
};

const assertNoAccountPersistence = async (pool: Pool): Promise<void> => {
  const tables = (
    await pool.query<{ name: string }>(`
    SELECT format('%I.%I',schemaname,tablename) AS name FROM pg_tables
    WHERE schemaname IN ('public','auth') ORDER BY 1
  `)
  ).rows;

  const forbidden = [
    account,
    normalizedAccount,
    alternateAccount,
    sha256(account),
    sha256(normalizedAccount),
  ];

  for (const { name } of tables) {
    const rows = (
      await pool.query<{ row: unknown }>(`SELECT to_jsonb(value) AS row FROM ${name} value`)
    ).rows;

    for (const row of rows) {
      const text = JSON.stringify(row);

      for (const secret of forbidden)
        assert.equal(text.includes(secret), false, "Account plaintext or unkeyed digest persisted");
    }
  }
};

const assertSummary = (report: Summary, accepted = 3): void => {
  assert.equal(report.input, receiptFixtures.length);
  assert.equal(report.accepted, accepted);
  assert.equal(report.excluded, 1);
  assert.equal(report.quarantined, receiptFixtures.length - accepted - 1);
  assert.equal(report.occurrences.length, receiptFixtures.length);
  assert.deepEqual(
    new Set(report.occurrences.map((row) => row.sourcePrimaryKey)),
    new Set(receiptFixtures.map((row) => String(row.id))),
  );

  const reason = (id: number, expected: string) => {
    const row = report.occurrences.find((entry) => entry.sourcePrimaryKey === String(id));
    assert.equal(row?.disposition, "Quarantined");
    assert.ok(row.reasons.includes(expected), `Quarantine ${id} omitted ${expected}`);
  };

  assert.equal(
    report.occurrences.find((row) => row.sourcePrimaryKey === "4")?.disposition,
    "Excluded",
  );

  for (const id of [5, 23]) reason(id, "InvalidAmount");
  reason(6, "UnknownStatus");
  reason(7, "InvalidReceiptDate");

  for (const id of [8, 9]) reason(id, "DuplicateVisualId");

  for (const id of [10, 11, 20, 24, 26]) reason(id, "UnresolvedOwner");

  for (const id of [12, 21]) reason(id, "MissingPaymentAccount");
  reason(14, "UnsafeFilePath");
  reason(15, "UnsafeFilePath");

  for (const id of [16, 17, 19]) reason(id, "FileDigestMismatch");
  reason(18, "UnsupportedFile");
  reason(22, "MissingVisualId");
  reason(25, "UnresolvedDepartment");
  reason(27, "InvalidSubmittedAt");
  assert.equal(
    report.occurrences.find((row) => row.sourcePrimaryKey === "13")?.disposition,
    "Quarantined",
  );
};

const rehearse = async () =>
  withOrganizationDatabases(fixtureSql, async ({ sourceUrl, mysql, target, temporaryRoot }) => {
    const checks: string[] = [];
    const checked = (name: string) => checks.push(name);
    const key = randomBytes(32);

    const cipher = PaymentCustody.makePaymentAccountCipher({
      keyId: "synthetic-receipt-key-v1",
      key,
    });

    const wrongCipher = PaymentCustody.makePaymentAccountCipher({
      keyId: cipher.keyId,
      key: randomBytes(32),
    });

    const keyPath = join(temporaryRoot, "payment-key.json");
    await privateJson(keyPath, { keyId: cipher.keyId, keyBase64: key.toString("base64") });

    stage = "SelectOnlySource";
    const source = await readLegacySourceSnapshot(sourceUrl, "NotRequested", "Include");
    const omitted = await readLegacySourceSnapshot(sourceUrl, "NotRequested", "NotRequested");
    assert.equal("receipts" in omitted, false);
    assert.equal("paymentAccounts" in omitted, false);
    assert.equal(
      legacyReceiptBaseSourceRevision(source),
      digest((({ credentials: _credentials, ...rest }) => rest)(omitted)),
    );
    assert.equal(source.receipts?.length, receiptFixtures.length);
    assert.equal(source.receipts?.find((row) => String(row.id) === "23")?.amountDecimal, "1.234");
    assert.ok(
      source.receipts?.find((row) => String(row.id) === "7")?.receiptDate.startsWith("0000-00-00"),
    );
    const writer = new URL(sourceUrl);
    writer.username = "root";
    await assert.rejects(
      readLegacySourceSnapshot(writer.toString(), "NotRequested", "Include"),
      /Grants/,
    );
    const sourceRows = legacyReceiptRows(source, cipher);
    const baseRevision = legacyReceiptBaseSourceRevision(source);
    const financeRevision = receiptSourceRevision(sourceRows);
    await mysql(
      `UPDATE vektor.user SET accountNumber='${alternateAccount}',password='synthetic-password-must-not-leak' WHERE id=1`,
    );
    const changedSecrets = await readLegacySourceSnapshot(sourceUrl, "NotRequested", "Include");
    assert.equal(legacyReceiptBaseSourceRevision(changedSecrets), baseRevision);
    assert.notEqual(
      receiptSourceRevision(legacyReceiptRows(changedSecrets, cipher)),
      financeRevision,
    );
    assert.notEqual(cipher.commitment(account), cipher.commitment(normalizedAccount));
    assert.notEqual(cipher.commitment(account), wrongCipher.commitment(account));
    assert.equal(JSON.stringify(sourceRows).includes(account), false);
    assert.equal(JSON.stringify(sourceRows).includes(sha256(account)), false);
    await mysql(`UPDATE vektor.user SET accountNumber='${account}',password=NULL WHERE id=1`);
    checked(
      "SELECT-only finance selection, exact decimal text, unchanged existing source shape, keyed raw-account commitment",
    );

    stage = "NativePersonAndReferences";

    const freshTarget = async (name: string): Promise<RehearsalTarget> => {
      const database = await target(name);

      const cutover = await runLegacyServiceCutover({
        sourceUrl,
        targetUrl: database.url,
        targetDatabase: database.database,
        snapshotId: personSnapshotId,
        attestedBy: "synthetic-reviewer",
        passwordlessPolicy: "ProvisionRecovery",
        currentAssignments: "NotRequested",
        organization: "NotRequested",
      });

      assert.equal(cutover.person.accepted, 4);
      assert.equal(cutover.person.quarantined, 1);
      assert.equal(cutover.references.digest, buildLegacyReferences(source).referenceDigest);

      return database;
    };

    const primary = await freshTarget("receipt_reviewed");
    const personSnapshotKey = digest([repository, personSnapshotId]);

    const acceptedPeople = (
      await primary.pool.query<{ source_user_id: string }>(
        "SELECT source_user_id FROM person_cohort_accepted_mappings WHERE snapshot_key=$1 ORDER BY source_user_id",
        [personSnapshotKey],
      )
    ).rows;

    assert.deepEqual(
      acceptedPeople.map((row) => row.source_user_id),
      ["legacy-user:1", "legacy-user:2", "legacy-user:4", "legacy-user:5"],
    );

    const rootsFor = async (name: string): Promise<Roots> => {
      const root = join(temporaryRoot, name);
      await mkdir(root, { mode: 0o700 });

      const roots = {
        archive: join(root, "archive"),
        staging: join(root, "staging"),
        committed: join(root, "private"),
      };

      for (const path of Object.values(roots)) await mkdir(path, { mode: 0o700 });

      for (const row of receiptFixtures) {
        if (row.id === 4 || row.id === 13 || row.id === 14 || row.id === 15) continue;

        const bytes = Match.value(row.id).pipe(
          Match.when(2, () => png),
          Match.when(3, () => jpeg),
          Match.when(18, () => Buffer.from("not-a-PDF-document")),
          Match.orElse(() => pdf),
        );

        await writeFile(join(roots.archive, row.path ?? `row-${row.id}.pdf`), bytes, {
          mode: 0o600,
        });
      }

      await truncate(join(roots.archive, "oversized.pdf"), 11 * 1024 * 1024);
      await writeFile(join(root, "outside.pdf"), pdf, { mode: 0o600 });
      await symlink(join(root, "outside.pdf"), join(roots.archive, "outside-link.pdf"));

      return roots;
    };

    const roots = await rootsFor("primary-files");

    const metadataFor = async (row: ReceiptSourceRow) => {
      const id = Number(row.sourcePrimaryKey);
      const path = row.picturePath!;

      const bytes = await Match.value(id).pipe(
        Match.when(19, () => readFile(join(roots.archive, path))),
        Match.when(2, () => png),
        Match.when(3, () => jpeg),
        Match.when(18, () => Buffer.from("not-a-PDF-document")),
        Match.orElse(() => pdf),
      );

      return {
        path,
        sha256: id === 16 ? "0".repeat(64) : sha256(bytes),
        byteLength: bytes.byteLength + (id === 17 ? 1 : 0),
        contentType: Match.value(id).pipe(
          Match.when(2, () => "image/png" as const),
          Match.when(3, () => "image/jpeg" as const),
          Match.orElse(() => "application/pdf" as const),
        ),
      };
    };

    const entries = await Promise.all(
      sourceRows.map(async (row) => {
        const id = Number(row.sourcePrimaryKey);

        const common = {
          sourcePrimaryKey: row.sourcePrimaryKey,
          sourceRowDigest: receiptSourceRowDigest(row),
          evidenceRef: `synthetic-receipt-evidence:${id}`,
        };

        if (id === 4)
          return { ...common, _tag: "Excluded" as const, reason: "ExplicitSyntheticExclusion" };
        const user = row.sourceUserId?.slice("legacy-user:".length) ?? "999";

        return {
          ...common,
          _tag: "Import" as const,
          person:
            row.sourceUserId === null
              ? null
              : {
                  occurrenceId: id === 26 ? "missing-occurrence" : `legacy-user-row-${user}`,
                  sourceUserId: row.sourceUserId,
                  personId: id === 24 ? "legacy-person-2" : `legacy-person-${user}`,
                },
          department: {
            sourceDepartmentId: id === 25 ? "legacy-department:999" : "legacy-department:1",
            departmentId: "legacy-department:1",
          },
          receiptDate: "2026-08-20",
          submittedAt: "2026-08-21T12:00:00Z",
          approvedAt: row.status === "refunded" ? "2026-09-02T12:00:00Z" : null,
          file: await metadataFor(row),
          payment: {
            commitment: row.accountCommitment,
            evidenceRef: `synthetic-account-ownership:${user}`,
          },
        };
      }),
    );

    const review = Schema.decodeSync(ReceiptReview)({
      sourceRepository: repository,
      sourceRevision: baseRevision,
      receiptSourceRevision: financeRevision,
      snapshotId: "synthetic-receipt-2026",
      sourceWatermark,
      transformationRevision: await Effect.runPromise(
        legacyReceiptTransformationRevision.pipe(Effect.provide(BunServices.layer)),
      ),
      personSnapshotKey,
      referenceSnapshotId: personSnapshotId,
      referenceDigest: buildLegacyReferences(source).referenceDigest,
      attestedBy: "synthetic-reviewer",
      evidenceRef: "synthetic-review-evidence",
      entries,
    });

    const reviewPath = join(temporaryRoot, "receipt-review.json");
    await privateJson(reviewPath, review);

    const sensitive = [
      account,
      normalizedAccount,
      alternateAccount,
      sha256(account),
      sha256(normalizedAccount),
      description,
      "fixture1@example.invalid",
      "FixtureGiven",
      key.toString("base64"),
      sourceUrl,
      temporaryRoot,
      "synthetic-password-must-not-leak",
      "private-sql-parameter-must-not-leak",
      "secret@",
    ];

    const noLeaks = (value: string): void => {
      for (const secret of sensitive)
        assert.equal(
          value.includes(secret),
          false,
          "Public output contains private source material",
        );
      assert.equal(
        value.includes("acceptedResults"),
        false,
        "Private accepted results escaped into public output",
      );
      assert.equal(value.includes("payment_account_ciphertext"), false);
    };

    noLeaks(await readFile(reviewPath, "utf8"));

    const cliArgs = (
      database: RehearsalTarget,
      files: Roots,
      selectedReview = reviewPath,
      selectedKey = keyPath,
    ) => [
      "bun",
      "--no-env-file",
      "tools/e2e/run-legacy-receipt-import.ts",
      `--review=${selectedReview}`,
      `--archive-root=${files.archive}`,
      `--staging-root=${files.staging}`,
      `--committed-root=${files.committed}`,
      `--payment-key=${selectedKey}`,
      "--source-env=RECEIPT_REHEARSAL_SOURCE",
      "--target-env=RECEIPT_REHEARSAL_TARGET",
      `--target-database=${database.database}`,
      "--organization-source=none",
    ];

    const invoke = async (
      database: RehearsalTarget,
      files: Roots,
      selectedReview = reviewPath,
      environment: Record<string, string> = {},
      selectedKey = keyPath,
    ) => {
      const output = await runLocalResult(
        cliArgs(database, files, selectedReview, selectedKey),
        undefined,
        {
          RECEIPT_REHEARSAL_SOURCE: sourceUrl,
          RECEIPT_REHEARSAL_TARGET: database.url,
          ...environment,
        },
      );

      noLeaks(output.stdout + output.stderr);

      return output;
    };

    const success = async (database: RehearsalTarget, files: Roots): Promise<Summary> => {
      const output = await invoke(database, files);
      assert.equal(output.stderr, "");
      const report = Schema.decodeUnknownSync(Summary)(JSON.parse(output.stdout));
      assert.equal(
        output.code,
        report.complete ? 0 : 2,
        "Actual receipt CLI exit status contradicts reconciliation state",
      );

      return report;
    };

    const safeFailure = (output: LocalCommandResult, code?: string): void => {
      assert.notEqual(output.code, 0);
      assert.equal(output.stdout, "");
      assert.match(output.stderr, /failed.*details redacted/);

      if (code) assert.ok(output.stderr.includes(code), "Safe failure lost stage/code");
      assert.equal(output.stderr.includes(" at "), false, "CLI leaked a stack trace");
    };

    stage = "ReviewFailuresBeforeTargetAndFileIO";
    const pristine = await targetFingerprint(primary.pool);
    const pristineFiles = await tree(roots.staging);

    const refusal = async (name: string, value: Schema.Json, code?: string) => {
      stage = name;
      const candidatePath = join(temporaryRoot, `${name}.json`);
      await privateJson(candidatePath, value);
      safeFailure(await invoke(primary, roots, candidatePath), code);
      assert.equal(await targetFingerprint(primary.pool), pristine);
      assert.deepEqual(await tree(roots.staging), pristineFiles);
      assert.deepEqual(await tree(roots.committed), {});
      checked(name);
    };

    await refusal("missing-review-entry", { ...review, entries: review.entries.slice(1) });
    await refusal("duplicate-review-entry", {
      ...review,
      entries: [...review.entries, review.entries[0]!],
    });
    await refusal("unknown-review-entry", {
      ...review,
      entries: [...review.entries, { ...review.entries[0], sourcePrimaryKey: "9999" }],
    });
    await refusal("changed-source-digest", {
      ...review,
      entries: review.entries.map((entry, index) =>
        index ? entry : { ...entry, sourceRowDigest: "0".repeat(64) },
      ),
    });
    await refusal(
      "wrong-person-snapshot",
      { ...review, personSnapshotKey: "0".repeat(64) },
      "PersonSnapshotConflict",
    );
    await refusal(
      "wrong-reference-snapshot",
      { ...review, referenceSnapshotId: "wrong-snapshot" },
      "ReferenceProvenanceConflict",
    );
    await refusal(
      "wrong-reference-digest",
      { ...review, referenceDigest: "0".repeat(64) },
      "Projection",
    );
    await refusal("wrong-transformation", { ...review, transformationRevision: "0".repeat(64) });
    const invalidPath = join(temporaryRoot, "invalid-shape.json");
    await privateJson(invalidPath, { entries: [] });

    const unavailable = {
      archive: join(temporaryRoot, "absent-archive"),
      staging: join(temporaryRoot, "absent-stage"),
      committed: join(temporaryRoot, "absent-committed"),
    };

    safeFailure(
      await invoke(primary, unavailable, invalidPath, {
        RECEIPT_REHEARSAL_SOURCE: "mysql://user:secret@127.0.0.1:1/no_source",
        RECEIPT_REHEARSAL_TARGET: `postgresql://user:secret@localhost/${primary.database}?host=${encodeURIComponent(join(temporaryRoot, "absent-postgres"))}`,
      }),
      "Review",
    );

    for (const path of Object.values(unavailable))
      await assert.rejects(lstat(path), { code: "ENOENT" });
    assert.equal(await targetFingerprint(primary.pool), pristine);
    checked("malformed review wins over unreachable connections and absent file roots");

    stage = "PrivateFilesAndTransportSelections";
    await chmod(reviewPath, 0o644);
    safeFailure(await invoke(primary, roots));
    await chmod(reviewPath, 0o600);
    await chmod(keyPath, 0o644);
    safeFailure(await invoke(primary, roots));
    await chmod(keyPath, 0o600);
    const reviewLink = join(temporaryRoot, "review-link.json");
    await symlink(reviewPath, reviewLink);
    safeFailure(await invoke(primary, roots, reviewLink));

    const transportSelections: Record<string, string>[] = [
      { RECEIPT_REHEARSAL_SOURCE: "mysql://user:secret@remote.example.invalid/vektor" },
      {
        RECEIPT_REHEARSAL_TARGET:
          "postgresql://user:secret@remote.example.invalid/receipt_reviewed?sslmode=disable",
      },
      { RECEIPT_REHEARSAL_SOURCE: "not-a-connection" },
    ];

    for (const environment of transportSelections)
      safeFailure(await invoke(primary, roots, reviewPath, environment));
    const wrongTarget = { ...primary, database: "not_selected_database" };
    safeFailure(await invoke(wrongTarget, roots));

    const malformedOptions = await runLocalResult(
      [...cliArgs(primary, roots), "--organization-source=unknown"],
      undefined,
      {
        RECEIPT_REHEARSAL_SOURCE: sourceUrl,
        RECEIPT_REHEARSAL_TARGET: primary.url,
      },
    );

    noLeaks(malformedOptions.stdout + malformedOptions.stderr);
    safeFailure(malformedOptions);
    assert.equal(await targetFingerprint(primary.pool), pristine);
    assert.deepEqual(await tree(roots.staging), pristineFiles);
    checked(
      "owner-only JSON and key files, symlink rejection, explicit selections, insecure remote transport refused",
    );

    stage = "FirstActualCLIImport";
    const first = await success(primary, roots);
    assertSummary(first);
    assert.equal(first.replay, false);
    assert.equal(first.reconciled, 3);
    assert.equal(first.pending, 0);
    assert.equal(first.complete, true);
    const initialReceipts = await receipts(primary.pool);
    assert.deepEqual(
      initialReceipts.map((row) => [row.visual_id, row.status, row.approved_at, row.amount_ore]),
      [
        ["RECEIPT-1", "Pending", null, "1234"],
        ["RECEIPT-2", "Rejected", null, "1234"],
        ["RECEIPT-3", "Approved", "2026-09-02T12:00:00.000Z", "1234"],
      ],
    );

    for (const row of initialReceipts) {
      assert.equal(row.owner_person_id, "legacy-person-1");
      assert.equal(row.department_id, "legacy-department:1");
      assert.equal(
        sha256(await readFile(join(roots.committed, row.file_object_key))),
        row.file_sha256,
      );
    }

    await noInventedEffects(primary.pool);
    await assertNoAccountPersistence(primary.pool);
    checked(
      "all occurrences accounted for; pending/rejected stale refunds ignored only by review; refunded means approval not payment",
    );
    checked(
      "missing/quarantined/null/wrong Person and wrong department ownership, malformed values, duplicate visual IDs and missing accounts quarantine",
    );
    checked(
      "real PDF/PNG/JPEG bytes; missing/traversal/outside symlink/digest/size/signature/oversize failures isolated",
    );

    stage = "ActualAuthenticatedEncryption";
    const encrypted = initialReceipts[0]!;
    assert.equal(
      cipher.decrypt(encrypted.payment_account_ciphertext, encrypted.receipt_id),
      normalizedAccount,
    );
    assert.throws(() =>
      wrongCipher.decrypt(encrypted.payment_account_ciphertext, encrypted.receipt_id),
    );
    assert.throws(() =>
      cipher.decrypt(encrypted.payment_account_ciphertext, initialReceipts[1]!.receipt_id),
    );
    const ciphertext = encrypted.payment_account_ciphertext;
    const tamperIndex = ciphertext.length - 4;

    const tampered =
      ciphertext.slice(0, tamperIndex) +
      (ciphertext[tamperIndex] === "A" ? "B" : "A") +
      ciphertext.slice(tamperIndex + 1);

    assert.throws(() => cipher.decrypt(tampered, encrypted.receipt_id));
    const additional = cipher.encrypt(account, encrypted.receipt_id);
    assert.notEqual(additional, ciphertext);
    assert.equal(cipher.decrypt(additional, encrypted.receipt_id), normalizedAccount);
    const ciphertexts = initialReceipts.map((row) => row.payment_account_ciphertext);
    assert.equal(new Set(ciphertexts).size, 3);
    checked(
      "real authenticated decryption, wrong key/context/tamper rejection, fresh nonces and no plaintext/unkeyed hash in SQL or output",
    );

    stage = "ExactReplay";
    const acceptedFingerprint = await targetFingerprint(primary.pool);
    const replay = await success(primary, roots);
    assertSummary(replay);
    assert.equal(replay.replay, true);
    assert.equal(replay.complete, true);
    assert.equal(await targetFingerprint(primary.pool), acceptedFingerprint);
    assert.deepEqual(await receipts(primary.pool), initialReceipts);
    checked(
      "actual process restart exact replay preserves ciphertext, identities, dispositions and facts",
    );

    stage = "UnchangedAcceptedSourceAcrossSnapshots";

    const bindingsBeforeReuse = (
      await primary.pool.query(
        "SELECT * FROM receipt_cohort_source_bindings ORDER BY source_primary_key",
      )
    ).rows;

    const acceptedBeforeReuse = (
      await primary.pool.query(
        "SELECT accepted_result_json FROM receipt_cohort_occurrences WHERE snapshot_key=$1 AND disposition='Accepted' ORDER BY source_primary_key",
        [first.snapshotKey],
      )
    ).rows;

    const committedBeforeReuse = await tree(roots.committed);
    const laterReviewPath = join(temporaryRoot, "unchanged-source-later-snapshot.json");
    await privateJson(laterReviewPath, {
      ...review,
      snapshotId: "synthetic-receipt-unchanged-later",
    });
    const reusedOutput = await invoke(primary, roots, laterReviewPath);
    assert.equal(reusedOutput.code, 0);
    assert.equal(reusedOutput.stderr, "");
    const reused = Schema.decodeUnknownSync(Summary)(JSON.parse(reusedOutput.stdout));
    assertSummary(reused);
    assert.equal(reused.replay, false);
    assert.equal(reused.complete, true);
    assert.notEqual(reused.snapshotKey, first.snapshotKey);
    assert.deepEqual(await receipts(primary.pool), initialReceipts);
    assert.deepEqual(
      (
        await primary.pool.query(
          "SELECT * FROM receipt_cohort_source_bindings ORDER BY source_primary_key",
        )
      ).rows,
      bindingsBeforeReuse,
    );
    assert.deepEqual(
      (
        await primary.pool.query(
          "SELECT accepted_result_json FROM receipt_cohort_occurrences WHERE snapshot_key=$1 AND disposition='Accepted' ORDER BY source_primary_key",
          [reused.snapshotKey],
        )
      ).rows,
      acceptedBeforeReuse,
    );
    assert.deepEqual(
      (
        await primary.pool.query(
          "SELECT count(*)::int AS count FROM economy_receipt_import_ledger WHERE result='Accepted'",
        )
      ).rows,
      [{ count: 3 }],
    );
    assert.deepEqual(await tree(roots.committed), committedBeforeReuse);
    await noInventedEffects(primary.pool);
    checked(
      "unchanged accepted source crosses snapshots with original facts, ciphertext, file identities and exactly one durable source binding",
    );

    stage = "ReplayReobservesCorruptAndMissingBytes";
    const committedPath = join(roots.committed, encrypted.file_object_key);
    const originalBytes = await readFile(committedPath);
    await writeFile(committedPath, "corrupt-private-bytes");
    const corruptReplay = await success(primary, roots);
    assert.equal(corruptReplay.complete, false);
    assert.equal(corruptReplay.pending, 1);
    assert.equal((await receipts(primary.pool))[0]!.payment_account_ciphertext, ciphertext);
    await rm(committedPath);
    const archivePath = join(roots.archive, "pending.pdf");
    await rm(archivePath);
    const missingReplay = await success(primary, roots);
    assert.equal(missingReplay.complete, false);
    assert.equal(missingReplay.pending, 1);
    await writeFile(archivePath, originalBytes, { mode: 0o600 });
    const recoveredReplay = await success(primary, roots);
    assert.equal(recoveredReplay.complete, true);
    assert.equal(sha256(await readFile(committedPath)), encrypted.file_sha256);
    assert.deepEqual(await receipts(primary.pool), initialReceipts);
    checked(
      "fresh replay detects corrupt/deleted custody and restores original bytes from authorized archive",
    );

    stage = "NativeEditPreservation";
    await primary.pool.query(
      "UPDATE economy_receipts SET description='native edited receipt',amount_ore=4321,revision=revision+1 WHERE receipt_id=$1",
      [encrypted.receipt_id],
    );
    const edited = await receipts(primary.pool);
    const editedReplay = await success(primary, roots);
    assert.equal(editedReplay.replay, true);
    assert.equal(editedReplay.complete, false);
    assert.equal(editedReplay.pending, 1);
    assert.deepEqual(await receipts(primary.pool), edited);
    assert.deepEqual(
      edited.map((row) => row.payment_account_ciphertext),
      ciphertexts,
    );
    checked(
      "native edit remains authoritative; replay retains original encrypted import evidence and reports drift pending",
    );

    stage = "ImmutableSourceAndReviewConflicts";
    const conflictFingerprint = await targetFingerprint(primary.pool);
    const conflictFiles = await tree(roots.committed);

    const conflict = async (name: string, candidate: Schema.Json, code?: string) => {
      stage = name;
      const path = join(temporaryRoot, `${name}.json`);
      await privateJson(path, candidate);
      safeFailure(await invoke(primary, roots, path), code);
      assert.equal(await targetFingerprint(primary.pool), conflictFingerprint);
      assert.deepEqual(await tree(roots.committed), conflictFiles);
      checked(name);
    };

    await conflict(
      "same-snapshot-review-collision",
      { ...review, evidenceRef: "changed-evidence" },
      "SnapshotConflict",
    );
    await conflict(
      "cross-snapshot-review-collision",
      { ...review, snapshotId: "changed-snapshot", evidenceRef: "changed-evidence" },
      "SourceConflict",
    );
    await mysql(`UPDATE vektor.receipt SET description='${description}-changed' WHERE id=1`);

    const changedRows = legacyReceiptRows(
      await readLegacySourceSnapshot(sourceUrl, "NotRequested", "Include"),
      cipher,
    );

    await conflict(
      "changed-accepted-source",
      {
        ...review,
        snapshotId: "changed-source-snapshot",
        receiptSourceRevision: receiptSourceRevision(changedRows),
        entries: review.entries.map((entry) => ({
          ...entry,
          sourceRowDigest: receiptSourceRowDigest(
            changedRows.find((row) => row.sourcePrimaryKey === entry.sourcePrimaryKey)!,
          ),
        })),
      },
      "SourceConflict",
    );
    await mysql(`UPDATE vektor.receipt SET description='${description}-1' WHERE id=1`);
    await mysql(`UPDATE vektor.user SET accountNumber='${alternateAccount}' WHERE id=1`);
    safeFailure(await invoke(primary, roots));
    assert.equal(await targetFingerprint(primary.pool), conflictFingerprint);
    await mysql(`UPDATE vektor.user SET accountNumber='${account}' WHERE id=1`);
    checked("changed source account invalidates reviewed commitment without target/file mutation");

    stage = "NativeLedgerOwnershipWithoutReviewedBinding";
    const nativeOwnership = await freshTarget("receipt_native_ownership");
    const nativeRoots = await rootsFor("native-ownership-files");

    const nativeFiles = await Effect.runPromise(
      FileCustody.makeReceiptFileStore({
        stagingRoot: nativeRoots.staging,
        committedRoot: nativeRoots.committed,
      }).pipe(Effect.provide(BunServices.layer)),
    );

    const nativeIdentity = "prior-native-receipt";

    const nativeFile = await Effect.runPromise(
      nativeFiles.stageBytes(
        new File([pdf], "native.pdf"),
        nativeIdentity,
        "application/pdf",
        10 * 1024 * 1024,
      ),
    );

    const nativeEntry = review.entries.find((entry) => entry.sourcePrimaryKey === "1");
    assert.ok(nativeEntry?._tag === "Import" && nativeEntry.person !== null);

    const nativeRow = {
      sourcePrimaryKey: "1",
      ownerPersonId: nativeEntry.person.personId,
      departmentId: nativeEntry.department.departmentId,
      visualId: "PRIOR-NATIVE-RECEIPT",
      amountDecimal: "12.34",
      description: "Native accepted source ownership",
      receiptDate: "2026-08-20",
      submittedAt: "2026-08-21T12:00:00.000Z",
      status: "pending",
      refundDate: null,
      paymentAccountCiphertext: cipher.encrypt(account, nativeIdentity),
      file: nativeFile.file,
    };

    const nativeProvenance = {
      sourceRepository: repository,
      sourceRevision: "prior-native-revision",
      snapshotId: "prior-native-snapshot",
      sourceWatermark,
      transformationRevision: "prior-native-transform",
      sourceDigest: nativeEntry.sourceRowDigest,
      destinationIdentity: nativeIdentity,
    };

    const nativeImport = importLegacyReceipt(nativeRow, nativeIdentity, nativeProvenance);
    assert.equal(nativeImport._tag, "AcceptedReceiptImport");
    await Effect.runPromise(
      storeReceiptImportResult(nativeImport).pipe(
        Effect.provide(
          DatabaseRuntimeLive({
            url: Redacted.make(nativeOwnership.url),
            host: new URL(nativeOwnership.url).searchParams.get("host") ?? undefined,
            applicationName: "receipt-native-ownership-proof",
            maxConnections: 2,
          }),
        ),
      ),
    );
    await Effect.runPromise(
      nativeFiles.service.apply(
        receiptOutboxRequest(
          "prior-native-command",
          nativeIdentity,
          "PromoteReceiptFile",
          nativeFile.file,
        ),
      ),
    );
    assert.equal((await receipts(nativeOwnership.pool))[0]?.receipt_id, nativeIdentity);
    assert.deepEqual(
      (
        await nativeOwnership.pool.query(
          "SELECT count(*)::int AS count FROM receipt_cohort_source_bindings",
        )
      ).rows,
      [{ count: 0 }],
    );
    const nativeBeforeReviewed = await targetFingerprint(nativeOwnership.pool);
    const nativeBytesBeforeReviewed = await tree(nativeRoots.committed);
    safeFailure(await invoke(nativeOwnership, nativeRoots), "SourceConflict");
    assert.equal(await targetFingerprint(nativeOwnership.pool), nativeBeforeReviewed);
    assert.deepEqual(await tree(nativeRoots.committed), nativeBytesBeforeReviewed);
    assert.deepEqual(await tree(nativeRoots.staging), {});
    checked(
      "accepted native ledger owns source even without a reviewed binding; reviewed CLI rejects before staging or mutation",
    );

    stage = "ReviewedOwnershipBlocksAlternateNativeImport";
    const reverseIdentity = "attempted-second-native-receipt";

    const reverseImport = importLegacyReceipt(
      {
        ...nativeRow,
        visualId: "ATTEMPTED-SECOND-NATIVE",
        paymentAccountCiphertext: cipher.encrypt(account, reverseIdentity),
      },
      reverseIdentity,
      {
        ...nativeProvenance,
        snapshotId: "reverse-native-snapshot",
        destinationIdentity: reverseIdentity,
      },
    );

    assert.equal(reverseImport._tag, "AcceptedReceiptImport");
    const receiptsBeforeNativeAttempt = await receipts(primary.pool);

    const reviewedBindingsBeforeNativeAttempt = (
      await primary.pool.query(
        "SELECT * FROM receipt_cohort_source_bindings ORDER BY source_primary_key",
      )
    ).rows;

    await Effect.runPromise(
      storeReceiptImportResult(reverseImport).pipe(
        Effect.provide(
          DatabaseRuntimeLive({
            url: Redacted.make(primary.url),
            host: new URL(primary.url).searchParams.get("host") ?? undefined,
            applicationName: "receipt-native-ownership-proof",
            maxConnections: 2,
          }),
        ),
      ),
    );
    assert.deepEqual(await receipts(primary.pool), receiptsBeforeNativeAttempt);
    assert.deepEqual(
      (
        await primary.pool.query(
          "SELECT * FROM receipt_cohort_source_bindings ORDER BY source_primary_key",
        )
      ).rows,
      reviewedBindingsBeforeNativeAttempt,
    );
    assert.deepEqual(
      (
        await primary.pool.query(
          "SELECT result,reasons_json FROM economy_receipt_import_ledger WHERE snapshot_id='reverse-native-snapshot'",
        )
      ).rows,
      [{ result: "Quarantined", reasons_json: { reasons: ["SourceIdentityCollision"] } }],
    );
    assert.deepEqual(await tree(roots.committed), conflictFiles);
    await noInventedEffects(primary.pool);
    checked(
      "alternate native importer cannot acquire an already reviewed source: persisted quarantine, no second receipt or file change",
    );

    stage = "ConcurrentActualCLIImports";
    const concurrent = await freshTarget("receipt_concurrent");
    const concurrentRoots = await rootsFor("concurrent-files");

    const concurrentReports = await Promise.all([
      success(concurrent, concurrentRoots),
      success(concurrent, concurrentRoots),
    ]);

    for (const report of concurrentReports) assertSummary(report);
    assert.deepEqual(
      concurrentReports.map((report) => report.replay).sort((a, b) => Number(a) - Number(b)),
      [false, true],
    );
    const concurrencyReplay = await success(concurrent, concurrentRoots);
    assert.equal(concurrencyReplay.complete, true);
    const concurrentReceipts = await receipts(concurrent.pool);
    assert.equal(concurrentReceipts.length, 3);
    assert.deepEqual(
      (
        await concurrent.pool.query(
          "SELECT count(*)::int AS count FROM receipt_cohort_source_bindings",
        )
      ).rows,
      [{ count: 3 }],
    );
    await noInventedEffects(concurrent.pool);
    checked(
      "concurrent real CLI imports serialize source ownership; one cohort, no duplicate receipt or effects",
    );

    stage = "PersistedDestinationCollision";
    const collision = await freshTarget("receipt_collision");
    const collisionRoots = await rootsFor("collision-files");
    const nativePath = join(collisionRoots.committed, "native", "unrelated.pdf");
    await mkdir(join(collisionRoots.committed, "native"), { mode: 0o700 });
    await writeFile(nativePath, pdf, { mode: 0o600 });
    await collision.pool.query(
      `INSERT INTO economy_receipts(
    receipt_id,visual_id,owner_person_id,department_id,amount_ore,currency,description,receipt_date,
    submitted_at,status,approved_at,payment_account_ciphertext,file_ref,file_object_key,file_content_type,file_byte_length,file_sha256,revision
  ) VALUES('unrelated-native-receipt','RECEIPT-1','legacy-person-1','legacy-department:1',999,'NOK','Native receipt','2026-08-20',
    '2026-08-21T12:00:00Z','Pending',NULL,$1,'native-stage/unrelated.pdf','native/unrelated.pdf','application/pdf',$2,$3,4)`,
      [cipher.encrypt(account, "unrelated-native-receipt"), pdf.byteLength, sha256(pdf)],
    );
    const nativeBefore = (await receipts(collision.pool))[0]!;
    const collisionReport = await success(collision, collisionRoots);
    assertSummary(collisionReport, 2);
    assert.ok(
      collisionReport.occurrences
        .find((row) => row.sourcePrimaryKey === "1")
        ?.reasons.includes("DuplicateVisualId"),
    );
    assert.deepEqual(
      (await receipts(collision.pool)).find((row) => row.receipt_id === "unrelated-native-receipt"),
      nativeBefore,
    );
    assert.equal(sha256(await readFile(nativePath)), sha256(pdf));
    const collisionReplay = await success(collision, collisionRoots);
    assertSummary(collisionReplay, 2);
    assert.equal(collisionReplay.replay, true);
    assert.equal(sha256(await readFile(nativePath)), sha256(pdf));
    checked(
      "persisted collision overrides classifier acceptance; prior dispositions replay; unrelated native bytes remain owned by native receipt",
    );

    stage = "WholeCohortTransactionRollback";
    const rollback = await freshTarget("receipt_rollback");
    const rollbackRoots = await rootsFor("rollback-files");
    await mkdir(join(rollbackRoots.committed, "native"), { mode: 0o700 });
    const unrelated = join(rollbackRoots.committed, "native", "retained.pdf");
    await writeFile(unrelated, pdf, { mode: 0o600 });
    await rollback.pool
      .query(`CREATE FUNCTION fail_receipt_proof_insert() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'private-sql-parameter-must-not-leak'; END $$;
    CREATE TRIGGER fail_receipt_proof_insert BEFORE INSERT ON receipt_cohort_occurrences
    FOR EACH ROW EXECUTE FUNCTION fail_receipt_proof_insert()`);
    // A previous accepted import owns these bytes; this failed attempt must not remove them.
    await mkdir(join(rollbackRoots.staging, "staging"), { mode: 0o700 });
    await writeFile(join(rollbackRoots.staging, encrypted.file_ref), pdf, { mode: 0o600 });
    const preexistingStage = await tree(rollbackRoots.staging);
    const beforeRollback = await targetFingerprint(rollback.pool);
    safeFailure(await invoke(rollback, rollbackRoots), "PersistenceFailure");
    assert.equal(await targetFingerprint(rollback.pool), beforeRollback);
    assert.deepEqual(await tree(rollbackRoots.staging), preexistingStage);
    assert.equal(sha256(await readFile(unrelated)), sha256(pdf));
    safeFailure(await invoke(rollback, roots), "PersistenceFailure");
    assert.equal(await targetFingerprint(rollback.pool), beforeRollback);
    assert.deepEqual(await tree(roots.committed), conflictFiles);
    await rollback.pool.query(
      "DROP TRIGGER fail_receipt_proof_insert ON receipt_cohort_occurrences; DROP FUNCTION fail_receipt_proof_insert()",
    );
    const afterRollback = await success(rollback, rollbackRoots);
    assertSummary(afterRollback);
    assert.equal(afterRollback.complete, true);
    checked(
      "real SQL failure after receipt writes rolls back whole cohort, cleans only owned staging, safe SQL error, retry succeeds",
    );

    stage = "DurableIncompletePromotion";
    const pending = await freshTarget("receipt_pending");
    const pendingRoots = await rootsFor("pending-files");
    await writeFile(join(pendingRoots.committed, "committed"), "promotion-obstruction", {
      mode: 0o600,
    });
    const pendingReport = await success(pending, pendingRoots);
    assertSummary(pendingReport);
    assert.equal(pendingReport.complete, false);
    assert.equal(pendingReport.pending, 3);
    assert.equal(pendingReport.reconciled, 0);
    const pendingReceipts = await receipts(pending.pool);

    for (const receipt of pendingReceipts)
      assert.equal(
        sha256(await readFile(join(pendingRoots.staging, receipt.file_ref))),
        receipt.file_sha256,
      );

    const durablePending = (
      await pending.pool.query(
        "SELECT reconciliation_result,count(*)::int AS count FROM economy_receipt_import_ledger WHERE result='Accepted' GROUP BY reconciliation_result",
      )
    ).rows;

    assert.deepEqual(durablePending, [{ reconciliation_result: "Pending", count: 3 }]);
    checked(
      "actual filesystem promotion failure commits explicit Pending metadata and retains staged bytes",
    );

    stage = "RestoreIncompleteWork";
    const dumpPath = join(temporaryRoot, "pending.dump");
    await runLocal([
      postgresProgram("pg_dump"),
      "--dbname",
      pending.url,
      "--format=custom",
      "--file",
      dumpPath,
    ]);
    await chmod(dumpPath, 0o600);
    const restore = await target("receipt_restored");
    await runLocal([
      postgresProgram("pg_restore"),
      "--dbname",
      restore.url,
      "--clean",
      "--if-exists",
      "--exit-on-error",
      "--no-owner",
      dumpPath,
    ]);
    const restoredRoot = join(temporaryRoot, "restored-files");
    await mkdir(restoredRoot, { mode: 0o700 });

    const restoredRoots = {
      archive: join(restoredRoot, "archive"),
      staging: join(restoredRoot, "staging"),
      committed: join(restoredRoot, "private"),
    };

    await cp(pendingRoots.archive, restoredRoots.archive, { recursive: true, dereference: false });
    await cp(pendingRoots.staging, restoredRoots.staging, { recursive: true });
    await mkdir(restoredRoots.committed, { mode: 0o700 });
    assert.deepEqual(await receipts(restore.pool), pendingReceipts);
    // Destroy one staged object in the restored copy: durable metadata and the authorized archive must suffice.
    await rm(join(restoredRoots.staging, pendingReceipts[0]!.file_ref));
    const restoredReport = await success(restore, restoredRoots);
    assertSummary(restoredReport);
    assert.equal(restoredReport.replay, true);
    assert.equal(restoredReport.complete, true);
    assert.deepEqual(await receipts(restore.pool), pendingReceipts);

    for (const receipt of pendingReceipts)
      assert.equal(
        sha256(await readFile(join(restoredRoots.committed, receipt.file_object_key))),
        receipt.file_sha256,
      );
    await noInventedEffects(restore.pool);
    await assertNoAccountPersistence(restore.pool);
    await rm(join(pendingRoots.committed, "committed"));
    const pendingRecovery = await success(pending, pendingRoots);
    assert.equal(pendingRecovery.complete, true);
    assert.equal(pendingRecovery.replay, true);
    assert.deepEqual(await receipts(pending.pool), pendingReceipts);
    checked(
      "real pg_dump/pg_restore plus private-file restore resumes incomplete work in new CLI process; missing stage rebuilt; original ciphertext and facts retained",
    );

    stage = "SyntheticAdapterCompatibility";

    const syntheticFiles = await Effect.runPromise(
      FileCustody.makeReceiptFileStore({
        stagingRoot: join(temporaryRoot, "synthetic-stage"),
        committedRoot: join(temporaryRoot, "synthetic-committed"),
      }).pipe(Effect.provide(BunServices.layer)),
    );

    const syntheticRow = {
      sourcePrimaryKey: "synthetic-source",
      destinationIdentity: "synthetic-target",
      sourceUser: "synthetic-owner",
      sourceDepartment: "synthetic-department",
      visualId: "SYNTHETIC-ONLY",
      amountDecimal: "1.25",
      description: "Synthetic adapter compatibility",
      receiptDate: "2026-08-20",
      submittedAt: "2026-08-21T12:00:00Z",
      status: "pending",
      refundDate: null,
      file: {
        path: "pending.pdf",
        sha256: sha256(pdf),
        byteLength: pdf.length,
        contentType: "application/pdf",
      },
    };

    const { sourcePrimaryKey, destinationIdentity, ...syntheticData } = syntheticRow;

    const syntheticInput = {
      kind: "synthetic-receipt-import-0095",
      sourceRepository: "synthetic",
      sourceRevision: "1",
      snapshotId: "1",
      sourceWatermark: "0",
      transformationRevision: "1",
      persons: [
        {
          sourceUser: "synthetic-owner",
          personId: "synthetic-owner",
          syntheticPaymentAccount: "synthetic:0095:not-a-payment-account",
        },
      ],
      departments: [
        { sourceDepartment: "synthetic-department", departmentId: "synthetic-department" },
      ],
      rows: [
        {
          sourcePrimaryKey,
          destinationIdentity,
          data: syntheticData,
          rowDigest: rowDigest(syntheticRow),
        },
      ],
    };

    const synthetic = await Effect.runPromise(
      prepareReceiptSnapshot(decodeSnapshot(syntheticInput), roots.archive, syntheticFiles).pipe(
        Effect.provide(BunServices.layer),
      ),
    );

    assert.equal(synthetic.results[0]?._tag, "AcceptedReceiptImport");
    assert.throws(() =>
      decodeSnapshot({
        ...syntheticInput,
        persons: [{ ...syntheticInput.persons[0], syntheticPaymentAccount: account }],
      }),
    );
    assert.throws(() => decodeSnapshot({ ...syntheticInput, kind: "legacy-receipt-import" }));
    checked(
      "existing bounded synthetic adapter still accepts only its explicit non-payment fixture account and kind",
    );

    const report = {
      scope: "synthetic-reviewed-receipt-reconciliation",
      schemaRevision: databaseSchemaRevision,
      source: {
        repository,
        revision: baseRevision,
        receiptRevision: financeRevision,
        transformationRevision: review.transformationRevision,
        watermark: sourceWatermark,
      },
      counts: {
        input: first.input,
        accepted: first.accepted,
        quarantined: first.quarantined,
        excluded: first.excluded,
      },
      checks,
      noInventedEffects: await noInventedEffects(primary.pool),
      cli: {
        command:
          "bun --no-env-file tools/e2e/run-legacy-receipt-import.ts --review=<private-json> --archive-root=<private-archive> --staging-root=<private-stage> --committed-root=<private-store> --payment-key=<private-key> --source-env=RECEIPT_REHEARSAL_SOURCE --target-env=RECEIPT_REHEARSAL_TARGET --target-database=<disposable-database> --organization-source=none",
        transport: "private Unix sockets",
        databaseFixture: "invented MariaDB InnoDB rows",
      },
      limits: [
        "No historical data or provider access",
        "No payment or settlement proof",
        "Historical import requires a real file archive and resolved ownership, department and account evidence",
        "CLI process restart and logical database/file restore; no power-loss simulation",
      ],
    };

    noLeaks(JSON.stringify(report));

    return report;
  });

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);

  if (args.length === 1 && args[0] === "--help") {
    console.log(
      "Usage: bun --no-env-file tools/e2e/run-legacy-receipt-rehearsal.ts --evidence-dir=<new-directory>\nRuns invented source rows on private socket-only MariaDB/PostgreSQL and actual receipt CLI. No backup, production, or provider access.",
    );

    return;
  }

  const output = args.length === 1 ? /^--evidence-dir=(.+)$/.exec(args[0]!)?.[1] : undefined;

  if (!output) throw new Error("Use --help or --evidence-dir=<new-directory>");
  const evidenceDirectory = resolve(output);
  const relativeEvidence = relative(repositoryRoot, evidenceDirectory);

  if (
    !(
      relativeEvidence === ".." ||
      relativeEvidence.startsWith(`..${sep}`) ||
      isAbsolute(relativeEvidence)
    )
  )
    throw new Error("Evidence must remain outside the product repository");
  process.umask(0o077);
  stage = "CleanTrackedSourceBeforeArchive";
  await runLocal(["git", "diff", "--quiet", "HEAD", "--"]);
  await mkdir(evidenceDirectory, { mode: 0o700 });
  const sourceCommit = await runLocal(["git", "rev-parse", "HEAD"]);
  const sourceArchive = join(evidenceDirectory, "tested-source.tar.gz");
  await runLocal(["git", "archive", "--format=tar.gz", `--output=${sourceArchive}`, "HEAD"]);
  await chmod(sourceArchive, 0o600);
  const report = await rehearse();
  stage = "CleanTrackedSourceAfterRehearsal";
  await runLocal(["git", "diff", "--quiet", "HEAD", "--"]);
  assert.equal(
    await runLocal(["git", "rev-parse", "HEAD"]),
    sourceCommit,
    "Tested source commit changed during rehearsal",
  );
  stage = "PrivateEvidence";
  const evidenceFile = join(evidenceDirectory, "report.json");
  await privateJson(evidenceFile, {
    ...report,
    testedSource: { commit: sourceCommit, archiveSha256: sha256(await readFile(sourceArchive)) },
    rehearsalCommand:
      "bun --no-env-file tools/e2e/run-legacy-receipt-rehearsal.ts --evidence-dir=<new-private-directory>",
    ownedDatabasesCleaned: true,
  });

  for (const [path, mode] of [
    [evidenceDirectory, 0o700],
    [evidenceFile, 0o600],
    [sourceArchive, 0o600],
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
        counts: report.counts,
        checks: report.checks.length,
        evidence: "owner-only-report-and-checksummed-source",
        ownedDatabasesCleaned: true,
      },
      null,
      2,
    ),
  );
};

if (process.argv[1] === fileURLToPath(import.meta.url))
  await main().catch((cause) => {
    const error = cause instanceof AggregateError ? cause.errors[0] : cause;

    const line =
      error instanceof Error
        ? /run-legacy-receipt-rehearsal\.ts:(\d+):/.exec(error.stack ?? "")?.[1]
        : undefined;

    console.error(
      `Synthetic receipt rehearsal failed at ${stage}${line ? ` (line ${line})` : ""}; details redacted`,
    );
    process.exitCode = 1;
  });
