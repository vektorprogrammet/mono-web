import { Schema } from "effect";

const MAX_REQUEST_BODY_BYTES = 1_048_576;

const BoundedBodyBytesSchema = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(MAX_REQUEST_BODY_BYTES)),
);

export interface OrganizationApiConfig {
  readonly maxBodyBytes: number;
}

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
  maxBodyBytes: parseMaxBodyBytes(env.ORGANIZATION_MAX_BODY_BYTES),
});
