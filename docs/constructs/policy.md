# policy

[//]: # "constructs: generated from the @construct tags and their JSDoc by just constructs write; do not edit"

Pure domain eligibility decisions over decoded facts and an explicit instant. The [index](../constructs.md) lists every category.

## `admissionStanding`

Admission standing of the application's own period and semester at one instant.

```ts
admissionStanding(evidence: ApplicationAdmissionEvidence, at: Instant): AdmissionOutcome | null
```

- Inputs:
  - `evidence: ApplicationAdmissionEvidence`
  - `at: Instant`
- Output: `AdmissionOutcome | null`
- Errors: none
- Requirements: none
- Side effects: None: consumes decoded evidence and does not read the clock or storage.
- Source: [packages/domain/src/admissions/standing.ts:24](../../packages/domain/src/admissions/standing.ts#L24)

**How it works**

Both windows are half-open. Closed decisions use frozen evidence, including preserved
historical outcomes whose assessment provenance is unavailable. Before closure a new
applicant needs completed, uncancelled conduct: Ja/Nei take precedence and Kanskje needs
an explicit decision. Returning registration still needs its explicit decision. Neither
an account link nor an announcement is a prerequisite for standing.

**Use**

```ts
const admitted = admissionStanding(evidence, at) === "Admitted";
```

**Avoid**

Using a department's other period, cached preflight time, or live assessments after closure.
