export const capabilityNames = [
  "Database",
  "Identity",
  "Organization",
  "Profile",
  "Admissions",
  "Recruitment",
  "Economy",
  "Content",
  "ContentManagement",
  "PrivateFileStore",
  "NotificationGateway",
] as const;

export type CapabilityName = (typeof capabilityNames)[number];

export type CapabilityAuthorityDependencyGraph = {
  readonly [Capability in CapabilityName]: ReadonlyArray<CapabilityName>;
};

/** Compile-time checked logical authority dependencies from design spec 0040.1. */
export const capabilityAuthorityDependencies = {
  Database: [],
  Identity: ["Database"],
  Organization: ["Database"],
  Profile: ["Organization"],
  Admissions: ["Database", "Organization"],
  Recruitment: ["Database", "Admissions", "Organization"],
  Economy: ["Database", "Identity", "PrivateFileStore", "NotificationGateway"],
  Content: ["ContentManagement"],
  ContentManagement: [],
  PrivateFileStore: [],
  NotificationGateway: [],
} as const satisfies CapabilityAuthorityDependencyGraph;
