import { Predicate } from "effect";

/** The text of a form field. A missing field or a file reads as empty text. */
export const formText = (form: FormData, name: string): string => {
  const value = form.get(name);

  return Predicate.isString(value) ? value : "";
};
