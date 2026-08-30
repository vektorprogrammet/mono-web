import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const effects: Array<() => void> = [];
  return {
    effects,
    startTransition: vi.fn((run: () => void) => run()),
    useEffect: vi.fn((effect: () => void) => effects.push(effect)),
    hydrateRoot: vi.fn(),
    hydratedRouter: vi.fn(() => null),
    registerDashboard: vi.fn(),
    registerInterview: vi.fn(),
    registerOrganization: vi.fn(),
    registerSchools: vi.fn(),
    registerContent: vi.fn(),
    registerProfile: vi.fn(),
  };
});

vi.mock("react", () => ({
  StrictMode: Symbol.for("react.fragment"),
  startTransition: mocks.startTransition,
  useEffect: mocks.useEffect,
}));
vi.mock("react-dom/client", () => ({ hydrateRoot: mocks.hydrateRoot }));
vi.mock("react-router/dom", () => ({ HydratedRouter: mocks.hydratedRouter }));
vi.mock("./foldkit/dashboard/elements", () => ({
  registerDashboardElement: mocks.registerDashboard,
}));
vi.mock("./foldkit/interview/elements", () => ({
  registerInterviewElement: mocks.registerInterview,
}));
vi.mock("./foldkit/organization/elements", () => ({
  registerOrganizationCatalogElement: mocks.registerOrganization,
}));
vi.mock("./foldkit/schools/elements", () => ({
  registerSchoolsDirectoryElement: mocks.registerSchools,
}));
vi.mock("./foldkit/content/elements", () => ({
  registerContentWorkspaceElement: mocks.registerContent,
}));
vi.mock("./foldkit/profile/elements", () => ({
  registerProfileEditorElement: mocks.registerProfile,
}));

const registrations = [
  mocks.registerDashboard,
  mocks.registerInterview,
  mocks.registerOrganization,
  mocks.registerSchools,
  mocks.registerContent,
  mocks.registerProfile,
] as const;

describe("dashboard hydration custom-element ownership", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.effects.length = 0;
    vi.stubGlobal("document", {});
  });

  afterEach(() => vi.unstubAllGlobals());

  it("registers every custom element from the post-hydration effect", async () => {
    await import("./entry.client");

    expect(mocks.startTransition).toHaveBeenCalledTimes(1);
    expect(mocks.hydrateRoot).toHaveBeenCalledTimes(1);
    for (const register of registrations) expect(register).not.toHaveBeenCalled();

    const root = mocks.hydrateRoot.mock.calls[0]?.[1] as ReactElement<{
      readonly children: ReactElement;
    }>;
    const hydrationOwner = root.props.children;
    if (typeof hydrationOwner.type !== "function")
      throw new Error("hydration owner is not callable");
    (hydrationOwner.type as (props: Record<string, never>) => unknown)({});

    expect(mocks.useEffect).toHaveBeenCalledTimes(1);
    for (const register of registrations) expect(register).not.toHaveBeenCalled();

    expect(mocks.effects).toHaveLength(1);
    mocks.effects[0]?.();
    for (const register of registrations) expect(register).toHaveBeenCalledTimes(1);
  });
});
