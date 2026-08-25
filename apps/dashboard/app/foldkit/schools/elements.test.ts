import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(() => ({ admin: { schools: { list: vi.fn() } } })),
  dispose: vi.fn(),
  embed: vi.fn(() => mocks.dispose),
}));

vi.mock("./browser-client", () => ({
  createBrowserSchoolsDirectoryClient: mocks.createClient,
}));
vi.mock("./main", () => ({ embedSchoolsDirectory: mocks.embed }));

import { SCHOOLS_DIRECTORY_ELEMENT, registerSchoolsDirectoryElement } from "./elements";

class FakeElement {
  id = "";
  className = "";
  textContent: string | null = null;
  children: ReadonlyArray<unknown> = [];
  readonly attributes = new Map<string, string>();

  replaceChildren(...children: ReadonlyArray<unknown>): void {
    this.children = children;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
}

interface SchoolsElementLifecycle {
  connectedCallback(): void;
  disconnectedCallback(): void;
}

describe("Schools directory custom element", () => {
  const registry = new Map<string, CustomElementConstructor>();
  const define = vi.fn((name: string, constructor: CustomElementConstructor) => {
    registry.set(name, constructor);
  });

  beforeEach(() => {
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

  it("registers once, owns one runtime while connected, and disposes it on disconnect", () => {
    registerSchoolsDirectoryElement();
    registerSchoolsDirectoryElement();

    expect(define).toHaveBeenCalledTimes(1);
    const ElementConstructor = registry.get(SCHOOLS_DIRECTORY_ELEMENT);
    if (ElementConstructor === undefined) throw new Error("schools element was not registered");
    const element = new ElementConstructor() as HTMLElement & SchoolsElementLifecycle;

    element.connectedCallback();
    element.connectedCallback();
    expect(mocks.createClient).toHaveBeenCalledTimes(1);
    expect(mocks.embed).toHaveBeenCalledTimes(1);

    element.disconnectedCallback();
    expect(mocks.dispose).toHaveBeenCalledTimes(1);

    element.connectedCallback();
    expect(mocks.createClient).toHaveBeenCalledTimes(2);
    expect(mocks.embed).toHaveBeenCalledTimes(2);
  });
});
