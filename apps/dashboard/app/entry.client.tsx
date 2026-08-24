import { startTransition, StrictMode, useEffect } from "react";
import { hydrateRoot } from "react-dom/client";
import { HydratedRouter } from "react-router/dom";
import { registerDashboardElement } from "./foldkit/dashboard/elements";
import { registerInterviewElement } from "./foldkit/interview/elements";

function HydrationSafeRouter() {
  useEffect(() => {
    registerDashboardElement();
    registerInterviewElement();
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
