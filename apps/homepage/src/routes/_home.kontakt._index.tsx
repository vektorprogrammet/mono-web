import { useOutletContext } from "react-router";
import { ContactTabs } from "~/components/kontakt-tabs";
import type { KontaktContext } from "./_home.kontakt";

// biome-ignore lint/style/noDefaultExport: Route Modules require default export https://reactrouter.com/start/framework/route-module
export default function KontaktIndex() {
  const { departments } = useOutletContext<KontaktContext>();
  return <ContactTabs department="Trondheim" departments={departments} />;
}
