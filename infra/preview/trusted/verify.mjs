#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { canonicalJson, IDENTITY, isMainModule, parseArgs, requireDigest, requireOption, requireSha } from "./contracts.mjs";

function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = JSON.parse(readFileSync(requireOption(args, "input"), "utf8"));
  const expectedRepository = args.repository ?? IDENTITY.repository;
  const expectedHead = requireSha(requireOption(args, "head-sha"), "expectedHead");
  const expectedDigest = requireDigest(requireOption(args, "archive-digest"), "expectedDigest");
  if (input.schema !== "preview-source-digest/v1") throw new Error("unsupported source digest schema");
  if (input.repository !== expectedRepository || input.observedRepository !== expectedRepository) {
    throw new Error(`repository mismatch: expected ${expectedRepository}`);
  }
  if (input.headSha !== expectedHead) throw new Error(`head mismatch: expected ${expectedHead}, observed ${input.headSha}`);
  if (input.archiveDigest !== expectedDigest) throw new Error(`archive digest mismatch: expected ${expectedDigest}, observed ${input.archiveDigest}`);
  if (input.credentialFree !== true) throw new Error("source digest was not produced credential-free");
  const result = {
    schema: "preview-source-verification/v1",
    repository: expectedRepository,
    headSha: expectedHead,
    archiveDigest: expectedDigest,
    verified: true,
    promotionAllowed: true,
  };
  if (args.output) writeFileSync(args.output, canonicalJson(result), { encoding: "utf8", mode: 0o600 });
  process.stdout.write(canonicalJson(result));
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`preview digest verification failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
