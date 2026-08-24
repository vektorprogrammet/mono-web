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

const errorTag = (error: unknown): string => {
  if (typeof error !== "object" || error === null) return "";
  if ("_tag" in error && typeof error._tag === "string") return error._tag;
  if ("type" in error && typeof error.type === "string") return error.type;
  if ("tag" in error && typeof error.tag === "string") return error.tag;
  return "";
};

export const toProfileBridgeFailure = (error: unknown): ProfileBridgeFailure => {
  const tag = errorTag(error);

  if (tag.includes("Unauthenticated") || tag === "Unauthorized") {
    return { _tag: "Unauthorized", message: "Sesjonen har utløpt. Logg inn på nytt." };
  }
  if (tag.includes("Forbidden") || tag.includes("Inactive")) {
    return { _tag: "Forbidden", message: "Du mangler tillatelse til å endre profilen." };
  }
  if (tag.includes("NotFound") || tag.includes("ProfileContact")) {
    return { _tag: "NotFound", message: "Fant ikke profildataene." };
  }
  if (tag.includes("Stale") || tag.includes("Revision") || tag.includes("RevisionConflict")) {
    return {
      _tag: "Conflict",
      message:
        "Profilen er endret av en annen. Last siden på nytt for å se de nyeste verdiene.",
    };
  }
  if (
    tag.includes("CommandConflict") ||
    tag.includes("Duplicate") ||
    tag.includes("Replay")
  ) {
    return {
      _tag: "Conflict",
      message: "Lagringen ble ikke registrert fordi samme kommando allerede er utført.",
    };
  }
  if (tag.includes("Validation") || tag.includes("Decode")) {
    return {
      _tag: "Validation",
      message: "Serveren godtok ikke verdienne. Kontroller feltene og prøv igjen.",
    };
  }
  if (tag.includes("RateLimited")) {
    return {
      _tag: "RateLimited",
      message: "For mange forespørsler. Vent litt og prøv på nytt.",
    };
  }
  if (tag.includes("Configuration")) {
    return { _tag: "Configuration", message: "Tjenesten er feilkonfigurert." };
  }
  return { _tag: "Network", message: "Kunne ikke lagre profilen. Prøv på nytt." };
};
