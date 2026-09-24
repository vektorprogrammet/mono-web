import { Scene } from "foldkit/test";
import { commandsFor } from "./command";
import { createBrowserSchoolsDirectoryClient } from "./browser-client";
import { updateFor } from "./update";

const config = {update: updateFor(commandsFor(createBrowserSchoolsDirectoryClient())), view};

import { DepartmentId } from "@vektorprogrammet/http-api"
import { SchoolId, type SchoolDirectory } from "@vektorprogrammet/http-api"
import { describe, expect, it } from "vitest";
import { SchoolDirectoryData, init, type Model, SchoolDirectoryFailure } from "./model";
import { view } from "./view";

const department = DepartmentId.make("department-a");

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
  ...init(),
  directory: SchoolDirectoryData.Success({ data: directory }),
  knownDepartments: [{ departmentId: department, name: "Avdeling A" }],
  searchText,
});

describe("Foldkit Schools directory view", () => {
  it("renders semantic directory tables, tabs, and contact links", () => {
    Scene.scene(config, Scene.given(readyModel()),
      Scene.expect(Scene.role("heading", {name: "Skoler"})).toBeVisible(),
      Scene.expectAll(Scene.all.role("tab")).toHaveCount(2),
      Scene.expectAll(Scene.all.role("tabpanel")).toHaveCount(2),
      Scene.expectAll(Scene.all.selector('th[scope="col"]')).toHaveCount(12),
      Scene.expectAll(Scene.all.role("rowheader")).toHaveCount(3),
      Scene.expect(Scene.selector('a[href="mailto:ada@example.invalid"]')).toBeVisible(),
      Scene.expect(Scene.role("link", { name: "+47 111 11 111" })).toHaveAttr("href", "tel:+47 111 11 111"),
    );
  });
  it("filters rows locally without altering the server-owned directory", () => {
    Scene.scene(config, Scene.given(readyModel("grace")),
      Scene.expect(Scene.text("Betaskolen")).toBeVisible(),
      Scene.expectAll(Scene.all.text("Alfaskolen")).toBeEmpty(),
    );
    expect(directory.activeSchools).toHaveLength(2);
  });
  it("announces loading and failure states and offers a retry", () => {
    Scene.scene(config, Scene.given(init()), Scene.expect(Scene.role("status")).toBeVisible());
    Scene.scene(config, Scene.given({...init(), directory: SchoolDirectoryData.Failure({error: SchoolDirectoryFailure.cases.Failed.make({message: "Prøv på nytt."})})}),
      Scene.expect(Scene.role("alert")).toBeVisible(),
      Scene.expect(Scene.role("button", {name: "Prøv igjen"})).toBeEnabled(),
    );
  });
});
