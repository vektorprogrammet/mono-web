import { Predicate } from "effect";

const jsonBytes = (value) => new TextEncoder().encode(JSON.stringify(value));

export const sanitizePlaywrightArtifact = (rawBytes) => {
  let report;

  try {
    report = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBytes));
  } catch {
    throw new Error("Playwright JSON reporter output is not valid JSON");
  }

  const tests = [];

  const visitSuite = (suite) => {
    if (suite === null || !Predicate.isObjectOrArray(suite)) return;

    if (Array.isArray(suite.specs)) {
      for (const spec of suite.specs) {
        if (spec === null || !Predicate.isObjectOrArray(spec)) continue;
        const specTests = Array.isArray(spec.tests) ? spec.tests : [];
        tests.push({
          title: Predicate.isString(spec.title) ? spec.title : "",
          ok: spec.ok === true,
          tests: specTests.map((test) => ({
            expectedStatus:
              test && Predicate.isString(test.expectedStatus) ? test.expectedStatus : "",
            resultStatuses:
              test && Array.isArray(test.results)
                ? test.results
                    .map((result) =>
                      result && Predicate.isString(result.status) ? result.status : "",
                    )
                    .sort()
                : [],
          })),
        });
      }
    }

    if (Array.isArray(suite.suites)) for (const child of suite.suites) visitSuite(child);
  };

  if (report && Array.isArray(report.suites)) for (const suite of report.suites) visitSuite(suite);
  tests.sort((left, right) => {
    const leftText = JSON.stringify(left);
    const rightText = JSON.stringify(right);

    return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
  });

  const passed =
    tests.length > 0 &&
    tests.every(
      (spec) =>
        spec.ok &&
        spec.tests.length > 0 &&
        spec.tests.every(
          (test) =>
            test.resultStatuses.length > 0 &&
            test.resultStatuses.every((status) => status === "passed"),
        ),
    );

  if (!passed) throw new Error("Runtime evidence requires a non-empty passing Playwright report");

  return jsonBytes({ tests });
};

export const runtimeEvidenceOutcome = (sanitizedBytes) => {
  let value;

  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(sanitizedBytes));
  } catch {
    throw new Error("Runtime evidence artifact is not valid sanitized JSON");
  }

  const tests = value && (value === null || Predicate.isObjectOrArray(value)) && Array.isArray(value.tests) ? value.tests : [];

  const passed =
    tests.length > 0 &&
    tests.every(
      (spec) =>
        spec &&
        spec.ok === true &&
        Array.isArray(spec.tests) &&
        spec.tests.length > 0 &&
        spec.tests.every(
          (test) =>
            test &&
            Array.isArray(test.resultStatuses) &&
            test.resultStatuses.length > 0 &&
            test.resultStatuses.every((status) => status === "passed"),
        ),
    );

  if (!passed) throw new Error("Runtime evidence requires a non-empty passing Playwright report");

  return { result: "passed", exit_code: 0 };
};
