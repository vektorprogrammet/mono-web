import { describe, expect, it } from "vitest";
import { capabilityDependencies, capabilityNames, type CapabilityName } from "./capabilities.js";

const visit = (
  capability: CapabilityName,
  visiting: Set<CapabilityName>,
  visited: Set<CapabilityName>,
): void => {
  if (visiting.has(capability)) throw new Error(`capability cycle at ${capability}`);
  if (visited.has(capability)) return;
  visiting.add(capability);
  for (const dependency of capabilityDependencies[capability]) {
    visit(dependency, visiting, visited);
  }
  visiting.delete(capability);
  visited.add(capability);
};

describe("logical capability dependencies", () => {
  it("keeps the capability graph acyclic", () => {
    const visited = new Set<CapabilityName>();
    for (const capability of capabilityNames) visit(capability, new Set(), visited);
    expect(visited.size).toBe(capabilityNames.length);
  });

  it("matches every direct capability requirement in the frozen topology", () => {
    expect(capabilityDependencies).toEqual({
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
    });
  });
});
