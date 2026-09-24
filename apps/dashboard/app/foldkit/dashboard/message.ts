import { Schema as S } from "effect";
import { taggedStruct } from "foldkit/schema";

export const OpenedMobileNavigation = taggedStruct("OpenedMobileNavigation", {});

export const ClosedMobileNavigation = taggedStruct("ClosedMobileNavigation", {});

export const ToggledAdmissionMenu = taggedStruct("ToggledAdmissionMenu", {
  isOpen: S.Boolean,
});

export const ToggledProfileMenu = taggedStruct("ToggledProfileMenu", {
  isOpen: S.Boolean,
});

export const ActivatedNavigation = taggedStruct("ActivatedNavigation", {
  path: S.String,
});

export const DismissedNavigation = taggedStruct("DismissedNavigation", {});

export const Message = S.Union([
  OpenedMobileNavigation,
  ClosedMobileNavigation,
  ToggledAdmissionMenu,
  ToggledProfileMenu,
  ActivatedNavigation,
  DismissedNavigation,
]);

export type Message = S.Schema.Type<typeof Message>;
