import { Scene } from "foldkit/test";
import { DepartmentJsonSchema,
FieldOfStudyJsonSchema,
TeamJsonSchema, } from "@vektorprogrammet/http-api"
import { Schema as S } from "effect";
import { describe, it } from "vitest";
import { OrganizationCatalogData, init, type Model, TeamCatalogSnapshot, FieldOfStudyCatalogSnapshot } from "./model";
import { view } from "./view";

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
  ...init(catalogKind),
  catalog: OrganizationCatalogData.Success({
    data:
      catalogKind === "Team"
        ? TeamCatalogSnapshot.make({ departments: [department], records: [team] })
        : FieldOfStudyCatalogSnapshot.make({
            departments: [department],
            records: [fieldOfStudy],
          }),
  }),
});

const assertAccessibleTable = (
  model: Model,
  heading: string,
  caption: string,
  recordName: string,
): void => {
  Scene.scene({view, update: (current: Model) => ({model: current})}, Scene.given(model),
    Scene.expect(Scene.role("heading", {name: heading})).toHaveId("organization-catalog-title"),
    Scene.expect(Scene.selector("section")).toHaveAttr("aria-labelledby", "organization-catalog-title"),
    Scene.expect(Scene.role("table", {name: caption})).toBeVisible(),
    Scene.expect(Scene.role("rowheader", {name: recordName})).toHaveAttr("scope", "row"),
    Scene.expectAll(Scene.all.role("columnheader")).not.toBeEmpty(),
  );
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
