import type { HttpAccessAnnotationSpec } from "@effx/runtime";
import { type SCOPE_RESOLVER_IDS } from "@vektorprogrammet/domain/authz";
import { Schema } from "effect";
import { accessSpecAnnotations, invitationNativeAccess, personNativeAccess } from "./access.js";
import { decodeDeclaredOrThrow } from "./declaration-decoding.js";

export const RecruitmentInvitationByCapabilityResolver = {
  id: "recruitment.invitation-response-by-capability",
} as const satisfies { readonly id: (typeof SCOPE_RESOLVER_IDS)[number] };

export const RecruitmentAssignmentBoardResolver = {
  id: "recruitment.application-assignments",
} as const satisfies { readonly id: (typeof SCOPE_RESOLVER_IDS)[number] };

export const RecruitmentSchedulingBoardResolver = {
  id: "recruitment.interviews",
} as const satisfies { readonly id: (typeof SCOPE_RESOLVER_IDS)[number] };

export const RecruitmentInterviewReportResolver = {
  id: "recruitment.interview-report",
} as const satisfies { readonly id: (typeof SCOPE_RESOLVER_IDS)[number] };

export const RecruitmentApplicationByIdResolver = {
  id: "recruitment.application-by-id",
} as const satisfies { readonly id: (typeof SCOPE_RESOLVER_IDS)[number] };

export const RecruitmentInterviewByIdResolver = {
  id: "recruitment.interview-by-id",
} as const satisfies { readonly id: (typeof SCOPE_RESOLVER_IDS)[number] };

export const RecruitmentMaintenanceResolver = {
  id: "recruitment.maintenance",
} as const satisfies { readonly id: (typeof SCOPE_RESOLVER_IDS)[number] };

/** Resolver identity, not a copied id, binds a declaration to the app's projection. */
export const RecruitmentScopeResolvers = [
  RecruitmentInvitationByCapabilityResolver,
  RecruitmentAssignmentBoardResolver,
  RecruitmentSchedulingBoardResolver,
  RecruitmentInterviewReportResolver,
  RecruitmentApplicationByIdResolver,
  RecruitmentInterviewByIdResolver,
  RecruitmentMaintenanceResolver,
] as const;

type RecruitmentResolver = (typeof RecruitmentScopeResolvers)[number];

const resolverSymbol = <R extends RecruitmentResolver>(symbol: R) =>
  Schema.declare((value: unknown): value is R => value === symbol);

const PersonResolver = Schema.Union([
  resolverSymbol(RecruitmentAssignmentBoardResolver),
  resolverSymbol(RecruitmentSchedulingBoardResolver),
  resolverSymbol(RecruitmentInterviewReportResolver),
  resolverSymbol(RecruitmentApplicationByIdResolver),
  resolverSymbol(RecruitmentInterviewByIdResolver),
  resolverSymbol(RecruitmentMaintenanceResolver),
]);

const Requirement = Schema.Struct({
  id: Schema.Literals([
    "organization.single-department-administrator",
    "organization.single-department-member",
    "recruitment.interviewer-eligible",
    "recruitment.assigned-interviewer-or-administrator",
    "recruitment.assigned-interviewer-or-co-interviewer",
    "recruitment.assigned-interviewer",
    "recruitment.not-known-self",
  ]),
  parameters: Schema.optionalKey(Schema.Record(Schema.String, Schema.Never)),
});

const PersonAccess = Schema.Struct({
  exposure: Schema.Literal("External"),
  acceptedCredentials: Schema.Tuple([
    Schema.Literal("BetterAuthCookie"),
    Schema.Literal("OAuthUserBearer"),
  ]),
  principalKinds: Schema.Tuple([Schema.Literal("Person")]),
  capabilities: Schema.TaggedStruct("One", {
    capability: Schema.Literals([
      "reviewApplicants",
      "recruitment.read-interview-report",
      "recruitment.read-interviews",
      "recruitment.schedule-interview",
      "recruitment.conduct-interview",
      "recruitment.maintain",
    ]),
  }),
  requirements: Schema.Array(Requirement),
  canonicalScopeResolver: PersonResolver,
  concealment: Schema.TaggedStruct("Reveal", {}),
  decisionTime: Schema.Literals(["SnapshotRead", "Transaction"]),
});

type PersonPolicy = {
  readonly capability: typeof PersonAccess.Type.capabilities.capability;
  readonly resolver: typeof PersonAccess.Type.canonicalScopeResolver;
  readonly requirements: ReadonlyArray<typeof Requirement.Type.id>;
  readonly decisionTime: typeof PersonAccess.Type.decisionTime;
};

/** The distinct repaired policy shapes, shared only when all access facts are identical. */
const personPolicies: ReadonlyArray<PersonPolicy> = [
  {
    capability: "reviewApplicants",
    resolver: RecruitmentAssignmentBoardResolver,
    requirements: ["organization.single-department-administrator"],
    decisionTime: "SnapshotRead",
  },
  {
    capability: "recruitment.read-interview-report",
    resolver: RecruitmentInterviewReportResolver,
    requirements: ["organization.single-department-administrator"],
    decisionTime: "SnapshotRead",
  },
  {
    capability: "recruitment.read-interviews",
    resolver: RecruitmentSchedulingBoardResolver,
    requirements: ["organization.single-department-member"],
    decisionTime: "SnapshotRead",
  },
  {
    capability: "reviewApplicants",
    resolver: RecruitmentApplicationByIdResolver,
    requirements: [
      "organization.single-department-administrator",
      "recruitment.interviewer-eligible",
    ],
    decisionTime: "Transaction",
  },
  {
    capability: "recruitment.schedule-interview",
    resolver: RecruitmentInterviewByIdResolver,
    requirements: ["recruitment.assigned-interviewer-or-administrator"],
    decisionTime: "Transaction",
  },
  {
    capability: "recruitment.conduct-interview",
    resolver: RecruitmentInterviewByIdResolver,
    requirements: [
      "recruitment.assigned-interviewer-or-co-interviewer",
      "recruitment.not-known-self",
    ],
    decisionTime: "SnapshotRead",
  },
  {
    capability: "recruitment.conduct-interview",
    resolver: RecruitmentInterviewByIdResolver,
    requirements: [
      "recruitment.assigned-interviewer-or-co-interviewer",
      "recruitment.not-known-self",
    ],
    decisionTime: "Transaction",
  },
  {
    capability: "recruitment.conduct-interview",
    resolver: RecruitmentInterviewByIdResolver,
    requirements: ["recruitment.assigned-interviewer", "recruitment.not-known-self"],
    decisionTime: "Transaction",
  },
  {
    capability: "recruitment.maintain",
    resolver: RecruitmentMaintenanceResolver,
    requirements: [],
    decisionTime: "SnapshotRead",
  },
  {
    capability: "recruitment.maintain",
    resolver: RecruitmentMaintenanceResolver,
    requirements: [],
    decisionTime: "Transaction",
  },
];

const CheckedPersonAccess = PersonAccess.pipe(
  Schema.check(
    Schema.makeFilter((spec) =>
      personPolicies.some(
        (policy) =>
          policy.capability === spec.capabilities.capability &&
          policy.resolver === spec.canonicalScopeResolver &&
          policy.decisionTime === spec.decisionTime &&
          policy.requirements.length === spec.requirements.length &&
          policy.requirements.every((id, index) => spec.requirements[index]?.id === id),
      ),
    ),
  ),
);

const decodePersonRead = decodeDeclaredOrThrow(
  CheckedPersonAccess.pipe(
    Schema.check(Schema.makeFilter((spec) => spec.decisionTime === "SnapshotRead")),
  ),
  { onExcessProperty: "error" },
);

const decodePersonCommand = decodeDeclaredOrThrow(
  CheckedPersonAccess.pipe(
    Schema.check(Schema.makeFilter((spec) => spec.decisionTime === "Transaction")),
  ),
  { onExcessProperty: "error" },
);

const personAnnotations = (spec: typeof PersonAccess.Type) =>
  accessSpecAnnotations(
    personNativeAccess({
      capability: spec.capabilities.capability,
      canonicalScopeResolver: spec.canonicalScopeResolver.id,
      requirements: spec.requirements.map(({ id }) => id),
      decisionTime: spec.decisionTime,
    }),
  );

/** A read cannot certify a command policy, including shared conduct/maintenance policies. */
export const recruitmentReadAccessAnnotations = (input: HttpAccessAnnotationSpec) =>
  personAnnotations(decodePersonRead(input));

/** A write cannot certify a read decision or weaken the repaired requirements. */
export const recruitmentCommandAccessAnnotations = (input: HttpAccessAnnotationSpec) =>
  personAnnotations(decodePersonCommand(input));

const invitationFields = {
  exposure: Schema.Literal("External"),
  acceptedCredentials: Schema.Tuple([Schema.Literal("ObjectCapability")]),
  principalKinds: Schema.Tuple([Schema.Literal("CapabilityHolder")]),
  capabilities: Schema.TaggedStruct("One", {
    capability: Schema.Literal("recruitment.invitation-response"),
  }),
  requirements: Schema.Array(Schema.Never),
  canonicalScopeResolver: resolverSymbol(RecruitmentInvitationByCapabilityResolver),
  concealment: Schema.TaggedStruct("NotFound", {
    stages: Schema.Tuple([
      Schema.Literal("CredentialFailure"),
      Schema.Literal("PrincipalKind"),
      Schema.Literal("Capability"),
      Schema.Literal("Scope"),
      Schema.Literal("Requirement"),
    ]),
  }),
};

const decodeInvitationRead = decodeDeclaredOrThrow(
  Schema.Struct({ ...invitationFields, decisionTime: Schema.Literal("SnapshotRead") }),
  { onExcessProperty: "error" },
);

const decodeInvitationCommand = decodeDeclaredOrThrow(
  Schema.Struct({ ...invitationFields, decisionTime: Schema.Literal("Transaction") }),
  { onExcessProperty: "error" },
);

/** Invitation reads never inherit a Person credential or reveal a denial. */
export const invitationReadAccessAnnotations = (input: HttpAccessAnnotationSpec) => {
  const spec = decodeInvitationRead(input);

  return accessSpecAnnotations(invitationNativeAccess([], spec.decisionTime));
};

/** Invitation responses retain transaction decisions and all five concealment stages. */
export const invitationCommandAccessAnnotations = (input: HttpAccessAnnotationSpec) => {
  const spec = decodeInvitationCommand(input);

  return accessSpecAnnotations(invitationNativeAccess([], spec.decisionTime));
};
