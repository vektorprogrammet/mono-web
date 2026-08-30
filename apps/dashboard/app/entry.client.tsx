import { startTransition, StrictMode, useEffect } from "react";
import { hydrateRoot } from "react-dom/client";
import { HydratedRouter } from "react-router/dom";
import { registerProfileEditorElement } from "./foldkit/profile/elements";
import { registerDashboardElement } from "./foldkit/dashboard/elements";
import { registerInterviewElement } from "./foldkit/interview/elements";
import "./foldkit/organization/elements";
import { registerSchoolsDirectoryElement } from "./foldkit/schools/elements";
import { registerContentWorkspaceElement } from "./foldkit/content/elements";

function HydrationSafeRouter() {
  useEffect(() => {
    registerDashboardElement();
    registerInterviewElement();
    registerSchoolsDirectoryElement();
    registerContentWorkspaceElement();
    registerProfileEditorElement();
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
