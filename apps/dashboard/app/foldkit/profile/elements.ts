import { Schema as S } from "effect";
import { createBrowserProfileClient, type ProfileClient } from "./browser-client";
import { embedProfileEditor } from "./main";
import { ProfileInputJson, type UserProfileObservation } from "./model";

export const PROFILE_ELEMENT = "vektor-profile-editor";
export const PROFILE_INPUT_ATTRIBUTE = "profile-input";
export const PROFILE_SEED_ATTRIBUTE = "command-id-seed";

export const registerProfileEditorElement = (): void => {
  if (typeof window === "undefined" || typeof customElements === "undefined") return;
  if (customElements.get(PROFILE_ELEMENT) !== undefined) return;

  customElements.define(
    PROFILE_ELEMENT,
    class extends HTMLElement {
      readonly #container = document.createElement("div");
      #dispose: (() => void) | undefined;

      connectedCallback(): void {
        if (this.#dispose !== undefined) return;
        this.#container.id = "foldkit-profile-editor";
        this.replaceChildren(this.#container);

        try {
          const serialized = this.getAttribute(PROFILE_INPUT_ATTRIBUTE);
          if (serialized === null) throw new Error("missing profile input");
          const commandIdSeed = this.getAttribute(PROFILE_SEED_ATTRIBUTE);
          if (commandIdSeed === null || commandIdSeed.length === 0) {
            throw new Error("missing Profile command ID seed");
          }
          const initialProfile: UserProfileObservation = S.decodeUnknownSync(
            ProfileInputJson,
          )(serialized, { onExcessProperty: "error" });
          const client: ProfileClient = createBrowserProfileClient();
          this.#dispose = embedProfileEditor(this.#container, {
            client,
            commandIdSeed,
            initialProfile,
          });
        } catch {
          const error = document.createElement("section");
          error.className = "fk-profile fk-error";
          error.setAttribute("role", "alert");
          const heading = document.createElement("h1");
          heading.textContent = "Profilredigeringen kunne ikke startes";
          const guidance = document.createElement("p");
          guidance.textContent = "Profildataene mangler eller er ugyldige.";
          error.replaceChildren(heading, guidance);
          this.#container.replaceChildren(error);
        }
      }

      disconnectedCallback(): void {
        this.#dispose?.();
        this.#dispose = undefined;
      }
    },
  );
};

