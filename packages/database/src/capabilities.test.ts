import { describe, expect, it } from "vitest";
import { Database } from "./service.js";
import { Admissions } from "@vektorprogrammet/domain/admissions";
import { AdmissionsLive } from "./admissions/postgres-layer.js";
import { Economy } from "@vektorprogrammet/domain/receipt";
import { EconomyLive } from "./receipt/postgres-layer.js";
import { Organization } from "@vektorprogrammet/domain/organization";
import { OrganizationLive } from "./organization/postgres-layer.js";
import { Profile } from "@vektorprogrammet/domain/profile";
import { ProfileLive } from "./profile/postgres-layer.js";
import { Recruitment } from "@vektorprogrammet/domain/recruitment";
import { RecruitmentLive } from "./recruitment/postgres-layer.js";
import { Schools } from "@vektorprogrammet/domain/schools";
import { SchoolsLive } from "./schools/postgres-layer.js";
import { SocialEvents } from "@vektorprogrammet/domain/social-events";
import { SocialEventsLive } from "./social-events/postgres-layer.js";
import type { Layer } from "effect";
import {
  capabilityAuthorityDependencies,
  capabilityNames,
  type CapabilityName,
} from "@vektorprogrammet/domain/capabilities";

const visit = (
  capability: CapabilityName,
  visiting: Set<CapabilityName>,
  visited: Set<CapabilityName>,
): void => {
  if (visiting.has(capability)) throw new Error(`capability cycle at ${capability}`);

  if (visited.has(capability)) return;
  visiting.add(capability);

  for (const dependency of capabilityAuthorityDependencies[capability]) {
    visit(dependency, visiting, visited);
  }

  visiting.delete(capability);
  visited.add(capability);
};

const implementedCapabilityLayers = {
  Admissions: AdmissionsLive,
  Economy: EconomyLive,
  Organization: OrganizationLive,
  Profile: ProfileLive,
  Schools: SchoolsLive,
  Recruitment: RecruitmentLive,
  SocialEvents: SocialEventsLive,
} satisfies {
  readonly Admissions: Layer.Layer<Admissions, never, Database>;
  readonly Economy: Layer.Layer<Economy, never, Database>;
  readonly Organization: Layer.Layer<Organization, never, Database>;
  readonly Profile: Layer.Layer<Profile, never, Database | Organization>;
  readonly Schools: Layer.Layer<Schools, never, Database>;
  readonly Recruitment: Layer.Layer<
    Recruitment,
    never,
    Database | Admissions | Organization | Profile
  >;
  readonly SocialEvents: Layer.Layer<SocialEvents, never, Database>;
};

describe("logical capability dependencies", () => {
  it("keeps the capability graph acyclic", () => {
    const visited = new Set<CapabilityName>();

    for (const capability of capabilityNames) visit(capability, new Set(), visited);
    expect(visited.size).toBe(capabilityNames.length);
  });

  it("matches every logical authority dependency in the frozen topology", () => {
    expect(capabilityAuthorityDependencies).toEqual({
      Database: [],
      Identity: ["Database"],
      Organization: ["Database"],
      Profile: ["Organization"],
      Admissions: ["Database", "Organization"],
      Schools: ["Database", "Organization"],
      Recruitment: ["Database", "Admissions", "Organization", "Profile"],
      Economy: ["Database", "Identity", "PrivateFileStore", "NotificationGateway"],
      SocialEvents: ["Database", "Organization"],
      Content: ["ContentManagement"],
      ContentManagement: [],
      PrivateFileStore: [],
      NotificationGateway: [],
    });
  });

  it("makes implemented Layer requirements compiler-visible", () => {
    expect(Object.keys(implementedCapabilityLayers).toSorted()).toEqual([
      "Admissions",
      "Economy",
      "Organization",
      "Profile",
      "Recruitment",
      "Schools",
      "SocialEvents",
    ]);
  });
});
