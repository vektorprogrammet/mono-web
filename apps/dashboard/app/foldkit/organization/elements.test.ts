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

  it("registers before hydration and owns one Team runtime while connected", async () => {
    // The dynamic import intentionally exercises registration during module evaluation after browser globals exist.
    const {
      ORGANIZATION_CATALOG_ELEMENT,
      ORGANIZATION_CATALOG_KIND_ATTRIBUTE,
      registerOrganizationCatalogElement,
    } = await import("./elements");

    expect(define).toHaveBeenCalledTimes(1);
    registerOrganizationCatalogElement();
    expect(define).toHaveBeenCalledTimes(1);

    const ElementConstructor = registry.get(ORGANIZATION_CATALOG_ELEMENT);
    if (ElementConstructor === undefined)
      throw new Error("organization element was not registered");
    const element = new ElementConstructor() as HTMLElement & OrganizationElementLifecycle;
    element.setAttribute(ORGANIZATION_CATALOG_KIND_ATTRIBUTE, "Team");

    element.connectedCallback();
    element.connectedCallback();
    expect(mocks.createClient).toHaveBeenCalledTimes(1);
    expect(mocks.embed).toHaveBeenCalledTimes(1);
    expect(mocks.embed).toHaveBeenCalledWith(
      expect.objectContaining({ id: "foldkit-organization-catalog" }),
      { catalogKind: "Team", client: mocks.client },
    );

    element.disconnectedCallback();
    expect(mocks.dispose).toHaveBeenCalledTimes(1);

    element.connectedCallback();
    expect(mocks.createClient).toHaveBeenCalledTimes(2);
    expect(mocks.embed).toHaveBeenCalledTimes(2);
  });
});
