import { useLoaderData } from "react-router";
import { ContactTabs } from "~/components/kontakt-tabs";
import { loadContactPage, submitContactMessage } from "~/lib/contact-message.server";
import type { Route } from "./+types/_home.kontakt.$department";

export function loader({ params }: Route.LoaderArgs) {
  return loadContactPage(params.department);
}

export function action({ request, params }: Route.ActionArgs) {
  return submitContactMessage(request, params.department);
}

// biome-ignore lint/style/noDefaultExport: Route Modules require default export https://reactrouter.com/start/framework/route-module
export default function KontaktDepartment() {
  const { departments, selectedDepartment } = useLoaderData<typeof loader>();
  return <ContactTabs department={selectedDepartment} departments={departments} />;
}
