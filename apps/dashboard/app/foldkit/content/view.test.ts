import { ArticleId, DepartmentId, type ContentWorkspace } from "@vektorprogrammet/sdk/effect";
import type { HtmlBuilder } from "foldkit/html";
import { describe, expect, it } from "vitest";
import type { Message } from "./message";
import { makeInitialModel, type Model } from "./model";
import { view } from "./view";

interface RenderedAttribute {
  readonly name: string;
  readonly values: ReadonlyArray<unknown>;
}

interface RenderedNode {
  readonly tag: string;
  readonly attributes: ReadonlyArray<RenderedAttribute>;
  readonly children: ReadonlyArray<RenderedNode | string>;
}

const renderedNode = (tag: string, args: ReadonlyArray<unknown>): RenderedNode => ({
  tag,
  attributes: Array.isArray(args[0]) ? (args[0] as ReadonlyArray<RenderedAttribute>) : [],
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

const descendants = (node: RenderedNode): ReadonlyArray<RenderedNode> => [
  node,
  ...node.children.flatMap((child) => (typeof child === "string" ? [] : descendants(child))),
];

const textContent = (node: RenderedNode): string =>
  node.children.map((child) => (typeof child === "string" ? child : textContent(child))).join("");

const hasAttribute = (node: RenderedNode, name: string, value: unknown): boolean =>
  node.attributes.some(
    (attribute) => attribute.name === name && attribute.values.some((entry) => entry === value),
  );

const departmentA = DepartmentId.make("department-a");
const departmentB = DepartmentId.make("department-b");
const articleId = ArticleId.make(1);
const workspace: ContentWorkspace = { entries: [] };

const readyModel = (): Model => ({
  ...makeInitialModel(),
  workspace: { _tag: "Success", data: workspace },
  knownDepartments: [
    { departmentId: departmentA, name: "Trondheim" },
    { departmentId: departmentB, name: "Bergen" },
  ],
});

describe("Foldkit content workspace view", () => {
  it("renders active Organization departments for creation and filtering with no articles", () => {
    const rendered = view(readyModel(), htmlBuilder) as unknown as RenderedNode;
    const nodes = descendants(rendered);
    const optionLabels = nodes.filter((node) => node.tag === "option").map(textContent);

    expect(optionLabels).toEqual(["Alle avdelinger", "Trondheim", "Bergen"]);
    expect(textContent(rendered)).toContain("Ingen artikler i denne visningen.");
    expect(nodes.some((node) => hasAttribute(node, "Id", "content-dept-department-a"))).toBe(true);
    expect(nodes.some((node) => hasAttribute(node, "Id", "content-dept-department-b"))).toBe(true);
  });

  it("does not render an unsafe revise control without a full working-copy revision", () => {
    const unavailable: Model = {
      ...readyModel(),
      selectedArticleId: articleId,
      selectedRevision: null,
      dirty: true,
      editor: {
        title: "Tittel",
        bodyHtml: "<p>Bevarte byte</p>",
        departmentIds: [departmentA],
        sticky: false,
      },
    };
    const rendered = view(unavailable, htmlBuilder) as unknown as RenderedNode;
    const nodes = descendants(rendered);

    expect(textContent(rendered)).toContain(
      "Arbeidskopien mangler revisjonsdata og kan ikke lagres trygt.",
    );
    expect(
      nodes.some(
        (node) => node.tag === "button" && hasAttribute(node, "Id", "content-editor-revise"),
      ),
    ).toBe(false);

    const available = view(
      { ...unavailable, selectedRevision: 4 },
      htmlBuilder,
    ) as unknown as RenderedNode;
    expect(
      descendants(available).some(
        (node) => node.tag === "button" && hasAttribute(node, "Id", "content-editor-revise"),
      ),
    ).toBe(true);
  });
});
