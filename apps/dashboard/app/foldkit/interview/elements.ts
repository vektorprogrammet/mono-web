import {
  decodeInvitationInteractionId,
  INVITATION_INTERACTION_ATTRIBUTE,
  type InvitationInteractionId,
} from "./bridge";
import { createBrowserInterviewClient } from "./browser-client";
import { embedInterview } from "./main";

const CANDIDATE_ELEMENT = "vektor-interview-response";

export const registerInterviewElement = (): void => {
  if (typeof window === "undefined" || typeof customElements === "undefined") return;
  if (customElements.get(CANDIDATE_ELEMENT) !== undefined) return;

  customElements.define(
    CANDIDATE_ELEMENT,
    class extends HTMLElement {
      static readonly observedAttributes = [INVITATION_INTERACTION_ATTRIBUTE];

      readonly #container = document.createElement("div");
      #dispose: (() => void) | undefined;

      #mount(): void {
        if (this.#dispose !== undefined) return;
        let interactionId: InvitationInteractionId;
        try {
          interactionId = decodeInvitationInteractionId(
            this.getAttribute(INVITATION_INTERACTION_ATTRIBUTE),
          );
        } catch {
          this.replaceChildren();
          return;
        }
        this.#container.id = "foldkit-candidate-response";
        this.replaceChildren(this.#container);
        this.#dispose = embedInterview(this.#container, {
          client: createBrowserInterviewClient(interactionId),
        });
      }

      connectedCallback(): void {
        this.#mount();
      }

      attributeChangedCallback(
        name: string,
        previousValue: string | null,
        currentValue: string | null,
      ): void {
        if (
          name !== INVITATION_INTERACTION_ATTRIBUTE ||
          previousValue === currentValue ||
          !this.isConnected
        ) {
          return;
        }
        this.#dispose?.();
        this.#dispose = undefined;
        this.#mount();
      }

      disconnectedCallback(): void {
        this.#dispose?.();
        this.#dispose = undefined;
      }
    },
  );
};

export { CANDIDATE_ELEMENT };
