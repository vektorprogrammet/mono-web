import { expect, test, type APIRequestContext } from "@playwright/test";
import { contactDepartmentSlug } from "../src/lib/contact-message";

const enabled = process.env.REAL_PUBLIC_CONTACT_E2E === "1";
const backendOrigin = process.env.PUBLIC_CONTACT_E2E_BACKEND_ORIGIN;

type PublicDepartment = {
  readonly id: number;
  readonly name: string;
  readonly shortName: string;
  readonly email: string;
  readonly active: boolean;
};

const publicDepartments = async (
  request: APIRequestContext,
): Promise<readonly PublicDepartment[]> => {
  if (backendOrigin === undefined) {
    throw new Error("PUBLIC_CONTACT_E2E_BACKEND_ORIGIN is required");
  }
  const response = await request.get(`${backendOrigin}/api/departments`);
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as {
    readonly "hydra:member"?: readonly PublicDepartment[];
  };
  if (!Array.isArray(body["hydra:member"])) {
    throw new Error("The department API did not return a Hydra collection");
  }
  return body["hydra:member"];
};

test.describe("real public contact-message journey", () => {
  test.skip(!enabled, "requires the isolated Symfony contact runner");

  test("sends one message for the selected live department and shows rejection", async ({
    page,
    request,
  }) => {
    const department = (await publicDepartments(request)).find(
      (candidate) => candidate.active,
    );
    if (department === undefined) {
      throw new Error("The department API returned no active department");
    }

    const route = `/kontakt/${contactDepartmentSlug(department)}`;
    const actionRequests: string[] = [];
    page.on("request", (browserRequest) => {
      if (
        browserRequest.method() === "POST" &&
        new URL(browserRequest.url()).pathname === route
      ) {
        actionRequests.push(browserRequest.url());
      }
    });

    await page.goto(route);
    await expect(
      page.getByRole("heading", { name: department.name, exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: department.email })).toBeVisible();

    await page.getByLabel("Ditt navn").fill("Kontakt E2E");
    await page.getByLabel("Din e-post").fill("contact-e2e@example.invalid");
    await page.getByLabel("Emne").fill("E2E kontaktmelding");
    await page.getByLabel("Melding").fill("Dette er en isolert kontaktprøve.");
    await page.getByRole("button", { name: "Send melding" }).click();

    await expect(page.getByRole("status")).toHaveText("Meldingen er sendt.");
    expect(actionRequests).toHaveLength(1);

    await page.getByLabel("Ditt navn").fill("   ");
    await page.getByLabel("Din e-post").fill("contact-e2e@example.invalid");
    await page.getByLabel("Emne").fill("Avvist kontaktmelding");
    await page.getByLabel("Melding").fill("Denne meldingen skal avvises før API-kallet.");
    await page.getByRole("button", { name: "Send melding" }).click();

    await expect(page.getByRole("alert")).toHaveText(
      "Fyll ut alle feltene med gyldig informasjon.",
    );
    expect(actionRequests).toHaveLength(2);
  });
});
