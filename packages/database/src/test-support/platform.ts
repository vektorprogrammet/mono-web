import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { Layer } from "effect";
import { DatabaseTest } from "./pglite-layer.js";

/**
 * The Bun file system, path and cryptographic services that database tests, proofs, and CLIs run on.
 * Migration readers use the filesystem services; native SQL and recovery resolve Crypto at construction.
 */
export const TestPlatform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, BunCrypto.layer);

/** `DatabaseTest` on the Bun platform services of `TestPlatform`. */
export const DatabaseTestLive = (...options: Parameters<typeof DatabaseTest>) =>
  DatabaseTest(...options).pipe(Layer.provide(TestPlatform));
