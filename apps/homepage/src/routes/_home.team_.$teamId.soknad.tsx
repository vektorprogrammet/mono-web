import { Option } from "effect";
import { data, useActionData, useLoaderData, useNavigation } from "react-router";
import { PublicTeamApplicationForm } from "~/components/public-team-application-form";
import type { SubmittedTeamApplication } from "~/lib/api-types";
import { createHomepageApiClient } from "~/lib/api.server";
import {
  decodeTeamApplicationTeamId,
  parsePublicTeamApplicationForm,
  publicTeamApplicationPage,
  publicTeamApplicationPageFailure,
  receivedPublicTeamApplication,
  rejectPublicTeamApplication,
  type PublicTeamApplicationActionData,
  type PublicTeamApplicationLoaderData,
} from "~/lib/public-team-application";
import type { Route } from "./+types/_home.team_.$teamId.soknad";

const pageStatus = {
  open: 200,
  closed: 200,
  "not-found": 404,
  unavailable: 503,
} as const satisfies Readonly<Record<PublicTeamApplicationLoaderData["state"], number>>;

const outcomeStatus = {
  received: 200,
  closed: 409,
  "not-found": 404,
} as const satisfies Readonly<
  Record<Exclude<PublicTeamApplicationActionData["outcome"], "rejected">, number>
>;

function pageResponse(page: PublicTeamApplicationLoaderData) {
  return data(page, { status: pageStatus[page.state] });
}

function outcomeResponse(result: PublicTeamApplicationActionData) {
  return data(result, {
    status:
      result.outcome === "rejected" ? result.failure.error.status : outcomeStatus[result.outcome],
  });
}

/** Each render carries its own idempotency key, so neither documents nor data may be stored. */
export const headers: Route.HeadersFunction = ({ parentHeaders }) => {
  const responseHeaders = new Headers(parentHeaders);

  responseHeaders.set("Cache-Control", "no-store");

  return responseHeaders;
};

export async function loader({ params }: Route.LoaderArgs) {
  const teamId = decodeTeamApplicationTeamId(params.teamId);

  if (Option.isNone(teamId)) return pageResponse({ state: "not-found" });

  try {
    const result = await createHomepageApiClient()["team-applications"].readTeamApplicationIntake({
      params: { teamId: teamId.value },
    });

    return pageResponse(publicTeamApplicationPage(result.body));
  } catch (cause) {
    return pageResponse(publicTeamApplicationPageFailure(cause));
  }
}

export async function action({ request, params }: Route.ActionArgs) {
  const teamId = decodeTeamApplicationTeamId(params.teamId);

  if (Option.isNone(teamId)) return outcomeResponse({ outcome: "not-found" });

  let formData: FormData;

  try {
    formData = await request.formData();
  } catch {
    formData = new FormData();
  }

  const parsed = parsePublicTeamApplicationForm(formData);

  if (!parsed.ok) return outcomeResponse({ outcome: "rejected", failure: parsed.failure });

  const applications = createHomepageApiClient()["team-applications"];
  let submitted: SubmittedTeamApplication;

  try {
    const result = await applications.submitTeamApplication({
      params: { teamId: teamId.value },
      headers: { "idempotency-key": parsed.value.commandId },
      payload: parsed.value.payload,
    });

    submitted = result.body;
  } catch (cause) {
    return outcomeResponse(rejectPublicTeamApplication(parsed.value, cause));
  }

  // The application is stored. A failed name read only leaves the name out of the confirmation.
  const teamName = await applications
    .readTeamApplicationIntake({ params: { teamId: teamId.value } })
    .then(
      (intake) => intake.body.teamName,
      () => undefined,
    );

  return outcomeResponse(receivedPublicTeamApplication(submitted, teamName));
}

// biome-ignore lint/style/noDefaultExport: Route Modules require default export https://reactrouter.com/start/framework/route-module
export default function TeamApplication() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();

  return (
    <main className="mx-auto mt-12 mb-20 w-full min-w-0 max-w-3xl px-4 sm:px-6">
      <PublicTeamApplicationForm
        loaderData={loaderData}
        actionData={actionData}
        submitting={navigation.state === "submitting"}
      />
    </main>
  );
}
