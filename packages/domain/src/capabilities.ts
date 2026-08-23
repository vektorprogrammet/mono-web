export const capabilityNames = [
  "Identity",
  "Organization",
  "Recruitment",
  "Admissions",
  "Economy",
  "ContentManagement",
] as const;

export type CapabilityName = (typeof capabilityNames)[number];

export type CapabilityDependencyGraph = {
  readonly [Capability in CapabilityName]: ReadonlyArray<CapabilityName>;
};

/**
 * Compile-time checked logical dependencies. An empty list means that no
 * cross-capability dependency is accepted yet; it does not claim isolation.
 */
export const capabilityDependencies = {
  Identity: [],
  Organization: [],
  Recruitment: ["Identity", "Admissions", "Organization"],
  Admissions: [],
  Economy: [],
  ContentManagement: [],
} as const satisfies CapabilityDependencyGraph;
