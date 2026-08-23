export const capabilityNames = [
  "Database",
  "Identity",
  "Organization",
  "Admissions",
  "Recruitment",
  "Economy",
  "Content",
  "ContentManagement",
  "PrivateFileStore",
  "NotificationGateway",
] as const;

export type CapabilityName = (typeof capabilityNames)[number];

export type CapabilityDependencyGraph = {
  readonly [Capability in CapabilityName]: ReadonlyArray<CapabilityName>;
};

/** Compile-time checked direct requirements from design spec 0040. */
export const capabilityDependencies = {
  Database: [],
  Identity: ["Database"],
  Organization: ["Database"],
  Admissions: ["Database", "Organization"],
  Recruitment: ["Database", "Admissions", "Organization"],
  Economy: ["Database", "Identity", "PrivateFileStore", "NotificationGateway"],
  Content: ["ContentManagement"],
  ContentManagement: [],
  PrivateFileStore: [],
  NotificationGateway: [],
} as const satisfies CapabilityDependencyGraph;
