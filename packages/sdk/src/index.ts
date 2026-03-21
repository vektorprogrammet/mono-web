export {
  createClient,
  type ApiClient,
  type ClientOptions,
  SdkError,
  UnauthorizedError,
  NotFoundError,
  ValidationError,
  ConflictError,
  NetworkError,
  RateLimitedError,
  type SdkErrorType,
  type ClientContext,
  type Receipt,
  type AdminReceipt,
  type Application,
  type AdminApplicationListData,
  type Interview,
  type Assistant,
  type School,
  type Substitute,
  type MailingListEntry,
  type AdmissionStats,
  type TeamInterest,
  type Team,
  type Sponsor,
  type FieldOfStudy,
  type UserProfile,
  type DashboardData,
} from "./promise.js";
export { apiUrl, isFixtureMode } from "./config.js";

// Pre-configured instance using API_URL or Railway staging default
import { createClient } from "./promise.js";
import { apiUrl } from "./config.js";

export const apiClient = createClient(apiUrl);
