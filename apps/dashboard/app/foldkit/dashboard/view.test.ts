import type { HtmlBuilder } from "foldkit/html";
import { describe, expect, it, vi } from "vitest";
import type { Message } from "./message";
import { makeInitialModel } from "./model";

vi.mock("@foldkit/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@foldkit/ui")>()),
  Button: {
    view: (input: {
      readonly toView: (parts: { readonly button: ReadonlyArray<unknown> }) => unknown;
    }) => input.toView({ button: [] }),
  },
  Disclosure: {
    buttonId: (id: string) => `${id}-button`,
    view: (input: {
      readonly toView: (parts: {
        readonly button: ReadonlyArray<unknown>;
        readonly panel: ReadonlyArray<unknown>;
      }) => unknown;
    }) => input.toView({ button: [], panel: [] }),
  },
}));
import { view } from "./view";

interface RenderedNode {
  readonly tag: string;
  readonly children: ReadonlyArray<RenderedNode | string>;
}

const renderedNode = (tag: string, args: ReadonlyArray<unknown>): RenderedNode => ({
  tag,
  children: Array.isArray(args[1]) ? (args[1] as ReadonlyArray<RenderedNode | string>) : [],
});

const htmlBuilder = new Proxy(
  {},
  {
    get: (_target, property) => {
      if (property === "empty") return renderedNode("empty", []);
      const name = String(property);
      return (...args: ReadonlyArray<unknown>) =>
        /^[A-Z]/.test(name) ? { name, values: args } : renderedNode(name, args);
    },
  },
) as HtmlBuilder<Message>;

const textContent = (node: RenderedNode): string =>
  node.children.map((child) => (typeof child === "string" ? child : textContent(child))).join("");

describe("Foldkit dashboard nullable user shell", () => {
  it("hides identity-only content while retaining the dashboard shell", () => {
    const model = makeInitialModel({
      user: null,
      role: null,
      activePath: "/dashboard/skoler",
      summary: { _tag: "Unavailable" },
      recruitment: null,
    });

    if (model._tag !== "Ready") throw new Error("expected ready dashboard model");
    const text = textContent(view(model, htmlBuilder) as unknown as RenderedNode);

    expect(text).toContain("Tilbake til forsiden");
    expect(text).not.toContain("Logg ut");
    expect(text).not.toContain("Min profil");
  });
});
