# Placements documentation CI

## Scope

The credential-free Placements job runs on every main push and pull request.
It preserves the existing golden job and uses the frozen workspace dependencies.
The application compiler checks the public-import examples before their execution.
TypeDoc uses its isolated documentation compiler and the existing export-derived entry points.
No website, module expansion, provider access, or private evidence enters this work.

## Artifact contract

The CI command requires an exact expected Git revision and a clean checkout.
It runs the existing package checks and generates the reference once.
It checks local source links through TypeDoc and the generated source references.
Only complete output receives a source receipt with the revision and SHA-256 file inventory.
The command checks source cleanliness and revision again before it completes.

A separate retained-artifact command requires the expected revision and a clean matching checkout.
It checks the receipt, exact output inventory, and file hashes without a second generation.
Missing, incomplete, modified, or wrong-revision artifacts fail.
A changed guide, public example, or public source revision rejects the retained artifact.
The local `docs:check` command still compares retained output against current generated output.
This local check does not represent hosted CI or artifact-service acceptance.

## Failure and cleanup

Generation never replaces an existing output directory.
Failure or requested interruption removes only output owned by the command.
The workflow uploads only successful public documentation and its source receipt.
Missing upload output fails the job. Workflow cleanup runs after success or failure.
SIGKILL cannot run process cleanup; runner disposal remains the final boundary.

## Proof

Run the complete CI command and retained-artifact acceptance on committed source.
Use disposable source copies for broken public examples, broken links, and changed-source retained artifacts.
Prove nonzero exits and absence of complete output after failures and interruption.
Keep only regression checks that defend plausible artifact-consumer failures.
No local result claims hosted execution, artifact-service acceptance, or branch-protection configuration.

## Ownership

This branch owns `.github/workflows/ci.yml`, `tools/system-guide/placements.ts`, and narrow Placements documentation helpers and tests.
It also owns Placements documentation scripts and the corresponding package guide sections.
No dependency or lockfile change is planned.
The parent owns shared status, changelog, roadmaps, architecture, and the root README.
