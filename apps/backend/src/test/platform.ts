/**
 * EX-0024: required public native APIs in stable Effect 4 retain upstream unstable annotations.
 * @effect-diagnostics unstableApiUsage:off
 */
import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { Layer } from "effect";
import { FetchHttpClient } from "effect/http";

/** The Bun platform services that backend tests run against. */
export const TestPlatform = Layer.mergeAll(
  BunFileSystem.layer,
  BunPath.layer,
  BunCrypto.layer,
  FetchHttpClient.layer,
);
