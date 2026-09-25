import { IdempotencyKey } from "@vektorprogrammet/http-api";
import { Option, Schema as S } from "effect";
import { createBrowserTeamApplicationsClient } from "./browser-client";
import { embedTeamApplications } from "./main";
import { TeamId } from "./model";

export const TEAM_APPLICATIONS_ELEMENT = "vektor-team-applications";

export const TEAM_APPLICATIONS_TEAM_ATTRIBUTE = "team-id";

const decodeTeamId = S.decodeUnknownOption(TeamId);

const failureSection = (title: string): HTMLElement => {
  const section = document.createElement("section");
  section.className = "team-applications";
  section.setAttribute("role", "alert");
  const heading = document.createElement("h1");
  heading.textContent = title;
  const guidance = document.createElement("p");
  guidance.textContent = "Last siden på nytt og prøv igjen.";
  section.replaceChildren(heading, guidance);

  return section;
};

export const registerTeamApplicationsElement = (): void => {
  if (typeof window === "undefined" || typeof customElements === "undefined") return;

  if (customElements.get(TEAM_APPLICATIONS_ELEMENT) !== undefined) return;

  customElements.define(
    TEAM_APPLICATIONS_ELEMENT,
    class extends HTMLElement {
      readonly #container = document.createElement("div");
      #dispose: (() => void) | undefined;

      connectedCallback(): void {
        if (this.#dispose !== undefined) return;
        this.replaceChildren(this.#container);
        const teamId = decodeTeamId(this.getAttribute(TEAM_APPLICATIONS_TEAM_ATTRIBUTE));

        if (Option.isNone(teamId)) {
          this.#container.replaceChildren(failureSection("Fant ikke teamet"));

          return;
        }

        try {
          this.#dispose = embedTeamApplications(this.#container, {
            teamId: teamId.value,
            // Generated in the browser so no rendered document carries a mutation key.
            idempotencyKeySeed: IdempotencyKey.make(globalThis.crypto.randomUUID()),
            client: createBrowserTeamApplicationsClient(),
          });
        } catch (cause) {
          this.#container.replaceChildren(failureSection("Team-søknadene kunne ikke startes"));
          globalThis.reportError(cause);
        }
      }

      disconnectedCallback(): void {
        this.#dispose?.();
        this.#dispose = undefined;
      }
    },
  );
};
