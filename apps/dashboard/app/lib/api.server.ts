import { createClient } from "@vektorprogrammet/sdk"
import { apiUrl } from "@vektorprogrammet/sdk"

export function createAuthenticatedClient(token: string) {
  return createClient(apiUrl, { auth: token })
}
