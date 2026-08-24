import {
  DepartmentJsonSchema,
  FieldOfStudyJsonSchema,
  TeamJsonSchema,
} from "@vektorprogrammet/sdk/effect";
import { Schema as S } from "effect";
import type { HtmlBuilder } from "foldkit/html";
import { describe, expect, it } from "vitest";
import type { Message } from "./message";
import { OrganizationCatalogData, makeInitialModel, type Model } from "./model";
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

const department = S.decodeUnknownSync(DepartmentJsonSchema)({
  departmentId: "department-trondheim",
  name: "Vektorprogrammet Trondheim",
  shortName: "Trondheim",
  email: "trondheim@example.invalid",
  address: "Høgskoleringen 1",
  city: "Trondheim",
  latitude: "63.418",
  longitude: "10.402",
  slackChannel: null,
  logoPath: null,
  active: true,
  revision: 0,
});

const team = S.decodeUnknownSync(TeamJsonSchema)({
  teamId: "team-rekruttering",
  departmentId: department.departmentId,
  name: "Rekruttering",
  email: "rekruttering@example.invalid",
  description: "Rekrutterer nye studenter.",
  shortDescription: "Rekruttering",
  acceptApplication: true,
  deadline: null,
  active: true,
  revision: 0,
});

const fieldOfStudy = S.decodeUnknownSync(FieldOfStudyJsonSchema)({
  fieldOfStudyId: "field-datateknologi",
  name: "Datateknologi",
  shortName: "Data",
  departmentId: null,
  active: true,
  revision: 0,
});

const readyModel = (catalogKind: Model["catalogKind"]): Model => ({
  ...makeInitialModel(catalogKind),
  catalog: OrganizationCatalogData.Success({
    data:
      catalogKind === "Team"
        ? { _tag: "Team", departments: [department], records: [team] }
        : {
            _tag: "FieldOfStudy",
            departments: [department],
            records: [fieldOfStudy],
          },
  }),
});

const assertAccessibleTable = (
  model: Model,
  heading: string,
  caption: string,
  recordName: string,
): void => {
  const rendered = view(model, htmlBuilder) as unknown as RenderedNode;
  const nodes = descendants(rendered);
  const pageHeading = nodes.find(
    (node) => node.tag === "h1" && hasAttribute(node, "Id", "organization-catalog-title"),
  );
  const table = nodes.find((node) => node.tag === "table");
  const tableNodes = table === undefined ? [] : descendants(table);

  expect(pageHeading).toBeDefined();
  expect(pageHeading === undefined ? "" : textContent(pageHeading)).toBe(heading);
  expect(hasAttribute(rendered, "AriaLabelledBy", "organization-catalog-title")).toBe(true);
  expect(table).toBeDefined();
  expect(tableNodes.some((node) => node.tag === "caption" && textContent(node) === caption)).toBe(
    true,
  );
  expect(tableNodes.some((node) => node.tag === "th" && hasAttribute(node, "Scope", "col"))).toBe(
    true,
  );
  expect(
    tableNodes.some(
      (node) =>
        node.tag === "th" && hasAttribute(node, "Scope", "row") && textContent(node) === recordName,
    ),
  ).toBe(true);
};

describe("Foldkit Organization catalog accessibility", () => {
  it("renders the Team catalog with one labelled heading and semantic table", () => {
    assertAccessibleTable(
      readyModel("Team"),
      "Team",
      "Aktive og inaktive team i organisasjonen",
      "Rekruttering",
    );
  });

  it("renders the FieldOfStudy catalog with Norwegian copy and semantic table", () => {
    assertAccessibleTable(
      readyModel("FieldOfStudy"),
      "Studieretninger",
      "Aktive og inaktive studieretninger i organisasjonen",
      "Datateknologi",
    );
  });
});
