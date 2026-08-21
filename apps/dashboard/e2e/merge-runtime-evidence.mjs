import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const usage = "Usage: bun e2e/merge-runtime-evidence.mjs --output <path> <register> [register ...]";

const parseArgs = (args) => {
  let outputPath;
  const inputPaths = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--output") {
      outputPath = args[index + 1];
      index += 1;
      if (typeof outputPath !== "string" || outputPath.length === 0) {
        throw new Error(`Missing value for --output\n${usage}`);
      }
      continue;
    }
    if (argument.startsWith("--output=")) {
      outputPath = argument.slice("--output=".length);
      if (outputPath.length === 0) throw new Error(`Missing value for --output\n${usage}`);
      continue;
    }
    if (argument.startsWith("-")) throw new Error(`Unknown option: ${argument}\n${usage}`);
    inputPaths.push(argument);
  }
  if (!outputPath) throw new Error(`The --output option is required\n${usage}`);
  if (inputPaths.length === 0) throw new Error(`At least one input register is required\n${usage}`);
  return { outputPath, inputPaths };
};

export const mergeRuntimeEvidenceRegisters = async (inputBytesList) => {
  if (!Array.isArray(inputBytesList) || inputBytesList.length === 0) {
    throw new Error("At least one runtime evidence register is required");
  }
  const {
    assertSafeRuntimeEvidenceBytes,
    canonicalRuntimeEvidenceBytes,
    makeRuntimeEvidenceRegister,
  } = await import("../../../packages/parity-inventory/src/runtime-evidence.ts");
  const receiptsById = new Map();
  for (const inputBytes of inputBytesList) {
    const register = assertSafeRuntimeEvidenceBytes(inputBytes);
    for (const receipt of register.receipts) {
      const receiptBytes = canonicalRuntimeEvidenceBytes(makeRuntimeEvidenceRegister([receipt]));
      const existing = receiptsById.get(receipt.receipt_ref_id);
      if (existing === undefined) {
        receiptsById.set(receipt.receipt_ref_id, receiptBytes);
      } else if (existing !== receiptBytes) {
        throw new Error(`Conflicting runtime evidence receipt identifier: ${receipt.receipt_ref_id}`);
      }
    }
  }
  const receipts = [...receiptsById.values()].map((receiptBytes) => {
    const register = assertSafeRuntimeEvidenceBytes(new TextEncoder().encode(receiptBytes));
    return register.receipts[0];
  });
  return canonicalRuntimeEvidenceBytes(makeRuntimeEvidenceRegister(receipts));
};

const main = async () => {
  const { outputPath, inputPaths } = parseArgs(process.argv.slice(2));
  const inputBytesList = await Promise.all(inputPaths.map((inputPath) => readFile(inputPath)));
  const outputBytes = await mergeRuntimeEvidenceRegisters(inputBytesList);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, outputBytes, { encoding: "utf8" });
};

if (process.versions.bun === undefined) {
  const result = spawnSync("bun", [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} else {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
