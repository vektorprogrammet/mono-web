import { describe, expect, test } from "bun:test";
import { accountAlloyResults, type AlloyCommandResult } from "../model";

const commands = [
  { kind: "check", name: "Invariant", expectsInstance: false },
  { kind: "check", name: "Invariant_mutant", expectsInstance: true },
  { kind: "run", name: "Scenario", expectsInstance: true },
];

// Alloy 6.2 ExecutionDTO.commands / CommandDTO.solution, with default empty
// solution lists omitted by JSONCodec. SAT solutions retain their DTO fields.
const receipt = JSON.stringify({
  solver: "glucose",
  commands: {
    Invariant: {},
    Invariant_mutant: { solution: [{ instances: [{}], duration: 1 }] },
    Scenario: { solution: [{ instances: [{}], duration: 1 }] },
  },
});

const trace = [
  "00. check Invariant                0       UNSAT",
  "01. check Invariant_mutant         0\b\b\b\b\b    1/1     SAT",
  "02. run   Scenario                0\b\b\b\b\b    1/1     SAT",
].join("\n");

const heldChecks = (results: ReadonlyArray<AlloyCommandResult>) =>
  results.filter((command) => command.kind === "check" && command.result === "UNSAT");

describe("Alloy result accounting", () => {
  test("parser/type failure without a receipt cannot turn absent instances into held checks", () => {
    const result = accountAlloyResults(commands, undefined, "Type error: Two overlapping signatures cannot have two fields with the same name", 1);
    expect(result.passed).toBe(false);
    expect(heldChecks(result.results)).toHaveLength(0);
    expect(result.missing.map((command) => command.name)).toEqual(commands.map((command) => command.name));
    expect(result.unexpected).toHaveLength(0);
  });

  test("a zero exit with missing normal check metadata fails and retains the actual SAT results", () => {
    const incomplete = JSON.stringify({ commands: {
      Invariant_mutant: { solution: [{}] }, Scenario: { solution: [{}] },
    } });

    const result = accountAlloyResults(commands, incomplete, trace, 0);
    expect(result.passed).toBe(false);
    expect(heldChecks(result.results)).toHaveLength(0);
    expect(result.missing.map((command) => command.name)).toEqual(["Invariant"]);
    expect(result.results.map((command) => command.result)).toEqual(["missing", "SAT", "SAT"]);
  });

  test("an entry added before a solver error is not a completed UNSAT result", () => {
    const result = accountAlloyResults(commands, receipt, "00. check Invariant !could not be solved", 1);
    expect(result.passed).toBe(false);
    expect(heldChecks(result.results)).toHaveLength(0);
    expect(result.missing).toHaveLength(3);
  });

  test("valid complete output preserves command names and actual solver outcomes", () => {
    const result = accountAlloyResults(commands, receipt, trace, 0);
    expect(result.passed).toBe(true);
    expect(result.results.map((command) => command.name)).toEqual(commands.map((command) => command.name));
    expect(result.results.map((command) => command.result)).toEqual(["UNSAT", "SAT", "SAT"]);
    expect(heldChecks(result.results)).toHaveLength(1);
    expect(result.missing).toHaveLength(0);
    expect(result.unexpected).toHaveLength(0);
  });

  test("nonzero exit or signal still fails when every recorded result matches", () => {
    for (const status of [1, null]) {
      const result = accountAlloyResults(commands, receipt, trace, status);
      expect(result.passed).toBe(false);
      expect(result.results.map((command) => command.result)).toEqual(["UNSAT", "SAT", "SAT"]);
    }
  });

  test("missing trace or receipt never proves a check holds", () => {
    for (const result of [
      accountAlloyResults(commands, receipt, "", 0),
      accountAlloyResults(commands, undefined, trace, 0),
    ]) {
      expect(result.passed).toBe(false);
      expect(heldChecks(result.results)).toHaveLength(0);
      expect(result.missing).toHaveLength(3);
    }
  });

  test("receipt and completed trace disagreement is an error, not a held check", () => {
    const result = accountAlloyResults(commands, receipt, trace.replace("UNSAT", "SAT"), 0);
    expect(result.passed).toBe(false);
    expect(result.missing.map((command) => command.result)).toEqual(["error"]);
    expect(heldChecks(result.results)).toHaveLength(0);
  });

  test("malformed metadata fails at the decoding boundary", () => {
    for (const text of ["{", "{}", '{"commands":{"Invariant":{"solution":false}}}']) {
      expect(() => accountAlloyResults(commands, text, trace, 0)).toThrow();
    }
  });

  test("actual counterexamples remain unexpected, not missing", () => {
    const counterexample = JSON.stringify({ commands: {
      Invariant: { solution: [{}] }, Invariant_mutant: { solution: [{}] }, Scenario: { solution: [{}] },
    } });

    const result = accountAlloyResults(commands, counterexample, trace.replace("UNSAT", "SAT"), 1);
    expect(result.passed).toBe(false);
    expect(result.missing).toHaveLength(0);
    expect(result.unexpected.map((command) => command.name)).toEqual(["Invariant"]);
  });
});
