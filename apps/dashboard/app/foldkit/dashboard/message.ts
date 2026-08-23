import { Schema as S } from "effect"
import { m } from "foldkit/message"

export const OpenedMobileNavigation = m("OpenedMobileNavigation")
export const ClosedMobileNavigation = m("ClosedMobileNavigation")
export const ToggledAdmissionMenu = m("ToggledAdmissionMenu", {
  isOpen: S.Boolean,
})
export const ToggledProfileMenu = m("ToggledProfileMenu", {
  isOpen: S.Boolean,
})
export const ActivatedNavigation = m("ActivatedNavigation", {
  path: S.String,
})
export const DismissedNavigation = m("DismissedNavigation")

export const Message = S.Union([
  OpenedMobileNavigation,
  ClosedMobileNavigation,
  ToggledAdmissionMenu,
  ToggledProfileMenu,
  ActivatedNavigation,
  DismissedNavigation,
])
export type Message = S.Schema.Type<typeof Message>
