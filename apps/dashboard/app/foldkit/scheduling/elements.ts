import { createBrowserRecruitmentClient } from "../recruitment/browser-client";
import { embedScheduling } from "./main";

const SCHEDULING_ELEMENT = "vektor-recruitment-scheduling";
const SCHEDULING_INPUT_ATTRIBUTE = "scheduling-input";

const registerSchedulingElement = (): void => {
  if (typeof window === "undefined" || typeof customElements === "undefined") return;
  if (customElements.get(SCHEDULING_ELEMENT) !== undefined) return;

  customElements.define(
    SCHEDULING_ELEMENT,
    class extends HTMLElement {
      readonly #container = document.createElement("div");
      #dispose: (() => void) | undefined;

      connectedCallback(): void {
        if (this.#dispose !== undefined) return;
        this.#container.id = "foldkit-recruitment-scheduling";
        this.replaceChildren(this.#container);
        this.#dispose = embedScheduling(this.#container, {
          client: createBrowserRecruitmentClient(),
          serializedInput: this.getAttribute(SCHEDULING_INPUT_ATTRIBUTE),
          commandIdSeed: window.crypto.randomUUID(),
        });
      }

      disconnectedCallback(): void {
        this.#dispose?.();
        this.#dispose = undefined;
      }
    },
  );
};

registerSchedulingElement();

export { SCHEDULING_ELEMENT, SCHEDULING_INPUT_ATTRIBUTE };
