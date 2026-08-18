# Holter Platform Engineering Path

This roadmap is the working order for the product. It intentionally separates the parts that can be stabilized now from the hardware-dependent acquisition work.

## Phase 0 — Requirements and clinical baseline

- Maintain the client technical specification as the baseline requirement set.
- Maintain the current product definition: dynamic 1–12 leads, On-Spot and Retrospective modes, shared clinical taxonomy and patient observation history.
- Maintain the clinical/dataset traceability matrix.
- Keep Phase 2+ additions (SQI, personalization, HRT/TWA/DC/fQRS, auto narrative, etc.) as controlled requirements until clinical/regulatory justification and verification criteria are approved.

## Phase 1 — Current target

**Goal:** stable application shell and clinical-workflow foundation, excluding physical device acquisition.

1. React frontend communicates only through the FastAPI contract.
2. FastAPI owns API validation, HTTP errors and domain routing.
3. PostgreSQL stores patient, recording metadata, annotations and report state.
4. ECG/HDF5 and generated files stay outside PostgreSQL behind an object-storage abstraction.
5. Filesystem storage is the current single-machine implementation.
6. MinIO can be introduced later without changing the database schema or UI contract.
7. Existing ECG files can be registered explicitly for development/testing.
8. ECG windows are read by recording ID and lead metadata; no 3/12-lead hardcoding exists in the API contract.
9. Automated backend tests and CI are mandatory before merging feature branches.
10. Authentication/RBAC is a planned subsequent phase, not mixed into this structural refactor.

## Phase 1.5 — Authentication and authorization

- Users, roles and permissions.
- Password hashing and session/token strategy.
- Role-based route authorization.
- Audit trail for security-sensitive and clinical actions.
- Electron login/session lifecycle.
- Least-privilege access to patient records and reports.

## Phase 2 — Analysis foundation

- Finalize hardware/data contract first.
- Normalize sampling/lead metadata.
- Preprocessing and cached filtered signal.
- R-peak and SQI pipeline.
- Beat model.
- Rhythm/arrhythmia models.
- ST, QT/QTc and HRV modules.
- Observation engine.
- Physician verification workflow.
- Report generation.

## Phase 2+ — Controlled clinical enhancements

- Personalised morphology baseline.
- Multi-model agreement where clinically justified.
- DC, HRT, TWA and fQRS.
- Adaptive thresholds.
- Assisted narrative generation.
- All additions require their own requirements, risk controls, verification datasets and clinical evidence.

## Hardware/acquisition track — intentionally paused

Do not freeze this interface until the firmware team confirms:

- sampling rate
- ADC resolution / bit depth
- gain and physical units
- lead count and lead names/order
- timestamps and clock behavior
- packet/frame format
- transport(s): USB, SD, Wi-Fi, Bluetooth
- loss/retry semantics
- device identifiers
- recorder file format
- maximum recording size and duration

The acquisition adapter will implement this contract later without changing the domain model.

## Production delivery

Target deployment is cloudless/on-premise:

```text
Windows Electron application
        |
        +-- bundled FastAPI/Python service
        |
        +-- PostgreSQL service (local PC or hospital server)
        |
        +-- local filesystem/object store for ECG and reports
        |
        +-- optional MinIO for multi-user/server deployments
```

The `.exe` is the user-facing shell; PostgreSQL is still a separate data service. It may be installed locally as a Windows service by the product installer or hosted on a hospital server. The application does not become a single self-contained `.exe` database just because Electron packages the UI.

## Release gate

A release candidate must pass:

- lint/type/static checks
- unit tests
- API integration tests
- database migration tests
- frontend tests
- end-to-end workflow tests
- ECG data integrity tests
- performance/load tests
- security tests
- ML verification and regression tests once ML is integrated
- clinical verification/validation evidence as required by the regulatory plan
- backup/restore test
- clean-install test on a fresh Windows machine
