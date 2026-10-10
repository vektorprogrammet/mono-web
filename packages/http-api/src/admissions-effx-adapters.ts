import type { HttpAccessAnnotationSpec } from "@effx/runtime";
import { type SCOPE_RESOLVER_IDS } from "@vektorprogrammet/domain/authz";
import { Predicate, Schema } from "effect";
import { accessSpecAnnotations, anonymousNativeAccess, personNativeAccess } from "./access.js";
import { decodeDeclaredOrThrow } from "./declaration-decoding.js";
import { ProfileCurrentPerson } from "./profile-effx-adapters.js";

/** The exported identities bind each declared resolver to its current authority projection. */
export const AdmissionsPublicOpenPeriodsResolver = {
  id: "admissions.public-open-periods",
} as const satisfies { readonly id: (typeof SCOPE_RESOLVER_IDS)[number] };

export const AdmissionsPublicApplicationOptionsResolver = {
  id: "admissions.public-application-options",
} as const satisfies { readonly id: (typeof SCOPE_RESOLVER_IDS)[number] };

export const AdmissionsApplicationCreateResolver = {
  id: "admissions.application-create",
} as const satisfies { readonly id: (typeof SCOPE_RESOLVER_IDS)[number] };

export const AdmissionsPublicApplicationByIdResolver = {
  id: "admissions.public-application-by-id",
} as const satisfies { readonly id: (typeof SCOPE_RESOLVER_IDS)[number] };

export const AdmissionsManagementPeriodsResolver = {
  id: "admissions.management-periods",
} as const satisfies { readonly id: (typeof SCOPE_RESOLVER_IDS)[number] };

export const AdmissionsPeriodCreateResolver = {
  id: "admissions.period-create",
} as const satisfies { readonly id: (typeof SCOPE_RESOLVER_IDS)[number] };

export const AdmissionsPeriodByIdResolver = {
  id: "admissions.period-by-id",
} as const satisfies { readonly id: (typeof SCOPE_RESOLVER_IDS)[number] };

type AdmissionsResolver = { readonly id: (typeof SCOPE_RESOLVER_IDS)[number] };

type AnonymousPolicy = {
  readonly kind: "Anonymous";
  readonly resolver: AdmissionsResolver;
  readonly decisionTime: "SnapshotRead" | "Transaction";
};

type PersonPolicy = {
  readonly kind: "Person";
  readonly capability:
    | "admissions.read-applicant-progress"
    | "admissions.read-periods"
    | "admissions.create-period"
    | "admissions.revise-period"
    | "placements.self";
  readonly resolver: AdmissionsResolver;
  readonly requirements: readonly ["profile.owner"] | readonly [];
  readonly decisionTime: "SnapshotRead" | "Transaction";
};

/** The ten approved operations; an access outside this table is refused when it is annotated. */
const policies: ReadonlyArray<AnonymousPolicy | PersonPolicy> = [
  {
    kind: "Anonymous",
    resolver: AdmissionsPublicOpenPeriodsResolver,
    decisionTime: "SnapshotRead",
  },
  {
    kind: "Anonymous",
    resolver: AdmissionsPublicApplicationOptionsResolver,
    decisionTime: "SnapshotRead",
  },
  {
    kind: "Anonymous",
    resolver: AdmissionsApplicationCreateResolver,
    decisionTime: "Transaction",
  },
  {
    kind: "Anonymous",
    resolver: AdmissionsPublicApplicationByIdResolver,
    decisionTime: "SnapshotRead",
  },
  {
    kind: "Person",
    capability: "admissions.read-applicant-progress",
    resolver: ProfileCurrentPerson,
    requirements: ["profile.owner"],
    decisionTime: "SnapshotRead",
  },
  {
    kind: "Person",
    capability: "admissions.read-periods",
    resolver: AdmissionsManagementPeriodsResolver,
    requirements: [],
    decisionTime: "SnapshotRead",
  },
  {
    kind: "Person",
    capability: "admissions.create-period",
    resolver: AdmissionsPeriodCreateResolver,
    requirements: [],
    decisionTime: "Transaction",
  },
  {
    kind: "Person",
    capability: "admissions.revise-period",
    resolver: AdmissionsPeriodByIdResolver,
    requirements: [],
    decisionTime: "Transaction",
  },
  {
    kind: "Person",
    capability: "placements.self",
    resolver: ProfileCurrentPerson,
    requirements: [],
    decisionTime: "SnapshotRead",
  },
  {
    kind: "Person",
    capability: "placements.self",
    resolver: ProfileCurrentPerson,
    requirements: [],
    decisionTime: "Transaction",
  },
];

const resolverSymbol = <R extends AdmissionsResolver>(symbol: R) =>
  Schema.declare((value: unknown): value is R => value === symbol);

const AdmissionsResolverSchema = Schema.Union([
  resolverSymbol(AdmissionsPublicOpenPeriodsResolver),
  resolverSymbol(AdmissionsPublicApplicationOptionsResolver),
  resolverSymbol(AdmissionsApplicationCreateResolver),
  resolverSymbol(AdmissionsPublicApplicationByIdResolver),
  resolverSymbol(AdmissionsManagementPeriodsResolver),
  resolverSymbol(AdmissionsPeriodCreateResolver),
  resolverSymbol(AdmissionsPeriodByIdResolver),
  resolverSymbol(ProfileCurrentPerson),
]);

const AdmissionsAccess = Schema.Struct({
  exposure: Schema.Literal("External"),
  acceptedCredentials: Schema.Union([
    Schema.Tuple([Schema.Literal("None")]),
    Schema.Tuple([Schema.Literal("BetterAuthCookie"), Schema.Literal("OAuthUserBearer")]),
  ]),
  principalKinds: Schema.Union([
    Schema.Tuple([Schema.Literal("Anonymous")]),
    Schema.Tuple([Schema.Literal("Person")]),
  ]),
  capabilities: Schema.Union([
    Schema.TaggedStruct("None", {}),
    Schema.TaggedStruct("One", {
      capability: Schema.Literals([
        "admissions.read-applicant-progress",
        "admissions.read-periods",
        "admissions.create-period",
        "admissions.revise-period",
        "placements.self",
      ]),
    }),
  ]),
  requirements: Schema.Array(
    Schema.Struct({
      id: Schema.Literal("profile.owner"),
      parameters: Schema.optionalKey(Schema.Record(Schema.String, Schema.Never)),
    }),
  ),
  canonicalScopeResolver: AdmissionsResolverSchema,
  concealment: Schema.TaggedStruct("Reveal", {}),
  decisionTime: Schema.Literals(["SnapshotRead", "Transaction"]),
}).pipe(
  Schema.check(
    Schema.makeFilter((spec) => {
      const capabilities = spec.capabilities;

      if (Predicate.isTagged(capabilities, "One")) {
        return (
          spec.acceptedCredentials.length === 2 &&
          spec.principalKinds[0] === "Person" &&
          policies.some(
            (policy) =>
              policy.kind === "Person" &&
              policy.capability === capabilities.capability &&
              policy.resolver === spec.canonicalScopeResolver &&
              policy.decisionTime === spec.decisionTime &&
              policy.requirements.length === spec.requirements.length &&
              policy.requirements.every((id, index) => spec.requirements[index]?.id === id),
          )
        );
      }

      return (
        spec.acceptedCredentials.length === 1 &&
        spec.principalKinds[0] === "Anonymous" &&
        spec.requirements.length === 0 &&
        policies.some(
          (policy) =>
            policy.kind === "Anonymous" &&
            policy.resolver === spec.canonicalScopeResolver &&
            policy.decisionTime === spec.decisionTime,
        )
      );
    }),
  ),
);

const decodeAdmissionsAccess = decodeDeclaredOrThrow(AdmissionsAccess, {
  onExcessProperty: "error",
});

/** Projects only the ten approved operations onto the existing native AccessSpec. */
export const admissionsAccessAnnotations = (input: HttpAccessAnnotationSpec) => {
  const spec = decodeAdmissionsAccess(input);

  return accessSpecAnnotations(
    Predicate.isTagged(spec.capabilities, "One")
      ? personNativeAccess({
          capability: spec.capabilities.capability,
          canonicalScopeResolver: spec.canonicalScopeResolver.id,
          requirements: spec.requirements.map(({ id }) => id),
          decisionTime: spec.decisionTime,
        })
      : anonymousNativeAccess(spec.canonicalScopeResolver.id, spec.decisionTime),
  );
};
