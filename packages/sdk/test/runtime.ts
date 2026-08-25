import { Layer, ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

/**
 * Creates a runtime owned by one test module. The module must dispose it in
 * `afterAll`, so test execution and any acquired resources have a bounded life.
 */
const testFetch = (...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args);

const TestServices = Layer.succeed(FetchHttpClient.Fetch)(testFetch);

export const makeTestRuntime = () => ManagedRuntime.make(TestServices);
