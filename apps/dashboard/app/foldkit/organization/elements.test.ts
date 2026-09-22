import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const client = { public: { organization: {} } };
  const dispose = vi.fn();
  return {
    client,
    createClient: vi.fn(() => client),
    dispose,
    embed: vi.fn(() => dispose),
  };
});

vi.mock("./browser-client", () => ({
  createBrowserOrganizationCatalogClient: mocks.createClient,
}));
vi.mock("./main", () => ({ embedOrganizationCatalog: mocks.embed }));

class FakeElement {
  id = "";
  className = "";
  textContent: string | null = null;
  children: ReadonlyArray<unknown> = [];
  readonly attributes = new Map<string, string>();

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  replaceChildren(...children: ReadonlyArray<unknown>): void {
    this.children = children;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
}

interface OrganizationElementLifecycle {
  connectedCallback(): void;
  disconnectedCallback(): void;
}

describe("Organization catalog custom element", () => {
  const registry = new Map<string, CustomElementConstructor>();
  const define = vi.fn((name: string, constructor: CustomElementConstructor) => {
    registry.set(name, constructor);
  });

  beforeEach(() => {
    vi.resetModules();
    registry.clear();
    define.mockClear();
    mocks.createClient.mockClear();
    mocks.embed.mockClear();
    mocks.dispose.mockClear();
    vi.stubGlobal("window", {});
    vi.stubGlobal("HTMLElement", FakeElement);
    vi.stubGlobal("document", { createElement: () => new FakeElement() });
    vi.stubGlobal("customElements", {
      define,
      get: (name: string) => registry.get(name),
    });
  });

  it("registers kind-specific elements and owns one runtime per connection", async () => {
    // The dynamic import intentionally proves module evaluation does not claim DOM ownership.
    const {
      FIELD_OF_STUDY_CATALOG_ELEMENT,
      TEAM_CATALOG_ELEMENT,
      registerOrganizationCatalogElement,
    } = await import("./elements");

    expect(define).not.toHaveBeenCalled();
    expect(mocks.embed).not.toHaveBeenCalled();
    registerOrganizationCatalogElement();
    registerOrganizationCatalogElement();
    expect(define).toHaveBeenCalledTimes(2);

    const TeamElementConstructor = registry.get(TEAM_CATALOG_ELEMENT);
    const FieldOfStudyElementConstructor = registry.get(FIELD_OF_STUDY_CATALOG_ELEMENT);
    if (TeamElementConstructor === undefined || FieldOfStudyElementConstructor === undefined) {
      throw new Error("organization elements were not registered");
    }
    const teamElement = new TeamElementConstructor() as HTMLElement & OrganizationElementLifecycle;
    const fieldOfStudyElement = new FieldOfStudyElementConstructor() as HTMLElement &
      OrganizationElementLifecycle;

    teamElement.connectedCallback();
    teamElement.connectedCallback();
    fieldOfStudyElement.connectedCallback();
    expect(mocks.createClient).toHaveBeenCalledTimes(2);
    expect(mocks.embed).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: "foldkit-organization-catalog" }),
      { catalogKind: "Team", client: mocks.client },
    );
    expect(mocks.embed).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: "foldkit-organization-catalog" }),
      { catalogKind: "FieldOfStudy", client: mocks.client },
    );

    teamElement.disconnectedCallback();
    fieldOfStudyElement.disconnectedCallback();
    expect(mocks.dispose).toHaveBeenCalledTimes(2);

    teamElement.connectedCallback();
    expect(mocks.createClient).toHaveBeenCalledTimes(3);
    expect(mocks.embed).toHaveBeenCalledTimes(3);
  });
});
