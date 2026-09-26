import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { Layer } from "effect";

/** The Bun platform services that backend tests run against. */
export const TestPlatform = Layer.merge(BunFileSystem.layer, BunPath.layer);
