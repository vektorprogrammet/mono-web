import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export const parityVerifyArguments = (root = repositoryRoot): readonly string[] => [
  "--root",
  root,
  "--legacy-root",
  resolve(root, "..", "vektorprogrammet"),
  "--intent-register",
  resolve(root, "..", "functional-parity-intent-authority", "accepted-intent.json"),
  "--evidence-register",
  resolve(root, "..", "functional-parity-runtime-evidence", "runtime-evidence.json"),
  "--mode",
  "diff",
];

export const parityExternalInputs = (root: string) => [
  { label: "legacy repository", path: resolve(root, "..", "vektorprogrammet"), directory: true },
  {
    label: "accepted-intent authority register",
    path: resolve(root, "..", "functional-parity-intent-authority", "accepted-intent.json"),
    directory: false,
  },
  {
    label: "runtime-evidence authority register",
    path: resolve(root, "..", "functional-parity-runtime-evidence", "runtime-evidence.json"),
    directory: false,
  },
] as const;
