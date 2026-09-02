import { Schema as S } from "effect";

export const ProfileRequestId = S.Int.check(S.isGreaterThanOrEqualTo(0));

export const ProfileBridgeFailure = S.Struct({
  _tag: S.Literals([
    "Unauthorized",
    "Forbidden",
    "NotFound",
    "Validation",
    "Conflict",
    "Network",
    "RateLimited",
    "Configuration",
  ]),
  message: S.String,
});
export type ProfileBridgeFailure = S.Schema.Type<typeof ProfileBridgeFailure>;

// Tags arrive either as native Effect tags (capitalized, e.g.
// "ProfileCommandConflict") or as public SDK error types from the
// promise boundary (lowercase, e.g. "conflict"). Match both.
const errorTag = (error: unknown): string => {
  if (typeof error !== "object" || error === null) return "";
  if ("code" in error && typeof error.code === "string") return error.code;
  if ("_tag" in error && typeof error._tag === "string") return error._tag;
  if ("tag" in error && typeof error.tag === "string") return error.tag;
  return "";
};

export const toProfileBridgeFailure = (error: unknown): ProfileBridgeFailure => {
  const tag = errorTag(error);

  if (tag === "credential.missing" || tag === "credential.invalid") {
    return { _tag: "Unauthorized", message: "Sesjonen har utløpt. Logg inn på nytt." };
  }
  if (tag === "authority.denied" || tag === "scope.not-found") {
    return { _tag: "Forbidden", message: "Du mangler tillatelse til å endre profilen." };
  }
  if (tag === "resource.not-found") {
    return { _tag: "NotFound", message: "Fant ikke profildataene." };
  }
  if (tag.startsWith("precondition.") || tag.startsWith("idempotency.") || tag === "conflict") {
    return {
      _tag: "Conflict",
      message: "Profilen er endret av en annen. Last siden på nytt for å se de nyeste verdiene.",
    };
  }
  if (tag === "idempotency.response-expired") {
    return {
      _tag: "Conflict",
      message: "Lagringen kunne ikke spilles av. Prøv på nytt.",
    };
  }
  if (tag.startsWith("validation.") || tag === "request.malformed") {
    return {
      _tag: "Validation",
      message: "Serveren godtok ikke verdienne. Kontroller feltene og prøv igjen.",
    };
  }
  if (tag === "rate-limit.exceeded") {
    return {
      _tag: "RateLimited",
      message: "For mange forespørsler. Vent litt og prøv på nytt.",
    };
  }
  if (tag === "dependency.unavailable" || tag === "internal.error") {
    return { _tag: "Configuration", message: "Tjenesten er feilkonfigurert." };
  }
  return { _tag: "Network", message: "Kunne ikke lagre profilen. Prøv på nytt." };
};
