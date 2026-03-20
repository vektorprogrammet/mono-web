# DDD/FCIS Architecture Analysis — End-State Specification

Restructure plan for the Symfony codebase (`apps/server/src/App/`) toward
colocated Domain-Driven Design with Functional Core, Imperative Shell (FCIS).

**Relationship to migration:** Independent workstream. The restructure is purely
internal — API Platform DTOs and the OpenAPI spec are the external contract and
remain unchanged. Can proceed in parallel with A1 (SDK) and B0/B1 (frontend).

## FCIS Interpretation

Doctrine entities are data containers with getters/setters. Business logic lives
in services. The valuable extraction is **business rules and computations from
services into pure PHP classes** — not mirroring the entity graph.

- **Functional Core:** Pure PHP in `Domain/` — business rules, value objects,
  event definitions, repository interfaces. Zero Symfony/Doctrine imports.
- **Imperative Shell:** Doctrine entities, repositories, API Platform, mailers,
  external integrations.

Doctrine entities stay as Infrastructure. No entity splitting.

## Bounded Contexts

| Context | Responsibility | Core Entities |
|---------|---------------|---------------|
| **Admission** | Application lifecycle — submit, review, accept/reject | Application, AdmissionPeriod, AdmissionSubscriber, AdmissionNotification |
| **Interview** | Interview scheduling, conducting, scoring | Interview, InterviewSchema, InterviewQuestion, InterviewQuestionAlternative, InterviewAnswer, InterviewScore, InterviewDistribution |
| **Organization** | Departments, teams, boards, positions, user groups | Department, Team, TeamMembership, ExecutiveBoard, ExecutiveBoardMembership, Position, TeamApplication, TeamInterest, UserGroup, UserGroupCollection |
| **Survey** | Questionnaire creation, distribution, response collection | Survey, SurveyQuestion, SurveyQuestionAlternative, SurveyAnswer, SurveyTaken, SurveyNotification, SurveyNotificationCollection, SurveyLinkClick |
| **Identity** | Users, authentication, roles, access control | User, Role, PasswordReset, AccessRule, UnhandledAccessRule |
| **Scheduling** | Assistant-to-school assignment | School, SchoolCapacity, AssistantScheduling/* |
| **Finance** | Receipts, certificates, assistant work history | Receipt, CertificateRequest, AssistantHistory, Signature |
| **Content** | Articles, static pages, sponsors, changelog, events, support | Article, StaticContent, Sponsor, ChangeLogItem, SupportTicket, SocialEvent, InfoMeeting, Feedback |

### Changes from initial design (validated by analysis)

- **Feedback** moved from Survey to Content — zero structural dependency on Survey
  entities; captures bug reports/feature requests, not survey responses.
- **UserGroup/UserGroupCollection** moved from Identity to Organization — they
  manage team/department/semester grouping, not identity concerns.
- **FieldOfStudy** moved from Shared to Organization — only referenced by
  Department (Organization) and Application forms, not truly cross-context.
- **SupportTicket** is a non-persisted DTO (no `@ORM\Entity`), kept in Content as
  a contact form submission object.

## Shared Kernel

| Class | Rationale |
|-------|-----------|
| `Semester` | Used by Admission, Organization, Scheduling, Finance, Survey, Interview |
| `SemesterUtil` | Pure semester calculations |
| `DepartmentSemesterInterface` | Implemented by Application (Admission) and TeamInterest (Organization) |
| `PeriodInterface` | Implemented by Semester and AdmissionPeriod |
| `TeamInterface` | Implemented by Team and ExecutiveBoard (polymorphic team structure) |
| `TeamMembershipInterface` | Implemented by TeamMembership and ExecutiveBoardMembership |

**Excluded:** Department (Organization), User (Identity), FieldOfStudy
(Organization), Role/AccessRule (Identity).

## Layer Structure

```
src/
  {Context}/
    Domain/
      Rules/             # Pure business rules
      ValueObjects/      # Immutable value types
      Events/            # Domain event definitions
      Contracts/         # Repository/service interfaces
    Infrastructure/
      Entity/            # Doctrine entities
      Repository/        # Concrete repositories
      Subscriber/        # Event subscribers
      Validator/         # Symfony validators
      Command/           # Console commands
      ...                # Context-specific infra (Mailer, etc.)
    Api/
      Resource/          # API Platform DTOs
      State/             # Providers + Processors
    Controller/          # Legacy Twig (deprecated, removed post-migration)
    Form/                # Legacy form types (deprecated)
  Shared/                # Cross-context contracts and value objects
  Support/               # Context-agnostic infrastructure
    Infrastructure/      # Mailer, SMS, Google, file upload, logging
    Controller/          # BaseController, FileBrowserController, GitHubController
    EventSubscriber/     # DbSubscriber, ExceptionSubscriber, GSuiteSubscriber
    Twig/                # Cross-cutting Twig extensions (legacy)
    Form/                # Cross-cutting form types/extensions (legacy)
    Utils/               # CsvUtil, TimeUtil
```

## Migration Map

### Admission

| Existing Path | Cat | Target Path |
|---------------|-----|-------------|
| Entity/Application.php | 1 | Admission/Infrastructure/Entity/ |
| Entity/AdmissionPeriod.php | 1 | Admission/Infrastructure/Entity/ |
| Entity/AdmissionSubscriber.php | 1 | Admission/Infrastructure/Entity/ |
| Entity/AdmissionNotification.php | 1 | Admission/Infrastructure/Entity/ |
| Model/ApplicationStatus.php | 1 | Admission/Domain/ValueObjects/ |
| Entity/Repository/ApplicationRepository.php | 1 | Admission/Infrastructure/Repository/ |
| Entity/Repository/AdmissionPeriodRepository.php | 1 | Admission/Infrastructure/Repository/ |
| Entity/Repository/AdmissionSubscriberRepository.php | 1 | Admission/Infrastructure/Repository/ |
| Entity/Repository/AdmissionNotificationRepository.php | 1 | Admission/Infrastructure/Repository/ |
| Service/ApplicationManager.php | 2 | Admission/Infrastructure/ (extract rules) |
| Service/ApplicationAdmission.php | 2 | Admission/Infrastructure/ (extract rules) |
| Service/AdmissionNotifier.php | 1 | Admission/Infrastructure/ |
| Service/AdmissionStatistics.php | 2 | Admission/Domain/Rules/ (fully pure) |
| Service/ApplicationData.php | 2 | Admission/Infrastructure/ (extract counting rules) |
| Service/EmailSender.php | 1 | Admission/Infrastructure/ |
| Event/ApplicationCreatedEvent.php | 1 | Admission/Domain/Events/ |
| EventSubscriber/ApplicationSubscriber.php | 1 | Admission/Infrastructure/Subscriber/ |
| Validator/Constraints/ApplicationEmail.php | 1 | Admission/Infrastructure/Validator/ |
| Validator/Constraints/ApplicationEmailValidator.php | 1 | Admission/Infrastructure/Validator/ |
| ApiResource/ApplicationInput.php | 1 | Admission/Api/Resource/ |
| ApiResource/ExistingUserApplicationInput.php | 1 | Admission/Api/Resource/ |
| ApiResource/ApplicationDetailResource.php | 1 | Admission/Api/Resource/ |
| ApiResource/AdminApplicationListResource.php | 1 | Admission/Api/Resource/ |
| ApiResource/AdminApplicationCreateInput.php | 1 | Admission/Api/Resource/ |
| ApiResource/AdminApplicationDeleteResource.php | 1 | Admission/Api/Resource/ |
| ApiResource/AdminApplicationBulkDeleteInput.php | 1 | Admission/Api/Resource/ |
| ApiResource/AdmissionSubscriberInput.php | 1 | Admission/Api/Resource/ |
| ApiResource/AdmissionStatisticsResource.php | 1 | Admission/Api/Resource/ |
| ApiResource/AdminAdmissionPeriodWriteResource.php | 1 | Admission/Api/Resource/ |
| ApiResource/AdminAdmissionPeriodDeleteResource.php | 1 | Admission/Api/Resource/ |
| State/ApplicationProcessor.php | 1 | Admission/Api/State/ |
| State/ExistingUserApplicationProcessor.php | 1 | Admission/Api/State/ |
| State/ApplicationDetailProvider.php | 1 | Admission/Api/State/ |
| State/AdminApplicationListProvider.php | 1 | Admission/Api/State/ |
| State/AdminApplicationCreateProcessor.php | 1 | Admission/Api/State/ |
| State/AdminApplicationDeleteProcessor.php | 1 | Admission/Api/State/ |
| State/AdminApplicationDeleteProvider.php | 1 | Admission/Api/State/ |
| State/AdminApplicationBulkDeleteProcessor.php | 1 | Admission/Api/State/ |
| State/AdmissionSubscriberProcessor.php | 1 | Admission/Api/State/ |
| State/AdmissionStatisticsProvider.php | 1 | Admission/Api/State/ |
| State/AdminAdmissionPeriodCreateProcessor.php | 1 | Admission/Api/State/ |
| State/AdminAdmissionPeriodEditProcessor.php | 1 | Admission/Api/State/ |
| State/AdminAdmissionPeriodDeleteProcessor.php | 1 | Admission/Api/State/ |
| State/AdminAdmissionPeriodEditProvider.php | 1 | Admission/Api/State/ |
| State/AdminAdmissionPeriodDeleteProvider.php | 1 | Admission/Api/State/ |
| Controller/ExistingUserAdmissionController.php | 4 | Admission/Controller/ |
| Controller/ApplicationStatisticsController.php | 4 | Admission/Controller/ |
| Controller/AdmissionAdminController.php | 4 | Admission/Controller/ |
| Controller/AdmissionPeriodController.php | 4 | Admission/Controller/ |
| Controller/AdmissionSubscriberController.php | 4 | Admission/Controller/ |
| Controller/SubstituteController.php | 4 | Admission/Controller/ |
| Controller/ConfirmationController.php | 4 | Admission/Controller/ |
| Form/Type/AdmissionSubscriberType.php | 4 | Admission/Form/ |
| Form/Type/ApplicationPracticalType.php | 4 | Admission/Form/ |
| Form/Type/DaysType.php | 4 | Admission/Form/ |
| Form/Type/ModifySubstituteType.php | 4 | Admission/Form/ |
| Form/Type/UserDataForSubstituteType.php | 4 | Admission/Form/ |
| ApiResource/AdminSubstituteResource.php | 1 | Admission/Api/Resource/ |
| State/AdminSubstituteListProvider.php | 1 | Admission/Api/State/ |
| State/AdminSubstituteEditProcessor.php | 1 | Admission/Api/State/ |
| State/AdminSubstituteEditProvider.php | 1 | Admission/Api/State/ |
| State/AdminSubstituteActivateProcessor.php | 1 | Admission/Api/State/ |
| State/AdminSubstituteActivateProvider.php | 1 | Admission/Api/State/ |
| State/AdminSubstituteDeactivateProcessor.php | 1 | Admission/Api/State/ |
| State/AdminSubstituteDeactivateProvider.php | 1 | Admission/Api/State/ |

### Interview

| Existing Path | Cat | Target Path |
|---------------|-----|-------------|
| Entity/Interview.php | 1 | Interview/Infrastructure/Entity/ |
| Entity/InterviewSchema.php | 1 | Interview/Infrastructure/Entity/ |
| Entity/InterviewQuestion.php | 1 | Interview/Infrastructure/Entity/ |
| Entity/InterviewQuestionAlternative.php | 1 | Interview/Infrastructure/Entity/ |
| Entity/InterviewAnswer.php | 1 | Interview/Infrastructure/Entity/ |
| Entity/InterviewScore.php | 1 | Interview/Infrastructure/Entity/ |
| Entity/InterviewDistribution.php | 1 | Interview/Infrastructure/Entity/ |
| Entity/Repository/InterviewRepository.php | 1 | Interview/Infrastructure/Repository/ |
| Service/InterviewManager.php | 2 | Interview/Infrastructure/ (extract rules) |
| Service/InterviewCounter.php | 1 | Interview/Domain/Rules/ (fully pure) |
| Service/InterviewNotificationManager.php | 1 | Interview/Infrastructure/ |
| Event/InterviewConductedEvent.php | 1 | Interview/Domain/Events/ |
| Event/InterviewEvent.php | 1 | Interview/Domain/Events/ |
| EventSubscriber/InterviewSubscriber.php | 1 | Interview/Infrastructure/Subscriber/ |
| Type/InterviewStatusType.php | 1 | Interview/Domain/ValueObjects/ |
| Validator/Constraints/InterviewAnswer.php | 1 | Interview/Infrastructure/Validator/ |
| Validator/Constraints/InterviewAnswerValidator.php | 1 | Interview/Infrastructure/Validator/ |
| ApiResource/InterviewResponseResource.php | 1 | Interview/Api/Resource/ |
| ApiResource/AdminInterviewListResource.php | 1 | Interview/Api/Resource/ |
| ApiResource/AdminInterviewSchemaWriteResource.php | 1 | Interview/Api/Resource/ |
| ApiResource/AdminInterviewSchemaDeleteResource.php | 1 | Interview/Api/Resource/ |
| ApiResource/InterviewScheduleInput.php | 1 | Interview/Api/Resource/ |
| ApiResource/InterviewConductInput.php | 1 | Interview/Api/Resource/ |
| ApiResource/InterviewAssignInput.php | 1 | Interview/Api/Resource/ |
| ApiResource/InterviewBulkAssignInput.php | 1 | Interview/Api/Resource/ |
| ApiResource/InterviewCoInterviewerInput.php | 1 | Interview/Api/Resource/ |
| ApiResource/InterviewStatusInput.php | 1 | Interview/Api/Resource/ |
| ApiResource/InterviewDeleteResource.php | 1 | Interview/Api/Resource/ |
| ApiResource/InterviewClearCoInterviewerResource.php | 1 | Interview/Api/Resource/ |
| ApiResource/InterviewSchemaResource.php | 1 | Interview/Api/Resource/ |
| State/Interview*.php (17 files) | 1 | Interview/Api/State/ |
| State/AdminInterviewSchema*.php (3 files) | 1 | Interview/Api/State/ |
| Controller/InterviewController.php | 4 | Interview/Controller/ |
| Controller/InterviewSchemaController.php | 4 | Interview/Controller/ |
| Form/Type/InterviewType.php | 4 | Interview/Form/ |
| Form/Type/InterviewNewTimeType.php | 4 | Interview/Form/ |
| Form/Type/AddCoInterviewerType.php | 4 | Interview/Form/ |
| Form/Type/ApplicationInterviewType.php | 4 | Interview/Form/ |
| Form/Type/ScheduleInterviewType.php | 4 | Interview/Form/ |
| Form/Type/CreateInterviewType.php | 4 | Interview/Form/ |
| Form/Type/CancelInterviewConfirmationType.php | 4 | Interview/Form/ |
| Form/Type/InterviewQuestionType.php | 4 | Interview/Form/ |
| Form/Type/InterviewQuestionAlternativeType.php | 4 | Interview/Form/ |
| Form/Type/InterviewScoreType.php | 4 | Interview/Form/ |
| Form/Type/InterviewAnswerType.php | 4 | Interview/Form/ |
| Form/Type/AssignInterviewType.php | 4 | Interview/Form/ |
| Form/Type/InterviewSchemaType.php | 4 | Interview/Form/ |

### Organization

| Existing Path | Cat | Target Path |
|---------------|-----|-------------|
| Entity/Department.php | 1 | Organization/Infrastructure/Entity/ |
| Entity/Team.php | 1 | Organization/Infrastructure/Entity/ |
| Entity/TeamMembership.php | 1 | Organization/Infrastructure/Entity/ |
| Entity/ExecutiveBoard.php | 1 | Organization/Infrastructure/Entity/ |
| Entity/ExecutiveBoardMembership.php | 1 | Organization/Infrastructure/Entity/ |
| Entity/Position.php | 1 | Organization/Infrastructure/Entity/ |
| Entity/TeamApplication.php | 1 | Organization/Infrastructure/Entity/ |
| Entity/TeamInterest.php | 1 | Organization/Infrastructure/Entity/ |
| Entity/UserGroup.php | 1 | Organization/Infrastructure/Entity/ |
| Entity/UserGroupCollection.php | 1 | Organization/Infrastructure/Entity/ |
| Entity/FieldOfStudy.php | 1 | Organization/Infrastructure/Entity/ |
| Entity/Repository/DepartmentRepository.php | 1 | Organization/Infrastructure/Repository/ |
| Entity/Repository/TeamRepository.php | 1 | Organization/Infrastructure/Repository/ |
| Entity/Repository/TeamMembershipRepository.php | 1 | Organization/Infrastructure/Repository/ |
| Entity/Repository/ExecutiveBoardRepository.php | 1 | Organization/Infrastructure/Repository/ |
| Entity/Repository/ExecutiveBoardMembershipRepository.php | 1 | Organization/Infrastructure/Repository/ |
| Entity/Repository/PositionRepository.php | 1 | Organization/Infrastructure/Repository/ |
| Entity/Repository/TeamApplicationRepository.php | 1 | Organization/Infrastructure/Repository/ |
| Entity/Repository/TeamInterestRepository.php | 1 | Organization/Infrastructure/Repository/ |
| Entity/Repository/FieldOfStudyRepository.php | 1 | Organization/Infrastructure/Repository/ |
| Service/TeamMembershipService.php | 2 | Organization/Infrastructure/ (extract rules) |
| Service/UserGroupCollectionManager.php | 2 | Organization/Infrastructure/ (extract rules) |
| Event/TeamEvent.php | 1 | Organization/Domain/Events/ |
| Event/TeamApplicationCreatedEvent.php | 1 | Organization/Domain/Events/ |
| Event/TeamInterestCreatedEvent.php | 1 | Organization/Domain/Events/ |
| Event/TeamMembershipEvent.php | 1 | Organization/Domain/Events/ |
| EventSubscriber/TeamApplicationSubscriber.php | 1 | Organization/Infrastructure/Subscriber/ |
| EventSubscriber/TeamInterestSubscriber.php | 1 | Organization/Infrastructure/Subscriber/ |
| EventSubscriber/TeamMembershipSubscriber.php | 1 | Organization/Infrastructure/Subscriber/ |
| EventSubscriber/IntroductionEmailSubscriber.php | 1 | Organization/Infrastructure/Subscriber/ |
| ApiResource/AdminTeam*.php (5 files) | 1 | Organization/Api/Resource/ |
| ApiResource/AdminDepartment*.php (2 files) | 1 | Organization/Api/Resource/ |
| ApiResource/AdminExecutiveBoard*.php (4 files) | 1 | Organization/Api/Resource/ |
| ApiResource/AdminFieldOfStudyWriteResource.php | 1 | Organization/Api/Resource/ |
| ApiResource/TeamApplicationInput.php | 1 | Organization/Api/Resource/ |
| ApiResource/TeamInterestResource.php | 1 | Organization/Api/Resource/ |
| State/AdminTeam*.php (10 files) | 1 | Organization/Api/State/ |
| State/AdminDepartment*.php (5 files) | 1 | Organization/Api/State/ |
| State/AdminExecutiveBoard*.php (6 files) | 1 | Organization/Api/State/ |
| State/AdminFieldOfStudy*.php (3 files) | 1 | Organization/Api/State/ |
| State/TeamApplicationProcessor.php | 1 | Organization/Api/State/ |
| State/TeamInterestProvider.php | 1 | Organization/Api/State/ |
| Controller/TeamController.php | 4 | Organization/Controller/ |
| Controller/TeamAdminController.php | 4 | Organization/Controller/ |
| Controller/TeamApplicationController.php | 4 | Organization/Controller/ |
| Controller/TeamInterestController.php | 4 | Organization/Controller/ |
| Controller/BoardAndTeamController.php | 4 | Organization/Controller/ |
| Controller/DepartmentController.php | 4 | Organization/Controller/ |
| Controller/ExecutiveBoardController.php | 4 | Organization/Controller/ |
| Controller/PositionController.php | 4 | Organization/Controller/ |
| Controller/UserGroupCollectionController.php | 4 | Organization/Controller/ |
| Controller/ControlPanelController.php | 4 | Organization/Controller/ |
| Controller/MailingListController.php | 4 | Organization/Controller/ |
| Form/Type/CreateTeamType.php | 4 | Organization/Form/ |
| Form/Type/TeamApplicationType.php | 4 | Organization/Form/ |
| Form/Type/CreatePositionType.php | 4 | Organization/Form/ |
| Form/Type/CreateExecutiveBoardMembershipType.php | 4 | Organization/Form/ |
| Form/Type/GenerateMailingListType.php | 4 | Organization/Form/ |
| Twig/Extension/DepartmentExtension.php | 4 | Organization/Twig/ |
| Twig/Extension/TeamPositionSortExtension.php | 4 | Organization/Twig/ |
| ApiResource/MailingListResource.php | 1 | Organization/Api/Resource/ |

### Survey

| Existing Path | Cat | Target Path |
|---------------|-----|-------------|
| Entity/Survey.php | 1 | Survey/Infrastructure/Entity/ |
| Entity/SurveyQuestion.php | 1 | Survey/Infrastructure/Entity/ |
| Entity/SurveyQuestionAlternative.php | 1 | Survey/Infrastructure/Entity/ |
| Entity/SurveyAnswer.php | 1 | Survey/Infrastructure/Entity/ |
| Entity/SurveyTaken.php | 1 | Survey/Infrastructure/Entity/ |
| Entity/SurveyNotification.php | 1 | Survey/Infrastructure/Entity/ |
| Entity/SurveyNotificationCollection.php | 1 | Survey/Infrastructure/Entity/ |
| Entity/SurveyLinkClick.php | 1 | Survey/Infrastructure/Entity/ |
| Entity/Repository/SurveyRepository.php | 1 | Survey/Infrastructure/Repository/ |
| Entity/Repository/SurveyTakenRepository.php | 1 | Survey/Infrastructure/Repository/ |
| Entity/Repository/SurveyNotificationRepository.php | 1 | Survey/Infrastructure/Repository/ |
| Service/SurveyManager.php | 2 | Survey/Infrastructure/ (extract rules) |
| Service/SurveyNotifier.php | 1 | Survey/Infrastructure/ |
| ApiResource/AdminSurvey*.php (5 files) | 1 | Survey/Api/Resource/ |
| ApiResource/AdminSurveyNotifier*.php (3 files) | 1 | Survey/Api/Resource/ |
| ApiResource/SurveyRespondInput.php | 1 | Survey/Api/Resource/ |
| ApiResource/SurveyPopupResource.php | 1 | Survey/Api/Resource/ |
| ApiResource/SurveyResultResource.php | 1 | Survey/Api/Resource/ |
| ApiResource/PopupDismissInput.php | 1 | Survey/Api/Resource/ |
| ApiResource/PopupPreferenceInput.php | 1 | Survey/Api/Resource/ |
| State/AdminSurvey*.php (7 files) | 1 | Survey/Api/State/ |
| State/AdminSurveyNotifier*.php (5 files) | 1 | Survey/Api/State/ |
| State/SurveyRespondProcessor.php | 1 | Survey/Api/State/ |
| State/SurveyPopupProvider.php | 1 | Survey/Api/State/ |
| State/SurveyResultProvider.php | 1 | Survey/Api/State/ |
| State/PopupDismissProcessor.php | 1 | Survey/Api/State/ |
| State/PopupPreferenceProcessor.php | 1 | Survey/Api/State/ |
| Controller/SurveyController.php | 4 | Survey/Controller/ |
| Controller/SurveyNotifierController.php | 4 | Survey/Controller/ |
| Controller/SurveyPopupController.php | 4 | Survey/Controller/ |
| Form/Type/SurveyType.php | 4 | Survey/Form/ |
| Form/Type/SurveyAdminType.php | 4 | Survey/Form/ |

### Identity

| Existing Path | Cat | Target Path |
|---------------|-----|-------------|
| Entity/User.php | 1 | Identity/Infrastructure/Entity/ |
| Entity/Role.php | 1 | Identity/Infrastructure/Entity/ |
| Entity/PasswordReset.php | 1 | Identity/Infrastructure/Entity/ |
| Entity/AccessRule.php | 1 | Identity/Infrastructure/Entity/ |
| Entity/UnhandledAccessRule.php | 1 | Identity/Infrastructure/Entity/ |
| Entity/Repository/UserRepository.php | 1 | Identity/Infrastructure/Repository/ |
| Entity/Repository/RoleRepository.php | 1 | Identity/Infrastructure/Repository/ |
| Entity/Repository/PasswordResetRepository.php | 1 | Identity/Infrastructure/Repository/ |
| Entity/Repository/AccessRuleRepository.php | 1 | Identity/Infrastructure/Repository/ |
| Entity/Repository/UnhandledAccessRuleRepository.php | 1 | Identity/Infrastructure/Repository/ |
| Service/UserService.php | 1 | Identity/Infrastructure/ |
| Service/UserRegistration.php | 1 | Identity/Infrastructure/ |
| Service/LoginManager.php | 1 | Identity/Infrastructure/ |
| Service/RoleManager.php | 2 | Identity/Infrastructure/ (extract rules) |
| Service/AccessControlService.php | 1 | Identity/Infrastructure/ |
| Service/PasswordManager.php | 1 | Identity/Infrastructure/ |
| Service/CompanyEmailMaker.php | 1 | Identity/Infrastructure/ |
| Event/UserEvent.php | 1 | Identity/Domain/Events/ |
| EventSubscriber/UserSubscriber.php | 1 | Identity/Infrastructure/Subscriber/ |
| EventSubscriber/AccessControlSubscriber.php | 1 | Identity/Infrastructure/Subscriber/ |
| Security/UserChecker.php | 1 | Identity/Infrastructure/ |
| Role/Roles.php | 1 | Identity/Domain/ |
| Role/ReversedRoleHierarchy.php | 1 | Identity/Infrastructure/ |
| AutoMapper/UserMap.php | 1 | Identity/Infrastructure/ |
| Validator/Constraints/UniqueCompanyEmail.php | 1 | Identity/Infrastructure/Validator/ |
| Validator/Constraints/UniqueCompanyEmailValidator.php | 1 | Identity/Infrastructure/Validator/ |
| Validator/Constraints/VektorEmail.php | 1 | Identity/Infrastructure/Validator/ |
| Validator/Constraints/VektorEmailValidator.php | 1 | Identity/Infrastructure/Validator/ |
| ApiResource/AdminUserWriteResource.php | 1 | Identity/Api/Resource/ |
| ApiResource/AdminUserListResource.php | 1 | Identity/Api/Resource/ |
| ApiResource/AdminUserDeleteResource.php | 1 | Identity/Api/Resource/ |
| ApiResource/AdminUserActivationResource.php | 1 | Identity/Api/Resource/ |
| ApiResource/ProfileResource.php | 1 | Identity/Api/Resource/ |
| ApiResource/ProfilePhotoInput.php | 1 | Identity/Api/Resource/ |
| ApiResource/PasswordResetRequest.php | 1 | Identity/Api/Resource/ |
| ApiResource/PasswordResetExecute.php | 1 | Identity/Api/Resource/ |
| ApiResource/PasswordChangeInput.php | 1 | Identity/Api/Resource/ |
| State/AdminUser*.php (6 files) | 1 | Identity/Api/State/ |
| State/Profile*.php (3 files) | 1 | Identity/Api/State/ |
| State/PasswordChange*.php | 1 | Identity/Api/State/ |
| State/PasswordResetRequest*.php | 1 | Identity/Api/State/ |
| State/PasswordResetExecute*.php | 1 | Identity/Api/State/ |
| State/PublicUserProfileProvider.php | 1 | Identity/Api/State/ |
| Controller/UserAdminController.php | 4 | Identity/Controller/ |
| Controller/UserController.php | 4 | Identity/Controller/ |
| Controller/ProfileController.php | 4 | Identity/Controller/ |
| Controller/ProfilePhotoController.php | 4 | Identity/Controller/ |
| Controller/SecurityController.php | 4 | Identity/Controller/ |
| Controller/PasswordResetController.php | 4 | Identity/Controller/ |
| Controller/AccessRuleController.php | 4 | Identity/Controller/ |
| Controller/SsoController.php | 4 | Identity/Controller/ |
| Form/Type/EditUserType.php | 4 | Identity/Form/ |
| Form/Type/NewUserType.php | 4 | Identity/Form/ |
| Form/Type/EditUserPasswordType.php | 4 | Identity/Form/ |
| Form/Type/NewPasswordType.php | 4 | Identity/Form/ |
| Form/Type/UserCompanyEmailType.php | 4 | Identity/Form/ |
| Form/Type/PasswordResetType.php | 4 | Identity/Form/ |

### Scheduling

| Existing Path | Cat | Target Path |
|---------------|-----|-------------|
| Entity/School.php | 1 | Scheduling/Infrastructure/Entity/ |
| Entity/SchoolCapacity.php | 1 | Scheduling/Infrastructure/Entity/ |
| Entity/Repository/SchoolRepository.php | 1 | Scheduling/Infrastructure/Repository/ |
| Entity/Repository/SchoolCapacityRepository.php | 1 | Scheduling/Infrastructure/Repository/ |
| AssistantScheduling/School.php | 1 | Scheduling/Domain/Rules/ (already pure) |
| AssistantScheduling/Assistant.php | 1 | Scheduling/Domain/Rules/ (already pure) |
| Service/SbsData.php | 1 | Scheduling/Infrastructure/ |
| Service/GeoLocation.php | 1 | Scheduling/Infrastructure/ |
| ApiResource/AdminSchedulingAssistantResource.php | 1 | Scheduling/Api/Resource/ |
| ApiResource/AdminSchedulingSchoolResource.php | 1 | Scheduling/Api/Resource/ |
| ApiResource/AdminSchoolWriteResource.php | 1 | Scheduling/Api/Resource/ |
| ApiResource/AdminSchoolDeleteResource.php | 1 | Scheduling/Api/Resource/ |
| State/AdminScheduling*.php (2 files) | 1 | Scheduling/Api/State/ |
| State/AdminSchool*.php (4 files) | 1 | Scheduling/Api/State/ |
| Controller/SchoolAdminController.php | 4 | Scheduling/Controller/ |
| Controller/SchoolCapacityController.php | 4 | Scheduling/Controller/ |
| Controller/AssistantSchedulingController.php | 4 | Scheduling/Controller/ |
| Form/Type/CreateSchoolType.php | 4 | Scheduling/Form/ |
| Form/Type/SchoolCapacityEditType.php | 4 | Scheduling/Form/ |

### Finance

| Existing Path | Cat | Target Path |
|---------------|-----|-------------|
| Entity/Receipt.php | 1 | Finance/Infrastructure/Entity/ |
| Entity/CertificateRequest.php | 1 | Finance/Infrastructure/Entity/ |
| Entity/AssistantHistory.php | 1 | Finance/Infrastructure/Entity/ |
| Entity/Signature.php | 1 | Finance/Infrastructure/Entity/ |
| Entity/Repository/ReceiptRepository.php | 1 | Finance/Infrastructure/Repository/ |
| Entity/Repository/CertificateRequestRepository.php | 1 | Finance/Infrastructure/Repository/ |
| Entity/Repository/AssistantHistoryRepository.php | 1 | Finance/Infrastructure/Repository/ |
| Entity/Repository/SignatureRepository.php | 1 | Finance/Infrastructure/Repository/ |
| Service/AssistantHistoryData.php | 1 | Finance/Infrastructure/ |
| Utils/ReceiptStatistics.php | 1 | Finance/Domain/Rules/ (fully pure) |
| Event/ReceiptEvent.php | 1 | Finance/Domain/Events/ |
| Event/AssistantHistoryCreatedEvent.php | 1 | Finance/Domain/Events/ |
| EventSubscriber/ReceiptSubscriber.php | 1 | Finance/Infrastructure/Subscriber/ |
| EventSubscriber/AssistantHistorySubscriber.php | 1 | Finance/Infrastructure/Subscriber/ |
| ApiResource/AdminReceiptDashboardResource.php | 1 | Finance/Api/Resource/ |
| ApiResource/AdminReceiptStatusInput.php | 1 | Finance/Api/Resource/ |
| ApiResource/AdminCertificateResource.php | 1 | Finance/Api/Resource/ |
| ApiResource/ReceiptWriteResource.php | 1 | Finance/Api/Resource/ |
| ApiResource/AdminAssistantHistory*.php (2 files) | 1 | Finance/Api/Resource/ |
| State/AdminReceipt*.php (2 files) | 1 | Finance/Api/State/ |
| State/AdminCertificate*.php | 1 | Finance/Api/State/ |
| State/AdminAssistantHistory*.php (4 files) | 1 | Finance/Api/State/ |
| State/ReceiptWriteProcessor.php | 1 | Finance/Api/State/ |
| Controller/ReceiptController.php | 4 | Finance/Controller/ |
| Controller/CertificateController.php | 4 | Finance/Controller/ |
| Controller/AssistantController.php | 4 | Finance/Controller/ |
| Controller/AssistantHistoryController.php | 4 | Finance/Controller/ |
| Controller/SignatureController.php | 4 | Finance/Controller/ |
| Controller/ParticipantHistoryController.php | 4 | Finance/Controller/ |
| Form/Type/ReceiptType.php | 4 | Finance/Form/ |
| Form/Type/CreateSignatureType.php | 4 | Finance/Form/ |

### Content

| Existing Path | Cat | Target Path |
|---------------|-----|-------------|
| Entity/Article.php | 1 | Content/Infrastructure/Entity/ |
| Entity/StaticContent.php | 1 | Content/Infrastructure/Entity/ |
| Entity/Sponsor.php | 1 | Content/Infrastructure/Entity/ |
| Entity/ChangeLogItem.php | 1 | Content/Infrastructure/Entity/ |
| Entity/SupportTicket.php | 1 | Content/Infrastructure/Entity/ |
| Entity/SocialEvent.php | 1 | Content/Infrastructure/Entity/ |
| Entity/InfoMeeting.php | 1 | Content/Infrastructure/Entity/ |
| Entity/Feedback.php | 1 | Content/Infrastructure/Entity/ |
| Entity/Repository/ArticleRepository.php | 1 | Content/Infrastructure/Repository/ |
| Entity/Repository/StaticContentRepository.php | 1 | Content/Infrastructure/Repository/ |
| Entity/Repository/ChangeLogItemRepository.php | 1 | Content/Infrastructure/Repository/ |
| Entity/Repository/SocialEventRepository.php | 1 | Content/Infrastructure/Repository/ |
| Entity/Repository/InfoMeetingRepository.php | 1 | Content/Infrastructure/Repository/ |
| Entity/Repository/FeedbackRepository.php | 1 | Content/Infrastructure/Repository/ |
| Service/ContentModeManager.php | 1 | Content/Infrastructure/ |
| Event/SupportTicketCreatedEvent.php | 1 | Content/Domain/Events/ |
| EventSubscriber/SupportTicketSubscriber.php | 1 | Content/Infrastructure/Subscriber/ |
| Validator/Constraints/InfoMeeting.php | 1 | Content/Infrastructure/Validator/ |
| Validator/Constraints/InfoMeetingValidator.php | 1 | Content/Infrastructure/Validator/ |
| ApiResource/AdminChangelog*.php (2 files) | 1 | Content/Api/Resource/ |
| ApiResource/AdminStaticContent*.php | 1 | Content/Api/Resource/ |
| ApiResource/AdminSocialEvent*.php (2 files) | 1 | Content/Api/Resource/ |
| ApiResource/PartnersResource.php | 1 | Content/Api/Resource/ |
| ApiResource/ContactMessageInput.php | 1 | Content/Api/Resource/ |
| State/AdminChangelog*.php (5 files) | 1 | Content/Api/State/ |
| State/AdminStaticContent*.php (2 files) | 1 | Content/Api/State/ |
| State/AdminSocialEvent*.php (6 files) | 1 | Content/Api/State/ |
| State/ArticleProcessor.php | 1 | Content/Api/State/ |
| State/ContactMessageProcessor.php | 1 | Content/Api/State/ |
| State/PartnersProvider.php | 1 | Content/Api/State/ |
| Controller/ArticleController.php | 4 | Content/Controller/ |
| Controller/ArticleAdminController.php | 4 | Content/Controller/ |
| Controller/StaticContentController.php | 4 | Content/Controller/ |
| Controller/ChangeLogController.php | 4 | Content/Controller/ |
| Controller/SponsorsController.php | 4 | Content/Controller/ |
| Controller/SocialEventController.php | 4 | Content/Controller/ |
| Controller/ContactController.php | 4 | Content/Controller/ |
| Controller/AboutVektorController.php | 4 | Content/Controller/ |
| Controller/HomeController.php | 4 | Content/Controller/ |
| Controller/ParentsController.php | 4 | Content/Controller/ |
| Controller/TeacherController.php | 4 | Content/Controller/ |
| Controller/StandController.php | 4 | Content/Controller/ |
| Controller/WidgetController.php | 4 | Content/Controller/ |
| Controller/FeedbackController.php | 4 | Content/Controller/ |
| Form/Type/ArticleType.php | 4 | Content/Form/ |
| Form/Type/SponsorType.php | 4 | Content/Form/ |
| Twig/Extension/SponsorsExtension.php | 4 | Content/Twig/ |
| Twig/Extension/StaticContentExtension.php | 4 | Content/Twig/ |

### Shared Kernel

| Existing Path | Target Path |
|---------------|-------------|
| Entity/Semester.php | Shared/Entity/Semester.php |
| Entity/Repository/SemesterRepository.php | Shared/Repository/SemesterRepository.php |
| Entity/DepartmentSemesterInterface.php | Shared/Contracts/DepartmentSemesterInterface.php |
| Entity/PeriodInterface.php | Shared/Contracts/PeriodInterface.php |
| Entity/TeamInterface.php | Shared/Contracts/TeamInterface.php |
| Entity/TeamMembershipInterface.php | Shared/Contracts/TeamMembershipInterface.php |
| Utils/SemesterUtil.php | Shared/SemesterUtil.php |

### Support (context-agnostic infrastructure)

| Existing Path | Target Path |
|---------------|-------------|
| Mailer/Mailer.php | Support/Infrastructure/Mailer/Mailer.php |
| Mailer/MailerInterface.php | Support/Infrastructure/Mailer/MailerInterface.php |
| Sms/*.php (5 files) | Support/Infrastructure/Sms/ |
| Google/*.php (6 files) | Support/Infrastructure/Google/ |
| Service/SlackMailer.php | Support/Infrastructure/Slack/ |
| Service/SlackMessenger.php | Support/Infrastructure/Slack/ |
| Service/FileUploader.php | Support/Infrastructure/ |
| Service/LogService.php | Support/Infrastructure/ |
| Service/BetaRedirecter.php | Support/Infrastructure/ |
| Service/FilterService.php | Support/ |
| Service/Sorter.php | Support/ |
| Utils/CsvUtil.php | Support/Utils/ |
| Utils/TimeUtil.php | Support/Utils/ |
| EventSubscriber/DbSubscriber.php | Support/EventSubscriber/ |
| EventSubscriber/ExceptionSubscriber.php | Support/EventSubscriber/ |
| EventSubscriber/GSuiteSubscriber.php | Support/EventSubscriber/ |
| Controller/BaseController.php | Support/Controller/ |
| Controller/FileBrowserController.php | Support/Controller/ |
| Controller/GitHubController.php | Support/Controller/ |
| Twig/Extension/AccessExtension.php | Support/Twig/ |
| Twig/Extension/AppRoutingExtension.php | Support/Twig/ |
| Twig/Extension/AssetExtension.php | Support/Twig/ |
| Twig/Extension/ContentModeExtension.php | Support/Twig/ |
| Twig/Extension/RoleExtension.php | Support/Twig/ |
| Twig/Extension/RouteDisplayExtension.php | Support/Twig/ |
| Twig/Extension/SafeHtmlExtension.php | Support/Twig/ |
| Twig/Extension/SemesterExtension.php | Support/Twig/ |
| Form/Extension/FieldTypeHelpExtension.php | Support/Form/ |
| Form/Type/CropImageType.php | Support/Form/ |
| DataFixtures/ | Support/DataFixtures/ (or split per context) |

## Domain Extractions

Pure logic to extract from services into Domain/Rules/:

### Admission

| Service | Pure Logic | Extract To |
|---------|-----------|------------|
| ApplicationManager | `getApplicationStatus()` — determines candidate position in workflow based on user state and interview status | Admission/Domain/Rules/ApplicationStatusRule.php |
| AdmissionStatistics | All methods — `generateGraphData*()`, `initializeDataArray()`, `populateApplicationData*()`, `calculatePaddingDays()` | Admission/Domain/Rules/AdmissionGraphData.php |
| ApplicationData | `getMalePercentage()`, `getFemalePercentage()`, `countPositions()` | Admission/Domain/Rules/ApplicationCounting.php |
| ApplicationAdmission | `userCanApplyInPeriod()`, `userHasAssistantHistory()` checks | Admission/Domain/Rules/ApplicationEligibility.php |
| AdmissionNotifier | `canReceiveNotification()` eligibility predicate (embedded in sendAdmissionNotifications) | Admission/Domain/Rules/SubscriberEligibility.php |

### Interview

| Service | Pure Logic | Extract To |
|---------|-----------|------------|
| InterviewManager | `loggedInUserCanSeeInterview()` authorization check, `getDefaultScheduleFormData()` projection | Interview/Domain/Rules/InterviewAccess.php |
| InterviewCounter | Entire service — `count()` aggregates by suitability, `groupInterviewsByInterviewer()` | Interview/Domain/Rules/InterviewCounter.php (already pure) |
| InterviewAnswerValidator | `validate()` — checks question type vs answer emptiness | Interview/Domain/Rules/InterviewAnswerValidation.php |

### Organization

| Service | Pure Logic | Extract To |
|---------|-----------|------------|
| TeamMembershipService | Membership expiration detection: `(endSemester, currentStartDate) → isExpired` | Organization/Domain/Rules/MembershipExpiration.php |
| UserGroupCollectionManager | User distribution algorithm: `(users[], groupCount) → groups[][]` | Organization/Domain/Rules/UserGroupDistribution.php |

### Survey

| Service | Pure Logic | Extract To |
|---------|-----------|------------|
| SurveyManager | `initializeSurveyTaken()`, `predictSurveyTakenAnswers()`, `surveyResultToJson()`, `getSurveyTargetAudienceString()`, percentage/grouping calculations | Survey/Domain/Rules/SurveyDataTransformer.php |

### Identity

| Service | Pure Logic | Extract To |
|---------|-----------|------------|
| RoleManager | `isValidRole()`, `canChangeToRole()`, `mapAliasToRole()`, `userIsGranted()` | Identity/Domain/Rules/RoleHierarchy.php |

### Finance

| Service | Pure Logic | Extract To |
|---------|-----------|------------|
| ReceiptStatistics | Entire service — `totalPayoutIn()`, `averageRefundTimeInHours()`, `totalAmount()` | Finance/Domain/Rules/ReceiptStatistics.php (already pure) |

### Scheduling

| Service | Pure Logic | Extract To |
|---------|-----------|------------|
| AssistantScheduling/School | `capacityLeftOnDay()`, `isFull()`, `getCapacity()` | Scheduling/Domain/Rules/School.php (already pure) |
| AssistantScheduling/Assistant | Getters, `assignToSchool()` state mutation | Scheduling/Domain/Rules/Assistant.php (already pure) |
| GeoLocation | `distance()` — pure math | Scheduling/Domain/Rules/GeoDistance.php |

## Cross-Context Entity Relations

| Source Entity | Field | Target Entity | Target Context | Relation |
|---------------|-------|---------------|----------------|----------|
| Application | user | User | Identity | ManyToOne (cascade persist) |
| Application | interview | Interview | Interview | OneToOne (cascade persist+remove) |
| Application | potentialTeams | Team | Organization | ManyToMany |
| AdmissionPeriod | department | Department | Organization | ManyToOne |
| AdmissionPeriod | semester | Semester | Shared | ManyToOne |
| AdmissionPeriod | infoMeeting | InfoMeeting | Content | OneToOne (cascade persist+remove) |
| AdmissionSubscriber | department | Department | Organization | ManyToOne |
| AdmissionNotification | semester | Semester | Shared | ManyToOne |
| AdmissionNotification | department | Department | Organization | ManyToOne |
| Interview | interviewer | User | Identity | ManyToOne |
| Interview | coInterviewer | User | Identity | ManyToOne |
| Interview | user (candidate) | User | Identity | ManyToOne |
| Interview | application | Application | Admission | OneToOne (inverse) |
| TeamMembership | user | User | Identity | ManyToOne |
| TeamMembership | startSemester | Semester | Shared | ManyToOne |
| TeamMembership | endSemester | Semester | Shared | ManyToOne |
| ExecutiveBoardMembership | user | User | Identity | ManyToOne |
| ExecutiveBoardMembership | startSemester | Semester | Shared | ManyToOne |
| TeamInterest | semester | Semester | Shared | ManyToOne |
| TeamApplication | (no user FK) | — | — | Stores raw applicant data |
| Survey | semester | Semester | Shared | ManyToOne |
| Survey | department | Department | Organization | ManyToOne (nullable) |
| SurveyTaken | user | User | Identity | ManyToOne |
| SurveyTaken | school | School | Scheduling | ManyToOne |
| SurveyNotification | user | User | Identity | ManyToOne |
| SurveyNotificationCollection | userGroups | UserGroup | Organization | ManyToMany |
| User | fieldOfStudy | FieldOfStudy | Organization | ManyToOne |
| School | departments | Department | Organization | ManyToMany |
| SchoolCapacity | semester | Semester | Shared | ManyToOne |
| SchoolCapacity | department | Department | Organization | ManyToOne |
| AssistantHistory | user | User | Identity | ManyToOne |
| AssistantHistory | semester | Semester | Shared | ManyToOne |
| AssistantHistory | department | Department | Organization | ManyToOne |
| AssistantHistory | school | School | Scheduling | ManyToOne |
| Receipt | user | User | Identity | ManyToOne |
| CertificateRequest | user | User | Identity | ManyToOne |
| Signature | user | User | Identity | OneToOne |
| Article | departments | Department | Organization | ManyToMany |
| Article | author | User | Identity | ManyToOne |
| SocialEvent | department | Department | Organization | ManyToOne |
| SocialEvent | semester | Semester | Shared | ManyToOne |
| Feedback | user | User | Identity | ManyToOne |

## Open Questions

### 1. Interview ownership: aggregate or independent context?

Interview has a OneToOne with Application (cascade persist+remove). Application
owns the FK. Deleting an Interview manually nulls `Application.interview`.

**Options:**
- Keep as independent context (current design) — Interview has its own lifecycle,
  ~77 files, complex enough to warrant separation.
- Make Interview a sub-context of Admission — simpler mental model but larger
  context.

**Recommendation:** Keep separate. Interview has its own schema management,
scheduling workflow, and scoring system. The OneToOne with Application is a
reference, not ownership.

### 2. Application.user cascade persist

`Application.user` has `cascade: ['persist']`, allowing new User creation from
application submission. This violates Identity context ownership.

**Recommendation:** Remove cascade persist. ApplicationProcessor already uses
`setCorrectUser()` to find/reuse existing users. The cascade is vestigial.

### 3. AdmissionPeriod.infoMeeting cascade

`AdmissionPeriod.infoMeeting` has `cascade: ['remove', 'persist']`, tying
InfoMeeting lifecycle to AdmissionPeriod. InfoMeeting is in Content context.

**Recommendation:** Accept this as infrastructure-level coupling. InfoMeeting is
effectively owned by AdmissionPeriod despite being in Content. Could move
InfoMeeting to Admission instead.

### 4. AssistantHistory: Finance or Scheduling?

AssistantHistory references both User (Finance concern — work records) and School
(Scheduling concern — assignment). Currently in Finance.

**Recommendation:** Keep in Finance. The primary purpose is tracking assistant work
history for administrative/financial purposes. The School reference is "where they
worked," not scheduling logic.

### 5. InterviewStatusType: constants or enum?

Currently an abstract class with int constants (0-4). PHP 8.1+ supports native
enums.

**Decision:** Convert to enum during restructure (natural cleanup opportunity).

### 6. SuitableAssistant field

`InterviewScore.suitableAssistant` is a string ('Ja'/'Kanskje'/'Nei') matching
constants in InterviewCounter. Should be an enum.

**Decision:** Convert to enum during restructure.

### 7. TeamMembershipSubscriber → RoleManager coupling

TeamMembershipSubscriber calls `RoleManager.updateUserRole()` on membership
events. This crosses Organization → Identity boundary.

**Recommendation:** Keep as-is (Infrastructure layer cross-context import is
allowed per our pragmatic coupling rule). The subscriber is already in
Infrastructure.

### 8. GSuiteSubscriber: multi-context coordinator

Subscribes to TeamMembershipEvent, UserEvent, TeamEvent. Coordinates Google
Workspace sync across Identity and Organization contexts.

**Recommendation:** Keep in Support as infrastructure adapter. It bridges contexts
but is purely an integration concern.

### 9. BaseController helper methods

`getDepartment()` → Organization, `getCurrentSemester()` → Shared. Used by all
legacy controllers.

**Recommendation:** Keep in Support/Controller/. These are convenience methods for
the legacy Twig layer. They'll be deleted with the controllers post-migration.

## Constraints

- Domain layer classes must have zero Symfony/Doctrine dependencies
- Doctrine entities remain as Infrastructure — no entity splitting
- Prefer explicit bounded context boundaries over a large Shared Kernel
- Infrastructure layers may import across contexts; Domain layers never
- This is an end-state specification — no implementation ordering prescribed
