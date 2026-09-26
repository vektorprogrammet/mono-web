import * as BunServices from "@effect/platform-bun/BunServices";
import { Effect, Layer, Redacted } from "effect";
import { Pool } from "pg";
import {
  parseDisposableCohortDatabaseUrl,
  readPrivateCohortJson,
} from "@vektorprogrammet/database/cohort-cli";
import {
  CurrentAssignmentFailure,
  decodeCurrentAssignmentSnapshot,
  importCurrentAssignmentCohort,
} from "@vektorprogrammet/database/placements";
import { DatabaseLive } from "@vektorprogrammet/database/live";
import { databaseHealth } from "@vektorprogrammet/database";

const invalidSnapshot = () => new CurrentAssignmentFailure({ code: "InvalidSnapshot" });

export const currentAssignmentForbiddenAmbientConfigurationKeys = [
  "DATABASE_URL",
  "BACKEND_PG_URL",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "BETTER_AUTH_TRUSTED_ORIGINS",
  "NATIVE_IDENTITY_TRUSTED_ORIGINS",
  "OAUTH_CANONICAL_ORIGIN",
  "OAUTH_DASHBOARD_ORIGIN",
  "OAUTH_NATIVE_API_RESOURCE",
  "OAUTH_INTERNAL_SOURCE_NETWORKS",
  "PUBLIC_APPLICATION_EFFECT_MODE",
  "PASSWORD_RESET_DELIVERY_MODE",
  "RECEIPT_DELIVERY_MODE",
  "MAIL_DELIVERY_URL",
  "MAIL_DELIVERY_TOKEN",
  "PUBLIC_APPLICATION_EFFECT_ENDPOINT",
  "PUBLIC_APPLICATION_EFFECT_TOKEN",
  "CONTACT_DELIVERY_URL",
  "CONTACT_DELIVERY_TOKEN",
  "ONBOARDING_DELIVERY_URL",
  "ONBOARDING_DELIVERY_TOKEN",
  "RECEIPT_DELIVERY_URL",
  "RECEIPT_DELIVERY_TOKEN",
  "PASSWORD_RESET_DELIVERY_URL",
  "PASSWORD_RESET_DELIVERY_TOKEN",
  "SLACK_ENDPOINT",
  "GATEWAY_API_TOKEN",
] as const;

export const rejectCurrentAssignmentAmbientConfiguration = (
  environment: Readonly<Record<string, string | undefined>>,
  invalid: () => Error,
): void => {
  if (
    currentAssignmentForbiddenAmbientConfigurationKeys.some((key) => environment[key] !== undefined)
  )
    throw invalid();
};

export const disposableCurrentAssignmentDatabaseUrl = (value: string | undefined): string =>
  parseDisposableCohortDatabaseUrl(value, /^\/current_assignment_rehearsal$/, invalidSnapshot);

export const runCurrentAssignmentCohortCli = async (): Promise<void> => {
  if (
    process.argv.length !== 2 ||
    process.env.CURRENT_ASSIGNMENT_MODE !== "synthetic" ||
    process.env.NATIVE_IDENTITY_DEPLOYMENT !== "local"
  )
    throw invalidSnapshot();
  rejectCurrentAssignmentAmbientConfiguration(process.env, invalidSnapshot);

  const input = decodeCurrentAssignmentSnapshot(
    await Effect.runPromise(
      readPrivateCohortJson(process.env.CURRENT_ASSIGNMENT_INPUT, invalidSnapshot),
    ),
  );

  const url = disposableCurrentAssignmentDatabaseUrl(process.env.CURRENT_ASSIGNMENT_PG_URL);
  await Effect.runPromise(
    databaseHealth.pipe(
      Effect.provide(
        DatabaseLive({ url: Redacted.make(url), maxConnections: 1 }).pipe(
          Layer.provide(BunServices.layer),
        ),
      ),
    ),
  );
  const pool = new Pool({ connectionString: url, max: 2 });

  try {
    process.stdout.write(
      JSON.stringify(await Effect.runPromise(importCurrentAssignmentCohort(pool, input))) + "\n",
    );
  } finally {
    await pool.end();
  }
};
