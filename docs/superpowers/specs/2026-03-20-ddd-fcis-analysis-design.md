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
| **Admission** | Application lifecycle — submit, review, accept/reject | Application, AdmissionPeriod, AdmissionSubscriber, AdmissionNotification, InfoMeeting |
| **Interview** | Interview scheduling, conducting, scoring | Interview, InterviewSchema, InterviewQuestion, InterviewQuestionAlternative, InterviewAnswer, InterviewScore, InterviewDistribution |
| **Organization** | Departments, teams, boards, positions, user groups | Department, Team, TeamMembership, ExecutiveBoard, ExecutiveBoardMembership, Position, TeamApplication, TeamInterest, UserGroup, UserGroupCollection, FieldOfStudy |
| **Survey** | Questionnaire creation, distribution, response collection | Survey, SurveyQuestion, SurveyQuestionAlternative, SurveyAnswer, SurveyTaken, SurveyNotification, SurveyNotificationCollection, SurveyLinkClick |
| **Identity** | Users, authentication, roles, access control | User, Role, PasswordReset, AccessRule, UnhandledAccessRule |
| **Scheduling** | Assistant-to-school assignment | School, SchoolCapacity, AssistantScheduling/* |
| **Operations** | Receipts, certificates, assistant work history, signatures | Receipt, CertificateRequest, AssistantHistory, Signature |
| **Content** | Articles, static pages, sponsors, changelog, events, feedback | Article, StaticContent, Sponsor, ChangeLogItem, SupportTicket, SocialEvent, Feedback |

### Changes from initial design (validated by analysis)

- **Feedback** moved from Survey to Content — zero structural dependency on Survey.
- **UserGroup/UserGroupCollection** moved from Identity to Organization — they
  manage team/department/semester grouping, not identity concerns.
- **FieldOfStudy** moved from Shared to Organization — only referenced by
  Department and Application forms, not truly cross-context.
- **InfoMeeting** moved from Content to Admission — lifecycle tied to
  AdmissionPeriod via cascade persist+remove; no independent existence.
- **Finance renamed to Operations** — Receipt, CertificateRequest, AssistantHistory,
  and Signature are administrative record-keeping, not financial concerns.
- **Interview kept as independent context** — ~77 files, own schema/scheduling/
  scoring system. The OneToOne with Application is a reference, not ownership.

## Shared Kernel

| Class | Rationale |
|-------|-----------|
| `Semester` | Used by Admission, Organization, Scheduling, Operations, Survey, Interview |
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
    Api/                 # Cross-context aggregation endpoints
    Controller/          # BaseController, FileBrowserController, GitHubController
    EventSubscriber/     # DbSubscriber, ExceptionSubscriber, GSuiteSubscriber
    Twig/                # Cross-cutting Twig extensions (legacy)
    Form/                # Cross-cutting form types/extensions (legacy)
    Utils/               # CsvUtil, TimeUtil
    DataFixtures/        # Test data fixtures (31 files, cross-context deps)
```

## Migration Map

### Admission

| Existing Path | Cat | Target Path |
|---------------|-----|-------------|
| Entity/Application.php | 1 | Admission/Infrastructure/Entity/ |
| Entity/AdmissionPeriod.php | 1 | Admission/Infrastructure/Entity/ |
| Entity/AdmissionSubscriber.php | 1 | Admission/Infrastructure/Entity/ |
| Entity/AdmissionNotification.php | 1 | Admission/Infrastructure/Entity/ |
| Entity/InfoMeeting.php | 1 | Admission/Infrastructure/Entity/ |
| Entity/Repository/ApplicationRepository.php | 1 | Admission/Infrastructure/Repository/ |
| Entity/Repository/AdmissionPeriodRepository.php | 1 | Admission/Infrastructure/Repository/ |
| Entity/Repository/AdmissionSubscriberRepository.php | 1 | Admission/Infrastructure/Repository/ |
| Entity/Repository/AdmissionNotificationRepository.php | 1 | Admission/Infrastructure/Repository/ |
| Entity/Repository/InfoMeetingRepository.php | 1 | Admission/Infrastructure/Repository/ |
| Model/ApplicationStatus.php | 1 | Admission/Domain/ValueObjects/ |
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
| Validator/Constraints/InfoMeeting.php | 1 | Admission/Infrastructure/Validator/ |
| Validator/Constraints/InfoMeetingValidator.php | 1 | Admission/Infrastructure/Validator/ |
| Command/SendAdmissionNotificationsCommand.php | 1 | Admission/Infrastructure/Command/ |
| Command/SendInfoMeetingNotificationsCommand.php | 1 | Admission/Infrastructure/Command/ |
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
| ApiResource/AdminSubstituteResource.php | 1 | Admission/Api/Resource/ |
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
| State/AdminSubstituteListProvider.php | 1 | Admission/Api/State/ |
| State/AdminSubstituteEditProcessor.php | 1 | Admission/Api/State/ |
| State/AdminSubstituteEditProvider.php | 1 | Admission/Api/State/ |
| State/AdminSubstituteActivateProcessor.php | 1 | Admission/Api/State/ |
| State/AdminSubstituteActivateProvider.php | 1 | Admission/Api/State/ |
| State/AdminSubstituteDeactivateProcessor.php | 1 | Admission/Api/State/ |
| State/AdminSubstituteDeactivateProvider.php | 1 | Admission/Api/State/ |
| Controller/ExistingUserAdmissionController.php | 4 | Admission/Controller/ |
| Controller/ApplicationStatisticsController.php | 4 | Admission/Controller/ |
| Controller/AdmissionAdminController.php | 4 | Admission/Controller/ |
| Controller/AdmissionPeriodController.php | 4 | Admission/Controller/ |
| Controller/AdmissionSubscriberController.php | 4 | Admission/Controller/ |
| Controller/SubstituteController.php | 4 | Admission/Controller/ |
| Controller/ConfirmationController.php | 4 | Admission/Controller/ |
| Form/Type/AdmissionSubscriberType.php | 4 | Admission/Form/ |
| Form/Type/ApplicationPracticalType.php | 4 | Admission/Form/ |
| Form/Type/ApplicationType.php | 4 | Admission/Form/ |
| Form/Type/ApplicationExistingUserType.php | 4 | Admission/Form/ |
| Form/Type/CreateUserOnApplicationType.php | 4 | Admission/Form/ |
| Form/Type/CreateAdmissionPeriodType.php | 4 | Admission/Form/ |
| Form/Type/EditAdmissionPeriodType.php | 4 | Admission/Form/ |
| Form/Type/InfoMeetingType.php | 4 | Admission/Form/ |
| Form/Type/DaysType.php | 4 | Admission/Form/ |
| Form/Type/ModifySubstituteType.php | 4 | Admission/Form/ |
| Form/Type/UserDataForSubstituteType.php | 4 | Admission/Form/ |

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
| Type/InterviewStatusType.php | 1 | Interview/Domain/ValueObjects/ (convert to enum) |
| Validator/Constraints/InterviewAnswer.php | 1 | Interview/Infrastructure/Validator/ |
| Validator/Constraints/InterviewAnswerValidator.php | 1 | Interview/Infrastructure/Validator/ |
| Command/SendAcceptInterviewReminderCommand.php | 1 | Interview/Infrastructure/Command/ |
| Command/SendListOfScheduledInterviewsCommand.php | 1 | Interview/Infrastructure/Command/ |
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
| State/InterviewAcceptProcessor.php | 1 | Interview/Api/State/ |
| State/InterviewAssignProcessor.php | 1 | Interview/Api/State/ |
| State/InterviewBulkAssignProcessor.php | 1 | Interview/Api/State/ |
| State/InterviewCancelProcessor.php | 1 | Interview/Api/State/ |
| State/InterviewClearCoInterviewerProcessor.php | 1 | Interview/Api/State/ |
| State/InterviewClearCoInterviewerProvider.php | 1 | Interview/Api/State/ |
| State/InterviewCoInterviewerProcessor.php | 1 | Interview/Api/State/ |
| State/InterviewConductProcessor.php | 1 | Interview/Api/State/ |
| State/InterviewDeleteProcessor.php | 1 | Interview/Api/State/ |
| State/InterviewDeleteProvider.php | 1 | Interview/Api/State/ |
| State/InterviewNewTimeProcessor.php | 1 | Interview/Api/State/ |
| State/InterviewResponseProvider.php | 1 | Interview/Api/State/ |
| State/InterviewScheduleProcessor.php | 1 | Interview/Api/State/ |
| State/InterviewSchemaListProvider.php | 1 | Interview/Api/State/ |
| State/InterviewStatusProcessor.php | 1 | Interview/Api/State/ |
| State/AdminInterviewListProvider.php | 1 | Interview/Api/State/ |
| State/AdminInterviewSchemaCreateProcessor.php | 1 | Interview/Api/State/ |
| State/AdminInterviewSchemaDeleteProcessor.php | 1 | Interview/Api/State/ |
| State/AdminInterviewSchemaDeleteProvider.php | 1 | Interview/Api/State/ |
| State/AdminInterviewSchemaEditProcessor.php | 1 | Interview/Api/State/ |
| Controller/InterviewController.php | 4 | Interview/Controller/ |
| Controller/InterviewSchemaController.php | 4 | Interview/Controller/ |
| Form/Type/InterviewType.php | 4 | Interview/Form/ |
| Form/InterviewNewTimeType.php | 4 | Interview/Form/ |
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
| Command/UpdateTeamMembershipCommand.php | 1 | Organization/Infrastructure/Command/ |
| ApiResource/AdminTeamWriteResource.php | 1 | Organization/Api/Resource/ |
| ApiResource/AdminTeamDeleteResource.php | 1 | Organization/Api/Resource/ |
| ApiResource/AdminTeamMemberInput.php | 1 | Organization/Api/Resource/ |
| ApiResource/AdminTeamMembershipWriteResource.php | 1 | Organization/Api/Resource/ |
| ApiResource/AdminTeamMembershipDeleteResource.php | 1 | Organization/Api/Resource/ |
| ApiResource/AdminDepartmentWriteResource.php | 1 | Organization/Api/Resource/ |
| ApiResource/AdminDepartmentDeleteResource.php | 1 | Organization/Api/Resource/ |
| ApiResource/AdminExecutiveBoardWriteResource.php | 1 | Organization/Api/Resource/ |
| ApiResource/AdminExecutiveBoardMemberWriteResource.php | 1 | Organization/Api/Resource/ |
| ApiResource/AdminExecutiveBoardMemberDeleteResource.php | 1 | Organization/Api/Resource/ |
| ApiResource/AdminExecutiveBoardMemberInput.php | 1 | Organization/Api/Resource/ |
| ApiResource/AdminFieldOfStudyWriteResource.php | 1 | Organization/Api/Resource/ |
| ApiResource/TeamApplicationInput.php | 1 | Organization/Api/Resource/ |
| ApiResource/TeamInterestResource.php | 1 | Organization/Api/Resource/ |
| ApiResource/MailingListResource.php | 1 | Organization/Api/Resource/ |
| State/AdminTeamCreateProcessor.php | 1 | Organization/Api/State/ |
| State/AdminTeamDeleteProcessor.php | 1 | Organization/Api/State/ |
| State/AdminTeamDeleteProvider.php | 1 | Organization/Api/State/ |
| State/AdminTeamEditProcessor.php | 1 | Organization/Api/State/ |
| State/AdminTeamEditProvider.php | 1 | Organization/Api/State/ |
| State/AdminTeamMemberAddProcessor.php | 1 | Organization/Api/State/ |
| State/AdminTeamMembershipDeleteProcessor.php | 1 | Organization/Api/State/ |
| State/AdminTeamMembershipDeleteProvider.php | 1 | Organization/Api/State/ |
| State/AdminTeamMembershipEditProcessor.php | 1 | Organization/Api/State/ |
| State/AdminTeamMembershipEditProvider.php | 1 | Organization/Api/State/ |
| State/AdminDepartmentCreateProcessor.php | 1 | Organization/Api/State/ |
| State/AdminDepartmentDeleteProcessor.php | 1 | Organization/Api/State/ |
| State/AdminDepartmentDeleteProvider.php | 1 | Organization/Api/State/ |
| State/AdminDepartmentEditProcessor.php | 1 | Organization/Api/State/ |
| State/AdminDepartmentEditProvider.php | 1 | Organization/Api/State/ |
| State/AdminExecutiveBoardEditProcessor.php | 1 | Organization/Api/State/ |
| State/AdminExecutiveBoardEditProvider.php | 1 | Organization/Api/State/ |
| State/AdminExecutiveBoardMemberAddProcessor.php | 1 | Organization/Api/State/ |
| State/AdminExecutiveBoardMemberDeleteProcessor.php | 1 | Organization/Api/State/ |
| State/AdminExecutiveBoardMemberDeleteProvider.php | 1 | Organization/Api/State/ |
| State/AdminExecutiveBoardMemberEditProcessor.php | 1 | Organization/Api/State/ |
| State/AdminExecutiveBoardMemberEditProvider.php | 1 | Organization/Api/State/ |
| State/AdminFieldOfStudyCreateProcessor.php | 1 | Organization/Api/State/ |
| State/AdminFieldOfStudyEditProcessor.php | 1 | Organization/Api/State/ |
| State/AdminFieldOfStudyEditProvider.php | 1 | Organization/Api/State/ |
| State/TeamApplicationProcessor.php | 1 | Organization/Api/State/ |
| State/TeamInterestProvider.php | 1 | Organization/Api/State/ |
| State/MailingListProvider.php | 1 | Organization/Api/State/ |
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
| Controller/FieldOfStudyController.php | 4 | Organization/Controller/ |
| Form/Type/CreateTeamType.php | 4 | Organization/Form/ |
| Form/Type/CreateTeamMembershipType.php | 4 | Organization/Form/ |
| Form/Type/TeamApplicationType.php | 4 | Organization/Form/ |
| Form/Type/TeamInterestType.php | 4 | Organization/Form/ |
| Form/Type/CreatePositionType.php | 4 | Organization/Form/ |
| Form/Type/CreateDepartmentType.php | 4 | Organization/Form/ |
| Form/Type/CreateExecutiveBoardType.php | 4 | Organization/Form/ |
| Form/Type/CreateExecutiveBoardMembershipType.php | 4 | Organization/Form/ |
| Form/Type/FieldOfStudyType.php | 4 | Organization/Form/ |
| Form/Type/UserGroupCollectionType.php | 4 | Organization/Form/ |
| Form/Type/GenerateMailingListType.php | 4 | Organization/Form/ |
| Twig/Extension/DepartmentExtension.php | 4 | Organization/Twig/ |
| Twig/Extension/TeamPositionSortExtension.php | 4 | Organization/Twig/ |

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
| ApiResource/AdminSurveyWriteResource.php | 1 | Survey/Api/Resource/ |
| ApiResource/AdminSurveyDeleteResource.php | 1 | Survey/Api/Resource/ |
| ApiResource/AdminSurveyListResource.php | 1 | Survey/Api/Resource/ |
| ApiResource/AdminSurveyCopyResource.php | 1 | Survey/Api/Resource/ |
| ApiResource/AdminSurveyNotifierWriteResource.php | 1 | Survey/Api/Resource/ |
| ApiResource/AdminSurveyNotifierDeleteResource.php | 1 | Survey/Api/Resource/ |
| ApiResource/AdminSurveyNotifierSendResource.php | 1 | Survey/Api/Resource/ |
| ApiResource/SurveyRespondInput.php | 1 | Survey/Api/Resource/ |
| ApiResource/SurveyPopupResource.php | 1 | Survey/Api/Resource/ |
| ApiResource/SurveyResultResource.php | 1 | Survey/Api/Resource/ |
| ApiResource/PopupDismissInput.php | 1 | Survey/Api/Resource/ |
| ApiResource/PopupPreferenceInput.php | 1 | Survey/Api/Resource/ |
| State/AdminSurveyCreateProcessor.php | 1 | Survey/Api/State/ |
| State/AdminSurveyEditProcessor.php | 1 | Survey/Api/State/ |
| State/AdminSurveyDeleteProcessor.php | 1 | Survey/Api/State/ |
| State/AdminSurveyDeleteProvider.php | 1 | Survey/Api/State/ |
| State/AdminSurveyListProvider.php | 1 | Survey/Api/State/ |
| State/AdminSurveyCopyProcessor.php | 1 | Survey/Api/State/ |
| State/AdminSurveyCopyProvider.php | 1 | Survey/Api/State/ |
| State/AdminSurveyNotifierCreateProcessor.php | 1 | Survey/Api/State/ |
| State/AdminSurveyNotifierEditProcessor.php | 1 | Survey/Api/State/ |
| State/AdminSurveyNotifierDeleteProcessor.php | 1 | Survey/Api/State/ |
| State/AdminSurveyNotifierDeleteProvider.php | 1 | Survey/Api/State/ |
| State/AdminSurveyNotifierSendProcessor.php | 1 | Survey/Api/State/ |
| State/AdminSurveyNotifierSendProvider.php | 1 | Survey/Api/State/ |
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
| Form/Type/SurveyAnswerType.php | 4 | Survey/Form/ |
| Form/Type/SurveyExecuteType.php | 4 | Survey/Form/ |
| Form/Type/SurveyNotifierType.php | 4 | Survey/Form/ |
| Form/Type/SurveyQuestionAlternativeType.php | 4 | Survey/Form/ |
| Form/Type/SurveyQuestionType.php | 4 | Survey/Form/ |

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
| Command/UpdateUserRolesCommand.php | 1 | Identity/Infrastructure/Command/ |
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
| State/AdminUserCreateProcessor.php | 1 | Identity/Api/State/ |
| State/AdminUserDeleteProcessor.php | 1 | Identity/Api/State/ |
| State/AdminUserDeleteProvider.php | 1 | Identity/Api/State/ |
| State/AdminUserListProvider.php | 1 | Identity/Api/State/ |
| State/AdminUserActivationProcessor.php | 1 | Identity/Api/State/ |
| State/AdminUserActivationProvider.php | 1 | Identity/Api/State/ |
| State/ProfileProvider.php | 1 | Identity/Api/State/ |
| State/ProfileProcessor.php | 1 | Identity/Api/State/ |
| State/ProfilePhotoProcessor.php | 1 | Identity/Api/State/ |
| State/PasswordChangeProcessor.php | 1 | Identity/Api/State/ |
| State/PasswordResetRequestProcessor.php | 1 | Identity/Api/State/ |
| State/PasswordResetExecuteProcessor.php | 1 | Identity/Api/State/ |
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
| Form/Type/CreateUserType.php | 4 | Identity/Form/ |
| Form/Type/EditUserPasswordType.php | 4 | Identity/Form/ |
| Form/Type/NewPasswordType.php | 4 | Identity/Form/ |
| Form/Type/UserCompanyEmailType.php | 4 | Identity/Form/ |
| Form/Type/PasswordResetType.php | 4 | Identity/Form/ |
| Form/Type/AccessRuleType.php | 4 | Identity/Form/ |
| Form/Type/RoutingAccessRuleType.php | 4 | Identity/Form/ |

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
| Service/GeoLocation.php | 1 | Support/Infrastructure/ |
| ApiResource/AdminSchedulingAssistantResource.php | 1 | Scheduling/Api/Resource/ |
| ApiResource/AdminSchedulingSchoolResource.php | 1 | Scheduling/Api/Resource/ |
| ApiResource/AdminSchoolWriteResource.php | 1 | Scheduling/Api/Resource/ |
| ApiResource/AdminSchoolDeleteResource.php | 1 | Scheduling/Api/Resource/ |
| State/AdminSchedulingAssistantProvider.php | 1 | Scheduling/Api/State/ |
| State/AdminSchedulingSchoolProvider.php | 1 | Scheduling/Api/State/ |
| State/AdminSchoolCreateProcessor.php | 1 | Scheduling/Api/State/ |
| State/AdminSchoolDeleteProcessor.php | 1 | Scheduling/Api/State/ |
| State/AdminSchoolDeleteProvider.php | 1 | Scheduling/Api/State/ |
| State/AdminSchoolEditProcessor.php | 1 | Scheduling/Api/State/ |
| State/AdminSchoolEditProvider.php | 1 | Scheduling/Api/State/ |
| Controller/SchoolAdminController.php | 4 | Scheduling/Controller/ |
| Controller/SchoolCapacityController.php | 4 | Scheduling/Controller/ |
| Controller/AssistantSchedulingController.php | 4 | Scheduling/Controller/ |
| Form/Type/CreateSchoolType.php | 4 | Scheduling/Form/ |
| Form/Type/SchoolCapacityEditType.php | 4 | Scheduling/Form/ |
| Form/Type/SchoolCapacityType.php | 4 | Scheduling/Form/ |

### Operations

| Existing Path | Cat | Target Path |
|---------------|-----|-------------|
| Entity/Receipt.php | 1 | Operations/Infrastructure/Entity/ |
| Entity/CertificateRequest.php | 1 | Operations/Infrastructure/Entity/ |
| Entity/AssistantHistory.php | 1 | Operations/Infrastructure/Entity/ |
| Entity/Signature.php | 1 | Operations/Infrastructure/Entity/ |
| Entity/Repository/ReceiptRepository.php | 1 | Operations/Infrastructure/Repository/ |
| Entity/Repository/CertificateRequestRepository.php | 1 | Operations/Infrastructure/Repository/ |
| Entity/Repository/AssistantHistoryRepository.php | 1 | Operations/Infrastructure/Repository/ |
| Entity/Repository/SignatureRepository.php | 1 | Operations/Infrastructure/Repository/ |
| Service/AssistantHistoryData.php | 1 | Operations/Infrastructure/ |
| Utils/ReceiptStatistics.php | 1 | Operations/Domain/Rules/ (fully pure) |
| Event/ReceiptEvent.php | 1 | Operations/Domain/Events/ |
| Event/AssistantHistoryCreatedEvent.php | 1 | Operations/Domain/Events/ |
| EventSubscriber/ReceiptSubscriber.php | 1 | Operations/Infrastructure/Subscriber/ |
| EventSubscriber/AssistantHistorySubscriber.php | 1 | Operations/Infrastructure/Subscriber/ |
| ApiResource/AdminReceiptDashboardResource.php | 1 | Operations/Api/Resource/ |
| ApiResource/AdminReceiptStatusInput.php | 1 | Operations/Api/Resource/ |
| ApiResource/AdminCertificateResource.php | 1 | Operations/Api/Resource/ |
| ApiResource/ReceiptWriteResource.php | 1 | Operations/Api/Resource/ |
| ApiResource/AdminAssistantHistoryWriteResource.php | 1 | Operations/Api/Resource/ |
| ApiResource/AdminAssistantHistoryDeleteResource.php | 1 | Operations/Api/Resource/ |
| State/AdminReceiptDashboardProvider.php | 1 | Operations/Api/State/ |
| State/AdminReceiptStatusProcessor.php | 1 | Operations/Api/State/ |
| State/AdminCertificateProvider.php | 1 | Operations/Api/State/ |
| State/ReceiptCreateProcessor.php | 1 | Operations/Api/State/ |
| State/ReceiptDeleteProcessor.php | 1 | Operations/Api/State/ |
| State/ReceiptEditProcessor.php | 1 | Operations/Api/State/ |
| State/ReceiptWriteProvider.php | 1 | Operations/Api/State/ |
| State/AdminAssistantHistoryCreateProcessor.php | 1 | Operations/Api/State/ |
| State/AdminAssistantHistoryCreateProvider.php | 1 | Operations/Api/State/ |
| State/AdminAssistantHistoryDeleteProcessor.php | 1 | Operations/Api/State/ |
| State/AdminAssistantHistoryDeleteProvider.php | 1 | Operations/Api/State/ |
| Controller/ReceiptController.php | 4 | Operations/Controller/ |
| Controller/CertificateController.php | 4 | Operations/Controller/ |
| Controller/AssistantController.php | 4 | Operations/Controller/ |
| Controller/AssistantHistoryController.php | 4 | Operations/Controller/ |
| Controller/SignatureController.php | 4 | Operations/Controller/ |
| Controller/ParticipantHistoryController.php | 4 | Operations/Controller/ |
| Form/Type/ReceiptType.php | 4 | Operations/Form/ |
| Form/Type/CreateSignatureType.php | 4 | Operations/Form/ |
| Form/Type/CreateAssistantHistoryType.php | 4 | Operations/Form/ |
| Form/Type/AccountNumberType.php | 4 | Operations/Form/ |

### Content

| Existing Path | Cat | Target Path |
|---------------|-----|-------------|
| Entity/Article.php | 1 | Content/Infrastructure/Entity/ |
| Entity/StaticContent.php | 1 | Content/Infrastructure/Entity/ |
| Entity/Sponsor.php | 1 | Content/Infrastructure/Entity/ |
| Entity/ChangeLogItem.php | 1 | Content/Infrastructure/Entity/ |
| Entity/SupportTicket.php | 1 | Content/Infrastructure/Entity/ |
| Entity/SocialEvent.php | 1 | Content/Infrastructure/Entity/ |
| Entity/Feedback.php | 1 | Content/Infrastructure/Entity/ |
| Entity/Repository/ArticleRepository.php | 1 | Content/Infrastructure/Repository/ |
| Entity/Repository/StaticContentRepository.php | 1 | Content/Infrastructure/Repository/ |
| Entity/Repository/ChangeLogItemRepository.php | 1 | Content/Infrastructure/Repository/ |
| Entity/Repository/SocialEventRepository.php | 1 | Content/Infrastructure/Repository/ |
| Entity/Repository/FeedbackRepository.php | 1 | Content/Infrastructure/Repository/ |
| Service/ContentModeManager.php | 1 | Content/Infrastructure/ |
| Event/SupportTicketCreatedEvent.php | 1 | Content/Domain/Events/ |
| EventSubscriber/SupportTicketSubscriber.php | 1 | Content/Infrastructure/Subscriber/ |
| ApiResource/AdminChangelogWriteResource.php | 1 | Content/Api/Resource/ |
| ApiResource/AdminChangelogDeleteResource.php | 1 | Content/Api/Resource/ |
| ApiResource/AdminStaticContentWriteResource.php | 1 | Content/Api/Resource/ |
| ApiResource/AdminSocialEventWriteResource.php | 1 | Content/Api/Resource/ |
| ApiResource/AdminSocialEventDeleteResource.php | 1 | Content/Api/Resource/ |
| ApiResource/PartnersResource.php | 1 | Content/Api/Resource/ |
| ApiResource/ContactMessageInput.php | 1 | Content/Api/Resource/ |
| State/AdminChangelogCreateProcessor.php | 1 | Content/Api/State/ |
| State/AdminChangelogEditProcessor.php | 1 | Content/Api/State/ |
| State/AdminChangelogEditProvider.php | 1 | Content/Api/State/ |
| State/AdminChangelogDeleteProcessor.php | 1 | Content/Api/State/ |
| State/AdminChangelogDeleteProvider.php | 1 | Content/Api/State/ |
| State/AdminStaticContentEditProcessor.php | 1 | Content/Api/State/ |
| State/AdminStaticContentEditProvider.php | 1 | Content/Api/State/ |
| State/AdminSocialEventCreateProcessor.php | 1 | Content/Api/State/ |
| State/AdminSocialEventEditProcessor.php | 1 | Content/Api/State/ |
| State/AdminSocialEventEditProvider.php | 1 | Content/Api/State/ |
| State/AdminSocialEventDeleteProcessor.php | 1 | Content/Api/State/ |
| State/AdminSocialEventDeleteProvider.php | 1 | Content/Api/State/ |
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
| Form/Type/ChangeLogType.php | 4 | Content/Form/ |
| Form/Type/SocialEventType.php | 4 | Content/Form/ |
| Form/Type/SupportTicketType.php | 4 | Content/Form/ |
| Form/Type/FeedbackType.php | 4 | Content/Form/ |
| Twig/Extension/SponsorsExtension.php | 4 | Content/Twig/ |
| Twig/Extension/StaticContentExtension.php | 4 | Content/Twig/ |

### Shared Kernel

| Existing Path | Target Path |
|---------------|-------------|
| Entity/Semester.php | Shared/Entity/ |
| Entity/Repository/SemesterRepository.php | Shared/Repository/ |
| Entity/DepartmentSemesterInterface.php | Shared/Contracts/ |
| Entity/PeriodInterface.php | Shared/Contracts/ |
| Entity/TeamInterface.php | Shared/Contracts/ |
| Entity/TeamMembershipInterface.php | Shared/Contracts/ |
| Utils/SemesterUtil.php | Shared/ |
| ApiResource/AdminSemesterWriteResource.php | Shared/Api/Resource/ |
| ApiResource/AdminSemesterDeleteResource.php | Shared/Api/Resource/ |
| State/AdminSemesterCreateProcessor.php | Shared/Api/State/ |
| State/AdminSemesterDeleteProcessor.php | Shared/Api/State/ |
| State/AdminSemesterDeleteProvider.php | Shared/Api/State/ |
| Controller/SemesterController.php | Shared/Controller/ |
| Form/Type/CreateSemesterType.php | Shared/Form/ |

### Support (context-agnostic infrastructure)

| Existing Path | Target Path |
|---------------|-------------|
| Mailer/Mailer.php | Support/Infrastructure/Mailer/ |
| Mailer/MailerInterface.php | Support/Infrastructure/Mailer/ |
| Sms/Sms.php | Support/Infrastructure/Sms/ |
| Sms/SmsSender.php | Support/Infrastructure/Sms/ |
| Sms/SmsSenderInterface.php | Support/Infrastructure/Sms/ |
| Sms/GatewayAPI.php | Support/Infrastructure/Sms/ |
| Sms/SlackSms.php | Support/Infrastructure/Sms/ |
| Google/GoogleAPI.php | Support/Infrastructure/Google/ |
| Google/GoogleService.php | Support/Infrastructure/Google/ |
| Google/Gmail.php | Support/Infrastructure/Google/ |
| Google/GoogleDrive.php | Support/Infrastructure/Google/ |
| Google/GoogleGroups.php | Support/Infrastructure/Google/ |
| Google/GoogleUsers.php | Support/Infrastructure/Google/ |
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
| ApiResource/DashboardResource.php | Support/Api/Resource/ |
| ApiResource/Statistics.php | Support/Api/Resource/ |
| State/DashboardProvider.php | Support/Api/State/ |
| State/StatisticsProvider.php | Support/Api/State/ |
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
| Form/Type/TelType.php | Support/Form/ |
| DataFixtures/ORM/ (31 files) | Support/DataFixtures/ |

## Domain Extractions

Pure logic to extract from services into Domain/Rules/:

### Admission

| Service | Pure Logic | Extract To | Status |
|---------|-----------|------------|--------|
| ApplicationManager | `getApplicationStatus()` — determines candidate position in workflow | Admission/Domain/Rules/ApplicationStatusRule.php | Done |
| AdmissionStatistics | All methods — graph data generation, date bucketing, cumulative aggregation | Admission/Domain/Rules/AdmissionStatistics.php | Done |
| ApplicationData | `getMalePercentage()`, `getFemalePercentage()`, `countPositions()` | Admission/Domain/Rules/ApplicationCounting.php | Skipped — percentages are impure (call repositories); countPositions is trivial with cross-context dep |
| ApplicationAdmission | `userCanApplyInPeriod()`, `userHasAssistantHistory()` checks | Admission/Domain/Rules/ApplicationEligibility.php | N/A — methods do not exist in source |
| AdmissionNotifier | `canReceiveNotification()` eligibility predicate | Admission/Domain/Rules/SubscriberEligibility.php | N/A — method does not exist in source |

### Interview

| Service | Pure Logic | Extract To | Status |
|---------|-----------|------------|--------|
| InterviewManager | `loggedInUserCanSeeInterview()`, `getDefaultScheduleFormData()` | Interview/Domain/Rules/InterviewAccess.php | Skipped — fully impure (TokenStorage, AuthorizationChecker, EM queries) |
| InterviewCounter | `count()` — suitability rating aggregation | Interview/Domain/Rules/InterviewCounter.php | Done |
| InterviewAnswerValidator | `validate()` — question type vs answer emptiness | Interview/Domain/Rules/InterviewAnswerValidation.php | Skipped — extends Symfony ConstraintValidator, not extractable |

### Organization

| Service | Pure Logic | Extract To | Status |
|---------|-----------|------------|--------|
| TeamMembershipService | Expiration detection: `(endSemester, currentStartDate) → isExpired` | Organization/Domain/Rules/MembershipExpiration.php | Done |
| UserGroupCollectionManager | Distribution algorithm: `(users[], groupCount) → groups[][]` | Organization/Domain/Rules/UserGroupDistribution.php | Done |

### Survey

| Service | Pure Logic | Extract To | Status |
|---------|-----------|------------|--------|
| SurveyManager | `getSurveyTargetAudienceString()`, `getTextAnswerWithSchoolResults()`, `formatTeamNames()` | Survey/Domain/Rules/SurveyDataTransformer.php | Done |
| SurveyManager | `predictSurveyTakenAnswers()`, `surveyResultToJson()` | — | Skipped — impure (use `$this->em->getRepository()`) |
| SurveyManager | `initializeSurveyTaken()` | — | Skipped — constructs Infrastructure entities (factory concern, not domain rule) |

### Identity

| Service | Pure Logic | Extract To | Status |
|---------|-----------|------------|--------|
| RoleManager | `isValidRole()`, `canChangeToRole()`, `mapAliasToRole()`, `userIsGranted()` | Identity/Domain/Rules/RoleHierarchy.php | Done |

### Operations

| Service | Pure Logic | Extract To | Status |
|---------|-----------|------------|--------|
| ReceiptStatistics | Entire service — `totalPayoutIn()`, `averageRefundTimeInHours()`, `totalAmount()` | Operations/Domain/Rules/ReceiptStatistics.php | Done (pre-existing) |

### Scheduling

| Service | Pure Logic | Extract To | Status |
|---------|-----------|------------|--------|
| AssistantScheduling/School | `capacityLeftOnDay()`, `isFull()`, `getCapacity()` | Scheduling/Domain/Rules/School.php | Done (pre-existing) |
| AssistantScheduling/Assistant | Getters, `assignToSchool()` | Scheduling/Domain/Rules/Assistant.php | Done (pre-existing) |
| GeoLocation | `distance()` — pure math | Support/Utils/GeoDistance.php | Deferred — not a bounded context extraction |

## Cross-Context Entity Relations

| Source Entity | Field | Target Entity | Target Context | Relation |
|---------------|-------|---------------|----------------|----------|
| Application | user | User | Identity | ManyToOne (remove cascade persist) |
| Application | interview | Interview | Interview | OneToOne (cascade persist+remove) |
| Application | potentialTeams | Team | Organization | ManyToMany |
| AdmissionPeriod | department | Department | Organization | ManyToOne |
| AdmissionPeriod | semester | Semester | Shared | ManyToOne |
| AdmissionPeriod | infoMeeting | InfoMeeting | Admission (same) | OneToOne (cascade) |
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

## Resolved Decisions

| # | Question | Decision |
|---|----------|----------|
| 1 | Interview: independent context or sub-context of Admission? | **Independent.** Own schema management, scheduling, scoring (~77 files). |
| 2 | Application.user cascade persist | **Remove.** Violates Identity ownership. ApplicationProcessor uses setCorrectUser(). |
| 3 | AdmissionPeriod.infoMeeting cascade | **Move InfoMeeting to Admission.** Lifecycle tied to AdmissionPeriod. |
| 4 | AssistantHistory context | **Operations.** Context renamed from Finance — administrative record-keeping. |
| 5 | InterviewStatusType: constants or enum? | **Convert to PHP enum** during restructure. |
| 6 | InterviewScore.suitableAssistant | **Convert to backed string enum** during restructure. |
| 7 | TeamMembershipSubscriber → RoleManager coupling | **Keep as-is.** Infrastructure cross-context import is allowed. |
| 8 | GSuiteSubscriber placement | **Keep in Support.** Infrastructure adapter bridging contexts. |
| 9 | BaseController helper methods | **Keep in Support.** Legacy convenience, deleted post-migration. |
| 10 | DashboardResource/Statistics (cross-context aggregation) | **Support/Api/.** Infrastructure-level read aggregations. |
| 11 | DataFixtures | **Support/DataFixtures/.** Cross-context dependencies, test infrastructure. |

## Constraints

- Domain layer classes must have zero Symfony/Doctrine dependencies
- Doctrine entities remain as Infrastructure — no entity splitting
- Prefer explicit bounded context boundaries over a large Shared Kernel
- Infrastructure layers may import across contexts; Domain layers never
- This is an end-state specification — no implementation ordering prescribed
