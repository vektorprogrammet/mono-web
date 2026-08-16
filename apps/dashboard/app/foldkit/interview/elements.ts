import { createBrowserInterviewClient } from "./browser-client"
import { embedInterview } from "./main"

const DASHBOARD_ELEMENT = "vektor-interview-dashboard"
const CANDIDATE_ELEMENT = "vektor-interview-response"

const registerInterviewElements = (): void => {
  if (typeof window === "undefined" || typeof customElements === "undefined") return

  if (customElements.get(DASHBOARD_ELEMENT) === undefined) {
    customElements.define(DASHBOARD_ELEMENT, class extends HTMLElement {
      readonly #container = document.createElement("div")
      #dispose: (() => void) | undefined

      connectedCallback(): void {
        if (this.#dispose !== undefined) return
        this.#container.id = "foldkit-dashboard-interview"
        this.replaceChildren(this.#container)
        this.#dispose = embedInterview(this.#container, {
          mode: "dashboard",
          client: createBrowserInterviewClient(),
        })
      }

      disconnectedCallback(): void {
        this.#dispose?.()
        this.#dispose = undefined
      }
    })
  }

  if (customElements.get(CANDIDATE_ELEMENT) === undefined) {
    customElements.define(CANDIDATE_ELEMENT, class extends HTMLElement {
      readonly #container = document.createElement("div")
      #dispose: (() => void) | undefined

      connectedCallback(): void {
        if (this.#dispose !== undefined) return
        this.#container.id = "foldkit-candidate-response"
        this.replaceChildren(this.#container)
        this.#dispose = embedInterview(this.#container, {
          mode: "candidate",
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
}

registerInterviewElements()

export { CANDIDATE_ELEMENT, DASHBOARD_ELEMENT }
