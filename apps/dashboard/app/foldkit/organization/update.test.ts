import {
  DepartmentJsonSchema,
  FieldOfStudyJsonSchema,
  TeamJsonSchema,
} from "@vektorprogrammet/sdk/effect";
import { Effect, Schema as S } from "effect";
import { AsyncData } from "foldkit";
import { describe, expect, it } from "vitest";
import type { OrganizationCatalogClient } from "./browser-client";
import { makeOrganizationCatalogCommands } from "./command";
import {
  FailedOrganizationCatalog,
  RetriedCatalog,
  SucceededFieldOfStudyCatalog,
  SucceededTeamCatalog,
} from "./message";
import { makeInitialModel } from "./model";
import { makeUpdate } from "./update";

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

const client: OrganizationCatalogClient = {
  public: {
    organization: {
      listDepartments: () => Effect.die("not executed by transition tests"),
      listTeams: () => Effect.die("not executed by transition tests"),
      listFieldOfStudies: () => Effect.die("not executed by transition tests"),
    },
  },
};
const update = makeUpdate(makeOrganizationCatalogCommands(client));

describe("Foldkit Organization catalog transitions", () => {
  it("starts a new identified request on retry and excludes stale results", () => {
    const initial = makeInitialModel("Team");
    const [failed] = update(
      initial,
      FailedOrganizationCatalog({
        requestId: 1,
        catalogKind: "Team",
        message: "Teamoversikten kunne ikke hentes. Prøv på nytt.",
      }),
    );
    expect(failed.catalog._tag).toBe("Failure");

    const [retried, commands] = update(failed, RetriedCatalog());
    expect(retried).toMatchObject({ requestId: 2, retryCount: 1 });
    expect(AsyncData.isPending(retried.catalog)).toBe(true);
    expect(commands).toHaveLength(1);

    const [staleSuccess] = update(
      retried,
      SucceededTeamCatalog({
        requestId: 1,
        catalogKind: "Team",
        snapshot: { _tag: "Team", departments: [department], records: [team] },
      }),
    );
    const [staleFailure] = update(
      retried,
      FailedOrganizationCatalog({
        requestId: 1,
        catalogKind: "Team",
        message: "Et foreldet svar",
      }),
    );
    expect(staleSuccess).toBe(retried);
    expect(staleFailure).toBe(retried);
  });

  it("replaces the model only with the fresh response for its catalog kind", () => {
    const teamModel = makeInitialModel("Team");
    const [wrongKind] = update(
      teamModel,
      SucceededFieldOfStudyCatalog({
        requestId: 1,
        catalogKind: "FieldOfStudy",
        snapshot: {
          _tag: "FieldOfStudy",
          departments: [department],
          records: [fieldOfStudy],
        },
      }),
    );
    expect(wrongKind).toBe(teamModel);

    const [fresh] = update(
      teamModel,
      SucceededTeamCatalog({
        requestId: 1,
        catalogKind: "Team",
        snapshot: { _tag: "Team", departments: [department], records: [team] },
      }),
    );
    const data = AsyncData.getData(fresh.catalog);
    expect(data._tag).toBe("Some");
    if (data._tag !== "Some") throw new Error("expected a fresh Team catalog");
    expect(data.value).toEqual({
      _tag: "Team",
      departments: [department],
      records: [team],
    });
  });
});
