import { DEV_CONTENT, type DepartmentContent } from "~/lib/dev-content";
import type { DepartmentPretty } from "~/lib/types";


export type TeamInfo = DepartmentContent;

export function info(query: DepartmentPretty): TeamInfo | Error {
  const department = DEV_CONTENT.departments.find((item) => item.name === query);
  return department ?? new Error("Unknown team");
}
