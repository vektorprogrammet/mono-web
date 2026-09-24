import { contactIngressContext } from "~/lib/contact-context.server";
import { useLoaderData } from "react-router";
import { ContactTabs } from "~/components/kontakt-tabs";
import { loadContactPage, submitContactMessage } from "~/lib/contact-message.server";
import type { Route } from "./+types/_home.kontakt._index";

export function loader({ context }: Route.LoaderArgs) {
  return loadContactPage(undefined, context.get(contactIngressContext)?.backendOrigin);
}

export function action({ request, context }: Route.ActionArgs) {
  return submitContactMessage(request, undefined, context.get(contactIngressContext));
}

// biome-ignore lint/style/noDefaultExport: Route Modules require default export https://reactrouter.com/start/framework/route-module
export default function KontaktIndex() {
  const { departments, selectedDepartment } = useLoaderData<typeof loader>();

  return <ContactTabs department={selectedDepartment} departments={departments} />;
}
