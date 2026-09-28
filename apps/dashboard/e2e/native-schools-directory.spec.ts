import AxeBuilder from "@axe-core/playwright";
import { writeFile } from "node:fs/promises";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { Option, Schema } from "effect";
import { DepartmentId } from "@vektorprogrammet/domain";
import { NativeProblem, nativeRpcPath } from "@vektorprogrammet/rpc";
import { nativeScriptClient } from "@vektorprogrammet/rpc/script";
import { addressesAnyRoute, legacyRoutes } from "./request-routes.js";

const realNativeIdentity = process.env.REAL_NATIVE_IDENTITY_E2E === "1";

const evidencePath = process.env.SCHOOLS_E2E_BROWSER_EVIDENCE_PATH;

const departments = {
  alpha: DepartmentId.make("schools-e2e-0061-department-alpha"),
  beta: DepartmentId.make("schools-e2e-0061-department-beta"),
  empty: DepartmentId.make("schools-e2e-0061-department-empty"),
} as const;

const apiOrigin = process.env.API_URL ?? "http://127.0.0.1:8790";

/** The RPC that the browser read the school directory with. */
const listSchoolsTag = "directory.listSchools";

/** The native RPC request that one browser request body carries. */
const RpcRequestBody = Schema.fromJsonString(Schema.Struct({ tag: Schema.String }));

/** The tag of the native RPC that one browser request body carries, if any. */
const rpcTagOf = (body: string | null): string | undefined =>
  body === null ? undefined : Option.getOrUndefined(Schema.decodeOption(RpcRequestBody)(body))?.tag;

/** An RPC answer that ends its request with one declared problem. */
const RpcProblemAnswer = Schema.fromJsonString(
  Schema.Tuple([
    Schema.Struct({
      exit: Schema.Struct({ cause: Schema.Tuple([Schema.Struct({ error: NativeProblem })]) }),
    }),
  ]),
);

/** The problem that one RPC answer failed with, decoded with the contract schema. */
const rpcProblemOf = (answer: string) => {
  const [
    {
      exit: {
        cause: [{ error }],
      },
    },
  ] = Schema.decodeSync(RpcProblemAnswer)(answer);

  return error;
};

const persons = {
  administrator: {
    email: "administrator.schools.0061@example.invalid",
    password: "schools-admin-0061-password",
  },
  twoDepartmentMember: {
    email: "two-departments.schools.0061@example.invalid",
    password: "schools-two-0061-password",
  },
  oneDepartmentMember: {
    email: "one-department.schools.0061@example.invalid",
    password: "schools-one-0061-password",
  },
  endedOnlyMember: {
    email: "ended-only.schools.0061@example.invalid",
    password: "schools-ended-0061-password",
  },
  noAuthority: {
    email: "no-authority.schools.0061@example.invalid",
    password: "schools-none-0061-password",
  },
} as const;

type BrowserRequest = {
  readonly method: string;
  readonly pathname: string;
  readonly search: string;
  readonly rpcTag?: string | undefined;
};

type BrowserResponse = BrowserRequest & { readonly status: number };

const openContext = async (
  browser: Browser,
  browserRequests: BrowserRequest[],
  browserResponses: BrowserResponse[],
  pageErrors: string[],
): Promise<{ readonly context: BrowserContext; readonly page: Page }> => {
  const context = await browser.newContext();
  context.on("request", (request) => {
    const url = new URL(request.url());
    browserRequests.push({
      method: request.method(),
      pathname: url.pathname,
      search: url.search,
      rpcTag: rpcTagOf(request.postData()),
    });
  });
  context.on("response", (response) => {
    const url = new URL(response.url());
    browserResponses.push({
      method: response.request().method(),
      pathname: url.pathname,
      search: url.search,
      rpcTag: rpcTagOf(response.request().postData()),
      status: response.status(),
    });
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));

  return { context, page };
};

const signIn = async (
  page: Page,
  person: { readonly email: string; readonly password: string },
  redirectTo: string,
) => {
  await page.goto(`/login?redirectTo=${encodeURIComponent(redirectTo)}`);
  await page.getByLabel("E-post").fill(person.email);
  await page.getByLabel("Passord", { exact: true }).fill(person.password);
  await page.getByRole("button", { name: "Logg inn" }).click({ noWaitAfter: true });

  try {
    await page.waitForURL((url) => url.pathname === redirectTo, {
      timeout: 15_000,
      waitUntil: "commit",
    });
  } catch (cause) {
    throw new Error(
      `sign-in did not reach ${redirectTo}; current URL ${page.url()}; body: ${await page.locator("body").innerText()}`,
      { cause },
    );
  }

  await expect
    .poll(async () =>
      (await page.context().cookies()).some(
        (cookie) => cookie.name === "better-auth.session_token",
      ),
    )
    .toBe(true);
};

const assertDirectoryShell = async (page: Page) => {
  await expect(page.getByRole("heading", { name: "Skoler", exact: true })).toBeVisible();
};

test.describe("Native Schools directory (spec 0061)", () => {
  test.skip(!realNativeIdentity, "run through the disposable PostgreSQL Schools runner");

  test("proves the authority matrix, Foldkit interactions, retry, and request confinement", async ({
    browser,
    baseURL,
  }) => {
    const browserRequests: BrowserRequest[] = [];
    const browserResponses: BrowserResponse[] = [];
    test.setTimeout(120_000);
    const pageErrors: string[] = [];
    const contexts: BrowserContext[] = [];
    const observations: Record<string, Schema.Json> = {};

    try {
      const administrator = await openContext(
        browser,
        browserRequests,
        browserResponses,
        pageErrors,
      );

      contexts.push(administrator.context);
      await signIn(administrator.page, persons.administrator, "/dashboard/skoler");
      await assertDirectoryShell(administrator.page);

      const failureAlert = administrator.page.getByRole("alert");
      await expect(failureAlert).toContainText("Skoleoversikten kunne ikke hentes");
      await failureAlert.getByRole("button", { name: "Prøv igjen" }).click();
      await expect(administrator.page.getByRole("tab", { name: "Aktive (4)" })).toBeVisible();
      await expect(administrator.page.getByRole("tab", { name: "Inaktive (2)" })).toBeVisible();
      await expect(administrator.page.getByRole("rowheader", { name: "Friskolen" })).toBeVisible();

      for (const label of ["Skole", "Kontaktperson", "Telefon", "E-post", "Språk", "Avdeling"]) {
        await expect(
          administrator.page.getByRole("columnheader", { name: label, exact: true }),
        ).toBeVisible();
      }

      await expect(administrator.page.getByText("Norsk", { exact: true }).first()).toBeVisible();
      await expect(
        administrator.page.getByText("Internasjonal", { exact: true }).first(),
      ).toBeVisible();

      const search = administrator.page.getByRole("searchbox", { name: "Søk" });
      await search.fill("Ada Lovelace");
      await expect(administrator.page.getByRole("rowheader", { name: "Alfaskolen" })).toBeVisible();
      await expect(administrator.page.getByRole("rowheader", { name: "Betaskolen" })).toHaveCount(
        0,
      );
      await search.fill("Fellesskolen");
      await expect(
        administrator.page.getByRole("rowheader", { name: "Fellesskolen" }),
      ).toBeVisible();
      await search.fill("");

      const department = administrator.page.getByRole("combobox", { name: "Avdeling" });
      await department.selectOption(departments.beta);
      await expect(administrator.page.getByRole("tab", { name: "Aktive (2)" })).toBeVisible();
      await expect(administrator.page.getByRole("tab", { name: "Inaktive (1)" })).toBeVisible();
      await expect(administrator.page.getByRole("rowheader", { name: "Betaskolen" })).toBeVisible();
      await expect(
        administrator.page.getByRole("rowheader", { name: "Fellesskolen" }),
      ).toBeVisible();
      await expect(administrator.page.getByRole("rowheader", { name: "Alfaskolen" })).toHaveCount(
        0,
      );
      await department.selectOption("");
      await expect(administrator.page.getByRole("tab", { name: "Aktive (4)" })).toBeVisible();

      const activeTab = administrator.page.getByRole("tab", { name: "Aktive (4)" });
      const inactiveTab = administrator.page.getByRole("tab", { name: "Inaktive (2)" });
      await activeTab.focus();
      await activeTab.press("ArrowRight");
      await expect(inactiveTab).toHaveAttribute("aria-selected", "true");
      await expect(
        administrator.page.getByRole("rowheader", { name: "Gamleskolen" }),
      ).toBeVisible();
      await expect(
        administrator.page.getByRole("rowheader", { name: "Historisk Internasjonal" }),
      ).toBeVisible();

      const native = nativeScriptClient(apiOrigin);

      const emptyDepartment = await native
        .call(
          {
            cookie: (await administrator.context.cookies())
              .map(({ name, value }) => `${name}=${value}`)
              .join("; "),
            origin: new URL(baseURL ?? administrator.page.url()).origin,
          },
          (client) => client[listSchoolsTag]({ departmentId: departments.empty }),
        )
        .finally(() => native.dispose())
        .then((result) => ({ status: result.status, body: result.ok ? result.value : result.code }));

      expect(emptyDepartment).toEqual({
        status: 200,
        body: { activeSchools: [], inactiveSchools: [] },
      });
      observations.administrator = {
        active: 4,
        inactive: 2,
        unassignedVisible: true,
        emptyDepartment,
      };

      const accessibility = await new AxeBuilder({ page: administrator.page }).analyze();
      expect(accessibility.violations).toEqual([]);

      const twoDepartment = await openContext(
        browser,
        browserRequests,
        browserResponses,
        pageErrors,
      );

      contexts.push(twoDepartment.context);
      await signIn(twoDepartment.page, persons.twoDepartmentMember, "/dashboard/skoler");
      await expect(twoDepartment.page.getByRole("tab", { name: "Aktive (3)" })).toBeVisible();
      await expect(twoDepartment.page.getByRole("tab", { name: "Inaktive (2)" })).toBeVisible();
      await expect(twoDepartment.page.getByRole("rowheader", { name: "Friskolen" })).toHaveCount(0);

      const sharedRow = twoDepartment.page
        .getByRole("row")
        .filter({ has: twoDepartment.page.getByRole("rowheader", { name: "Fellesskolen" }) });

      await expect(sharedRow).toHaveCount(1);
      await expect(sharedRow).toContainText("Avdeling Alfa, Avdeling Beta");
      observations.twoDepartmentMember = { active: 3, inactive: 2, sharedRows: 1 };

      const oneDepartment = await openContext(
        browser,
        browserRequests,
        browserResponses,
        pageErrors,
      );

      contexts.push(oneDepartment.context);
      await signIn(oneDepartment.page, persons.oneDepartmentMember, "/dashboard/skoler");
      await expect(oneDepartment.page.getByRole("tab", { name: "Aktive (2)" })).toBeVisible();
      await expect(oneDepartment.page.getByRole("tab", { name: "Inaktive (1)" })).toBeVisible();
      await expect(oneDepartment.page.getByRole("rowheader", { name: "Alfaskolen" })).toBeVisible();
      await expect(oneDepartment.page.getByRole("rowheader", { name: "Betaskolen" })).toHaveCount(
        0,
      );
      await expect(oneDepartment.page.getByRole("rowheader", { name: "Friskolen" })).toHaveCount(0);
      observations.oneDepartmentMember = { active: 2, inactive: 1 };

      for (const [name, person] of [
        ["endedOnlyMember", persons.endedOnlyMember],
        ["noAuthority", persons.noAuthority],
      ] as const) {
        const denied = await openContext(browser, browserRequests, browserResponses, pageErrors);
        contexts.push(denied.context);

        const rejection = denied.page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === nativeRpcPath &&
            rpcTagOf(response.request().postData()) === listSchoolsTag,
        );

        await signIn(denied.page, person, "/dashboard/skoler");
        const response = await rejection;
        const failure = rpcProblemOf(await response.text());
        expect(failure.status).toBe(403);
        expect(failure.code).toBe("authority.denied");
        await expect(denied.page).toHaveURL(/\/dashboard\/skoler$/);
        await assertDirectoryShell(denied.page);
        await expect(denied.page.getByRole("alert")).toBeVisible();
        await expect(denied.page.getByRole("rowheader")).toHaveCount(0);
        await expect(
          denied.page.getByRole("alert").getByText(person.email, { exact: true }),
        ).toHaveCount(0);
        observations[name] = {
          status: failure.status,
          tag: failure.code,
          renderedAt: "/dashboard/skoler",
        };
      }

      const directoryRequests = browserRequests.filter(
        (request) =>
          request.method === "POST" &&
          request.pathname === nativeRpcPath &&
          request.rpcTag === listSchoolsTag,
      );

      expect(
        browserRequests.filter((request) => request.pathname === "/api/admin/schools"),
      ).toEqual([]);
      expect(
        browserRequests.filter((request) => addressesAnyRoute(request.pathname, legacyRoutes)),
      ).toEqual([]);
      expect(pageErrors).toEqual([]);

      const evidence = {
        specId: "0061",
        passed: true,
        browser: "Chromium",
        realSessionCookie: true,
        browserPath: nativeRpcPath,
        rpcTag: listSchoolsTag,
        directoryRequests,
        directoryResponses: browserResponses.filter(
          (response) => response.pathname === nativeRpcPath && response.rpcTag === listSchoolsTag,
        ),
        observations,
        pageErrors,
        accessibilityViolations: accessibility.violations,
      };

      if (evidencePath !== undefined) {
        await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
      }
    } finally {
      await Promise.all(contexts.map((context) => context.close()));
    }
  });
});
