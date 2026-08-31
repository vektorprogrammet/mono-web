/**
 * SDK runtime configuration decoded through Effect Config.
 *
 * @since 0.2.0
 */
import { Config, Effect, Option } from "effect";

const optionalString = (name: string) => Config.option(Config.string(name));

const configuredApiUrl = Config.all([
  optionalString("API_URL"),
  optionalString("VITE_API_URL"),
]).pipe(
  Config.map(
    ([serverApiUrl, browserApiUrl]) =>
      Option.getOrUndefined(serverApiUrl) ?? Option.getOrUndefined(browserApiUrl),
  ),
);

const configuredFixtureMode = Config.all([
  optionalString("API_MODE"),
  optionalString("VITE_API_MODE"),
]).pipe(
  Config.map(
    ([serverMode, browserMode]) =>
      Option.getOrUndefined(serverMode) === "fixture" ||
      Option.getOrUndefined(browserMode) === "fixture",
  ),
);

/** Portable SDK configuration description for injected ConfigProviders. */
export const sdkRuntimeConfig = Config.all({
  apiUrl: configuredApiUrl,
  isFixtureMode: configuredFixtureMode,
});

/**
 * Compatibility adapter for the SDK's long-standing constant exports. Effect
 * Config owns the environment read; composition roots can use sdkRuntimeConfig
 * with an injected provider instead.
 */
const configured = sdkRuntimeConfig.pipe(Effect.runSync);

export const apiUrl: string | undefined = configured.apiUrl;
export const isFixtureMode: boolean = configured.isFixtureMode;
