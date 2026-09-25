import { createElement } from "react";
import {
  TEAM_APPLICATIONS_ELEMENT,
  TEAM_APPLICATIONS_TEAM_ATTRIBUTE,
} from "../foldkit/team-applications/elements";
import type { Route } from "./+types/dashboard.teamsoknader.$teamId";

// biome-ignore lint/style/noDefaultExport: Route Modules require default export
export default function TeamSoknader({ params }: Route.ComponentProps) {
  return createElement(TEAM_APPLICATIONS_ELEMENT, {
    key: params.teamId,
    [TEAM_APPLICATIONS_TEAM_ATTRIBUTE]: params.teamId,
  });
}
