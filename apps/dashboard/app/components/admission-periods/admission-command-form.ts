import type { FormEvent } from "react";

export function ensureStableAdmissionPeriodCommandId(
  event: FormEvent<HTMLFormElement>,
): void {
  const commandId = event.currentTarget.elements.namedItem("commandId");
  if (commandId instanceof HTMLInputElement && commandId.value.length === 0) {
    commandId.value = crypto.randomUUID();
  }
}
