import { href } from "react-router";
import { dashboardPagePath } from "../../../dashboard-base";

/**
 * Browser path of the team chooser. The typed `href` stops the type check when the chooser
 * route file moves, and `paths.test.ts` resolves the rendered links against the route table.
 */
export const TEAM_APPLICATIONS_CHOOSER_PATH = dashboardPagePath(href("/teamsoknader"));
