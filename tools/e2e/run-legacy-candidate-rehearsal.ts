import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { postgresProgram } from "@monoweb/postgres";
import { databaseSchemaRevision } from "@vektorprogrammet/database/migrations";
import { DepartmentId, OrganizationReview, PersonId } from "@vektorprogrammet/domain/organization";
import {
  ReceiptReview,
  ReceiptReviewEntry,
  receiptSourceRevision,
  receiptSourceRowDigest,
} from "@vektorprogrammet/domain/receipt";
import { CurrentAssignmentReview } from "@vektorprogrammet/domain/placements";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Effect, Schema } from "effect";
import type { Pool } from "pg";
import * as PaymentCustody from "@vektorprogrammet/backend/receipt/payment-account";
import { buildLegacyReferences } from "./legacy-cutover-references";
import {
  legacyReceiptBaseSourceRevision,
  legacyReceiptRows,
  legacyReceiptTransformationRevision,
} from "./legacy-receipt-snapshot";
import { readLegacySourceSnapshot, type LegacySourceSnapshot } from "./legacy-source-snapshot";
import {
  digest,
  repositoryRoot,
  runLocal,
  runLocalResult,
  targetFingerprint,
  withOrganizationDatabases,
  type RehearsalTarget,
} from "./legacy-organization-rehearsal-runtime";
import {
  candidateAccount,
  candidateAsOf,
  candidateFixtureSql,
  candidateIdentities,
  candidatePdf,
  candidateScope,
  candidateSnapshotId,
  candidateWatermark,
} from "./legacy-candidate-fixture";
import { observeLegacyCandidateNativeJourney } from "./legacy-candidate-native-journey";

let stage = "Options";

const repository = "vektorprogrammet/vektorprogrammet";

const sha256 = (bytes: string | Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const reasons = Schema.Record(Schema.String, Schema.Int);

const Counts = Schema.Struct({
  input: Schema.Int,
  accepted: Schema.Int,
  quarantined: Schema.Int,
  reasons,
});

const CutoverReport = Schema.Struct({
  source: Schema.Struct({
    snapshotId: Schema.String,
    revision: Schema.String,
    credentialRevision: Schema.String,
    transformationRevision: Schema.String,
  }),
  references: Schema.Struct({
    stage: Schema.String,
    departments: Schema.Int,
    semesters: Schema.Int,
    schools: Schema.Int,
    relationships: Schema.Int,
    digest: Schema.String,
  }),
  person: Schema.Struct({ ...Counts.fields, stage: Schema.String }),
  accounts: Schema.Struct({
    ...Counts.fields,
    credentialImported: Schema.Int,
    recoveryPending: Schema.Int,
  }),
  historicalService: Counts,
  currentAssignments: Counts,
  organization: Schema.Struct({ ...Counts.fields, excluded: Schema.Int }),
});

const ReceiptReport = Schema.Struct({
  sourceRevision: Schema.String,
  receiptSourceRevision: Schema.String,
  transformationRevision: Schema.String,
  schemaRevision: Schema.String,
  snapshotKey: Schema.String,
  replay: Schema.Boolean,
  input: Schema.Int,
  accepted: Schema.Int,
  quarantined: Schema.Int,
  excluded: Schema.Int,
  pending: Schema.Int,
  reconciled: Schema.Int,
  complete: Schema.Boolean,
  occurrences: Schema.Array(
    Schema.Struct({
      sourcePrimaryKey: Schema.String,
      disposition: Schema.Literals(["Accepted", "Quarantined", "Excluded"]),
      reasons: Schema.Array(Schema.String),
    }),
  ),
});

const StoredReceipt = Schema.Struct({
  receipt_id: Schema.String,
  visual_id: Schema.String,
  owner_person_id: Schema.String,
  description: Schema.String,
  payment_account_ciphertext: Schema.String,
  file_ref: Schema.String,
  file_object_key: Schema.String,
  file_sha256: Schema.String,
});

type Roots = { archive: string; staging: string; committed: string };

const privateJson = async (path: string, value: Schema.Json): Promise<void> => {
  await writeFile(path, JSON.stringify(value) + "\n", { mode: 0o600, flag: "wx" });
};

const storedReceipts = async (pool: Pool) =>
  Schema.decodeSync(Schema.Array(StoredReceipt))(
    (
      await pool.query(`
 SELECT receipt_id,visual_id,owner_person_id,description,payment_account_ciphertext,file_ref,file_object_key,file_sha256
 FROM public.economy_receipts ORDER BY visual_id
`)
    ).rows,
  );

const fileEvidence = async (root: string): Promise<Record<string, string>> => {
  const entries: Record<string, string> = {};

  const visit = async (directory: string): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name);
      const metadata = await lstat(path);
      assert.equal(metadata.isSymbolicLink(), false);

      if (metadata.isDirectory()) await visit(path);
      else {
        assert.ok(metadata.isFile());
        entries[relative(root, path)] = sha256(await readFile(path));
      }
    }
  };

  await visit(root);

  return entries;
};

const noInventedEffects = async (pool: Pool): Promise<void> => {
  const tables = (
    await pool.query<{ name: string }>(`
 SELECT format('%I.%I',schemaname,tablename) AS name FROM pg_tables
 WHERE schemaname='public' AND (tablename LIKE '%audit%' OR tablename LIKE '%outbox%'
 OR tablename LIKE '%grant%' OR tablename LIKE '%settlement%' OR tablename LIKE '%transfer%'
 OR tablename LIKE '%command_receipt%' OR tablename LIKE 'economy_%authorities' OR tablename='service_principals') ORDER BY 1
 `)
  ).rows;

  for (const { name } of tables)
    assert.equal(
      Number(
        (await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${name}`))
          .rows[0]!.count,
      ),
      0,
      "Import fabricated native authority or effects",
    );
};

const rehearse = async () =>
  withOrganizationDatabases(
    await candidateFixtureSql(),
    async ({ sourceUrl, mysql, target, temporaryRoot }) => {
      const checks: string[] = [];
      const checked = (name: string) => checks.push(name);
      const key = randomBytes(32);

      const cipher = PaymentCustody.makePaymentAccountCipher({
        keyId: "synthetic-candidate-payment-v1",
        key,
      });

      stage = "ReadCombinedSource";
      const source = await readLegacySourceSnapshot(sourceUrl, "Include", "Include");

      const evidenceFor = (snapshot: LegacySourceSnapshot) => ({
        baseRevision: legacyReceiptBaseSourceRevision(snapshot),
        credentialRevision: digest(snapshot.credentials),
        receiptRevision: receiptSourceRevision(legacyReceiptRows(snapshot, cipher)),
        accountRevision: digest(
          snapshot.paymentAccounts!.map((row) => [
            String(row.id),
            row.accountNumber === null ? null : cipher.commitment(row.accountNumber),
          ]),
        ),
      });

      const baseline = evidenceFor(source);

      const assertFrozen = async () =>
        assert.deepEqual(
          evidenceFor(await readLegacySourceSnapshot(sourceUrl, "Include", "Include")),
          baseline,
          "Selected source changed between candidate phases",
        );

      const referenceDigest = buildLegacyReferences(source).referenceDigest;
      const personSnapshotKey = digest([repository, candidateSnapshotId]);

      stage = "BuildOrganizationReview";

      const organization = Schema.decodeUnknownSync(OrganizationReview)({
        sourceRevision: baseline.baseRevision,
        sourceWatermark: candidateWatermark,
        asOf: candidateAsOf,
        attestedBy: "synthetic-candidate-reviewer",
        evidenceRef: "synthetic-organization-evidence",
        memberships: [
          ...source.teamMemberships!.map((row) => ({ sourceKind: "TeamMembership", row })),
          ...source.executiveBoardMemberships!.map((row) => ({
            sourceKind: "BoardMembership",
            row,
          })),
        ].map(({ sourceKind, row }) => {
          const common = {
            sourceKind,
            sourceId: String(row.id),
            sourceRowDigest: digest(row),
            evidenceRef: `synthetic-membership:${sourceKind}:${row.id}`,
          };

          if (String(row.id) === "105") return { ...common, decision: "Excluded" };

          return String(row.id) === "103" || sourceKind === "BoardMembership"
            ? {
                ...common,
                decision: "Historical",
                startAt: "2026-01-01T00:00:00Z",
                endAt: "2026-07-01T00:00:00Z",
              }
            : { ...common, decision: "Current", startAt: "2026-08-01T00:00:00Z", endAt: null };
        }),
      });

      const assignments = Schema.decodeSync(CurrentAssignmentReview)({
        sourceRevision: baseline.baseRevision,
        sourceWatermark: candidateWatermark,
        sourceSemesterId: candidateScope.semesterId,
        asOf: candidateAsOf.slice(0, 10),
        attestedBy: "synthetic-candidate-reviewer",
        evidenceRef: "synthetic-assignment-evidence",
        assignments: source.history
          .filter((row) => String(row.semesterId) === "1")
          .map((row) => ({
            sourceAssignmentId: `legacy-history:${row.id}`,
            sourceRowDigest: digest(row),
            active: true,
            affiliationEvidenceRef: `synthetic-affiliation:${row.id}`,
            placementEvidenceRef: `synthetic-placement:${row.id}`,
          })),
      });

      stage = "BuildReceiptReview";

      const receiptReview = Schema.decodeSync(ReceiptReview)({
        sourceRepository: repository,
        sourceRevision: baseline.baseRevision,
        receiptSourceRevision: baseline.receiptRevision,
        snapshotId: `${candidateSnapshotId}-receipts`,
        sourceWatermark: candidateWatermark,
        transformationRevision: await Effect.runPromise(
          legacyReceiptTransformationRevision.pipe(Effect.provide(BunServices.layer)),
        ),
        personSnapshotKey,
        referenceSnapshotId: candidateSnapshotId,
        referenceDigest,
        attestedBy: "synthetic-candidate-reviewer",
        evidenceRef: "synthetic-receipt-evidence",
        entries: legacyReceiptRows(source, cipher).map((row) => {
          const common = {
            sourcePrimaryKey: row.sourcePrimaryKey,
            sourceRowDigest: receiptSourceRowDigest(row),
            evidenceRef: `synthetic-receipt:${row.sourcePrimaryKey}`,
          };

          if (row.sourcePrimaryKey === "3")
            return ReceiptReviewEntry.members[0].make({
              ...common,
              reason: "ExplicitSyntheticExclusion",
            });
          const userId = row.sourceUserId!.slice("legacy-user:".length);

          return ReceiptReviewEntry.members[1].make({
            ...common,
            person: {
              occurrenceId: `legacy-user-row-${userId}`,
              sourceUserId: row.sourceUserId!,
              personId: PersonId.make(`legacy-person-${userId}`),
            },
            department: {
              sourceDepartmentId: candidateScope.departmentId,
              departmentId: DepartmentId.make(candidateScope.departmentId),
            },
            receiptDate: "2026-08-20",
            submittedAt: "2026-08-21T12:00:00Z",
            approvedAt: row.status === "refunded" ? "2026-09-01T12:00:00Z" : null,
            file: {
              path: row.picturePath!,
              sha256: sha256(candidatePdf),
              byteLength: candidatePdf.byteLength,
              contentType: "application/pdf",
            },
            payment: {
              commitment: row.accountCommitment,
              evidenceRef: `synthetic-account:${userId}`,
            },
          });
        }),
      });

      const organizationPath = join(temporaryRoot, "organization-review.json");
      const assignmentPath = join(temporaryRoot, "assignment-review.json");
      const receiptPath = join(temporaryRoot, "receipt-review.json");
      const keyPath = join(temporaryRoot, "payment-key.json");
      await privateJson(organizationPath, organization);
      await privateJson(assignmentPath, assignments);
      await privateJson(receiptPath, receiptReview);
      await privateJson(keyPath, { keyId: cipher.keyId, keyBase64: key.toString("base64") });

      const roots: Roots = {
        archive: join(temporaryRoot, "archive"),
        staging: join(temporaryRoot, "staging"),
        committed: join(temporaryRoot, "committed"),
      };

      for (const path of Object.values(roots)) await mkdir(path, { mode: 0o700 });

      for (const row of source.receipts!)
        await writeFile(join(roots.archive, row.picturePath!), candidatePdf, { mode: 0o600 });
      const primary = await target("candidate_primary");

      const sensitive = [
        candidateAccount,
        candidateAccount.replaceAll(".", ""),
        sha256(candidateAccount),
        key.toString("base64"),
        sourceUrl,
        temporaryRoot,
        ...Object.values(candidateIdentities).flatMap((person) => [
          person.email,
          person.password,
          person.firstName,
          person.lastName,
        ]),
        ...source.credentials.flatMap((row) =>
          row.passwordHash === null ? [] : [row.passwordHash],
        ),
        ...source.receipts!.map((row) => row.description),
      ];

      const noLeaks = (text: string) => {
        for (const value of sensitive)
          assert.equal(
            text.includes(value),
            false,
            "Private candidate data escaped into public output",
          );
      };

      const invoke = async (database: RehearsalTarget, receiptRoots?: Roots) => {
        const args =
          receiptRoots === undefined
            ? [
                "tools/e2e/run-legacy-service-cutover.ts",
                "--source-url-env=CANDIDATE_SOURCE",
                "--target-url-env=CANDIDATE_TARGET",
                `--target-database=${database.database}`,
                `--snapshot-id=${candidateSnapshotId}`,
                "--attested-by=synthetic-candidate-reviewer",
                "--passwordless-policy=provision-recovery",
                `--current-assignments=${assignmentPath}`,
                `--organization=${organizationPath}`,
              ]
            : [
                "tools/e2e/run-legacy-receipt-import.ts",
                `--review=${receiptPath}`,
                `--archive-root=${receiptRoots.archive}`,
                `--staging-root=${receiptRoots.staging}`,
                `--committed-root=${receiptRoots.committed}`,
                `--payment-key=${keyPath}`,
                "--source-env=CANDIDATE_SOURCE",
                "--target-env=CANDIDATE_TARGET",
                `--target-database=${database.database}`,
                "--organization-source=include",
              ];

        const result = await runLocalResult(["bun", "--no-env-file", ...args], undefined, {
          CANDIDATE_SOURCE: sourceUrl,
          CANDIDATE_TARGET: database.url,
        });

        noLeaks(result.stdout + result.stderr);

        return result;
      };

      const cutover = async (database = primary) => {
        await assertFrozen();
        const result = await invoke(database);
        assert.equal(result.code, 0, "Candidate cutover CLI failed; details redacted");
        const report = Schema.decodeSync(Schema.fromJsonString(CutoverReport))(result.stdout);
        assert.equal(report.source.revision, baseline.baseRevision);
        assert.equal(report.source.credentialRevision, baseline.credentialRevision);
        assert.equal(report.references.digest, referenceDigest);
        await assertFrozen();

        return report;
      };

      const receiptImport = async (database = primary, files = roots) => {
        await assertFrozen();
        const result = await invoke(database, files);
        assert.ok(
          result.code === 0 || result.code === 2,
          "Candidate receipt CLI failed; details redacted",
        );
        const report = Schema.decodeSync(Schema.fromJsonString(ReceiptReport))(result.stdout);
        assert.equal(result.code, report.complete ? 0 : 2);
        assert.equal(report.sourceRevision, baseline.baseRevision);
        assert.equal(report.receiptSourceRevision, baseline.receiptRevision);
        assert.equal(report.transformationRevision, receiptReview.transformationRevision);
        assert.equal(report.schemaRevision, databaseSchemaRevision);
        assert.equal(report.input, 4);
        assert.equal(report.accepted, 2);
        assert.equal(report.quarantined, 1);
        assert.equal(report.excluded, 1);
        assert.equal(report.input, report.accepted + report.quarantined + report.excluded);
        await assertFrozen();

        return report;
      };

      stage = "WholeCutoverRollback";
      const pristine = await targetFingerprint(primary.pool);
      await primary.pool
        .query(`CREATE FUNCTION auth.fail_candidate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic last-stage failure'; END; $$;
    CREATE TRIGGER fail_candidate BEFORE INSERT ON auth.account_cohort_imports FOR EACH ROW EXECUTE FUNCTION auth.fail_candidate();`);
      const failed = await invoke(primary);
      assert.notEqual(failed.code, 0);
      assert.match(failed.stderr, /AccountImport/);
      assert.equal(await targetFingerprint(primary.pool), pristine);
      await primary.pool.query(
        "DROP TRIGGER fail_candidate ON auth.account_cohort_imports; DROP FUNCTION auth.fail_candidate();",
      );
      checked(
        "last-stage Account failure rolls back references, People, Organization, history and assignments",
      );

      stage = "SQLPhaseExitAndResume";
      const first = await cutover();

      for (const cohort of [
        first.person,
        first.accounts,
        first.historicalService,
        first.currentAssignments,
      ])
        assert.equal(cohort.input, cohort.accepted + cohort.quarantined);
      assert.equal(
        first.organization.input,
        first.organization.accepted + first.organization.quarantined + first.organization.excluded,
      );
      assert.deepEqual(
        [
          first.person.accepted,
          first.accounts.accepted,
          first.accounts.credentialImported,
          first.historicalService.accepted,
          first.currentAssignments.accepted,
          first.organization.accepted,
        ],
        [4, 4, 4, 1, 1, 5],
      );
      assert.deepEqual(
        [
          first.person.quarantined,
          first.accounts.quarantined,
          first.historicalService.quarantined,
          first.currentAssignments.quarantined,
          first.organization.quarantined,
          first.organization.excluded,
        ],
        [1, 1, 1, 1, 1, 1],
      );
      await noInventedEffects(primary.pool);
      assert.deepEqual(await storedReceipts(primary.pool), []);
      const sqlOnly = await targetFingerprint(primary.pool);

      const interrupted = {
        cutover: "Committed",
        receipts: "NotStarted",
        candidateComplete: false,
      };

      await privateJson(join(temporaryRoot, "interrupted-candidate.json"), interrupted);
      const resumed = await cutover();
      assert.equal(resumed.person.stage, "ExactReplay");
      assert.equal(await targetFingerprint(primary.pool), sqlOnly);
      checked(
        "cutover process exits before receipt phase; incomplete checkpoint and fresh CLI resume preserve SQL state",
      );

      stage = "ChangedSourceRefusal";
      const beforeFiles = await fileEvidence(roots.staging);
      await mysql("UPDATE vektor.receipt SET `sum`=99.99 WHERE id=1");
      const changedReceipt = await invoke(primary, roots);
      assert.notEqual(changedReceipt.code, 0);
      assert.equal(await targetFingerprint(primary.pool), sqlOnly);
      assert.deepEqual(await fileEvidence(roots.staging), beforeFiles);
      assert.deepEqual(await fileEvidence(roots.committed), {});
      await mysql("UPDATE vektor.receipt SET `sum`=12.34 WHERE id=1");
      await assertFrozen();
      await mysql("UPDATE vektor.user SET password='changed-source' WHERE id=1");
      const changedCredential = await invoke(primary);
      assert.notEqual(changedCredential.code, 0);
      assert.equal(await targetFingerprint(primary.pool), sqlOnly);
      await assert.rejects(receiptImport(), /Selected source changed between candidate phases/);
      assert.equal(await targetFingerprint(primary.pool), sqlOnly);
      assert.deepEqual(await fileEvidence(roots.staging), beforeFiles);
      assert.deepEqual(await fileEvidence(roots.committed), {});
      await mysql(
        `UPDATE vektor.user SET password='${source.credentials[0]!.passwordHash}' WHERE id=1`,
      );
      await assertFrozen();
      await mysql("UPDATE vektor.user SET accountNumber='12345678903' WHERE id=1");
      await assert.rejects(receiptImport(), /Selected source changed between candidate phases/);
      assert.equal(await targetFingerprint(primary.pool), sqlOnly);
      assert.deepEqual(await fileEvidence(roots.staging), beforeFiles);
      assert.deepEqual(await fileEvidence(roots.committed), {});
      await mysql(`UPDATE vektor.user SET accountNumber='${candidateAccount}' WHERE id=1`);
      await assertFrozen();
      checked(
        "changed finance and credential source evidence fail closed without target or file mutation",
      );

      stage = "PromotionFailureAndFreshProcessRecovery";
      await writeFile(join(roots.committed, "committed"), "synthetic promotion obstruction", {
        mode: 0o600,
      });
      const pending = await receiptImport();
      assert.equal(pending.complete, false);
      assert.equal(pending.pending, 2);
      assert.equal(pending.reconciled, 0);
      const pendingReceipts = await storedReceipts(primary.pool);

      for (const receipt of pendingReceipts)
        assert.equal(
          sha256(await readFile(join(roots.staging, receipt.file_ref))),
          receipt.file_sha256,
        );
      await noInventedEffects(primary.pool);
      await rm(join(roots.committed, "committed"));
      const recovered = await receiptImport();
      assert.equal(recovered.replay, true);
      assert.equal(recovered.complete, true);
      assert.equal(recovered.pending, 0);
      assert.deepEqual(await storedReceipts(primary.pool), pendingReceipts);

      for (const receipt of pendingReceipts) {
        assert.equal(
          cipher.decrypt(receipt.payment_account_ciphertext, receipt.receipt_id),
          candidateAccount.replaceAll(".", ""),
        );
        assert.equal(
          sha256(await readFile(join(roots.committed, receipt.file_object_key))),
          receipt.file_sha256,
        );
      }

      await noInventedEffects(primary.pool);
      checked(
        "receipt SQL commits explicit Pending; fresh CLI recovers retained private bytes without replacing ciphertext or facts",
      );

      stage = "SharedIdentityNativeJourney";
      const owned = pendingReceipts.find((receipt) => receipt.visual_id === "CANDIDATE-1")!;
      assert.equal(owned.owner_person_id, candidateIdentities.member.personId);
      const changedPassword = "Candidate-native-changed-2026!";
      const authSecret = randomBytes(32).toString("base64url");
      sensitive.push(changedPassword, authSecret);

      const native = await observeLegacyCandidateNativeJourney({
        target: primary,
        asOf: candidateAsOf,
        authSecret,
        identities: candidateIdentities,
        scope: candidateScope,
        receipt: {
          receiptId: owned.receipt_id,
          ownerPersonId: owned.owner_person_id,
          sha256: owned.file_sha256,
        },
        receiptStore: { stagingRoot: roots.staging, committedRoot: roots.committed },
        changeMemberPasswordTo: changedPassword,
      });

      checked(
        "native shared-identity authentication, scoped reads, private-file ownership and changed credential",
      );

      stage = "NativeEditAndWholeCandidateReplay";
      await primary.pool.query(
        "UPDATE economy_receipts SET description='Native edited candidate receipt',revision=revision+1 WHERE receipt_id=$1",
        [owned.receipt_id],
      );
      const editedReceipts = await storedReceipts(primary.pool);

      const credentialsAfterNativeChange = (
        await primary.pool.query('SELECT * FROM auth."account" ORDER BY id')
      ).rows;

      const beforeReconciliation = await targetFingerprint(primary.pool);
      const nativeFiles = await fileEvidence(roots.committed);
      await cutover();
      assert.equal(await targetFingerprint(primary.pool), beforeReconciliation);
      const editedReplay = await receiptImport();
      assert.equal(editedReplay.replay, true);
      assert.equal(editedReplay.complete, false);
      assert.equal(editedReplay.pending, 1, "Native receipt drift must remain unresolved");
      assert.deepEqual(await storedReceipts(primary.pool), editedReceipts);
      assert.deepEqual(
        (await primary.pool.query('SELECT * FROM auth."account" ORDER BY id')).rows,
        credentialsAfterNativeChange,
      );
      const nativeState = await targetFingerprint(primary.pool);
      await cutover();
      assert.deepEqual(await receiptImport(), editedReplay);
      assert.equal(
        await targetFingerprint(primary.pool),
        nativeState,
        "Replay changed native edits, credentials or imported identities",
      );
      assert.deepEqual(await fileEvidence(roots.committed), nativeFiles);
      checked(
        "whole candidate replay preserves native receipt edit, changed credential, identities and ciphertext; drift remains explicit",
      );

      stage = "LogicalDatabaseAndPrivateFileRestore";
      const dump = join(temporaryRoot, "candidate.dump");
      await runLocal([
        postgresProgram("pg_dump"),
        "--dbname",
        primary.url,
        "--format=custom",
        "--file",
        dump,
      ]);
      await chmod(dump, 0o600);
      const restored = await target("candidate_restored");
      await runLocal([
        postgresProgram("pg_restore"),
        "--dbname",
        restored.url,
        "--clean",
        "--if-exists",
        "--exit-on-error",
        "--no-owner",
        dump,
      ]);
      const restoredRoot = join(temporaryRoot, "restored-files");
      await mkdir(restoredRoot, { mode: 0o700 });

      const restoredRoots = {
        archive: join(restoredRoot, "archive"),
        staging: join(restoredRoot, "staging"),
        committed: join(restoredRoot, "committed"),
      };

      for (const key of ["archive", "staging", "committed"] as const)
        await cp(roots[key], restoredRoots[key], { recursive: true, dereference: false });
      assert.equal(await targetFingerprint(restored.pool), nativeState);
      assert.deepEqual(await fileEvidence(restoredRoots.committed), nativeFiles);
      await cutover(restored);
      const restoredReplay = await receiptImport(restored, restoredRoots);
      assert.deepEqual(restoredReplay, editedReplay);
      assert.equal(await targetFingerprint(restored.pool), nativeState);
      assert.deepEqual(await storedReceipts(restored.pool), await storedReceipts(primary.pool));

      const restoredNative = await observeLegacyCandidateNativeJourney({
        target: restored,
        asOf: candidateAsOf,
        authSecret,
        identities: {
          ...candidateIdentities,
          member: { ...candidateIdentities.member, password: changedPassword },
        },
        scope: candidateScope,
        receipt: {
          receiptId: owned.receipt_id,
          ownerPersonId: owned.owner_person_id,
          sha256: owned.file_sha256,
        },
        receiptStore: {
          stagingRoot: restoredRoots.staging,
          committedRoot: restoredRoots.committed,
        },
      });

      checked(
        "logical database and private-file restore preserves full candidate, ciphertext, unresolved drift, replay and native sign-in with changed password",
      );
      await assertFrozen();

      const report = {
        scope: "SyntheticCombinedMigrationCandidate",
        result: "RehearsalChecksPassed",
        productionReadiness: "Blocked",
        source: {
          repository,
          snapshotId: candidateSnapshotId,
          watermark: candidateWatermark,
          ...baseline,
          reviewDigest: digest([organization, assignments, receiptReview]),
        },
        schemaRevision: databaseSchemaRevision,
        cutoverTransformationRevision: first.source.transformationRevision,
        receiptTransformationRevision: receiptReview.transformationRevision,
        cohorts: {
          references: first.references,
          person: first.person,
          accounts: first.accounts,
          organization: first.organization,
          historicalService: first.historicalService,
          currentAssignments: first.currentAssignments,
          receipts: editedReplay,
        },
        interruption: interrupted,
        custodyRecovery: {
          pendingBeforeRecovery: pending.pending,
          acceptedFilesReconciled: recovered.reconciled,
        },
        unresolved: {
          person: first.person.quarantined,
          accounts: first.accounts.quarantined,
          organization: first.organization.quarantined,
          historicalService: first.historicalService.quarantined,
          currentAssignments: first.currentAssignments.quarantined,
          receipts: editedReplay.quarantined,
          nativeReceiptDrift: editedReplay.pending,
        },
        excluded: { organization: first.organization.excluded, receipts: editedReplay.excluded },
        native,
        restoredNative,
        checks,
        limitations: [
          "Invented source and local providers only; no historical or current-production data",
          "Quarantine, exclusions and deliberate native receipt drift remain explicit; file reconciliation is not migration completion",
          "Phase-boundary process exit, fresh CLI retry and logical database/file restore; no power-loss simulation",
          "No mailbox ownership, real payment transfer, settlement, provider acceptance or writer transfer established",
        ],
      };

      noLeaks(JSON.stringify(report));

      return report;
    },
  );

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);

  if (args.length === 1 && args[0] === "--help") {
    console.log(
      "Usage: bun --no-env-file tools/e2e/run-legacy-candidate-rehearsal.ts --evidence-dir=<new-directory>\nRuns one invented candidate through local private MariaDB/PostgreSQL, both import CLIs and native services. No backup, production or provider access.",
    );

    return;
  }

  const output = args.length === 1 ? /^--evidence-dir=(.+)$/.exec(args[0]!)?.[1] : undefined;

  if (!output) throw new Error("Use --help or --evidence-dir=<new-directory>");
  const evidenceDirectory = resolve(output);
  assert.equal(
    await realpath(dirname(evidenceDirectory)),
    dirname(evidenceDirectory),
    "Evidence parent must not contain symlinks",
  );
  const location = relative(await realpath(repositoryRoot), evidenceDirectory);

  if (!(location === ".." || location.startsWith(`..${sep}`) || isAbsolute(location)))
    throw new Error("Evidence must remain outside the product repository");
  process.umask(0o077);
  stage = "CleanTrackedSourceBeforeArchive";
  await runLocal(["git", "diff", "--quiet", "HEAD", "--"]);

  for (const path of [
    "tools/e2e/run-legacy-candidate-rehearsal.ts",
    "tools/e2e/legacy-candidate-fixture.ts",
    "tools/e2e/legacy-candidate-native-journey.ts",
  ])
    await runLocal(["git", "cat-file", "-e", `HEAD:${path}`]);
  await mkdir(evidenceDirectory, { mode: 0o700 });
  const commit = await runLocal(["git", "rev-parse", "HEAD"]);
  const archive = join(evidenceDirectory, "tested-source.tar.gz");
  await runLocal(["git", "archive", "--format=tar.gz", `--output=${archive}`, "HEAD"]);
  await chmod(archive, 0o600);
  stage = "CreateCandidateFixtures";
  const report = await rehearse();
  stage = "CleanTrackedSourceAfterRehearsal";
  await runLocal(["git", "diff", "--quiet", "HEAD", "--"]);
  assert.equal(await runLocal(["git", "rev-parse", "HEAD"]), commit);
  const reportPath = join(evidenceDirectory, "report.json");
  await privateJson(reportPath, {
    ...report,
    testedSource: { commit, archiveSha256: sha256(await readFile(archive)) },
    ownedDatabasesCleaned: true,
    rehearsalCommand:
      "bun --no-env-file tools/e2e/run-legacy-candidate-rehearsal.ts --evidence-dir=<new-private-directory>",
  });

  for (const [path, mode] of [
    [evidenceDirectory, 0o700],
    [reportPath, 0o600],
    [archive, 0o600],
  ] as const) {
    const metadata = await lstat(path);
    assert.equal(metadata.isSymbolicLink(), false);
    assert.equal(metadata.uid, process.getuid?.());
    assert.equal(metadata.mode & 0o777, mode);
  }

  console.log(
    JSON.stringify({
      scope: report.scope,
      result: report.result,
      productionReadiness: report.productionReadiness,
      checks: report.checks.length,
      unresolved: report.unresolved,
      excluded: report.excluded,
      evidence: "owner-only-report-and-checksummed-source",
      ownedDatabasesCleaned: true,
    }),
  );
};

if (process.argv[1] === fileURLToPath(import.meta.url))
  await main().catch((cause) => {
    const error = cause instanceof AggregateError ? cause.errors[0] : cause;

    const location =
      error instanceof Error
        ? /(?:run-legacy-candidate-rehearsal|legacy-candidate-fixture)\.ts:(\d+):/.exec(
            error.stack ?? "",
          )?.[1]
        : undefined;

    const nativePhase =
      error instanceof Error
        ? /^Candidate native journey failed: ([A-Za-z0-9-]+)$/.exec(error.message)?.[1]
        : undefined;

    console.error(
      `Synthetic combined candidate rehearsal failed at ${stage}${nativePhase ? `/${nativePhase}` : ""}${location ? ` (line ${location})` : ""}; details redacted`,
    );
    process.exitCode = 1;
  });
