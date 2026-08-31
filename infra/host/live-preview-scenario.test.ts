import { describe, expect, it } from "vitest";
import {
  LIVE_ACKNOWLEDGMENT,
  REHEARSAL_ACKNOWLEDGMENT,
  evaluateScenarioReplay,
  parseLivePreviewScenarioCommand,
  runBackupGatedApplication,
  sanitizeEvidence,
  validateScenarioTarget,
  type ScenarioDatabaseFacts,
} from "./live-preview-scenario";

const liveUrl = "postgresql://postgres@127.0.0.1:5434/vektor_preview";
const rehearsalUrl = "postgresql://postgres@127.0.0.1:5435/preview_scenario";

const facts = (digest: string): ScenarioDatabaseFacts => ({
  admission_periods: { count: 1, sha256: digest },
  admission_applications: { count: 1, sha256: digest },
  recruitment_interviews: { count: 1, sha256: digest },
  economy_receipts: { count: 1, sha256: digest },
  content_articles: { count: 1, sha256: digest },
  organization_departments: { count: 4, sha256: digest },
  organization_teams: { count: 2, sha256: digest },
  organization_memberships: { count: 5, sha256: digest },
});

const replaySteps = [
  "native-departments",
  "native-team",
  "admission-period",
  "public-application",
  "interview-assignment",
  "receipt-submit",
  "content-publication",
].map((step) => ({ step, status: "replayed" }));

describe("spec 0076 target validation", () => {
  it("accepts only the exact live and rehearsal tuples", () => {
    expect(validateScenarioTarget("live", liveUrl)).toMatchObject({
      hostname: "127.0.0.1",
      port: 5434,
      database: "vektor_preview",
    });
    expect(validateScenarioTarget("rehearsal", rehearsalUrl)).toMatchObject({
      hostname: "127.0.0.1",
      port: 5435,
      database: "preview_scenario",
    });
  });

  it.each([
    "postgresql://postgres@localhost:5434/vektor_preview",
    "postgresql://postgres@127.0.0.1:5435/vektor_preview",
    "postgresql://postgres@127.0.0.1:5434/postgres",
    "postgresql://postgres:secret@127.0.0.1:5434/vektor_preview",
    "postgresql://postgres@127.0.0.1:5434/vektor_preview?sslmode=disable",
    "postgresql://postgres@127.0.0.1:5434/vektor_preview#fragment",
  ])("rejects a non-exact live URL: %s", (url) => {
    expect(() => validateScenarioTarget("live", url)).toThrow();
  });

  it("requires the exact target and acknowledgment with no fallback", () => {
    const args = [
      "--mode=live",
      "--target=synthetic-preview",
      `--ack=${LIVE_ACKNOWLEDGMENT}`,
      `--database-url=${liveUrl}`,
    ];
    expect(parseLivePreviewScenarioCommand(args).mode).toBe("live");
    expect(() =>
      parseLivePreviewScenarioCommand(args.filter((argument) => !argument.startsWith("--ack="))),
    ).toThrow("missing option: --ack");
    expect(() =>
      parseLivePreviewScenarioCommand(
        args.map((argument) =>
          argument.startsWith("--ack=") ? "--ack=I-DID-NOT-ACKNOWLEDGE" : argument,
        ),
      ),
    ).toThrow("live acknowledgment mismatch");

    expect(
      parseLivePreviewScenarioCommand([
        "--mode=rehearsal",
        "--target=disposable-preview",
        `--ack=${REHEARSAL_ACKNOWLEDGMENT}`,
        `--database-url=${rehearsalUrl}`,
      ]).mode,
    ).toBe("rehearsal");
  });
});

describe("spec 0076 mutation gates", () => {
  it("runs zero application commands when backup fails", async () => {
    let applicationCalls = 0;
    await expect(
      runBackupGatedApplication(
        async () => {
          throw new Error("snapshot failed");
        },
        async () => {
          applicationCalls += 1;
          return undefined;
        },
      ),
    ).rejects.toThrow("snapshot failed");
    expect(applicationCalls).toBe(0);
  });

  it("recognizes an exact idempotent command replay", () => {
    expect(
      evaluateScenarioReplay(replaySteps, facts("a".repeat(64)), facts("a".repeat(64)), true),
    ).toEqual({
      countsAndDigestsUnchanged: true,
      allCommandStepsReplayed: true,
    });
    expect(
      evaluateScenarioReplay(replaySteps, facts("a".repeat(64)), facts("b".repeat(64)), true),
    ).toMatchObject({ countsAndDigestsUnchanged: false });
  });

  it("rejects secrets while retaining sanitized backup metadata", () => {
    const safe = {
      backup: {
        fileName: "0076-2026-08-31-deadbeef.dump",
        sha256: "a".repeat(64),
        byteLength: 42,
        mode: "0600",
      },
    };
    expect(sanitizeEvidence(safe)).toEqual(safe);
    expect(() => sanitizeEvidence({ databaseUrl: liveUrl })).toThrow("sensitive key");
    expect(() => sanitizeEvidence({ value: liveUrl })).toThrow("URL-like value");
    expect(() => sanitizeEvidence({ value: "admin.apex@example.invalid" })).toThrow(
      "URL-like value",
    );
  });
});
