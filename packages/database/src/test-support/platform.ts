import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { Layer } from "effect";
import { DatabaseTest } from "../layers.js";

/**
 * The Bun file system and path services that the database tests, proofs, and CLIs run on. The
 * migration reader of `DatabaseLive` and `DatabaseTest` reads the migration files through them.
 */
export const TestPlatform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

/** `DatabaseTest` on the Bun platform services of `TestPlatform`. */
export const DatabaseTestLive = (...options: Parameters<typeof DatabaseTest>) =>
  DatabaseTest(...options).pipe(Layer.provide(TestPlatform));
