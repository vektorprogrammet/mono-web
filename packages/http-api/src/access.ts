import {
  CAPABILITY_TYPE_IDS,
  CREDENTIAL_MECHANISM_KINDS,
  OBJECT_CAPABILITY_TYPE_IDS,
  PRINCIPAL_KINDS,
  REQUIREMENT_IDS,
  type AccessSpec,
  type CapabilityExpression,
  type CapabilityTypeId,
  type CredentialMechanism,
  type TypedRequirement,
  makeAccessSpec,
} from "@vektorprogrammet/domain/authz";
import { Context, Option } from "effect";
import { HttpApiEndpoint, OpenApi } from "effect/unstable/httpapi";

export const AccessSpecAnnotation = Context.Service<AccessSpec>(
  "@vektorprogrammet/http-api/AccessSpec",
);

const rank = (order: ReadonlyArray<string>, value: string): number => {
  const index = order.indexOf(value);
  return index === -1 ? order.length : index;
};
const compareByRegistry = (order: ReadonlyArray<string>) => (left: string, right: string) =>
  rank(order, left) - rank(order, right);

const projectedCapabilities = (expression: CapabilityExpression): Record<string, unknown> => {
  switch (expression._tag) {
    case "None":
      return { none: true };
    case "One":
      return { one: expression.capability.type };
    case "All":
      return {
        all: expression.capabilities
          .map((capability) => capability.type)
          .sort(compareByRegistry(CAPABILITY_TYPE_IDS)),
      };
    case "Any":
      return {
        any: expression.capabilities
          .map((capability) => capability.type)
          .sort(compareByRegistry(CAPABILITY_TYPE_IDS)),
      };
  }
};
const projectedRequirement = (requirement: TypedRequirement): Record<string, unknown> => {
  const parameters = Object.keys(requirement.parameters);
  return parameters.length === 0
    ? { id: requirement.id }
    : { id: requirement.id, parameters: requirement.parameters };
};

export interface VektorAccessProjection {
  readonly exposure: AccessSpec["exposure"];
  readonly acceptedCredentials: ReadonlyArray<string>;
  readonly principalKinds: ReadonlyArray<string>;
  readonly capabilities: Record<string, unknown>;
  readonly requirements: ReadonlyArray<Record<string, unknown>>;
  readonly canonicalScopeResolver: string;
  readonly concealment: {
    readonly mode: "Reveal" | "NotFound";
    readonly stages: ReadonlyArray<string>;
  };
  readonly decisionTime: AccessSpec["decisionTime"];
}
export const projectVektorAccess = (spec: AccessSpec): VektorAccessProjection => ({
  exposure: spec.exposure,
  acceptedCredentials: spec.acceptedCredentials
    .map((credential) => credential._tag)
    .sort(compareByRegistry(CREDENTIAL_MECHANISM_KINDS)),
  principalKinds: [...spec.principalKinds].sort(compareByRegistry(PRINCIPAL_KINDS)),
  capabilities: projectedCapabilities(spec.capabilities),
  requirements: [...spec.requirements]
    .sort((left, right) => compareByRegistry(REQUIREMENT_IDS)(left.id, right.id))
    .map(projectedRequirement),
  canonicalScopeResolver: spec.canonicalScopeResolver,
  concealment:
    spec.concealment._tag === "Reveal"
      ? { mode: "Reveal", stages: [] }
      : { mode: "NotFound", stages: [...spec.concealment.conceal].sort() },
  decisionTime: spec.decisionTime,
});

type CapabilityTypeValue = (typeof CAPABILITY_TYPE_IDS)[number];
const capabilityTypeValue = (id: CapabilityTypeId): CapabilityTypeValue => id;
const objectCapabilitySecurityScheme: Partial<Record<CapabilityTypeValue, string>> = {
  "recruitment.invitation-response": "invitationCapability",
};
export const assertAccessProjectionRegistryParity = (): void => {
  const expected = [...OBJECT_CAPABILITY_TYPE_IDS].sort();
  const actual = Object.keys(objectCapabilitySecurityScheme).sort();
  if (
    expected.length !== actual.length ||
    expected.some((capabilityType, index) => capabilityType !== actual[index])
  ) {
    throw new TypeError(
      `ObjectCapability OpenAPI security mapping does not match the domain registry: expected ${expected.join(",")}; received ${actual.join(",")}`,
    );
  }
};
assertAccessProjectionRegistryParity();
const securitySchemeFor = (mechanism: CredentialMechanism): string | undefined => {
  switch (mechanism._tag) {
    case "None":
      return undefined;
    case "BetterAuthCookie":
      return "cookieHeader";
    case "OAuthUserBearer":
      return "oauthUserBearer";
    case "OAuthServiceBearer":
      return "oauthServiceBearer";
    case "ObjectCapability": {
      const scheme = objectCapabilitySecurityScheme[capabilityTypeValue(mechanism.capabilityType)];
      if (scheme === undefined) {
        throw new TypeError(
          `object capability ${mechanism.capabilityType} has no OpenAPI security scheme`,
        );
      }
      return scheme;
    }
  }
};
export type OpenApiSecurityProjection = ReadonlyArray<
  Readonly<Record<string, ReadonlyArray<string>>>
>;
export const projectCredentialSecurity = (spec: AccessSpec): OpenApiSecurityProjection => {
  if (spec.acceptedCredentials.length === 1 && spec.acceptedCredentials[0]?._tag === "None") {
    return [];
  }
  return spec.acceptedCredentials.map((mechanism) => {
    const scheme = securitySchemeFor(mechanism);
    if (scheme === undefined) {
      throw new TypeError("None cannot be combined with another credential mechanism");
    }
    return { [scheme]: [] };
  });
};

export const accessSpecAnnotations = (input: unknown): Context.Context<AccessSpec> => {
  const spec = makeAccessSpec(input);
  return Context.merge(
    Context.make(AccessSpecAnnotation, spec),
    OpenApi.annotations({
      transform: (operation) => ({
        ...operation,
        "x-vektor-access": projectVektorAccess(spec),
        security: projectCredentialSecurity(spec),
      }),
    }),
  );
};
export const reflectAccessSpec = <Endpoint>(endpoint: Endpoint): Option.Option<AccessSpec> =>
  Context.getOption((endpoint as HttpApiEndpoint.Top).annotations, AccessSpecAnnotation);

export const annotateAccessSpec = <Endpoint>(endpoint: Endpoint, input: unknown): Endpoint => {
  const typedEndpoint = endpoint as HttpApiEndpoint.Top;
  if (Option.isSome(reflectAccessSpec(typedEndpoint))) {
    throw new TypeError(`endpoint ${typedEndpoint.identifier} has multiple AccessSpec annotations`);
  }
  return typedEndpoint.annotateMerge(accessSpecAnnotations(input)) as unknown as Endpoint;
};
