import { IdempotencyKey } from "@vektorprogrammet/http-api";
import { createBrowserRecruitmentClient } from "./browser-client";
import { embedRecruitment } from "./main";

const RECRUITMENT_ELEMENT = "vektor-recruitment-board";
const RECRUITMENT_INPUT_ATTRIBUTE = "recruitment-input";
const makeIdempotencyKeySeed = (): typeof IdempotencyKey.Type => {
  const bytes = window.crypto.getRandomValues(new Uint8Array(32));
  let seed = "";
  for (const byte of bytes) seed += byte.toString(16).padStart(2, "0");
  return IdempotencyKey.make(seed);
};

const registerRecruitmentElement = (): void => {
  if (typeof window === "undefined" || typeof customElements === "undefined") return;
  if (customElements.get(RECRUITMENT_ELEMENT) !== undefined) return;

  customElements.define(
    RECRUITMENT_ELEMENT,
    class extends HTMLElement {
      readonly #container = document.createElement("div");
      #dispose: (() => void) | undefined;

      connectedCallback(): void {
        if (this.#dispose !== undefined) return;
        this.#container.id = "foldkit-recruitment-board";
        this.replaceChildren(this.#container);
        this.#dispose = embedRecruitment(this.#container, {
          client: createBrowserRecruitmentClient(),
          serializedInput: this.getAttribute(RECRUITMENT_INPUT_ATTRIBUTE),
          idempotencyKeySeed: makeIdempotencyKeySeed(),
        });
      }

      disconnectedCallback(): void {
        this.#dispose?.();
        this.#dispose = undefined;
      }
    },
  );
};

registerRecruitmentElement();

export { RECRUITMENT_ELEMENT, RECRUITMENT_INPUT_ATTRIBUTE };
