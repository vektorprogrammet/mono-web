import { AdmissionPeriodCreateForm } from "@/components/admission-periods/AdmissionPeriodCreateForm";
import { AdmissionPeriodList } from "@/components/admission-periods/AdmissionPeriodList";
import {
  isAdmissionPeriodUnauthorizedError,
  mapAdmissionPeriodError,
  mapAdmissionPeriodView,
  parseAdmissionPeriodForm,
  type AdmissionPeriodCreateFailure,
  type AdmissionPeriodRevisionFailure,
  type AdmissionPeriodView,
} from "@/lib/admission-period-view";
import { useActionData, useLoaderData, useNavigation } from "react-router";
import { createAuthenticatedClient } from "../lib/api.server";
import { expiredSessionRedirect, requireAuth } from "../lib/auth.server";
import type { Route } from "./+types/dashboard.opptaksperioder._index";

export async function loader({ request }: Route.LoaderArgs) {
  const cookie = await requireAuth(request);
  const client = createAuthenticatedClient(cookie, request);

  try {
    const result = await client.admissionPeriods.listForManagement();
    return {
      periods: result.items.map(mapAdmissionPeriodView),
      error: undefined,
    };
  } catch (error) {
    if (isAdmissionPeriodUnauthorizedError(error)) {
      throw await expiredSessionRedirect(request);
    }
    return {
      periods: [] as AdmissionPeriodView[],
      error: mapAdmissionPeriodError(error),
    };
  }
}

export async function action({ request }: Route.ActionArgs) {
  const cookie = await requireAuth(request);
  const client = createAuthenticatedClient(cookie, request);
  const form = await request.formData();
  const parsed = parseAdmissionPeriodForm(form, crypto.randomUUID());

  if ("failure" in parsed) {
    return { success: false as const, failure: parsed.failure };
  }

  const command = parsed.value;
  try {
    if (command._tag === "CreateAdmissionPeriod") {
      await client.admissionPeriods.create(command.input);
      return {
        success: true as const,
        notice: {
          intent: "create" as const,
          commandId: command.commandId,
        },
      };
    }

    await client.admissionPeriods.revise(command.admissionPeriodId, command.input);
    return {
      success: true as const,
      notice: {
        intent: "revise" as const,
        commandId: command.commandId,
        admissionPeriodId: command.admissionPeriodId,
      },
    };
  } catch (error) {
    if (isAdmissionPeriodUnauthorizedError(error)) {
      throw await expiredSessionRedirect(request);
    }
    const mappedError = mapAdmissionPeriodError(error);
    if (command._tag === "CreateAdmissionPeriod") {
      const failure: AdmissionPeriodCreateFailure = {
        intent: "create",
        commandId: command.commandId,
        draft: command.draft,
        error: mappedError,
      };
      return { success: false as const, failure };
    }

    const failure: AdmissionPeriodRevisionFailure = {
      intent: "revise",
      admissionPeriodId: command.admissionPeriodId,
      expectedRevision: command.expectedRevision,
      commandId:
        mappedError._tag === "StaleAdmissionPeriodRevision"
          ? crypto.randomUUID()
          : command.commandId,
      draft: command.draft,
      error: mappedError,
    };
    return { success: false as const, failure };
  }
}

// biome-ignore lint/style/noDefaultExport: Route Modules require default export https://reactrouter.com/start/framework/route-module
export default function Opptaksperioder() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const createFailure =
    actionData?.success === false && actionData.failure.intent === "create"
      ? actionData.failure
      : undefined;
  const revisionFailure =
    actionData?.success === false && actionData.failure.intent === "revise"
      ? actionData.failure
      : undefined;
  const createNotice =
    actionData?.success === true && actionData.notice.intent === "create"
      ? actionData.notice
      : undefined;
  const revisionNotice =
    actionData?.success === true && actionData.notice.intent === "revise"
      ? actionData.notice
      : undefined;
  const semesterIds = Array.from(
    new Set(loaderData.periods.map((period) => period.semesterId)),
  ).sort();
  const departmentIds = Array.from(
    new Set(loaderData.periods.map((period) => period.departmentId)),
  ).sort();

  return (
    <section className="flex w-full min-w-0 flex-col" aria-labelledby="admission-period-page-title">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 sm:px-6 lg:px-8">
        <header className="max-w-3xl">
          <h1 id="admission-period-page-title" className="font-semibold text-2xl">
            Opptaksperioder
          </h1>
          <p className="mt-2 text-muted-foreground">
            Åpne og revider tidsrommet der en avdeling tar imot nye søknader.
          </p>
        </header>

        <AdmissionPeriodCreateForm
          failure={createFailure}
          notice={createNotice}
          semesterIds={semesterIds}
          departmentIds={departmentIds}
        />

        <AdmissionPeriodList
          periods={loaderData.periods}
          error={loaderData.error}
          failure={revisionFailure}
          notice={revisionNotice}
          busy={navigation.state !== "idle"}
        />
      </div>
    </section>
  );
}
