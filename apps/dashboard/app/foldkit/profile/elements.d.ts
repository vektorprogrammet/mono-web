import type { DetailedHTMLProps, HTMLAttributes } from "react";

interface ProfileEditorElementAttributes extends HTMLAttributes<HTMLElement> {
  "profile-input": string;
  "command-id-seed": string;
}

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "vektor-profile-editor": DetailedHTMLProps<
        ProfileEditorElementAttributes,
        HTMLElement
      >;
    }
  }
}
