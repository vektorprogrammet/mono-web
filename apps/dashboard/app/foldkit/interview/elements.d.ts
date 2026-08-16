import type { DetailedHTMLProps, HTMLAttributes } from "react"

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "vektor-interview-dashboard": DetailedHTMLProps<
        HTMLAttributes<HTMLElement>,
        HTMLElement
      >
      "vektor-interview-response": DetailedHTMLProps<
        HTMLAttributes<HTMLElement>,
        HTMLElement
      >
    }
  }
}
