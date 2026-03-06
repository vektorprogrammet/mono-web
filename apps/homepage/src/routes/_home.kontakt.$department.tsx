import { useOutletContext } from "react-router";
import { ContactTabs } from "~/components/kontakt-tabs";
import { type DepartmentPretty, departments } from "~/lib/types";
import type { KontaktContext } from "./_home.kontakt";
import type { Route } from "./+types/_home.kontakt.$department";

// biome-ignore lint/style/noDefaultExport: Route Modules require default export https://reactrouter.com/start/framework/route-module
export default function KontaktDepartment({ params }: Route.ComponentProps) {
  const { departments: apiDepartments } = useOutletContext<KontaktContext>();
  const activeDepartment: DepartmentPretty =
    params.department === "hovedstyret"
      ? departments.hovedstyret
      : params.department === "bergen"
        ? departments.bergen
        : params.department === "aas"
          ? departments.aas
          : departments.trondheim;

  return <ContactTabs department={activeDepartment} departments={apiDepartments} />;
}
