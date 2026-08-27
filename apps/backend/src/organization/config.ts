import {
  OrganizationActorSchema,
  type OrganizationActor,
} from "@vektorprogrammet/domain/organization";
import { Schema } from "effect";

const MAX_TOKEN_MAPPINGS = 64;
const MAX_TOKEN_CONFIG_BYTES = 65_536;
const MAX_REQUEST_BODY_BYTES = 1_048_576;

const BearerTokenSchema = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value) => value.length > 0 && value.length <= 512 && !/\s/u.test(value), {
      message: "a bounded bearer token",
    }),
  ),
);
const OrganizationTokenMapSchema = Schema.Record(BearerTokenSchema, OrganizationActorSchema);
const BoundedBodyBytesSchema = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(MAX_REQUEST_BODY_BYTES)),
);

export interface OrganizationApiConfig {
  /** Temporary composition input. This map does not establish Identity persistence. */
  readonly actorsByToken: ReadonlyMap<string, OrganizationActor>;
  readonly maxBodyBytes: number;
}

const parseActorsByToken = (raw: string | undefined): ReadonlyMap<string, OrganizationActor> => {
  if (raw === undefined || raw.length === 0) return new Map();
  if (
    raw.length > MAX_TOKEN_CONFIG_BYTES ||
    new TextEncoder().encode(raw).byteLength > MAX_TOKEN_CONFIG_BYTES
  ) {
    throw new Error("ORGANIZATION_AUTH_TOKENS exceeds its configured bound");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("ORGANIZATION_AUTH_TOKENS must be JSON");
  }

  let actors: typeof OrganizationTokenMapSchema.Type;
  try {
    actors = Schema.decodeUnknownSync(OrganizationTokenMapSchema)(parsed, {
      onExcessProperty: "error",
    });
  } catch {
    throw new Error("ORGANIZATION_AUTH_TOKENS must map bounded tokens to Organization actors");
  }

  const entries = Object.entries(actors);
  if (entries.length > MAX_TOKEN_MAPPINGS) {
    throw new Error(`ORGANIZATION_AUTH_TOKENS must contain at most ${MAX_TOKEN_MAPPINGS} actors`);
  }
  return new Map(entries);
};

const parseMaxBodyBytes = (raw: string | undefined): number => {
  const value = raw ?? "16384";
  if (!/^\d+$/u.test(value)) {
    throw new Error("ORGANIZATION_MAX_BODY_BYTES must be a positive safe integer");
  }
  const parsed = Number(value);
  try {
    return Schema.decodeUnknownSync(BoundedBodyBytesSchema)(parsed);
  } catch {
    throw new Error("ORGANIZATION_MAX_BODY_BYTES must be a positive safe integer");
  }
};

export const makeOrganizationApiConfig = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): OrganizationApiConfig => ({
  actorsByToken: parseActorsByToken(env.ORGANIZATION_AUTH_TOKENS),
  maxBodyBytes: parseMaxBodyBytes(env.ORGANIZATION_MAX_BODY_BYTES),
});
