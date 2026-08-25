import { SchoolDepartmentId, SchoolId, type SchoolDirectory } from "@vektorprogrammet/sdk/effect";
import type { HtmlBuilder } from "foldkit/html";
import { describe, expect, it } from "vitest";
import type { Message } from "./message";
import { SchoolDirectoryData, makeInitialModel, type Model } from "./model";
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

interface RenderedTabsViewInputs {
  readonly tabs: ReadonlyArray<"Active" | "Inactive">;
  readonly selectedValue: "Active" | "Inactive";
  readonly toView: (render: {
    readonly tablist: ReadonlyArray<RenderedAttribute>;
    readonly activeIndex: number;
    readonly tabs: ReadonlyArray<{
      readonly value: "Active" | "Inactive";
      readonly index: number;
      readonly isActive: boolean;
      readonly isFocused: boolean;
      readonly isDisabled: boolean;
      readonly tab: ReadonlyArray<RenderedAttribute>;
      readonly panel: ReadonlyArray<RenderedAttribute>;
    }>;
  }) => RenderedNode;
}

interface RenderedSubmodelConfig {
  readonly viewInputs: RenderedTabsViewInputs;
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
      if (property === "submodel") {
        return ({ viewInputs }: RenderedSubmodelConfig) => {
          const activeIndex = viewInputs.tabs.indexOf(viewInputs.selectedValue);
          return viewInputs.toView({
            tablist: [{ name: "Role", values: ["tablist"] }],
            activeIndex,
            tabs: viewInputs.tabs.map((value, index) => ({
              value,
              index,
              isActive: index === activeIndex,
              isFocused: index === activeIndex,
              isDisabled: false,
              tab: [
                { name: "Role", values: ["tab"] },
                { name: "AriaSelected", values: [index === activeIndex] },
              ],
              panel: [{ name: "Role", values: ["tabpanel"] }],
            })),
          });
        };
      }
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

const department = SchoolDepartmentId.make("department-a");
const directory: SchoolDirectory = {
  activeSchools: [
    {
      schoolId: SchoolId.make(1),
      name: "Alfaskolen",
      contactPerson: "Ada Lovelace",
      email: "ada@example.invalid",
      phone: "+47 111 11 111",
      language: "Norwegian",
      departments: [{ departmentId: department, name: "Avdeling A" }],
      isActive: true,
    },
    {
      schoolId: SchoolId.make(2),
      name: "Betaskolen",
      contactPerson: "Grace Hopper",
      email: "grace@example.invalid",
      phone: "+47 222 22 222",
      language: "International",
      departments: [{ departmentId: department, name: "Avdeling A" }],
      isActive: true,
    },
  ],
  inactiveSchools: [
    {
      schoolId: SchoolId.make(3),
      name: "Gamleskolen",
      contactPerson: "Linus Torvalds",
      email: "linus@example.invalid",
      phone: "+47 333 33 333",
      language: "Norwegian",
      departments: [{ departmentId: department, name: "Avdeling A" }],
      isActive: false,
    },
  ],
};

const readyModel = (searchText = ""): Model => ({
  ...makeInitialModel(),
  directory: SchoolDirectoryData.Success({ data: directory }),
  knownDepartments: [{ departmentId: department, name: "Avdeling A" }],
  searchText,
});

describe("Foldkit Schools directory view", () => {
  it("renders the exact Norwegian directory columns, tabs, controls, and semantic table", () => {
    const rendered = view(readyModel(), htmlBuilder) as unknown as RenderedNode;
    const nodes = descendants(rendered);
    const text = textContent(rendered);

    expect(text).toContain("Skoler");
    expect(text).toContain("Aktive (2)");
    expect(text).toContain("Inaktive (1)");
    expect(text).toContain("Norsk");
    expect(text).toContain("Internasjonal");
    expect(text).toContain("Avdeling A");

    const columnHeaders = nodes
      .filter((node) => node.tag === "th" && hasAttribute(node, "Scope", "col"))
      .map(textContent);
    expect(columnHeaders).toEqual([
      "Skole",
      "Kontaktperson",
      "Telefon",
      "E-post",
      "Språk",
      "Avdeling",
      "Skole",
      "Kontaktperson",
      "Telefon",
      "E-post",
      "Språk",
      "Avdeling",
    ]);
    expect(nodes.some((node) => node.tag === "th" && hasAttribute(node, "Scope", "row"))).toBe(
      true,
    );
    expect(nodes.some((node) => node.tag === "div" && hasAttribute(node, "Role", "tablist"))).toBe(
      true,
    );
    expect(
      nodes.filter((node) => node.tag === "button" && hasAttribute(node, "Role", "tab")),
    ).toHaveLength(2);
    expect(
      nodes.filter((node) => node.tag === "section" && hasAttribute(node, "Role", "tabpanel")),
    ).toHaveLength(2);
    expect(
      nodes.some(
        (node) => node.tag === "a" && hasAttribute(node, "Href", "mailto:ada@example.invalid"),
      ),
    ).toBe(true);
    expect(
      nodes.some((node) => node.tag === "a" && hasAttribute(node, "Href", "tel:+47 111 11 111")),
    ).toBe(true);
    expect(nodes.filter((node) => node.tag === "caption")).toHaveLength(2);
    expect(nodes.some((node) => node.tag === "input")).toBe(true);
    expect(nodes.some((node) => node.tag === "select")).toBe(true);
  });

  it("filters rows locally without altering the server-owned directory", () => {
    const rendered = view(readyModel("grace"), htmlBuilder) as unknown as RenderedNode;
    const text = textContent(rendered);

    expect(text).toContain("Betaskolen");
    expect(text).not.toContain("Alfaskolen");
    expect(directory.activeSchools).toHaveLength(2);
  });

  it("announces loading and failure states and offers a retry", () => {
    const loading = view(makeInitialModel(), htmlBuilder) as unknown as RenderedNode;
    expect(
      descendants(loading).some(
        (node) => node.tag === "div" && hasAttribute(node, "Role", "status"),
      ),
    ).toBe(true);

    const failedModel: Model = {
      ...makeInitialModel(),
      directory: SchoolDirectoryData.Failure({
        error: { _tag: "Failed", message: "Prøv på nytt." },
      }),
    };
    const failed = view(failedModel, htmlBuilder) as unknown as RenderedNode;
    const failedNodes = descendants(failed);
    expect(
      failedNodes.some((node) => node.tag === "section" && hasAttribute(node, "Role", "alert")),
    ).toBe(true);
    expect(
      failedNodes.some((node) => node.tag === "button" && textContent(node) === "Prøv igjen"),
    ).toBe(true);
  });
});
