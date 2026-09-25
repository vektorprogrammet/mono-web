import { startTransition, StrictMode, useEffect } from "react";
import { hydrateRoot } from "react-dom/client";
import { HydratedRouter } from "react-router/dom";
import { registerProfileEditorElement } from "./foldkit/profile/elements";
import { registerDashboardElement } from "./foldkit/dashboard/elements";
import { registerInterviewElement } from "./foldkit/interview/elements";
import { registerOrganizationCatalogElement } from "./foldkit/organization/elements";
import { registerSchoolsDirectoryElement } from "./foldkit/schools/elements";
import { registerRecruitmentMaintenanceElements } from "./foldkit/recruitment-maintenance/elements";
import { registerContentWorkspaceElement } from "./foldkit/content/elements";
import { registerSocialEventsElement } from "./foldkit/social-events/elements";
import { registerSchoolSurveysElement } from "./foldkit/surveys/elements";
import { registerTeamApplicationsElement } from "./foldkit/team-applications/elements";

import { registerDatedServiceElement } from "./foldkit/dated-school-service/elements";

function HydrationSafeRouter() {
  useEffect(() => {
    registerInterviewElement();
    registerOrganizationCatalogElement();
    registerSchoolsDirectoryElement();
    registerRecruitmentMaintenanceElements();
    registerContentWorkspaceElement();
    registerSocialEventsElement();
    registerSchoolSurveysElement();
    registerDatedServiceElement();
    registerProfileEditorElement();
    registerTeamApplicationsElement();

    // Preview devtools (design spec 0074): production registers the ordinary
    // dashboard element. Only a build-time true constant can fetch the preview
    // composition root, so Rollup omits that entire chunk graph in production.
    if (import.meta.env.VITE_PREVIEW_DEVTOOLS === "true") {
      void import("./lib/preview-devtools-bootstrap").then((module) =>
        module.startPreviewDevtools(),
      );
    } else {
      registerDashboardElement();
    }
  }, []);

  return <HydratedRouter />;
}

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <HydrationSafeRouter />
    </StrictMode>,
  );
});
