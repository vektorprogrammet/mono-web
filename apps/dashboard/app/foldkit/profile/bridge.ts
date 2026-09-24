import { nativeProblemFrom } from "../../lib/native-problem";
import { Schema as S, flow } from "effect";


export const ProfileRequestId = S.Int.check(S.isGreaterThanOrEqualTo(0));

export const ProfileBridgeFailure = S.TaggedUnion({
"Unauthorized": { message: S.String },
"Forbidden": { message: S.String },
"NotFound": { message: S.String },
"Validation": { message: S.String },
"Conflict": { message: S.String },
"Network": { message: S.String },
"RateLimited": { message: S.String },
"Configuration": { message: S.String }
});

export type ProfileBridgeFailure = S.Schema.Type<typeof ProfileBridgeFailure>;

export const toProfileBridgeFailure = flow(nativeProblemFrom, (problem): ProfileBridgeFailure => {
 const tag = problem?.code ?? "";

  if (tag === "credential.missing" || tag === "credential.invalid") {
    return ProfileBridgeFailure.cases.Unauthorized.make({ message: "Sesjonen har utløpt. Logg inn på nytt." });
  }

  if (tag === "authority.denied") {
    return ProfileBridgeFailure.cases.Forbidden.make({ message: "Du mangler tillatelse til å endre profilen." });
  }

  if (tag === "resource.not-found") {
    return ProfileBridgeFailure.cases.NotFound.make({ message: "Fant ikke profildataene." });
  }

  if (tag.startsWith("precondition.") || tag.startsWith("idempotency.")) {
    return ProfileBridgeFailure.cases.Conflict.make({
      message: "Profilen er endret av en annen. Last siden på nytt for å se de nyeste verdiene.",
    });
  }

  if (tag === "idempotency.response-expired") {
    return ProfileBridgeFailure.cases.Conflict.make({
      message: "Lagringen kunne ikke spilles av. Prøv på nytt.",
    });
  }

  if (tag.startsWith("validation.") || tag === "request.malformed") {
    return ProfileBridgeFailure.cases.Validation.make({
      message: "Serveren godtok ikke verdienne. Kontroller feltene og prøv igjen.",
    });
  }

  if (tag === "rate-limit.exceeded") {
    return ProfileBridgeFailure.cases.RateLimited.make({
      message: "For mange forespørsler. Vent litt og prøv på nytt.",
    });
  }

  if (tag === "dependency.unavailable" || tag === "internal.error") {
    return ProfileBridgeFailure.cases.Configuration.make({ message: "Tjenesten er feilkonfigurert." });
  }

  return ProfileBridgeFailure.cases.Network.make({ message: "Kunne ikke lagre profilen. Prøv på nytt." });
});
