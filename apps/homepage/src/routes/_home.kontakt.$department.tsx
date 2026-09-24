import { contactIngressContext } from "~/lib/contact-context.server";
import { useLoaderData } from "react-router";
import { ContactTabs } from "~/components/kontakt-tabs";
import { loadContactPage, submitContactMessage } from "~/lib/contact-message.server";
import type { Route } from "./+types/_home.kontakt.$department";

export function loader({ params, context }: Route.LoaderArgs) {
  return loadContactPage(params.department, context.get(contactIngressContext)?.backendOrigin);
}

export function action({ request, params, context }: Route.ActionArgs) {
  return submitContactMessage(request, params.department, context.get(contactIngressContext));
}

// biome-ignore lint/style/noDefaultExport: Route Modules require default export https://reactrouter.com/start/framework/route-module
export default function KontaktDepartment() {
  const { departments, selectedDepartment } = useLoaderData<typeof loader>();

  return <ContactTabs department={selectedDepartment} departments={departments} />;
}
