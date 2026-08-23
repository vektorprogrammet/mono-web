import { createBrowserInterviewClient } from "./browser-client"
import { embedInterview } from "./main"

const CANDIDATE_ELEMENT = "vektor-interview-response"

const registerInterviewElement = (): void => {
  if (typeof window === "undefined" || typeof customElements === "undefined") return
  if (customElements.get(CANDIDATE_ELEMENT) !== undefined) return

  customElements.define(CANDIDATE_ELEMENT, class extends HTMLElement {
    readonly #container = document.createElement("div")
    #dispose: (() => void) | undefined

    connectedCallback(): void {
      if (this.#dispose !== undefined) return
      this.#container.id = "foldkit-candidate-response"
      this.replaceChildren(this.#container)
      this.#dispose = embedInterview(this.#container, {
        responseCapability: "server-held",
        client: createBrowserInterviewClient(),
      })
    }

    disconnectedCallback(): void {
      this.#dispose?.()
      this.#dispose = undefined
    }
  })
}

registerInterviewElement()

export { CANDIDATE_ELEMENT }
