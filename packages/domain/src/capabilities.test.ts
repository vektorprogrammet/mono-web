import { Database } from "./database/service.js";
import { Admissions, AdmissionsLive } from "./admissions/index.js";
import { Economy } from "./receipt/service.js";
import { EconomyLive } from "./receipt/postgres-layer.js";
import { Organization, OrganizationLive } from "./organization/index.js";
import { describe, expect, it } from "vitest";
import type { Layer } from "effect";
import {
  capabilityAuthorityDependencies,
  capabilityNames,
  type CapabilityName,
} from "./capabilities.js";

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
} satisfies {
  readonly Admissions: Layer.Layer<Admissions, never, Database>;
  readonly Economy: Layer.Layer<Economy, never, Database>;
  readonly Organization: Layer.Layer<Organization, never, Database>;
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
      Recruitment: ["Database", "Admissions", "Organization"],
      Economy: ["Database", "Identity", "PrivateFileStore", "NotificationGateway"],
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
    ]);
  });
});
