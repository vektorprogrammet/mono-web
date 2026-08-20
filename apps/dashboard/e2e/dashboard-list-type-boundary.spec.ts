import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { expect, test } from "@playwright/test";

const FIXTURE_PORT = 8791;
const FIXTURE_URL = `http://127.0.0.1:${FIXTURE_PORT}`;
const AUTH_TOKEN = "fixture-jwt-0025";
const AUTH_HEADER = `Bearer ${AUTH_TOKEN}`;

type FixtureEvidence = {
  route: string;
  method: string;
  status: number;
  responseShapeKeys: Array<string>;
  rowCount: number;
  visibleFieldNames: Array<string>;
};

const evidence: Array<FixtureEvidence> = [];
let failurePath: string | null = null;
let fixtureServer: Server | undefined;

function responseShapeKeys(value: unknown): Array<string> {
  if (value instanceof Array) {
    const first = value[0];
    return typeof first === "object" && first !== null ? Object.keys(first) : [];
  }

  return typeof value === "object" && value !== null ? Object.keys(value) : [];
}

function responseRowCount(value: unknown): number {
  if (value instanceof Array) return value.length;

  if (typeof value === "object" && value !== null && "hydra:member" in value) {
    const members = value["hydra:member"];
    return members instanceof Array ? members.length : 0;
  }

  return 1;
}

function respondJson(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  const route = new URL(request.url ?? "/", FIXTURE_URL).pathname;
  evidence.push({
    route,
    method: request.method ?? "GET",
    status,
    responseShapeKeys: responseShapeKeys(body),
    rowCount: responseRowCount(body),
    visibleFieldNames: [],
  });
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function recordVisibleFields(
  route: string,
  rowCount: number,
  visibleFieldNames: Array<string>,
): void {
  evidence.push({
    route,
    method: "GET",
    status: 200,
    responseShapeKeys: [],
    rowCount,
    visibleFieldNames,
  });
}

function handleFixtureRequest(request: IncomingMessage, response: ServerResponse): void {
  const route = new URL(request.url ?? "/", FIXTURE_URL).pathname;

  if (request.headers.authorization !== AUTH_HEADER) {
    respondJson(request, response, 401, { message: "Unauthorized" });
    return;
  }

  if (failurePath === route) {
    respondJson(request, response, 500, { message: "Synthetic route failure" });
    return;
  }

  switch (route) {
    case "/api/me/profile":
      respondJson(request, response, 200, {
        id: 2500,
        firstName: "Operator",
        lastName: "0025",
        email: "operator@example.invalid",
        phone: null,
        department: "Department-0025",
        fieldOfStudy: null,
        profilePhoto: null,
      });
      return;
    case "/api/admin/scheduling/assistants":
      respondJson(request, response, 200, {
        "hydra:member": [
          {
            id: 2501,
            name: "Assistant-0025",
            email: "assistant@example.invalid",
            doublePosition: null,
            preferredGroup: 7,
            availability: { friday: false, monday: true },
            score: 4.5,
            suitability: "accepted",
            previousParticipation: false,
            language: "nb",
          },
        ],
        "hydra:totalItems": 1,
      });
      return;
    case "/api/admin/mailing-lists":
      respondJson(request, response, 200, [
        {
          name: "List-0025",
          emails: ["first@example.invalid", "second@example.invalid"],
        },
        { name: "Empty-0025", emails: [] },
      ]);
      return;
    case "/api/admin/interviews":
      respondJson(request, response, 200, {
        interviews: [
          {
            id: 2601,
            applicantName: "Applicant-0025",
            interviewerName: null,
            scheduled: null,
            status: "Akseptert",
            interviewed: false,
            coInterviewer: null,
            room: null,
            campus: null,
            mapLink: null,
          },
        ],
      });
      return;
    case "/api/admin/scheduling/schools":
      respondJson(request, response, 200, {
        "hydra:member": [
          {
            id: 2801,
            name: "School-0025",
            capacity: [
              { afternoon: 2, morning: 5 },
              { evening: 1 },
            ],
          },
        ],
        "hydra:totalItems": 1,
      });
      return;
    case "/api/admin/team-interest":
      respondJson(request, response, 200, {
        "hydra:member": [
          { id: 2901, userName: "User-0025", teamName: "Team-0025" },
        ],
        "hydra:totalItems": 1,
      });
      return;
    case "/api/admin/substitutes":
      respondJson(request, response, 200, {
        "hydra:member": [
          {
            id: 3001,
            name: "Substitute-0025",
            email: "substitute@example.invalid",
            yearOfStudy: null,
            language: null,
            monday: true,
            tuesday: null,
            wednesday: false,
            thursday: null,
            friday: true,
          },
        ],
        "hydra:totalItems": 1,
      });
      return;
    default:
      respondJson(request, response, 404, { message: "Not found" });
  }
}

test.describe("dashboard list type boundary", () => {
  test.beforeAll(async () => {
    expect(process.env.API_MODE).toBeUndefined();
    expect(process.env.VITE_API_MODE).toBeUndefined();
    expect(process.env.API_URL).toBe(FIXTURE_URL);
    expect(process.env.VITE_API_URL).toBe(FIXTURE_URL);

    fixtureServer = createServer(handleFixtureRequest);
    await new Promise<void>((resolve, reject) => {
      fixtureServer?.once("error", reject);
      fixtureServer?.listen(FIXTURE_PORT, "127.0.0.1", resolve);
    });
  });

  test.afterAll(async () => {
    if (fixtureServer === undefined) return;
    await new Promise<void>((resolve, reject) => {
      fixtureServer?.close((error) => (error ? reject(error) : resolve()));
    });
  });

  test("observes six SDK-shaped list routes and a typed failure", async ({ page }) => {
    test.setTimeout(60_000);
    evidence.length = 0;
    failurePath = null;

    await page.context().addCookies([
      {
        name: "jwt_token",
        value: AUTH_TOKEN,
        domain: "127.0.0.1",
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);

    await page.goto("/dashboard/assistenter");
    await expect(page.getByRole("heading", { name: "Assistenter" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "Assistant-0025", exact: true })).toBeVisible();
    await expect(page.getByRole("cell", { name: "assistant@example.invalid", exact: true })).toBeVisible();
    await expect(page.getByRole("cell", { name: "nb", exact: true })).toBeVisible();
    await expect(page.getByRole("cell", { name: "friday=false, monday=true", exact: true })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Skole", exact: true })).toHaveCount(0);
    await expect(page.getByRole("columnheader", { name: "Telefon", exact: true })).toHaveCount(0);
    recordVisibleFields("/dashboard/assistenter", 1, [
      "id",
      "name",
      "email",
      "doublePosition",
      "preferredGroup",
      "availability",
      "score",
      "suitability",
      "previousParticipation",
      "language",
    ]);

    await page.goto("/dashboard/epostliste");
    await expect(page.getByRole("heading", { name: "E-postliste" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "first@example.invalid", exact: true })).toBeVisible();
    await expect(page.getByRole("cell", { name: "second@example.invalid", exact: true })).toBeVisible();
    await expect(page.locator("tbody tr")).toHaveCount(2);
    await expect(page.getByText("Empty-0025", { exact: true })).toHaveCount(0);
    recordVisibleFields("/dashboard/epostliste", 2, ["name", "email"]);

    await page.goto("/dashboard/intervjuer");
    await expect(page.getByRole("cell", { name: "2601", exact: true })).toBeVisible();
    await expect(page.getByRole("cell", { name: "Applicant-0025", exact: true })).toBeVisible();
    await expect(page.getByRole("cell", { name: "accepted", exact: true })).toBeVisible();
    await expect(page.getByText("Unavailable", { exact: true })).toHaveCount(2);
    await expect(page.getByRole("columnheader", { name: "Søker", exact: true })).toBeVisible();
    recordVisibleFields("/dashboard/intervjuer", 1, [
      "id",
      "applicantName",
      "interviewerName",
      "interviewTime",
      "schedulingStatus",
    ]);

    await page.goto("/dashboard/skoler");
    await expect(page.getByRole("heading", { name: "Skoler" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "School-0025", exact: true })).toBeVisible();
    await expect(
      page.getByRole("cell", { name: "afternoon=2, morning=5 | evening=1", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Antall assistenter", exact: true })).toHaveCount(0);
    recordVisibleFields("/dashboard/skoler", 1, ["id", "name", "capacity"]);

    await page.goto("/dashboard/teaminteresse");
    await expect(page.getByRole("heading", { name: "Teaminteresse" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "User-0025", exact: true })).toBeVisible();
    await expect(page.getByRole("cell", { name: "Team-0025", exact: true })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Semester", exact: true })).toHaveCount(0);
    await expect(page.getByRole("cell", { name: "fixture", exact: true })).toHaveCount(0);
    recordVisibleFields("/dashboard/teaminteresse", 1, ["id", "userName", "teamName"]);

    await page.goto("/dashboard/vikarer");
    await expect(page.getByRole("heading", { name: "Vikarer" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "Substitute-0025", exact: true })).toBeVisible();
    await expect(page.getByRole("cell", { name: "substitute@example.invalid", exact: true })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Telefon", exact: true })).toHaveCount(0);
    await expect(page.getByRole("columnheader", { name: "Status", exact: true })).toHaveCount(0);
    await expect(page.getByRole("cell", { name: "true", exact: true })).toHaveCount(2);
    await expect(page.getByRole("cell", { name: "false", exact: true })).toHaveCount(1);
    await expect(page.getByRole("cell", { name: "Unavailable", exact: true })).toHaveCount(4);
    recordVisibleFields("/dashboard/vikarer", 1, [
      "id",
      "name",
      "email",
      "yearOfStudy",
      "language",
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
    ]);

    const expectedWireEvidence = [
      {
        route: "/api/me/profile",
        responseShapeKeys: [
          "id",
          "firstName",
          "lastName",
          "email",
          "phone",
          "department",
          "fieldOfStudy",
          "profilePhoto",
        ],
        rowCount: 1,
      },
      {
        route: "/api/admin/scheduling/assistants",
        responseShapeKeys: ["hydra:member", "hydra:totalItems"],
        rowCount: 1,
      },
      {
        route: "/api/admin/mailing-lists",
        responseShapeKeys: ["name", "emails"],
        rowCount: 2,
      },
      {
        route: "/api/admin/interviews",
        responseShapeKeys: ["interviews"],
        rowCount: 1,
      },
      {
        route: "/api/admin/scheduling/schools",
        responseShapeKeys: ["hydra:member", "hydra:totalItems"],
        rowCount: 1,
      },
      {
        route: "/api/admin/team-interest",
        responseShapeKeys: ["hydra:member", "hydra:totalItems"],
        rowCount: 1,
      },
      {
        route: "/api/admin/substitutes",
        responseShapeKeys: ["hydra:member", "hydra:totalItems"],
        rowCount: 1,
      },
    ];

    for (const expected of expectedWireEvidence) {
      const observed = evidence.find(
        (entry) =>
          entry.route === expected.route &&
          entry.method === "GET" &&
          entry.status === 200 &&
          entry.responseShapeKeys.length > 0,
      );
      expect(observed).toEqual(
        expect.objectContaining({
          route: expected.route,
          method: "GET",
          status: 200,
          responseShapeKeys: expected.responseShapeKeys,
          rowCount: expected.rowCount,
        }),
      );
    }

    const expectedVisibleEvidence: Array<[string, number]> = [
      ["/dashboard/assistenter", 1],
      ["/dashboard/epostliste", 2],
      ["/dashboard/intervjuer", 1],
      ["/dashboard/skoler", 1],
      ["/dashboard/teaminteresse", 1],
      ["/dashboard/vikarer", 1],
    ];

    for (const [route, rowCount] of expectedVisibleEvidence) {
      const observed = evidence.find(
        (entry) => entry.route === route && entry.visibleFieldNames.length > 0,
      );
      expect(observed).toEqual(
        expect.objectContaining({
          route,
          method: "GET",
          status: 200,
          rowCount,
        }),
      );
    }

    failurePath = "/api/admin/scheduling/assistants";
    await page.goto("/dashboard/assistenter");
    await expect(page.getByRole("heading", { name: "Feil" })).toBeVisible();
    await expect(page.getByText("Noe gikk galt. Prøv å laste siden på nytt.")).toBeVisible();
    const failedEvidence = evidence.find(
      (entry) => entry.route === failurePath && entry.status === 500,
    );
    expect(failedEvidence).toEqual(
      expect.objectContaining({
        route: failurePath,
        method: "GET",
        status: 500,
        responseShapeKeys: ["message"],
        rowCount: 1,
      }),
    );
  });
});
