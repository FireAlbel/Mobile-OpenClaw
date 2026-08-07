# Mobile RPA Architecture Tasks

## Goal

Build the current mobile control feature set into an AI-assisted, multi-device mobile RPA orchestration platform.

The target is not a fully general "AI controls any app perfectly" system. The target is a modular execution system where LLM/VLM handles task understanding, planning, visual recognition, and correction, while deterministic RPA modules handle execution, verification, retry, pause, resume, and human handoff.

## Architecture

### 1. Device Runtime Layer

Meaning:

This layer is the lowest-level execution layer. It owns device access and atomic actions. It must not understand business tasks such as "open Meituan video" or "complete a coin task".

Functions:

- Manage connected Android devices by `deviceId`.
- Execute atomic actions: tap, swipe, drag, long press, double tap, key event, text input, app launch, app stop, app restart, screenshot, foreground app query, screen size query.
- Route actions to the correct physical device.
- Keep per-device action mutexes so commands for one device do not interfere with another device.
- Use an independent scrcpy raw video frame stream per device for RPA/VLM visual input.
- Normalize coordinate systems between screenshots, scrcpy windows, and physical screen size.

Primary inputs:

- `deviceId`
- Action type
- Absolute or percentage coordinates
- Optional duration, text, key code, package name, activity name

Primary outputs:

- Action result: success, failure, timeout, device offline, unauthorized, unsupported
- Optional screenshot path
- Optional foreground app/package
- Optional screen metadata

How to use:

- Called only by upper layers through a typed runtime API.
- Example: `runtime.tap({ deviceId, x, y })`
- Example: `runtime.screenshot({ deviceId, source: "scrcpy_stream", requireFreshFrame: true })`

Exception handling:

- Timeout: cancel the command if possible, mark the step as timed out, and return a structured error.
- Retry: retry only idempotent or safe actions such as screenshot, foreground query, and screen size query by default.
- Device offline: stop the current device queue and raise a device-level recoverable error.
- Unauthorized: pause all tasks for the device and ask the user to authorize USB debugging.
- Coordinate mismatch: re-query screen size, capture a fresh screenshot, and ask the VLM correction layer to remap the target if needed.
- Manual intervention: expose a "pause and take over" state to the Orchestrator layer.

### 2. Observation Layer

Meaning:

This layer converts raw device state into structured observations that planning, verification, and modules can consume.

Functions:

- Capture the current screen image from the device's scrcpy raw video frame stream.
- Collect foreground app/package/activity.
- Collect screen size and density.
- Collect optional UIAutomator XML tree when available.
- Run OCR on screenshot when enabled.
- Run VLM scene analysis when deterministic observation is insufficient.
- Store observation snapshots for debugging and replay.

Primary inputs:

- `deviceId`
- Observation request type: screenshot, UI tree, OCR, VLM summary, foreground app, full observation
- Optional target hints such as "find video tab" or "find coin icon"

Primary outputs:

- `DeviceObservation`
- Screenshot file path
- Normalized screen size
- UI text list
- OCR result list
- VLM object candidates
- Foreground app metadata
- Confidence scores

How to use:

- Modules request observations before execution and during verification.
- Planner uses observation summaries to decide the next step.
- Verification layer uses observations to decide whether a step succeeded.

Exception handling:

- Screenshot timeout: retry the scrcpy frame stream once, then mark visual observation unavailable and pause visual steps.
- UIAutomator blocked or unavailable: continue with screenshot, OCR, and VLM.
- OCR/VLM failure: return partial observation with explicit missing fields.
- Stale observation: mark observations with timestamps and require refresh before high-risk actions.
- Low confidence: ask LLM/VLM correction or pause for human confirmation depending on policy.

### 3. Action Module Layer

Meaning:

This is the core RPA module layer. Each module is a reusable semantic action. Modules should represent meaningful automation abilities rather than only low-level taps and swipes.

Functions:

- Define reusable modules such as launch app, wait for page, tap by text, tap by visual target, swipe until target appears, handle popup, input text, open task center, complete first task, claim reward.
- Validate module input schema before execution.
- Declare preconditions and postconditions.
- Execute using Device Runtime and Observation layers.
- Verify step result after execution.
- Provide recover logic for common failures.

Primary inputs:

- Module ID
- `deviceId`
- Module-specific params
- Current task context
- Latest observation

Primary outputs:

- `ActionModuleResult`
- Execution status: success, failed, retryable, needsHuman, skipped
- Verification details
- Updated task context
- Artifacts: screenshots, OCR output, VLM decision JSON, logs

How to use:

- The Orchestrator calls modules by ID.
- Planner only emits registered module IDs and validated params.
- Modules never call arbitrary unregistered logic.

Exception handling:

- Timeout: module returns timeout status with last observation and suggested next action.
- Retry: module defines safe retry count and backoff.
- VLM correction: if a visual target is ambiguous, ask VLM for candidate targets and confidence.
- LLM correction: if the module's precondition is not met, ask LLM whether to insert recovery steps such as back, close popup, or navigate home.
- Human intervention: if confidence remains below threshold after retries, pause the task and request user confirmation.

### 4. Task DSL Layer

Meaning:

This layer defines the declarative task format. It is the contract between Planner, Orchestrator, UI, storage, and execution modules.

Functions:

- Define task schema with metadata, devices, steps, variables, policies, retry rules, timeout rules, and verification rules.
- Support step dependencies and conditional branches.
- Support loops with bounded max iterations.
- Support per-device and batch execution modes.
- Support pause, resume, cancel, and replay.
- Support dry-run validation without touching devices.

Primary inputs:

- User task description
- Generated or manually edited DSL JSON
- Selected devices
- Runtime policies

Primary outputs:

- Validated `RpaTaskDefinition`
- Step graph
- Execution plan
- Schema validation errors

How to use:

- UI creates or imports DSL tasks.
- Planner generates DSL from natural language.
- Orchestrator executes validated DSL only.

Exception handling:

- Invalid JSON: reject before execution and show schema errors.
- Unknown module: reject or ask Planner to re-plan using available module registry.
- Unsafe action: require explicit confirmation.
- Unbounded loop: reject unless max iteration or max duration is defined.
- Missing device: keep task pending and ask the user to select devices.

### 5. Planner Layer

Meaning:

This layer uses LLM/VLM to turn user goals and current observations into executable DSL. It should plan and correct, but not directly operate devices.

Functions:

- Convert natural language tasks into module-based DSL.
- Select modules from registry based on descriptions and input schema.
- Insert verification steps.
- Insert popup handling and retry policies.
- Repair failed plans using execution history and observations.
- Explain the generated plan to the user before high-risk execution.

Primary inputs:

- User instruction
- Available module registry
- Current device observations
- Existing task templates
- Execution history
- Safety policy

Primary outputs:

- DSL task draft
- Plan explanation
- Missing requirement questions
- Re-plan proposal after failure
- Confidence score

How to use:

- User enters an instruction in the chat or task builder.
- Planner returns DSL and explanation.
- User or policy approves execution.

Exception handling:

- Ambiguous instruction: ask the user a concise clarification or generate a conservative draft with pending fields.
- Unsupported module: ask LLM to choose a different module combination.
- Low-confidence page recognition: request fresh observation and VLM assistance.
- Repeated failure: stop auto-replanning and request human intervention.
- Risky social/content action: require confirmation and policy check.

### 6. Orchestrator Layer

Meaning:

This layer executes task DSL across one or many devices. It owns queues, state transitions, concurrency, cancellation, and recovery.

Functions:

- Maintain task queues per device.
- Run multiple devices independently.
- Ensure one active task per device unless explicitly allowed.
- Execute step graph with timeout, retry, and verification.
- Pause, resume, cancel, and skip steps.
- Handle manual takeover and resume from checkpoint.
- Emit execution events to UI.
- Persist task state for recovery after app restart.

Primary inputs:

- Validated task DSL
- Selected device list
- Execution policy
- User control commands: pause, resume, cancel, retry, manual complete

Primary outputs:

- Task run ID
- Step-level execution events
- Device-level queue state
- Final task result
- Failure reason and recovery suggestion

How to use:

- UI submits a task definition to Orchestrator.
- Orchestrator schedules per-device runs.
- Device Queue panel shows live progress.

Exception handling:

- Step timeout: retry according to policy, then invoke correction flow.
- Device offline: pause that device run and continue other devices.
- Task cancellation: stop future steps and best-effort cancel current operation.
- App restart: reload persisted active runs and mark interrupted steps as recoverable.
- Manual intervention: pause step, show latest screenshot and suggested action, then allow resume.

### 7. Verification Layer

Meaning:

This layer decides whether each step or task actually succeeded. It prevents the system from blindly continuing after a wrong click.

Functions:

- Verify by foreground app/package.
- Verify by OCR text.
- Verify by UIAutomator node text.
- Verify by VLM visual target recognition.
- Verify by screenshot similarity or visual marker.
- Verify by module-specific predicate.
- Produce confidence and failure reason.

Primary inputs:

- Expected result definition
- Latest observation
- Previous observation
- Module result
- Optional VLM prompt

Primary outputs:

- `VerifyResult`
- Status: passed, failed, uncertain
- Confidence score
- Evidence artifacts
- Suggested correction action

How to use:

- Every non-trivial module should define a verification strategy.
- Orchestrator calls Verification layer after each step.

Exception handling:

- Uncertain result: capture another screenshot after a short delay.
- Conflicting evidence: ask VLM for visual judgment or LLM for reasoning over evidence.
- Verification timeout: mark step uncertain and follow policy.
- Failed verification: run module recovery or Planner re-plan.
- Repeated uncertainty: pause and notify human.

### 8. Human-in-the-loop Layer

Meaning:

This layer allows controlled human intervention when automation confidence is low or risk is high.

Functions:

- Pause a running task.
- Show latest screenshot, current step, failure reason, and suggested actions.
- Allow user to manually operate the device window.
- Allow user to mark step as completed, retry, skip, or abort.
- Notify user when a device needs attention.
- Resume from checkpoint after manual intervention.

Primary inputs:

- Task run ID
- Device ID
- Failure state
- Latest artifacts
- User decision

Primary outputs:

- User decision event
- Updated run state
- Optional correction instruction

How to use:

- Triggered automatically by policy or manually by the user.
- UI presents a clear "needs attention" state in the device/task panel.

Exception handling:

- No user response: keep task paused and optionally cancel after a configured timeout.
- User manually changes app state: refresh observation before resume.
- User marks completed incorrectly: verification layer still runs unless explicitly overridden.
- Notification failure: keep visible in-app alert and task state.

### 9. Persistence, Audit, and Replay Layer

Meaning:

This layer records what happened so failures can be debugged and successful flows can be reused.

Functions:

- Persist task definitions.
- Persist task runs and step results.
- Persist observation artifacts.
- Persist VLM/LLM prompts and structured responses where allowed.
- Support replaying a task run timeline.
- Support exporting failure bundles for debugging.

Primary inputs:

- Task DSL
- Orchestrator events
- Screenshots and observations
- Module results
- Verification results

Primary outputs:

- Run history
- Replay timeline
- Debug artifact bundle
- Reusable task template

How to use:

- Orchestrator writes events continuously.
- UI reads history for task detail and replay.

Exception handling:

- Storage write failure: continue in memory and warn user.
- Large artifacts: apply retention policy and compression.
- Sensitive content: redact or disable prompt/screenshot storage based on policy.
- Corrupt run record: ignore invalid record and preserve raw file for inspection.

### 10. Safety and Policy Layer

Meaning:

This layer prevents uncontrolled execution, high-frequency risky actions, and unsafe content generation.

Functions:

- Define allowed actions and restricted actions.
- Apply rate limits per device, app, and task.
- Require confirmation for sensitive actions such as posting comments, sending messages, payments, account changes, and mass operations.
- Enforce max duration, max retries, and max loop count.
- Provide content filters for generated text.
- Provide kill switch for all running tasks.

Primary inputs:

- Task DSL
- Module metadata
- User policy settings
- Runtime event stream

Primary outputs:

- Allow, deny, or require confirmation decision
- Policy violation reason
- Rate limit delay

How to use:

- Planner checks policy before proposing a task.
- Orchestrator checks policy before every high-impact step.

Exception handling:

- Policy violation: block step and show reason.
- Confirmation timeout: keep step paused.
- Rate limit reached: delay or skip according to policy.
- Suspicious repeated failures: stop task and notify human.

## Development Tasks

## Implementation Status

- [x] P0-1. Define RPA Task DSL Schema
- [x] P0-2. Implement Module Registry
- [x] P0-3. Wrap Existing Device Runtime APIs
- [x] P0-4. Implement Base Modules
- [x] P0-5. Implement Minimal RPA Task Executor
- [x] P1-1. Implement Observation Snapshot Service
- [x] P1-2. Implement Verification Engine
- [x] P1-3. Implement Global Popup Handler Module
- [x] P1-4. Implement Visual Target Modules
- [x] P2-1. Implement Planner Prompt Contract
- [x] P2-2. Implement LLM Re-planning After Failure
- [x] P2-3. Implement VLM Visual Correction
- [x] P3-1. Build RPA Task Runner UI (basic runner panel)
- [x] P3-2. Implement Multi-device Fan-out
- [x] P3-3. Persist Queue and Run State in Main Process (run state persisted through main-process IPC; full executor migration remains a follow-up)
- [x] P3-4. Implement Per-device Scrcpy Video Frame Capture
- [x] P4-1. Add Safety Policy Engine
- [x] P4-2. Add Run Replay and Debug Export
- [x] P5-1. Define RPA Workspace Information Architecture
  - [x] P5-1.1. Replace left Assistant/Topic/Device tabs with a unified RPA workspace sidebar
  - [x] P5-1.2. Show active RPA runs with live progress and human-intervention status
  - [x] P5-1.3. Keep chat topics and topic management in the workspace
  - [x] P5-1.4. Move device scan and management into a consolidated dialog
  - [x] P5-1.5. Make chat RPA generation independent of the former Device tab
  - [x] P5-1.6. Complete route ownership documentation and cross-module navigation QA
  - [x] P5-1.7. Rename Recent Tasks to Chat Topics
- [x] P5-2. Rebuild Assistant Configuration as the RPA Profile and Asset Binding Hub
  - [x] P5-2.1. Define RPA Assistant Profile and Repository
  - [x] P5-2.2. Consolidate Assistant Configuration into the Chat Header
  - [x] P5-2.3. Add Template, Skill, and Knowledge Bindings
  - [x] P5-2.4. Implement Topic Overrides and Effective Context Resolution
  - [x] P5-2.5. Show DSL Provenance and Persist Run Context Snapshots
  - [x] P5-2.6. Migrate Legacy Assistant Data and Add Compatibility Tests
- [x] P5-3. Reposition Knowledge Base as RPA SOP and Experience Library
- [x] P5-4. Reposition Files as RPA Evidence and Asset Library
- [x] P5-5. Build the RPA DSL Template Repository and Visual Editor
- [x] P5-6. Save Chat-generated RPA DSL into RPA Templates
- [x] P5-7. Review and Apply Run Improvement Proposals
- [x] P5-8. Delete Legacy Taskflow and Non-RPA Execution Paths
- [x] P5-9. Consolidate Device Selection into Execution Confirmation
- [x] P6-1. Extend Observation with UI Tree and OCR
- [x] P6-2. Implement App State Recognizer
- [x] P6-3. Add RPA Skill Library and Compiler
- [x] P6-4. Implement Deterministic Navigation Recovery
- [x] P6-5. Add Trace Learning and Failure Feedback
- [x] P7-1. Define the App Automation Role Domain and Compatibility Bridge
- [x] P7-2. Implement Effective Role Context and Asset Ownership Resolution
- [x] P7-3. Inject Versioned Role Prompts and Bounded Retrieved Context
- [x] P7-4. Build the Role Library and Role Detail Workspace
- [x] P7-5. Add Secure Remote Retrieval and Tool Providers
- [x] P7-6. Implement Signed Role Pack Import, Export, and Transactional Restore
- [x] P7-7. Build the RPA DSL Session alongside the Compatibility Topic Flow
- [ ] P7-8. Migrate Legacy Data and Verify Dual-read Compatibility
- [ ] P7-9. Switch Primary Navigation and Retire Legacy Entry Points
- [x] P7-10. Consolidate Role Configuration and Scheduled RPA Task Flows (real-device acceptance pending)
- [ ] P7-11. Make the RPA Session Orchestrator the Only Role-scoped Input Path
  - [x] P7-11.1. Define the task-session interaction protocol and state machine
  - [x] P7-11.2. Replace intent detection and generic chat fallback with session routing
  - [x] P7-11.3. Implement generation, revision, clarification, explanation, and run-control outcomes
  - [x] P7-11.4. Add explicit task lifecycle actions and contextual Replan entry points
  - [x] P7-11.5. Add revision concurrency control and immutable model/context provenance
  - [ ] P7-11.6. Complete gated migration, rollback, desktop UI, and real-device acceptance
- [ ] P7-12. Add Session-scoped Supplemental Context and Federated Retrieval
  - [x] P7-12.1. Define Session Supplement bindings and immutable provenance
  - [x] P7-12.2. Resolve Supplements after Effective Role Context without expanding permissions
  - [x] P7-12.3. Add Artifact extraction, OCR, VLM evidence, and temporary indexes
  - [x] P7-12.4. Implement federated retrieval, rank fusion, and optional unified reranking
  - [x] P7-12.5. Adapt approved URL and MCP sources through existing secure Providers
  - [x] P7-12.6. Add bounded Context Snapshots, retention, privacy, and replay policy
  - [x] P7-12.7. Add input UI, source visibility, removal, retention, and promotion proposals
  - [ ] P7-12.8. Complete concurrency, automated coverage, desktop UI, and real-device acceptance
- [x] P7-13. Harden Run Ownership, Role Asset Onboarding, and Deterministic Flow Reuse
- [x] P7-14. Replace Improvement Review and Free-form Run Experience with Automatic Versioned Learning

### P0-1. Define RPA Task DSL Schema

Background:

The current task execution is feature-oriented and scattered across device runtime, chat command, VLM action, and queue code. A stable DSL is needed as the common contract.

Function:

- Add TypeScript types for task definition, step definition, retry policy, timeout policy, verification policy, device selection, and execution policy.
- Add JSON schema or runtime validator for DSL input.
- Reject unknown module IDs, invalid params, missing devices, unbounded loops, and unsafe defaults.

Input:

- Raw task JSON
- Available module registry metadata
- Selected device IDs

Output:

- Validated task definition
- Validation error list

How to use:

- The task builder and LLM Planner submit a DSL draft to the validator.
- Orchestrator only accepts validated definitions.

Exception handling:

- Invalid schema: return field-level errors.
- Unknown module: return available alternatives.
- Missing timeout: apply safe default.
- Missing retry rule: apply module default.
- Unbounded loop: reject unless `maxIterations` or `maxDurationMs` is present.

Acceptance criteria:

- Unit tests cover valid task, invalid module, invalid params, missing device, and unsafe loop.
- Existing queue MVP can wrap a task into the new schema without behavior regression.

### P0-2. Implement Module Registry

Background:

Planner and Orchestrator need a single source of truth for what modules exist and how to call them.

Function:

- Create `ActionModule` interface.
- Create `ModuleRegistry`.
- Register built-in modules.
- Expose module metadata for Planner and UI.
- Support input schema validation per module.

Input:

- Module implementation
- Module metadata
- Module params

Output:

- Registered module catalog
- Validated module invocation

How to use:

- `registry.get("launch_app")`
- `registry.listForPlanner()`
- `registry.validateInput(moduleId, params)`

Exception handling:

- Duplicate module ID: fail during app initialization.
- Missing module: validation error before execution.
- Invalid params: block execution and show field-level error.

Acceptance criteria:

- Registry unit tests cover register, duplicate detection, lookup, planner-safe metadata, and validation.

### P0-3. Wrap Existing Device Runtime APIs

Background:

Existing device capabilities should be reused instead of reimplemented.

Function:

- Wrap current screenshot, tap, swipe, app launch, text input, foreground app, and screen size logic behind a typed `DeviceRuntime`.
- Normalize all runtime results into a common result format.
- Add per-device execution lock.

Input:

- `deviceId`
- Runtime action params

Output:

- Runtime action result

How to use:

- Modules call `context.runtime.tap(...)`, not raw IPC or service calls directly.

Exception handling:

- Device missing: return `device_offline`.
- ADB timeout: return `timeout`.
- Screenshot failure: try fallback capture path.
- Runtime exception: convert to structured error and log through `loggerService`.

Acceptance criteria:

- Existing device operations still pass tests.
- New runtime tests cover success, timeout, missing device, and screenshot fallback.

### P0-4. Implement Base Modules

Background:

The first useful RPA system requires a small set of reliable modules.

Function:

- Implement `launch_app`.
- Implement `wait`.
- Implement `screenshot`.
- Implement `tap_absolute`.
- Implement `tap_percent`.
- Implement `swipe_percent`.
- Implement `press_back`.
- Implement `press_home`.
- Implement `get_foreground_app`.

Input:

- Module params
- Device context

Output:

- Module result and optional observation artifact

How to use:

- DSL step: `{ "module": "tap_percent", "params": { "x": 0.5, "y": 0.8 } }`

Exception handling:

- Invalid coordinate: reject before execution.
- Step timeout: return timeout result.
- Failed verification: let Orchestrator run retry or recovery.

Acceptance criteria:

- All base modules have tests.
- Each module declares input schema, default timeout, retry safety, and verification support.

### P1-1. Implement Observation Snapshot Service

Background:

Reliable automation needs consistent state capture before and after actions.

Function:

- Add a service that captures screenshot, foreground app, screen size, optional OCR, optional UI tree, and optional VLM summary.
- Store artifacts with task run ID and step ID.
- Return normalized observation objects.

Input:

- `deviceId`
- Observation options
- Task run context

Output:

- `DeviceObservation`
- Artifact paths

How to use:

- Orchestrator captures observation before and after steps.
- Verification and Planner consume the latest observation.

Exception handling:

- Partial failure: return partial observation with warnings.
- Screenshot unavailable: mark observation unusable for visual modules.
- Artifact write failure: continue with in-memory result and warn.

Acceptance criteria:

- Tests cover screenshot-only, full observation, partial failure, and artifact path generation.

### P1-2. Implement Verification Engine

Background:

Without verification, the task flow will continue after wrong clicks and accumulate errors.

Function:

- Support foreground app verification.
- Support OCR/text contains verification.
- Support VLM visual verification.
- Support screenshot existence verification.
- Support custom module verifier.
- Return `passed`, `failed`, or `uncertain`.

Input:

- Expected verification rule
- Latest observation
- Previous observation
- Module result

Output:

- Verification result with confidence and evidence

How to use:

- Each DSL step can include `verify`.
- Modules can provide default verification.

Exception handling:

- Verification timeout: return `uncertain`.
- Low confidence: request a second observation.
- Still uncertain: trigger correction policy.

Acceptance criteria:

- Unit tests cover passed, failed, uncertain, timeout, and retry observation cases.

### P1-3. Implement Global Popup Handler Module

Background:

Unexpected popups break deterministic flows and are a common cause of failure.

Function:

- Detect permission dialogs, update dialogs, login prompts, ad close buttons, and common blocking overlays.
- Provide safe handling strategies: close, allow, deny, wait, or ask human.
- Run before or after selected steps as policy.

Input:

- Observation
- Popup handling policy

Output:

- Popup action result
- Updated observation

How to use:

- Orchestrator can run `handle_popup` before visual target modules.

Exception handling:

- Unknown popup: ask VLM to classify.
- Risky popup: pause and request human decision.
- Repeated popup: stop task to avoid loops.

Acceptance criteria:

- Tests cover known popup, unknown popup, risky popup, and repeated popup loop protection.

### P1-4. Implement Visual Target Modules

Background:

Many app actions require visual target selection such as tapping a tab or icon.

Function:

- Implement `tap_by_text`.
- Implement `tap_by_ocr`.
- Implement `tap_by_vlm_target`.
- Implement `swipe_until_text`.
- Implement `swipe_until_vlm_target`.
- Convert detected bounding boxes to device coordinates.

Input:

- Target description
- Observation options
- Search direction and max attempts

Output:

- Tap/swipe result
- Target evidence and confidence

How to use:

- DSL step: `{ "module": "tap_by_vlm_target", "params": { "target": "top-right coin icon" } }`

Exception handling:

- Target not found: retry with fresh observation.
- Multiple candidates: ask VLM to rank or ask human if low confidence.
- Coordinate mismatch: re-check screen size and remap.
- After max attempts: return `needsHuman` or trigger Planner correction.

Acceptance criteria:

- Tests cover single target, no target, multiple candidates, and coordinate mapping.

### P2-1. Implement Planner Prompt Contract

Background:

LLM should output only valid DSL, not free-form actions or arbitrary code.

Function:

- Provide Planner with module catalog, task schema, safety policy, and current observation summary.
- Require strict JSON output.
- Validate Planner output with DSL validator.
- Ask for correction if validation fails.

Input:

- User instruction
- Module catalog
- Observation summary
- Existing templates

Output:

- Valid DSL draft
- Planner explanation
- Confidence score

How to use:

- Chat command "对设备执行..." calls Planner first, then shows/executes DSL according to policy.

Exception handling:

- Invalid JSON: ask LLM to repair once or twice.
- Invalid schema: feed validation errors back to LLM for correction.
- Low confidence: ask user before execution.
- Unsafe task: block or require confirmation.

Acceptance criteria:

- Tests use mocked LLM responses for valid plan, invalid JSON repair, invalid module repair, and unsafe action confirmation.

### P2-2. Implement LLM Re-planning After Failure

Background:

Flows fail when the app is on an unexpected page. LLM can reason over history and suggest recovery steps.

Function:

- Collect failed step, previous steps, observations, verification result, and available modules.
- Ask LLM to propose a bounded correction plan.
- Validate and insert correction steps.

Input:

- Failed run context
- Latest observation
- Module catalog
- Failure reason

Output:

- Validated temporary RPA nodes compiled from the VLM decision
- `execute_actions`, `replan`, `human_required`, or `goal_achieved` decision
- Expected visual outcome for mandatory post-action verification

How to use:

- Orchestrator calls Planner correction after module recovery fails.

Exception handling:

- Correction plan invalid: ask repair once, then pause.
- Correction loops: enforce max correction attempts.
- Risky correction: require human approval.
- No useful correction: pause and notify human.

Acceptance criteria:

- Tests cover executable correction, invalid description-only output, mandatory verification, timeout, no-progress
  detection, bounded correction rounds, goal confirmation, and human handoff.

### P2-3. Implement VLM Visual Correction

Background:

VLM is useful for visual target recognition and page state correction, but should be bounded and structured.

Function:

- Provide screenshot and target prompt to VLM.
- Require a structured decision with executable whitelisted actions; reasoning is audit metadata only.
- Validate decision type, action parameters, confidence, coordinates, package names, and action count.
- Reject arbitrary ADB shell, scripts, markdown, and description-only responses.
- Execute each action group and observe the device again before another decision.

Input:

- Screenshot
- Target description
- Screen metadata
- Optional previous failed coordinate

Output:

- Structured `execute_actions`, `replan`, `human_required`, or `goal_achieved` decision
- Whitelisted tap, swipe, key, start-app, wait, or permission action list
- Confidence, expected outcome, and audit reason

How to use:

- Visual modules call this when OCR/UI tree cannot find the target.

Exception handling:

- VLM timeout: retry once with compressed image or lower detail.
- Invalid response: ask repair once.
- Low confidence: request human confirmation.
- Candidate outside bounds: reject and retry observation.

Acceptance criteria:

- Tests mock valid executable decisions, invalid description-only output, forbidden actions, low confidence, forced
  post-action verification, and human handoff.

### P3-1. Build RPA Task Runner UI

Background:

Users need to view, approve, start, pause, resume, and debug RPA tasks.

Function:

- Add task list and task run detail UI.
- Show selected devices.
- Show generated DSL in readable form.
- Show step timeline and artifacts.
- Provide controls: start, pause, resume, cancel, retry step, mark completed, request human takeover.

Input:

- Task definitions
- Orchestrator events
- User actions

Output:

- Updated run state
- User control events

How to use:

- From chat or RPA Templates, generated tasks can be opened in RPA runner.

Exception handling:

- Stale run state: refresh from persistence.
- Missing artifact: show unavailable state.
- Control command failed: show actionable error.

Acceptance criteria:

- UI tests cover task creation, run detail, pause/resume/cancel, and failed step display.

### P3-2. Implement Multi-device Fan-out

Background:

The project goal includes controlling multiple devices independently without cross-device interference.

Function:

- Run one task template across multiple selected devices.
- Maintain independent per-device context and queue.
- Support batch progress summary.
- Allow pausing/resuming/canceling one device or the whole batch.

Input:

- Task DSL
- Device list
- Batch policy

Output:

- Batch run ID
- Per-device run IDs
- Batch progress state

How to use:

- User selects multiple devices and starts the same RPA task.

Exception handling:

- One device fails: follow policy to continue others or stop batch.
- Device offline: pause only that device run.
- Rate limit: stagger start times and actions.
- Shared LLM/VLM capacity limit: queue model calls with concurrency limits.

Acceptance criteria:

- Tests cover two-device independent execution, one-device failure isolation, and batch cancel.

### P3-3. Persist Queue and Run State in Main Process

Background:

Renderer/localStorage state is not enough for production task execution.

Function:

- Move durable queue/run state to main process storage.
- Provide IPC APIs for task submit, control, events, and history.
- Restore interrupted runs after app restart.

Input:

- Task run events
- Control commands
- Storage records

Output:

- Durable task state
- Restored run records

How to use:

- Renderer subscribes to task events through IPC.
- Main process owns execution state.

Exception handling:

- App crash: mark active steps as interrupted on next start.
- Storage corruption: isolate bad records and continue.
- IPC disconnect: keep execution state and resync when renderer reconnects.

Acceptance criteria:

- Tests cover persistence, restore, interrupted run marking, and IPC state sync.

### P3-4. Implement Per-device Scrcpy Video Frame Capture

Implementation status: completed with per-device H.264/H.265 streams, startup retry, stale-packet watchdog,
exponential reconnect, decoder recovery, strict scrcpy-only RPA/VLM evidence, frame metadata UI, and automated
isolation/freshness/recovery tests. Live-device integration validation remains environment-dependent.

Background:

Current HWND capture reads desktop pixels and can capture an overlapping Electron window instead of mobile content. RPA/VLM must receive the actual video frame produced by scrcpy for the target device.

Function:

- Maintain one independent scrcpy video session per `deviceId`.
- Read the scrcpy H.264/H.265 video stream and decode the newest frame to PNG or RGBA.
- Keep a bounded latest-frame cache containing timestamp, sequence, width, height, codec, and stream health.
- Expose typed APIs: `startFrameStream`, `getLatestFrame`, `stopFrameStream`, and `getFrameStreamHealth`.
- Route screenshot modules, observations, VLM actions, correction evidence, and runner preview to the stream frame source.
- Do not use `CopyFromScreen` or HWND desktop capture as RPA/VLM evidence.

Input:

- `deviceId`
- Stream options: `maxFps`, `maxSize`, bitrate, and codec preference
- Optional freshness requirement

Output:

- `ScrcpyFrame { deviceId, imageBase64, mime, width, height, capturedAt, sequence, source: "scrcpy_stream" }`
- Stream health and structured error details

How to use:

- Start or reuse the device frame stream before a visual RPA step.
- Call `getLatestFrame(deviceId, { maxAgeMs: 1000 })` when sending an image to VLM or recording recovery evidence.
- Stop the stream when the device disconnects or no task/UI consumer remains.

Exception handling:

- Startup timeout: retry once, then mark the device visual channel unavailable.
- No new frame within 2 seconds: reconnect with exponential backoff.
- Decode failure: discard the invalid frame, retain the last valid frame only for diagnostics, then reconnect.
- Stale frame for a visual action: reject the action and obtain a fresh frame.
- Device offline or unauthorized: pause only that device run and request human action.
- Memory pressure: retain only the newest decoded frame and bounded diagnostic metadata.
- Low VLM confidence: submit a fresh stream frame to recovery analysis, then enter `needs_human` when confidence or correction limits require it.

Acceptance criteria:

- Two simulated devices maintain independent frame caches and no frame cross-contamination occurs.
- An occluded or minimized scrcpy UI does not alter the frame sent to VLM.
- Screenshot, observation, VLM action, and recovery evidence report source `scrcpy_stream`.
- Freshness, reconnect, decode error, device disconnect, and coordinate mapping are unit-tested.
- Integration validation confirms VLM receives the real mobile frame and returned coordinates target the correct device.

### P4-1. Add Safety Policy Engine

Implementation status: completed with structured allow/delay/confirmation-required/blocked decisions, task- and
device-bound approval fingerprints, module and correction-action risk evaluation, shared device/task rate limits,
injectable generated-text moderation, policy events, high-risk execution summaries, per-device abort propagation,
and a global emergency stop. Original nodes, temporary replan nodes, and VLM correction actions use the same policy
gate; editable DSL metadata cannot grant approval.

Background:

Automation involving comments, likes, messages, payment, or account settings needs explicit controls.

Function:

- Define action risk levels.
- Require confirmation for high-risk modules.
- Add per-device and per-task rate limits.
- Add content moderation hook for generated text.
- Add emergency stop.

Input:

- Module metadata
- Task DSL
- User policy settings
- Runtime event stream

Output:

- Policy decision
- Confirmation request
- Rate limit delay

How to use:

- Planner and Orchestrator call policy engine before execution.

Exception handling:

- Confirmation timeout: keep paused.
- Policy violation: block step and show reason.
- Emergency stop: cancel all queues immediately.

Acceptance criteria:

- Tests cover high-risk confirmation, task tampering, device-scoped approval, device rate-limit isolation, blocked
  content, permission-action escalation, VLM policy bypass prevention, cancellation propagation, and emergency stop.

### P4-2. Add Run Replay and Debug Export

Implementation status: Complete (2026-07-20)

Delivered:

- Added a normalized, chronological replay model for device events, actions, observations, model output, verification,
  safety decisions, and screenshot availability.
- Added read-only historical replay with device and execution-phase filters, plus explicit placeholders for missing
  screenshot evidence.
- Added a run-history picker to the inline chat workflow without replacing the existing editable DSL experience.
- Added sanitized ZIP debug exports containing a manifest, task DSL, run record, replay timeline, screenshot inventory,
  and extracted screenshot files.
- Added recursive secret redaction, archive path validation, event and screenshot size limits, compression, and omitted
  artifact reporting. Run history remains bounded to the existing 100-record retention policy.
- Added successful-run conversion into a device-neutral editable template. Failed or partially successful runs are
  rejected.
- Added renderer and main-process tests for replay ordering/loading, missing artifacts, redaction, ZIP generation,
  traversal rejection, and template creation.

Background:

Automation failures need reproducible evidence.

Function:

- Show timeline of steps, screenshots, observations, model outputs, and verification results.
- Export a debug bundle.
- Convert successful runs into reusable templates.

Input:

- Run history
- Artifacts
- Task DSL

Output:

- Replay UI
- Export bundle
- Template draft

How to use:

- User opens a failed or successful run from history.

Exception handling:

- Missing artifact: show placeholder.
- Large export: compress and apply retention policy.
- Sensitive data: redact based on policy.

Acceptance criteria:

- Tests cover replay loading, export bundle generation, and template creation.

### P5-1. Define RPA Workspace Information Architecture

Background:

The current product still exposes several Cherry Studio-origin modules as parallel top-level features. For a mobile RPA product, assistant library, knowledge base, files, RPA Templates, device control, run history, and chat should form one closed workspace instead of unrelated areas.

Function:

- Define the RPA workspace navigation model around active runs, chat topics, device management, RPA Templates, run history, knowledge, files, and assistant configuration in the chat header.
- Clarify module responsibilities: chat generates and runs drafts, RPA Templates stores reusable RPA DSL templates, run history verifies and reviews improvements, knowledge stores reviewed SOP/experience, files catalogs evidence/assets, the selected assistant provides the default model and RPA asset bindings, and the P6 skill engine owns executable skills.
- Update labels, empty states, and entry descriptions to reflect RPA usage.
- Define cross-module links such as "save as RPA template", "open run replay", "add to experience", and "attach evidence".
- Treat the current chat-shaped surface as a transitional RPA DSL session UI. P7 removes generic conversation behavior so every user request produces validated DSL, a bounded clarification request, or an explicit non-executable result.
- Remove the parallel Assistant, Topic, and Device Management tabs from the left sidebar. Replace them with active RPA runs and chat topics, while device scan and management move into one management dialog.
- Keep assistant/model configuration in the existing chat-header selector as the only primary assistant configuration entry.

Input:

- Existing sidebar configuration
- Existing route map
- Current RPA runner, RPA Templates, knowledge, files, and assistant modules
- Product target for mobile RPA orchestration

Output:

- RPA workspace information architecture
- Navigation and naming plan
- Module ownership map
- Migration list for legacy entry points

How to use:

- Product and implementation work should follow the workspace map before adding new RPA screens.
- New RPA features must land in the module that owns their lifecycle responsibility.

Exception handling:

- Existing user data remains accessible after navigation changes.
- Hidden legacy routes should remain deep-linkable during migration unless removal is explicitly scheduled.
- Ambiguous ownership should default to RPA Templates for reusable DSL and run history for execution evidence.

Acceptance criteria:

- Documentation identifies the primary RPA loop: generate, save, execute, verify, replay, improve, reuse.
- Sidebar and route ownership are mapped to RPA concepts.
- Tests or manual QA checklist cover navigation from chat to RPA Templates, RPA Templates to execution, execution to replay, and replay to knowledge feedback.
- The left sidebar does not expose duplicate assistant or model configuration, and RPA generation remains available without selecting a Device tab.

Implemented route ownership and navigation QA:

- Home left sidebar owns active RPA run monitoring, chat topics, and the entry to the device management dialog.
- Device management dialog owns device scan, grouping, metadata editing, scrcpy connection, command control, and batch actions.
- Chat header owns assistant and model selection/configuration. The left sidebar does not expose a second assistant selector.
- Chat content owns natural-language task entry, editable generated DSL, execution confirmation, and inline workflow output.
- Execution progress modal owns live per-device status, recovery events, human intervention, pause/resume, and emergency stop.
- RPA Templates owns reusable DSL templates; Run History owns replay and improvement review; Knowledge and Files own reviewed guidance and evidence browsing.
- Legacy `SHOW_ASSISTANTS` and `SHOW_TOPIC_SIDEBAR` events open the unified RPA workspace.
- The former right-side Topic panel and Device-tab gating have been removed from the Home workflow.
- Automated QA covers active-run subscription, human-intervention display, execution-detail opening, pause requests, and device-dialog mount/unmount behavior.

#### P5-1.7. Rename Recent Tasks to Chat Topics

Background:

The lower section of the RPA workspace contains assistant conversation topics, not RPA execution instances. Calling it "Recent Tasks" makes it easy to confuse chat context with active runs, saved Templates, or historical executions.

Function:

- Rename the workspace section from "Recent Tasks" to "Chat Topics".
- Keep existing topic creation, switching, renaming, pinning, deletion, export, and context-menu behavior.
- Use execution status only in the Active RPA Runs section; do not imply that every chat topic is an executable or running task.
- Update Chinese, English, and synchronized locale resources.
- Update component tests and navigation QA expectations.

Input:

- Existing workspace section labels
- Existing Topic records and management actions
- Locale resources

Output:

- "Chat Topics" workspace section
- Updated translations and tests
- Unchanged Topic data and behavior

Exception handling:

- Existing topics remain available without migration.
- Missing translations fall back to the base locale without displaying raw i18n keys.
- The rename must not alter Topic IDs, assistant ownership, messages, or pinned state.

Acceptance criteria:

- The left workspace displays "聊天话题" in Chinese and "Chat Topics" in English.
- No "Recent Tasks" label remains in the Home RPA workspace.
- Topic creation, switching, management, and persistence tests continue to pass.

#### P5/P6 Shared Domain and Ownership Contract

P5 owns the product workspace, catalog views, review flows, and cross-module lifecycle. P6 owns runtime intelligence, executable skill semantics, observation processing, recovery, and learning analysis. Both phases must reuse shared repositories and protocols instead of creating parallel stores.

Core asset definitions:

- `Assistant RPA Profile`: a transitional versioned set of model defaults, asset references, capability overrides, and resolution policies associated with an existing chat assistant. P7 migrates it into a role-owned configuration and removes it as an independent product concept.
- `Template`: a directly editable and executable RPA DSL snapshot. Templates are stored and versioned in RPA Templates.
- `Skill`: a reusable, parameterized app capability containing states, transitions, locators, assertions, fallback rules, and safety metadata. Skills are compiled into validated task DSL before execution.
- `Knowledge`: reviewed human-readable SOP, manual, policy, and experience content used for retrieval. Knowledge must not duplicate executable skill state graphs or recovery rules.
- `Artifact`: screenshot, scrcpy frame, UI tree, OCR output, log, replay event, or debug bundle produced or imported as evidence.
- `Improvement Proposal`: a reviewable suggestion generated from run traces that may update a template, skill, or knowledge entry after explicit approval.

Shared ownership rules:

- RPA Templates owns template catalog UI, template persistence, editing, validation display, and links to skill versions; the P6 skill engine owns skill schema, matching, compilation, and runtime behavior.
- Observation services own artifact capture, parsing, coordinate normalization, and redaction metadata; Files owns artifact browsing, attachment, retention visibility, and import/export UI.
- Trace Learning owns run analysis, failure classification, fingerprint aggregation, and proposal generation; Run History owns proposal review, approval, rejection, application status, and lineage display.
- Knowledge stores reviewed explanatory material. Failure fingerprints and executable state transitions remain structured P6 runtime data and may only be linked from knowledge entries.
- A template may be saved from one run. A skill requires parameterization, state modeling, validation evidence, and review. Templates do not automatically become skills.
- The Assistant RPA Profile grants access to assets and provides defaults. Topic context and execution confirmation may override those defaults according to the documented precedence rules.

Required shared services:

- `RpaAssistantProfileRepository` for versioned assistant-to-asset bindings and capability defaults.
- `RpaTemplateRepository` for editable DSL templates and versions.
- `RpaSkillRepository` for executable skill definitions and versions.
- `RpaArtifactStore` for evidence metadata, retention, redaction, and links.
- `RpaImprovementProposalRepository` for generated, reviewed, applied, and rejected proposals.

Recommended cross-phase implementation order:

1. P5-1 defines workspace navigation, domain ownership, repository boundaries, and migration constraints.
2. P5-2.1, P5-2.2, and P5-2.4 establish the assistant profile, single chat-header entry, topic overrides, and effective context resolver.
3. P5-5 and P5-6 establish the template repository, editor, and chat-to-template save flow.
4. P5-9 consolidates target-device selection, group resolution, and online preflight validation into execution confirmation.
5. P6-1 adds UI tree/OCR evidence and shared artifact persistence.
6. P6-2 implements state recognition on top of the normalized observation contract.
7. P6-3 implements the skill schema, repository, matching, and compiler.
8. P6-4 implements deterministic recovery using recognized states and compiled skill rules.
9. P6-5 implements trace analysis, failure fingerprints, and improvement proposal generation.
10. P5-2.3 and P5-2.5 complete asset binding, DSL provenance, and run snapshots against the final Template/Skill/Knowledge contracts.
11. P5-3, P5-4, and P5-7 integrate reviewed knowledge, artifact browsing, and proposal review around the completed P6 services.
12. P5-2.6 and P5-8 complete migration, compatibility, feature flags, and removal of duplicate legacy entry points.

This order is an implementation dependency sequence rather than a change to phase ownership. P5 remains the product layer and P6 remains the runtime intelligence layer.

Improvement proposal minimum contract:

- Source run IDs and source template/skill version.
- Target type: `template`, `skill`, or `knowledge`.
- Problem statement, failure classification, evidence artifact IDs, and confidence.
- Structured proposed changes that can be validated before application.
- Review state: `pending_review`, `approved`, `rejected`, or `applied`.
- Reviewer, timestamps, application result, and resulting target version.

### P5-2. Rebuild Assistant Configuration as the RPA Profile and Asset Binding Hub

Background:

The chat header already provides the primary assistant, provider, model, version, prompt, MCP, and reasoning configuration. Adding another assistant or execution-role selector to the left RPA sidebar would create conflicting configuration entry points. At the same time, RPA planning must consistently resolve which Templates, Skills, and Knowledge sources are available to the selected assistant. The assistant therefore needs a separate RPA profile that references these assets without copying or owning them.

Function:

- Keep the existing chat-header assistant selector as the only primary entry for assistant and model configuration.
- Add an RPA automation section to assistant configuration for Knowledge bindings, enabled Skill sets, recommended Templates, and optional capability-specific model overrides.
- Store bindings in a separate `RpaAssistantProfile` keyed by `assistantId`; do not embed Template, Skill, or Knowledge content in the existing Assistant entity.
- Allow one Template, Skill, or Knowledge asset to be referenced by multiple assistants without duplication.
- Add topic-level temporary overrides so a task conversation can add, exclude, or pin assets without mutating assistant defaults.
- Resolve an immutable effective RPA context before DSL generation and again before execution confirmation.
- Use the selected chat model as the default Planner, DSL generation, verification, recovery, and visual model. Allow optional advanced overrides for visual, verification, and recovery capabilities.
- Validate model capabilities before invoking screenshot/VLM operations.
- Resolve DSL generation in this order: load assistant profile, merge topic overrides, retrieve Knowledge, find candidate Templates, match allowed Skills, choose template parameterization/skill compilation/free-form planning, validate dependencies, and emit editable DSL.
- Display generation provenance for the Template, Skills, Knowledge entries, assistant profile version, and model used.
- Persist an immutable `RpaRunContextSnapshot` with each run so replay does not depend on the latest assistant or asset configuration.
- Keep external workflow orchestration out of the current roadmap; the local Planner, Verification, Recovery, and Safety contracts remain authoritative.

Implementation subtasks:

#### P5-2.1. Define RPA Assistant Profile and Repository

- Define `RpaAssistantProfile` independently from the existing Assistant type.
- Store `assistantId`, profile version, Knowledge bindings, Skill bindings, Template recommendations, model overrides, and update metadata.
- Knowledge bindings include enabled state, priority, retrieval limit, and optional filters.
- Skill bindings include skill ID, accepted version range, enabled state, and whether automatic matching is allowed.
- Template bindings include template ID, optional pinned version, and usage type such as `recommended` or `quick_start`.
- Model overrides may define visual, verification, and recovery models; the chat model remains the default when an override is absent.
- Implement `RpaAssistantProfileRepository` with get, save, version, delete-association, and asset-reference lookup operations.
- Deleting an assistant removes only its profile binding. It must not delete referenced Templates, Skills, Knowledge, or historical snapshots.

#### P5-2.2. Consolidate Assistant Configuration into the Chat Header

- Extend the existing chat-header assistant configuration UI instead of adding a new left-sidebar selector.
- Keep current assistant, provider, model, model version, prompt, reasoning, MCP, and tool configuration behavior.
- Add one compact Automation section for Knowledge sources, Skill sets, recommended Templates, and advanced model overrides.
- Use searchable multi-select controls with asset name, version, status, and compatibility warnings.
- Provide links to open the owning Template, Skill, or Knowledge management view without duplicating its editor.
- Show the effective default model and indicate only capability-specific overrides that differ from it.
- Remove or hide the legacy left Assistant tab after migration; retain a deep-linkable advanced assistant management route when required for old data.

#### P5-2.3. Add Template, Skill, and Knowledge Bindings

- Treat assistant bindings as references and permissions, not copied asset definitions.
- Knowledge bindings define what Planner, Verification, and Recovery may retrieve.
- Skill bindings define the executable capabilities available for matching and DSL compilation.
- Template bindings define recommended or quick-start flows and must never auto-execute.
- A Template may declare required Skill IDs/version ranges and optional Knowledge references.
- Missing required Skills block executable DSL validation; missing optional Knowledge produces an explicit degraded-generation warning.
- Binding updates create a new assistant profile version and preserve existing run snapshots.

#### P5-2.4. Implement Topic Overrides and Effective Context Resolution

- Add `RpaTopicContextOverride` for temporary per-topic asset additions, exclusions, pinned versions, app scope, and optional model overrides.
- Resolve configuration precedence as: system defaults -> assistant RPA profile -> topic overrides -> required Template dependencies -> execution confirmation overrides.
- Required Template dependencies cannot be silently excluded by a lower-priority setting.
- Return an `EffectiveRpaContext` containing resolved model clients, assets, versions, warnings, missing dependencies, and capability checks.
- Re-resolve context when the assistant changes, an asset version changes, or the user confirms execution.
- When switching assistants, ask whether topic overrides should be preserved, remapped, or cleared if they are incompatible.

#### P5-2.5. Show DSL Provenance and Persist Run Context Snapshots

- Add a compact task-context indicator in chat showing active Knowledge, Skill, and Template counts with an adjustment entry.
- Show DSL provenance inside the generated editable DSL block: source Template, compiled Skills, retrieved Knowledge, assistant profile version, and model IDs.
- Define `RpaRunContextSnapshot` with assistant ID, assistant profile version, provider/model IDs, Template ID/version, Skill IDs/versions, Knowledge IDs/versions, topic overrides, and resolution warnings.
- Persist the snapshot before execution starts and include it in run history, replay, and debug export.
- Historical replay always reads the snapshot rather than resolving the latest bindings.
- Redact credentials, provider secrets, retrieved sensitive text, and private prompt material from exported snapshots.

#### P5-2.6. Migrate Legacy Assistant Data and Add Compatibility Tests

- Create an empty/default RPA profile lazily for existing assistants during the transitional P5 implementation; P7 replaces generic chat behavior with role-scoped RPA DSL sessions.
- Preserve existing assistant IDs, prompts, model settings, topics, presets, MCP settings, and knowledge references.
- Convert compatible legacy knowledge references into profile bindings through an idempotent migration.
- Keep unsupported legacy fields readable and exportable; do not discard them during migration.
- Add a feature flag and rollback path for the consolidated assistant configuration UI.
- Update RPA model clients to consume `EffectiveRpaContext` while preserving fallback to the selected chat model.

Input:

- Existing assistant presets
- Model/provider settings
- Existing assistant prompts, MCP/tool settings, topics, and legacy knowledge references
- `RpaTemplateRepository`, `RpaSkillRepository`, and Knowledge repository metadata
- Topic-level task context
- Model capability metadata
- Template dependency declarations

Output:

- Versioned RPA assistant profile
- Template, Skill, and Knowledge reference bindings
- Topic-level context overrides
- Resolved `EffectiveRpaContext`
- DSL generation provenance
- Immutable `RpaRunContextSnapshot`
- Migration and compatibility result

How to use:

- User selects and configures an assistant from the right chat header.
- User optionally binds Knowledge sources, allowed Skills, recommended Templates, and capability-specific model overrides in the Automation section.
- A new task inherits assistant defaults and may temporarily adjust its context without modifying the assistant.
- DSL generation resolves the effective context, selects the best available template/skill/planner path, and shows its provenance in chat.
- Before execution, the user reviews target devices, dependencies, warnings, and the resolved context; the executor then stores an immutable snapshot.

Exception handling:

- Missing assistant profile: create or use an empty profile and continue with the selected chat model.
- Deleted or disabled optional asset: omit it, preserve the reference warning, and allow the user to remap it.
- Missing required Template Skill or incompatible Skill version: block executable validation and require rebinding or template revision.
- Knowledge unavailable or retrieval timeout: continue only when the dependency is optional and display a degraded-generation warning.
- Multiple Templates match: rank and display candidates; do not silently execute one.
- Selected model lacks visual capability: use a compatible configured visual override or block visual steps with a configuration action.
- Invalid model override: fall back only when the base chat model satisfies the required capability; otherwise block the affected operation.
- Assistant switch conflicts with topic overrides: preserve the current draft and require explicit preserve, remap, or clear selection.
- Profile or asset version changes before execution: re-resolve dependencies and show the difference before confirmation.
- Snapshot persistence failure: do not start execution because the run would not be reproducible.
- Migration failure: leave the original assistant unchanged, log through `loggerService`, and allow retry or rollback.

Acceptance criteria:

- The right chat header is the only primary assistant/model configuration entry; the left RPA sidebar has no duplicate assistant selector.
- Tests cover profile CRUD/versioning, shared asset references, assistant deletion isolation, and idempotent legacy migration.
- Tests cover binding, unbinding, required dependencies, optional dependency degradation, version mismatch, and deleted assets.
- Tests cover precedence resolution across system, assistant, topic, Template, and execution-confirmation layers.
- Tests cover model capability validation, visual-model override, compatible fallback, and blocked incompatible execution.
- Tests cover Template parameterization, Skill compilation, and free-form Planner fallback selection.
- Generated DSL displays Template, Skill, Knowledge, profile, and model provenance.
- Every started run contains a persisted context snapshot and replay remains stable after assistant or asset updates.
- Existing assistants, topics, prompts, models, presets, and MCP settings remain readable until the P7 role migration completes; generic chat behavior is intentionally not retained after that migration.
- No asset is duplicated into the Assistant entity, and deleting an assistant does not delete shared assets or historical snapshots.
- No external workflow scheduler or alternate execution path is introduced by P5-2.

### P5-3. Reposition Knowledge Base as RPA SOP and Experience Library

Background:

Knowledge base should become the reviewed, human-readable long-term memory for app operating manuals, SOPs, policy notes, failure explanations, and recovery guidance. Executable page states, transitions, locators, and recovery rules remain owned by the P6 skill engine.

Function:

- Add RPA knowledge categories: app SOP, page-state explanation, locator guidance, failure case, recovery guidance, version note, and policy note.
- Allow Planner and Recovery to retrieve relevant SOP and failure knowledge by app package, task goal, state ID, and error classification.
- Support saving run summaries and human-reviewed fixes into knowledge.
- Link knowledge entries to RPA templates and skill versions.
- Keep ordinary document RAG support available for imported manuals.
- Link to structured skill states, transitions, and failure fingerprints by ID instead of copying their executable definitions into knowledge records.

Input:

- Existing knowledge base records
- Run history summaries
- Debug bundle summaries
- RPA template metadata
- App package and state recognition metadata

Output:

- RPA SOP entries
- Experience and failure entries
- Knowledge references attached to plans and corrections
- Suggested RPA template updates

How to use:

- Chat and Planner retrieve SOP knowledge before generating DSL.
- Recovery retrieves known failure handling before open-ended VLM correction.
- Users can accept a run summary into the experience library after review.

Exception handling:

- Low-confidence or unreviewed entries should not auto-modify RPA templates.
- Sensitive screenshots, text, tokens, and account data must be redacted or skipped.
- Conflicting SOP entries require user review instead of automatic selection.
- Knowledge import must not overwrite executable skills or failure fingerprints.

Acceptance criteria:

- Tests cover RPA knowledge entry typing, retrieval by app/task/state, redaction, and linking to RPA templates.
- Planner prompts can include relevant SOP summaries without manual copy/paste.
- Failed-run summaries can be saved as reviewed experience entries.
- Knowledge entries can link to skill versions without becoming a second source of truth for executable behavior.

### P5-4. Reposition Files as RPA Evidence and Asset Library

Background:

The file module is useful, but as a mobile RPA product it should primarily manage imported SOP documents and execution evidence such as screenshots, UI XML, OCR output, run logs, and debug bundles.

Function:

- Add RPA file categories for SOP imports, screenshots, UI trees, OCR captures, run logs, debug bundles, exported DSL, and app reference images.
- Allow files to be attached to RPA templates, run records, knowledge entries, and bug reports.
- Support importing files into knowledge or RPA Templates when the file type is recognized.
- Enforce retention, size limits, and redaction for sensitive evidence.
- Keep generic file browsing available as an advanced view.
- Reuse `RpaArtifactStore`; this module does not implement screenshot, UI tree, OCR, or log capture.

Input:

- Uploaded or generated files
- Run artifacts
- Debug exports
- Imported SOP documents
- RPA template and knowledge links

Output:

- Categorized RPA assets
- Evidence references
- Import results
- Retention and redaction metadata

How to use:

- Run replay and debug export can open related evidence in the file module.
- Users can import a SOP document and convert it into knowledge or an RPA template draft.

Exception handling:

- Large artifacts are compressed, summarized, or omitted according to policy.
- Unsupported file types remain stored but are not auto-imported.
- Sensitive content is redacted before sharing or long-term persistence.

Acceptance criteria:

- Tests cover file categorization, artifact linking, SOP import routing, redaction, and retention limits.
- Debug bundle files can be attached back to a run or issue workflow.
- Existing file attachments in chat remain compatible.
- Evidence generated by P6 observation services appears in Files without duplicate persistence.

### P5-5. Build the RPA DSL Template Repository and Visual Editor

Background:

Reusable workflows require a dedicated repository and visual editor without introducing another execution engine. RPA Templates stores validated DSL and links to P6 skill definitions while every run remains owned by the RPA runtime.

Function:

- Display saved RPA DSL templates and show linked skill ID/version metadata where applicable.
- Show template name, goal, app package, steps, risk level, last run status, success rate, tags, and updated time.
- Provide a readable step timeline and raw DSL editor with validation.
- Submit execution only through `RpaBatchRunner` and `RpaTaskExecutor`.
- Remove execution paths that bypass RPA validation, policy, replay, or run history.
- Use `RpaTemplateRepository` as the only template source of truth and `RpaSkillRepository` for skill links.

Input:

- RPA task DSL
- Optional linked skill ID and version
- Run history
- Device selection
- Module registry metadata

Output:

- RPA template records
- Editable DSL drafts
- Validation results
- Execution requests
- Template-to-run links
- Template-to-skill links without duplicating skill definitions

How to use:

- Users open RPA Templates to find, edit, duplicate, execute, export, or version reusable RPA tasks.
- Chat-generated RPA DSL can be saved into RPA Templates for reuse.

Exception handling:

- Invalid DSL remains a draft and cannot execute.
- Unknown modules block execution and show registry alternatives.
- Records that are not valid RPA DSL are excluded from the executable template catalog.

Acceptance criteria:

- Tests cover listing saved DSL, opening details, editing validation, execution submission, and invalid legacy-record filtering.
- RPA Template execution goes through the RPA safety and replay pipeline.
- Legacy Taskflow records are not migrated or executed.
- RPA Templates cannot directly edit executable skill state graphs; skill changes go through the shared improvement proposal review flow.

### P5-6. Save Chat-generated RPA DSL into RPA Templates

Background:

Chat is a good place to generate a first RPA DSL draft, but reusable automation should not stay buried in a chat message. Users need a direct save path into RPA Templates.

Function:

- Add "save as RPA template" for generated RPA DSL blocks in chat.
- Save task name, goal, DSL, module metadata, selected app, tags, source chat message, and creation context.
- Support save as new template, overwrite existing template, or save as new version.
- Validate DSL before allowing executable save; invalid drafts can still be saved as non-executable drafts.
- Link the saved RPA template back to the chat message.

Input:

- Chat-generated RPA DSL
- Source assistant message
- User-provided template metadata
- Validation result

Output:

- RPA template draft or executable template
- Source-link metadata
- Validation issues
- User-facing save result

How to use:

- User reviews a generated DSL in chat and clicks save.
- Saved template becomes available in RPA Templates for editing and execution.

Exception handling:

- Duplicate template name: ask to overwrite, rename, or create new version.
- Invalid DSL: save only as draft unless user fixes validation issues.
- Missing device IDs: save as reusable template with devices unassigned.

Acceptance criteria:

- Tests cover saving valid DSL, saving invalid draft, duplicate handling, source chat linking, and re-opening the template from RPA Templates.
- Saved templates can be executed after selecting devices.
- Chat blocks show the linked RPA template status.

### P5-7. Review and Apply Run Improvement Proposals

Background:

Run replay and debug export already preserve evidence. P6 Trace Learning will analyze that evidence and generate structured improvement proposals. P5 owns the user-facing workflow for reviewing, approving, rejecting, and applying those proposals to templates, skills, or knowledge.

Function:

- Add actions on run history: create a template draft, request trace analysis, open a generated proposal, save an approved summary to knowledge, and attach evidence.
- Display the trace summary, failure classification, confidence, evidence, proposed structured changes, and validation result generated by P6-5.
- Track which RPA template and version produced each run.
- Let approved proposals create a new template version, skill version, or reviewed knowledge entry through the owning repository.
- Prevent unreviewed model suggestions from silently changing executable templates.
- Track proposal state, reviewer, source runs, application result, and target version lineage in `RpaImprovementProposalRepository`.

Input:

- Run history
- Replay timeline
- Debug artifacts
- Existing RPA templates
- Knowledge base entries
- Improvement proposals generated by P6-5

Output:

- Reviewed proposal decision
- New template, skill, or knowledge version when approved
- Evidence links
- Version lineage

How to use:

- After a run completes or fails, P6-5 creates a proposal and the user reviews it from Run History.
- Future planning and recovery can retrieve reviewed knowledge, template metadata, and approved skill versions.

Exception handling:

- Failed or partial runs cannot overwrite executable templates without user confirmation.
- Sensitive evidence must be redacted before knowledge save or export.
- Conflicting feedback creates a review task instead of auto-applying changes.
- Proposal validation or application failure leaves the target unchanged and keeps the proposal reviewable with an error result.

Acceptance criteria:

- Tests cover proposal display, approval, rejection, validation failure, template/skill/knowledge application, evidence linking, version lineage, and review-before-apply.
- Run history can show whether feedback has already been saved.
- Accepted feedback is available to Planner or Recovery retrieval.

### P5-8. Delete Legacy Taskflow and Non-RPA Execution Paths

Background:

The legacy Taskflow plugin duplicates orchestration, Python execution, storage, logs, and node editing outside the RPA safety and verification pipeline. Keeping it hidden or read-only still leaves two competing automation architectures and creates a path for unverified execution to return.

Function:

- Delete the legacy Taskflow plugin, routes, visual nodes, logs, store, IPC bridge, LangGraph service, script generator, Python executor, and main-process service.
- Remove the `/taskflow` route, sidebar entry, translation namespace, local-storage ownership, and direct execution commands.
- Retain only the current `RpaTemplateRepository`, RPA template list, timeline/JSON editor, and chat save flow under `/rpa-templates`.
- Route every template execution through `RpaTaskValidator`, safety policy, execution confirmation, device target resolution, `RpaBatchRunner`, correction, verification, replay, and improvement proposals.
- Keep the existing chat-monitor automation script under its owning MCP module rather than the deleted plugin.
- Reject legacy Taskflow-shaped records instead of migrating, preserving, importing, or executing them.
- Keep the one-time sidebar-key migration only to remove stale navigation state from existing installations.

Input:

- Route and sidebar configuration
- Legacy plugin and main-process source tree
- Current RPA template repository and editor
- RPA execution and safety services

Output:

- A single RPA Templates entry and route family
- Deleted legacy Taskflow source and IPC surface
- Device-agnostic validated RPA template records
- RPA-only execution requests and run records

How to use:

- Users generate DSL in chat, save it as an RPA template, edit it in RPA Templates, select devices during confirmation, and execute it through the current RPA runtime.
- Existing installations automatically replace the stale Taskflow sidebar key with the RPA Templates key.

Exception handling:

- Legacy-shaped records found in current template storage are filtered out and never exposed as executable templates.
- Invalid RPA DSL remains a non-executable RPA draft with validation issues.
- Missing or unavailable devices block execution in the standard confirmation flow.
- No fallback may invoke the removed Python executor, old IPC handlers, legacy store, or legacy route.

Acceptance criteria:

- The legacy Taskflow plugin directory and main-process service no longer exist.
- The router exposes `/rpa-templates`, `/rpa-templates/create`, and `/rpa-templates/edit/:id`, with no `/taskflow` route.
- No legacy Taskflow IPC command, local-storage owner, Python executor, LangGraph service, or visual node remains.
- Tests verify route removal, source deletion, legacy-record rejection, template editing, and execution through `RpaBatchRunner`.
- RPA DSL generation remains available in chat and device scanning remains available through execution confirmation and device management.

### P5-9. Consolidate Device Selection into Execution Confirmation

Background:

The generated RPA block currently renders a separate device section with online-device scanning and selection before the user opens "Confirm and Execute". The confirmation dialog then shows risk information but does not own target selection. This duplicates execution state across chat content and the modal, makes reusable DSL appear bound to transient devices, and can produce a mismatch between displayed devices and the final batch-run request.

Function:

- Remove the device title, refresh action, online-device alert, device list, and device-selection controls from generated RPA chat content.
- Keep chat content focused on the editable DSL timeline, validation, provenance, and the "Confirm and Execute" command.
- Add a target-device section to the execution-confirmation dialog alongside risk level, step count, and safety approval.
- Support target modes: manually selected devices, one or more device groups, and all currently online devices.
- Reuse persisted device groups from `device.groups` and device-to-group metadata from `device.info`; do not introduce a second grouping store.
- Resolve selected groups into concrete device IDs and visibly distinguish online, offline, unauthorized, missing, and ungrouped devices.
- Allow manual inclusion or exclusion after selecting groups while keeping the resulting device list explicit.
- Scan when the confirmation dialog opens and provide a refresh action inside the dialog.
- Re-scan immediately before submission and compare the result with the reviewed selection.
- Keep generated and saved reusable DSL device-agnostic. Device IDs selected for one execution are passed as a `RpaBatchRunner` execution override and are not written back into the Template DSL.
- Preserve DSL-defined device requirements only as validation constraints or selection hints; do not silently use stale concrete device IDs.
- Show the final device count and affected group count in the execution summary before the user confirms.
- Provide an entry from the confirmation dialog to the consolidated device-management dialog when devices need authorization, grouping, or connection repair.

Input:

- Validated editable RPA task DSL
- Risk and safety-policy result
- Fresh device scan result
- Persisted `device.groups`
- Persisted `device.info`
- User-selected target mode, group IDs, device inclusions, and device exclusions

Output:

- `RpaExecutionTargetSelection` containing target mode, selected group IDs, resolved device IDs, exclusions, and scan timestamp
- Execution-confirmation summary with risk, steps, groups, and device count
- `RpaBatchRunner` start request using the final resolved online device IDs
- Device-agnostic reusable DSL and Template records

How to use:

- User generates and edits an RPA workflow in chat without selecting devices in the message content.
- User clicks "Confirm and Execute".
- The dialog scans devices and lets the user select individual devices, device groups, or all online devices.
- The user reviews risk level, workflow size, target groups, and final device count in one place.
- On confirmation, the system performs a fresh preflight scan, resolves the final online IDs, requests any required safety approval, and starts the batch run.

Exception handling:

- No online devices: block execution, keep the DSL and dialog state, and provide refresh and device-management actions.
- Device scan failure: keep the dialog open, preserve the user's selection intent, show the error, and allow retry.
- Empty group: disable execution for that group and show that no devices are assigned.
- Group contains only offline or unauthorized devices: block that group from producing an executable target and explain the status.
- Group contains partially unavailable devices: list excluded devices and require explicit confirmation to continue with the online subset.
- Manually selected device disconnects before submission: block submission, refresh status, and require the user to review the changed target set.
- Device becomes unauthorized: remove it from the executable set and provide a device-management entry for authorization recovery.
- Group membership changes while the dialog is open: re-resolve the group during preflight and show the added/removed-device difference.
- Duplicate devices selected through multiple groups or manual selection: de-duplicate by device ID.
- DSL validation or safety approval fails: do not start a run and preserve the selected target configuration for retry.
- Batch-run start failure: keep the generated DSL and report the final attempted device IDs without persisting them into the Template.

Acceptance criteria:

- Generated RPA chat content no longer renders a Device section, device refresh button, online-device warning, or device selector.
- "Confirm and Execute" displays risk information and a complete device/group selection workflow.
- Tests cover manual selection, multiple groups, all-online selection, manual include/exclude, de-duplication, and final Runner device IDs.
- Tests cover no online devices, empty groups, partially offline groups, unauthorized devices, scan failure, stale selection, and disconnect-before-submit.
- Opening device management from confirmation preserves the editable DSL and returns to a refreshed confirmation flow.
- Saved Templates remain device-agnostic and can be executed against a different group without editing DSL.
- Run history records the actual resolved device IDs and selected group metadata used for that execution.

### P6-1. Extend Observation with UI Tree and OCR

Background:

Screenshot-only VLM recognition is expensive and can be unstable. UIAutomator and OCR provide deterministic signals that improve page state recognition, target location, and verification. These signals must be available before implementing the state recognizer that consumes them.

Function:

- Add optional UIAutomator XML capture to observations.
- Add optional OCR blocks with text, bounding boxes, and confidence.
- Normalize UI node and OCR coordinates into screenshot and physical screen coordinate spaces.
- Prefer UI tree and OCR for text/button detection before VLM.
- Persist selected UI/OCR evidence through `RpaArtifactStore` with retention and redaction limits.
- Keep capture, parsing, and coordinate normalization in the observation layer; P5 Files only catalogs and presents the resulting artifacts.
- Apply a reproducible humanized input policy after deterministic target resolution: bounded click jitter, safe target insets, cubic Bezier swipe paths, easing, configurable delays, and per-device serialization.
- Record the seed, requested coordinate, actual coordinate, swipe control points, sampled path, duration, and transport fallback in run data for replay and audit.
- Do not apply humanized input to CAPTCHA solving or security-control bypass; these states must follow failure, timeout, or human-intervention policy.

Input:

- `deviceId`
- Observation options
- Screenshot frame metadata
- Optional target text or locator hints

Output:

- UI tree nodes
- OCR text blocks
- Normalized bounding boxes
- Text locator candidates
- Observation warnings when UI/OCR is unavailable
- Artifact references for evidence selected for persistence

How to use:

- Visual modules attempt UI/OCR lookup before VLM lookup.
- State recognizer uses UI/OCR evidence to classify app pages.
- Verification can assert text or node presence without invoking VLM.
- Files displays persisted evidence by resolving artifact references from the shared store.

Exception handling:

- UIAutomator unavailable: continue with screenshot and OCR/VLM.
- OCR timeout: return partial observation with warnings.
- Coordinate mismatch: re-query screen size and normalize using frame metadata.
- Sensitive text: redact before persistence according to policy.
- Artifact persistence failure: continue with in-memory observation, record a warning, and do not duplicate the artifact in another store.
- Bezier motion-event injection unavailable: fall back to one bounded ADB swipe and record the fallback transport without retrying an unbounded gesture sequence.

Acceptance criteria:

- Tests cover UI tree parsing, OCR block normalization, text target lookup, fallback to VLM, coordinate mapping, and sensitive text redaction.
- Observation objects include optional UI/OCR fields without breaking existing screenshot-only flows.
- Verification supports text or UI-node assertions for common page checks.
- Persisted UI/OCR evidence is visible through P5 Files using the same artifact ID.
- Tests cover seeded click jitter, Bezier path reproducibility, per-device action serialization, and recorded transport fallback metadata.
- Real-device acceptance confirms UIAutomator capture, OCR coordinate mapping, bounded click coordinates, and Bezier/fallback swipe behavior on the unified scrcpy/ADB toolchain.

Implementation status (2026-07-27): complete. Code and automated coverage include UI tree capture and parsing, OCR normalization, coordinate mapping, text lookup, artifact persistence, redaction, deterministic input humanization, per-device serialization, and transport fallback audit data. Real-device acceptance passed on authorized device `3B6656026JF00000` (`PLR110`, 1272 x 2800): UIAutomator produced a 67-node tree and matched the `关于本机` page title; Windows System OCR recognized the same title from the captured phone screenshot and the observation layer produced its bounded approximate OCR evidence; a seeded bounded tap stayed inside the selected title bounds; a 12-sample cubic Bezier swipe trace was reproducible and the unified ADB fallback completed the swipe while the foreground activity remained `Settings$MyDeviceInfoActivity`.

### P6-2. Implement App State Recognizer

Background:

Visual correction from a single screenshot is not enough when a task starts from an unexpected app page. The system needs to identify where the device currently is in the app flow before choosing a recovery action.

Function:

- Classify the current app page into a stable `stateId` such as `HOME`, `PROFILE`, `SEARCH`, `DETAIL`, `LOGIN`, `PERMISSION_DIALOG`, `BLOCKED_BY_POPUP`, or `UNKNOWN`.
- Combine screenshot evidence, foreground package/activity, UI tree, OCR text, and recent run context.
- Return confidence, evidence, blocking status, and suggested state transitions.
- Expose state recognition to Planner, Orchestrator, Verification, and Recovery layers.
- Store recognized states as run artifacts through `RpaArtifactStore` for replay and learning.

Input:

- Device observation
- Target app profile
- Optional expected state
- Recent step and verification history

Output:

- Recognized app state
- Confidence score
- Evidence list
- Blocking condition classification
- Suggested next recovery scope

How to use:

- Orchestrator captures a fresh observation before visual steps and failed-step recovery.
- Recovery checks the recognized state before asking VLM for coordinates.
- Planner can use state summaries instead of raw screenshots when generating or repairing DSL.

Exception handling:

- Low confidence: request a fresh observation and add OCR/UI tree evidence if available.
- Conflicting evidence: mark state `UNKNOWN` and use deterministic recovery rules.
- Unsupported app version: keep the observation and state evidence for failure feedback.
- Missing screenshot: fall back to foreground app, activity, and UI tree if available.

Acceptance criteria:

- Tests cover known states, unknown states, popup-blocked states, low-confidence output, and conflicting evidence.
- Recognized state is included in run events, replay timeline, and debug bundles.
- Failed visual correction receives the latest recognized state in its context.

Implementation status (2026-07-23): complete. The recognizer combines foreground package/activity, UI tree, OCR, screenshot availability, expected state, and recent run events; emits confidence, evidence, blocking classification, recovery scope, and suggested transitions; persists state evidence through `RpaArtifactStore`; and feeds the latest recognized state into correction events, replay/debug data, and VLM recovery prompts. Automated coverage includes known, unknown, permission/popup-blocked, low-confidence, conflicting-evidence, missing-screenshot, artifact persistence, and executor/VLM integration cases.

### P6-3. Add RPA Skill Library and Compiler

Background:

Reusable app flows should be stored as structured skills rather than regenerated from a prompt for every run. This makes automation auditable, repeatable, and easier to improve after failures.

Function:

- Define a skill format for app-specific tasks, states, transitions, entry points, fallback rules, and success assertions.
- Compile skills into validated RPA DSL steps and recovery policies.
- Support state aliases, UI version hints, target locators, and prohibited actions.
- Allow reviewed successful-run templates and manually authored SOPs to propose reusable skills after parameterization and state validation.
- Version skills so changes can be reviewed and rolled back.
- Use `RpaSkillRepository` as the only source of truth for skill definitions; RPA Templates only displays links and compiled/template outputs.

Input:

- Skill definition
- Target app package
- Task goal
- Current recognized app state
- Selected device IDs

Output:

- Validated RPA task DSL
- Skill metadata and version
- Required observations and assertions
- Recovery policy for known states

How to use:

- User selects a saved skill or Planner chooses a matching skill for the task goal.
- Skill compiler emits DSL using registered modules only.
- Orchestrator records the skill version with each run.

Exception handling:

- Invalid skill schema: reject and show field-level errors.
- Unknown module or locator: reject during compilation.
- Missing target app or package: keep skill as draft.
- Skill version mismatch: warn and require explicit update before execution.

Acceptance criteria:

- Tests cover valid skill compilation, invalid skill rejection, unknown module rejection, version metadata, and state-specific fallback compilation.
- A skill can produce a runnable DSL without calling the LLM.
- Run history records the skill ID and version used for execution.
- Skill conversion requires review and cannot be triggered automatically by saving a template.

Implementation status (2026-07-23): complete. Added a versioned `RpaSkillRepository` with schema validation, revision history, lifecycle controls, aliases, app-version hints, structured locators, fallback rules, success assertions, prohibited actions, rollback, and IPC-backed persistence. Added a deterministic `RpaSkillCompiler` that resolves parameters and recognized-state aliases, selects a bounded transition path, prepends state-specific fallbacks, validates every module, and emits runnable DSL with Skill/version provenance and app-state metadata. Planner now prefers matching enabled Skills before LLM planning, while approved improvement proposals can create validated Skill revisions through the repository adapter without bypassing review. Runtime configuration, Knowledge links, execution confirmation, and run metadata consume the repository catalog as the source of truth. Automated coverage includes repository validation and versioning, compiler paths and failures, Skill-first planning without model calls, proposal application, and main-process persistence.

### P6-4. Implement Deterministic Navigation Recovery

Background:

Common failures such as "not on the home page" should not require open-ended VLM reasoning. The system needs a bounded recovery strategy that moves the app back to a stable anchor state.

Function:

- Add deterministic recovery policies such as close popup, handle permission, tap home tab, press back, press home, restart app, and reopen target app.
- Define an `UNKNOWN -> known state` recovery sequence per app or skill.
- Run state recognition after each recovery action.
- Enforce max recovery depth, no-progress detection, and action rate limits.
- Use VLM only for bounded target selection inside a known recovery rule.

Input:

- Failure context
- Recognized app state
- Skill recovery rules
- Latest observation
- Safety policy

Output:

- Recovery action sequence
- Updated recognized state
- Recovery result and evidence
- Human handoff reason when recovery is exhausted

How to use:

- Orchestrator invokes deterministic recovery before open-ended replan when the failed step is caused by app state mismatch.
- Recovery returns to a stable state, then retries the original step or compiled skill segment.

Exception handling:

- Repeated same state: stop after no-progress limit and request human intervention.
- Risky or unsupported state: skip automation and pause.
- Navigation action fails: capture fresh observation and continue only if state changed.
- Login, CAPTCHA, payment, or account security state: immediately enter `needs_human`.

Acceptance criteria:

- Tests cover `UNKNOWN -> HOME`, popup close, permission dialog, back navigation, restart app, no-progress stop, and human handoff.
- Deterministic recovery is attempted before VLM free-form recovery for state mismatch failures.
- Recovery events appear clearly in execution progress and replay.

Implementation status (2026-07-23): complete. Added `RpaDeterministicRecoveryService` to select validated Skill recovery policies before bounded built-in navigation rules. Skill compilation now persists parameter-resolved recovery policies with target states in task metadata. The executor runs deterministic recovery before free-form VLM correction, re-captures screenshot/UI/OCR evidence and recognizes state after every action group, retries the original step only after target-state verification, and applies recovery depth, deadline, safety-policy, rate-limit, and no-progress controls. Built-in recovery covers permission dialogs, blocking overlays, Back navigation, Home plus app reopen, and force-stop/restart through the unified device runtime. Authentication, CAPTCHA, payment, account-security, and unsupported-version states pause immediately for human intervention. Recovery plan, action, verification, and terminal events are exposed in live execution records and replay. Automated coverage includes configured Skill policies, `UNKNOWN` navigation stages, permission handling, restart transport, verified retry without VLM, no-progress handoff, protected-state handoff, and replay phases.

### P6-5. Add Trace Learning and Failure Feedback

Background:

Run history and debug bundles already record what happened, but failures are not converted into structured, reusable improvement proposals. This service owns analysis and proposal generation; P5 Run History owns review and application.

Function:

- Analyze successful traces to infer stable states, transitions, locators, and success assertions.
- Analyze failed traces to classify failure causes such as `NOT_ON_HOME`, `ENTRY_NOT_VISIBLE`, `LOGIN_REQUIRED`, `POPUP_BLOCKED`, `NETWORK_ERROR`, `UI_CHANGED`, and `NO_PROGRESS`.
- Propose skill updates or fallback rules based on repeated evidence.
- Keep proposed changes reviewable before they are applied.
- Store failure fingerprints to avoid repeating known bad recovery loops.
- Generate a shared `RpaImprovementProposal` targeting a template, skill, or knowledge entry without mutating the target.
- Keep failure fingerprints in a structured runtime store and link them from Knowledge instead of copying them into RAG documents.

Input:

- Run history
- Replay timeline
- Debug bundle artifacts
- State recognition results
- Verification and correction outcomes

Output:

- Trace summary
- Failure classification
- Suggested skill updates
- New or updated state transitions
- Known-failure fingerprints
- Structured improvement proposal with source runs, target type, evidence, confidence, proposed changes, and review state

How to use:

- After each completed, failed, or `needs_human` run, the learning service creates a trace summary and zero or more reviewable proposals.
- P5 Run History presents proposals and applies approved changes through the owning repository.
- Planner and Recovery can query known failures before executing risky correction loops.

Exception handling:

- Sensitive artifacts: redact or skip according to policy.
- Insufficient evidence: create a low-confidence suggestion only.
- Conflicting runs: require manual review before updating skills.
- Repeated failed suggestion: disable that suggestion and mark it as rejected.
- Proposal repository unavailable: keep the analysis result attached to the run, report persistence failure, and do not mutate any target.

Acceptance criteria:

- Tests cover trace summarization, failure classification, redacted artifacts, repeated-failure aggregation, proposal generation, and no-mutation-before-review behavior.
- Failed run history can generate at least one actionable skill fallback proposal.
- Proposals approved and applied through P5-7 update the owning repository without mutating historical run records.

Implementation status (2026-07-23): complete. Added terminal-run trace analysis for successful, failed, and `needs_human` device runs, including state transitions, locator and assertion hints, evidence artifact links, redacted summaries, failure classification, and persisted analysis records. Added structured, version-independent failure fingerprints with occurrence aggregation, protected-state human handoff, failed-policy suppression, disable lifecycle, IPC persistence, and corrupt-file preservation. Trace Learning now creates reviewable Skill fallback or Knowledge proposals without mutating the owning repository, links proposal evidence, and leaves application to the existing P5 review flow. Planner prompts and task provenance consume matching known failures, while deterministic recovery skips repeatedly failed policies and routes known human-only conditions directly to intervention. Automated coverage includes successful and failed traces, English and Chinese protected-state classification, redaction, repeated-failure aggregation, proposal generation, no-mutation-before-review, run lifecycle integration, Planner and Recovery consumption, and main-process persistence.

### P7-1. Define the App Automation Role Domain and Compatibility Bridge

Background:

Application automation needs an app-centered configuration unit, but it must not invalidate the Assistant Profile and historical snapshots already implemented in P5. The technical name must also remain distinct from model or execution role terminology.

Function:

- Define RpaAppRole as the technical schema while the UI may display Role.
- Store app packages, supported versions, lifecycle, version, prompt/model defaults, asset bindings, provider bindings, and provenance.
- Support primaryRoleId, supportingRoleIds, and systemCapabilities for cross-app and Android system tasks.
- Keep RpaAssistantProfile operational through a compatibility adapter during P7.
- Add optional Role provenance to new DSL and run snapshots without rewriting historical assistantId, assistantProfileVersion, or topicId data.
- Use qualified asset references composed of Role ID, asset type, asset ID, and version.

Input:

- Existing Assistant and RpaAssistantProfile records
- Existing asset, model, prompt, provider, and snapshot contracts
- App package and version metadata

Output:

- RpaAppRole schema and repository
- Compatibility adapter
- Qualified Role and asset reference contract
- Backward-compatible snapshot extension

How to use:

- A session selects one primary Role and optional supporting Roles.
- Existing Assistant Profile flows continue until migration and cutover are verified.

Exception handling:

- No Role: allow goal drafting and Role suggestions, but block executable validation and execution.
- Disabled Role: preserve replay and block new executable revisions.
- Missing required supporting Role: block with a dependency report.
- Historical snapshot without Role data: continue through its original Assistant Profile context.
- Active run: block destructive Role changes.

Acceptance criteria:

- Existing P5 behavior remains functional.
- Cross-app tasks resolve primary and supporting Roles.
- Qualified references do not collide.
- Historical snapshots remain stable.
- Tests cover CRUD, versioning, compatibility, cross-role context, lifecycle, deletion protection, and snapshot stability.

Implementation status (2026-07-23): complete. Added the versioned `RpaAppRole` domain with app scope, lifecycle, supporting Roles, system capabilities, qualified asset references, independent ownership and requirement semantics, model defaults, and Assistant Profile compatibility provenance. Added a repository with atomic queued writes, version increments, lifecycle updates, active-run deletion guards, and supporting-Role reference protection. Existing `RpaAssistantProfile` records can be adapted deterministically without copying asset bodies or disabling the P5 flow. Added IPC/localStorage persistence, main-process atomic JSON storage with corrupt-file preservation, and optional primary/supporting Role provenance in DSL and run snapshots while retaining schema-version-1 historical compatibility. Automated coverage includes sanitization, namespace safety, compatibility adaptation, repository versioning, deletion protection, Role provenance, legacy snapshots, IPC typing, and main-process persistence.

### P7-2. Implement Effective Role Context and Asset Ownership Resolution

Background:

Runtime services need one immutable Role context. Ownership and requirement are separate concepts and must not be represented by one ambiguous binding state.

Function:

- Implement EffectiveRpaRoleContextResolver over system defaults, primary Role, supporting Roles, Assistant Profile compatibility data, session overrides, Template dependencies, and execution overrides.
- Model ownership as owned, linked, or shared and requirement as required or optional.
- Keep assets in existing repositories; Roles store qualified bindings and provenance only.
- Define deterministic conflict rules for versions, app scope, model overrides, prohibited actions, and duplicate assets.
- Allow cross-role assets only through supporting Roles or explicit shared-library references.
- Persist Role IDs, versions, resolved asset versions, warnings, and compatibility-adapter version.
- Route improvement proposals to the qualified owning Role and target asset version.

Input:

- Role references and compatibility context
- Overrides, catalogs, Template dependencies, models, and provider capabilities

Output:

- Immutable EffectiveRpaRoleContext
- Resolved assets, prompts, models, providers, warnings, and readiness
- Conflict and dependency report
- Reproducible provenance

How to use:

- Resolve before planning and again before execution confirmation.
- Verification, Recovery, replay, and Trace Learning consume the persisted snapshot.

Exception handling:

- Required version conflict: block and identify both bindings.
- Optional asset missing: continue with a degraded warning.
- Shared asset changed: require explicit refresh.
- Unresolved improvement target: keep the proposal pending.
- Role and compatibility data disagree: prefer explicit Role data and report the mismatch.

Acceptance criteria:

- One resolver owns runtime context construction.
- Required assets cannot be silently excluded.
- Cross-role usage has explicit provenance.
- Ownership and requirement are independently tested.
- Planner, execution, replay, and improvement review use identical Role/version references.

Implementation status (2026-07-23): complete. Added the immutable `EffectiveRpaRoleContext` resolver over the primary Role, explicitly declared supporting Roles, Assistant Profile compatibility data, catalogs, model availability, topic overrides, system defaults, and execution overrides. Role bindings now preserve independent `owned`/`linked`/`shared` ownership and `required`/`optional` requirement semantics, qualified source Role provenance, resolved catalog versions, deterministic priority, app-package scope, system capabilities, and primary-Role model precedence. Required Role, asset, availability, and version issues block planning or execution; optional failures and shadowed model overrides remain auditable warnings. Undeclared supporting Roles and cross-Role references cannot contribute assets or model defaults. Planner prompts receive the resolved Role context and assets, generated DSL metadata persists Role/version provenance, and the execution path resolves the same context again before confirmation so run snapshots, replay, and improvement records retain stable references. The current UI uses a deterministic Assistant Profile compatibility Role until the P7-4 Role Library and selection workspace is available. Automated coverage verifies immutable output, ownership and requirement behavior, missing and inactive Roles, version conflicts, cross-Role isolation, model precedence, Planner prompt injection, DSL metadata, and legacy snapshot compatibility.

### P7-3. Inject Versioned Role Prompts and Bounded Retrieved Context

Background:

Role prompts and manuals must influence planning without becoming a way to override schema, safety, verification, or human-intervention policy.

Function:

- Add versioned Planner, Verification, Recovery, system, and capability prompts to EffectiveRpaRoleContext.
- Inject only prompts relevant to the current model call.
- Enforce DSL schema, module allowlists, Safety Policy, verification, timeout, and intervention rules in code outside the model.
- Treat Knowledge, remote content, OCR, UI text, and imported documents as untrusted data.
- Apply independent budgets to prompts, local Knowledge, remote Knowledge, observations, and execution history.
- Require structured model payloads; humanReadableExplanation is display and audit metadata only.
- Persist prompt versions, source IDs, model IDs, truncation, redaction, and conflicts.

Input:

- Effective Role context, retrieved content, observations, execution history, goal, and clarification answers

Output:

- Bounded Role-aware model context
- Structured Planner, Verification, and Recovery results
- Prompt and retrieval provenance

How to use:

- Role prompts provide stable app behavior and Knowledge is retrieved by relevance.
- Runtime validates structured results before execution.

Exception handling:

- Missing optional prompt: use the fixed RPA contract and warn.
- Oversized prompt: reject or summarize by field policy.
- Prompt injection: preserve as quoted evidence and record the conflict.
- Prompt changed before execution: re-resolve and display the difference.
- Prose-only response: repair once, then expose validation errors.

Acceptance criteria:

- Role prompts influence planning without weakening code-enforced policy.
- Large Knowledge respects explicit budgets.
- Explanatory prose cannot execute.
- Provenance is reproducible.
- Tests cover precedence, injection, schema/safety override attempts, budgeting, repair, and truncation.

Implementation status (2026-07-23): complete. Added a versioned `RpaRolePrompt` contract for System, Planner, Verification, Recovery, and Capability guidance while retaining qualified Role asset references and primary-Role precedence. `EffectiveRpaRoleContext` now resolves enabled prompt versions only from explicitly declared Roles. Added `RpaModelContextBuilder` with independent budgets for Role prompts, local Knowledge, remote Knowledge, observations, execution history, and clarification answers; binary screenshots are omitted from text evidence, secrets are redacted, oversized sources are truncated, and prompt-injection or precedence conflicts are recorded without changing the fixed runtime contract. Planner, Verification, and Recovery receive only prompts relevant to their call type plus applicable Capability prompts. DSL schema, module allowlists, safety decisions, verification thresholds, timeouts, and human-intervention rules remain code-enforced. Planner and Recovery retain one structured repair attempt, and Verification now repairs prose-only or malformed assertions once before returning an uncertain result. Bounded Prompt snapshots flow through task metadata to execution, while DSL/run snapshots persist only prompt/source versions, model IDs, budgets, truncation, redaction, and conflict provenance rather than evidence or prompt bodies. Automated coverage includes prompt sanitization and versioning, declared-Role isolation, primary precedence, call-type filtering, Capability propagation, independent budgets, large Knowledge truncation, secret redaction, injection detection, structured repair, executor propagation, and replay-safe provenance.

### P7-4. Build the Role Library and Role Detail Workspace

Implementation status (2026-07-27): complete. Added a primary Role Library route with readiness, lifecycle, app-package, asset-count, migration-state, recent-run, and active-run summaries. Catalog actions cover create, duplicate, enable/disable, guarded delete, import/export, edit, and direct Role-selected session entry. The Role detail workspace owns reusable prompts, Knowledge, Skills, files/evidence, versions, and Role metadata, but no longer binds concrete Retrieval, Artifact, URL, or MCP Provider instances. Legacy Provider bindings are ignored and removed during Role sanitization. Provider connectivity, credentials, health, and Resource discovery belong to the workspace runtime, while each Session explicitly selects the evidence Provider it needs. Role Prompt persistence is versioned and atomic, supporting Role cycles are rejected with an explicit cycle path, broken dependencies and active-run restrictions are visible, and native Role selection now reaches the Planner instead of falling back silently to the Assistant compatibility Role. Automated coverage includes catalog summaries, Provider-binding migration, duplicate namespace rewriting, lifecycle/deletion guards, prompt versioning, supporting Role cycles, and main-process persistence.

Background:

Users need an app-centered management surface without duplicating every existing asset editor.

Function:

- Introduce Role Library after the compatibility bridge exists.
- Show apps, packages, versions, lifecycle, readiness, asset counts, provider health, migration state, and recent runs.
- Support create, edit, duplicate, enable, disable, delete, import, export, and start-session actions.
- Keep concrete Provider configuration out of Role detail; Providers are workspace resources selected per Session.
- Reuse existing editors through Role-filtered routes or shared components.
- Show supporting Roles, shared assets, broken bindings, incompatible versions, unavailable providers, and active-run restrictions.
- Start a Role-selected DSL session directly from Role detail.

Input:

- Role repository and resolver
- Existing repositories and editors
- Provider, migration, import, and run status

Output:

- Role Library and Role detail workspace
- Readiness and compatibility summary
- Role-filtered asset management
- Direct session entry

How to use:

- User selects a Role, manages assets through filtered editors, and starts a session.
- Aggregate views remain available only when Role ownership is visible and filterable.

Exception handling:

- Empty Role: editable but not executable.
- Deleted asset: preserve unresolved reference and offer repair.
- Provider unavailable: allow unrelated local editing.
- Active run: block destructive changes.
- Supporting Role cycle: reject and identify the cycle.

Acceptance criteria:

- Role Library does not duplicate repository ownership.
- Existing editors work in Role-filtered context.
- Readiness and broken dependencies are visible.
- Tests cover catalog actions, filtered editors, supporting Roles, navigation, lifecycle, and deletion protection.

### P7-5. Add Secure Remote Retrieval and Tool Providers

Implementation status (2026-07-23): complete. Added separate RetrievalProvider, ArtifactProvider, and ToolProvider contracts with provider health, required/optional semantics, credential references, normalized snippet provenance, bounded ranking, deduplication, redaction, and imported-provider quarantine states. Added a secure Provider gateway for allowlisted tools with parameter validation, explicit approval, timeout, per-tool rate limiting, and centralized audit events. Remote HTTP execution now crosses an IPC boundary into a main-process transport that enforces TLS, domain allowlists, DNS resolution, private-address blocking, manual redirect validation, MIME allowlists, declared and streamed size limits, and network timeout. The renderer independently revalidates redirect chains, resolved addresses, MIME, and size before accepting content. Automated coverage includes public success, private DNS rejection, unsafe protocol/domain rejection, imported configuration state, tool validation, approval, rate limits, and provenance/audit behavior.

Background:

Read-only remote content and executable MCP tools have different risk profiles and require separate contracts.

Function:

- Define RetrievalProvider, ArtifactProvider, and ToolProvider separately.
- Support vector search, remote files, bounded HTTP or signed URL resources, and explicitly approved MCP tools.
- Store descriptors and credential references separately from secrets.
- Normalize retrieved snippets with source, URI, hash/version, confidence, scope, and timestamp.
- Apply ranking, deduplication, redaction, budgets, and provenance.
- Route tools through allowlists, parameter schemas, Safety Policy, approval, timeout, rate limits, and audit events.
- Add SSRF protection, private-address blocking, redirect limits, TLS checks, domain allowlists, MIME checks, size limits, and network timeouts.
- Import remote providers disabled or needs_configuration until trust and credentials are confirmed.

Input:

- Role provider bindings, goal, app state, secure credentials, policies, and budgets

Output:

- Provider health and capabilities
- Ranked snippets and remote Artifact references
- Policy-checked tool results
- Retrieval and tool provenance

How to use:

- Planner requests bounded retrieval through RetrievalProvider.
- Full files are fetched only for explicit inspection.
- ToolProvider is invoked only through approved registered capabilities.

Exception handling:

- Optional timeout: degrade with warning.
- Required provider unavailable: block dependent operation.
- Authentication failure: disable until repaired.
- Unsafe URL, redirect, type, or size: reject before processing.
- Untrusted tool or missing approval: block invocation.

Acceptance criteria:

- Retrieval and executable tools use separate interfaces.
- Remote content cannot override RPA contracts.
- Network protections cover SSRF, redirects, MIME, and size.
- Tool calls are validated, approved, rate-limited, and audited.
- Tests cover success, timeout, authentication, network attacks, degradation, required blocking, tool approval, and provenance.

### P7-6. Implement Signed Role Pack Import, Export, and Transactional Restore

Implementation status (2026-07-23): complete at the service and transaction-contract layer. Added a versioned RolePackManifest with app scope, permissions, dependencies, compatibility, publisher identity, signature metadata, file declarations, sizes, and SHA-256 checksums. Export recursively removes credential-like fields and machine-local secrets. Validation rejects path traversal, undeclared files, invalid JSON, size/checksum mismatches, and invalid signatures before writing. Import supports install, trusted replace with baseVersion and active-run checks, deterministic fork namespace rewriting, cancel, unsigned/untrusted quarantine, disabled imported Providers, repository snapshots, and full rollback on any transaction failure. Automated coverage includes secret-free round trip, quarantine, traversal/checksum rejection, deterministic fork, conflict guards, and rollback restoration. Product UI activation remains behind the P7 migration/cutover gate so an untrusted pack cannot bypass Role ownership or approval.

Background:

Checksums prove integrity rather than publisher trust. Import must not silently replace local work.

Function:

- Define RolePackManifest with metadata, app scope, prompts, models, assets, providers, qualified bindings, checksums, publisher, signature, permissions, dependencies, and compatibility.
- Export eligible content without credentials or machine-local secrets.
- Validate paths, checksums, signatures, schemas, DSL, Skills, dependencies, permissions, and compatibility in staging.
- Support install, replace, fork, and cancel import modes.
- Allow replace only after impact preview; trusted updates also require matching publisher and compatible baseVersion.
- Keep stable IDs for trusted install/replace; fork creates a new namespace and rewrites internal references deterministically.
- Add a transaction and backup service across all affected repositories.
- Quarantine unsigned or untrusted packs with tools and providers disabled.
- Produce trust, conflict, change, permission, provider, and rollback reports.

Input:

- Role Pack, existing same-ID Role, trust store, and import policy

Output:

- Exported Role Pack
- Installed, replaced, forked, or quarantined Role
- Backup and transaction record
- Validation and trust report

How to use:

- User previews identity, permissions, conflicts, and changes before import.
- Replacement creates a new Role version and retains the prior recoverable version.

Exception handling:

- Invalid signature: reject or quarantine.
- Traversal, checksum, schema, or dependency failure: reject before writing.
- Local version conflict: block replacement until resolved.
- Active run: block replacement.
- Transaction failure: roll back every repository.
- Missing credentials: mark providers needs_configuration.

Acceptance criteria:

- Invalid packages never partially modify data.
- Local changes are never silently overwritten.
- Trusted repeated imports are deterministic.
- Fork rewrites references consistently.
- Export contains no secrets.
- Tests cover round trip, signed update, quarantine, replace, fork, conflicts, rollback, traversal, invalid assets, and active runs.

### P7-7. Build the RPA DSL Session alongside the Compatibility Topic Flow

Implementation status (2026-07-23): complete. Added a persistent, versioned RpaDslSession repository covering primary/supporting Role references, goal, attachments, observations, bounded clarifications, immutable DSL revisions, validation issues, executable state, Template links, run links, replay links, and improvement links. Session mutation uses optimistic concurrency checks, executable revisions must match the immutable Role/version context, execution is blocked until validation succeeds, and prose remains display-only audit explanation. Main-process atomic JSON persistence is available through IPC with localStorage fallback. The existing Topic flow remains the compatibility surface; explicit Role Library entry now selects the native Role for Planner context, and successful chat planning creates or appends the matching Topic-linked DSL Session revision. Automated coverage includes generation, clarification, revision, missing Role, immutable Role context, conflict rejection, execution state, persistence, Template/run/replay/improvement links, and compatibility Topic linkage.

Background:

The new Role session must prove feature complete before existing Topic and message persistence is removed.

Function:

- Define RpaDslSession with Roles, goal, clarifications, DSL revisions, validation, Templates, runs, and improvement links.
- Support generate, revise, compare, validate, save draft, save as Template, select devices, execute, observe, repair, replay, and improve.
- Accept goals, screenshots, observations, and bounded clarification answers.
- Restrict authoritative outcomes to validated DSL, structured clarification, non-executable results, and repair proposals.
- Store humanReadableExplanation for display and audit only.
- Keep Topic compatibility behind a feature flag during migration.
- Distinguish Save from Save to Templates.
- Add revision concurrency checks and immutable Role context references.

Input:

- Role context, goal, attachments, clarification answers, assets, observations, and runs

Output:

- Versioned RpaDslSession
- Editable validated DSL revisions
- Structured clarification and non-executable results
- Draft, Template, execution, replay, and improvement links

How to use:

- User starts from Role Library or drafts a goal and selects a suggested Role before execution.
- Subsequent input revises DSL, resolves clarification, or responds to execution feedback.

Exception handling:

- No Role: preserve draft and suggest Roles, but block executable status.
- Cross-app goal: resolve primary and supporting Roles.
- Malformed response: repair once and expose errors.
- Invalid draft: allow draft save but block execution.
- Concurrent revision: require merge or reload.

Acceptance criteria:

- Session covers the complete RPA lifecycle without executing prose.
- Topic compatibility remains during validation.
- Executable revisions reference immutable Role context.
- Save behaviors are distinct.
- Tests cover Role suggestions, cross-app tasks, generation, clarification, repair, conflicts, persistence, Template saving, execution, and replay.

### P7-8. Migrate Legacy Data and Verify Dual-read Compatibility

Implementation status (2026-07-23): implementation complete; acceptance gate pending. Added a checkpointed, idempotent migration controller that creates a backup before writes, converts Assistant plus RpaAssistantProfile records into compatibility Roles, converts only RPA-relevant Topics into non-executable-until-validated DSL Sessions, preserves Topic/history linkage, reports unassigned and multiply assigned assets, and resumes without duplicate ownership. Dual-read comparison covers assets, model defaults, and compatibility provenance, and any mismatch leaves migration in the dual-read phase. Rollback restores the captured backup and records rolled_back state. Automated tests cover idempotency, Topic linkage, ownership reporting, dual-read equality, cutover rejection without device evidence, and rollback. Remaining acceptance: execute representative single-app and cross-app flows on connected real devices and attach evidence IDs; until both pass this item remains unchecked.

Background:

Migration and rollback must complete before old routes or readers are removed.

Function:

- Migrate Assistant plus RpaAssistantProfile to RpaAppRole idempotently.
- Convert RPA-relevant Topics to RpaDslSession without injecting generic messages into Planner context.
- Assign assets through existing references and app metadata.
- Preserve legitimate shared references and report unassigned or multiply assigned assets.
- Preserve historical snapshots and store migration linkage separately.
- Add checkpointed backup, resume, rollback, and migration reports.
- Run legacy and Role readers in dual-read mode and compare assets, models, prompts, and provenance.
- Add end-to-end tests for Role creation/import through execution, replay, improvement, update, and reuse.
- Complete real-device acceptance for representative single-app and cross-app flows.

Input:

- Legacy records, Role/session schemas, app metadata, backup and migration policy

Output:

- Migrated Roles and sessions
- Qualified bindings and archived non-RPA metadata
- Migration, comparison, backup, and rollback reports
- Automated and real-device acceptance results

How to use:

- Migration runs in checkpoints and can resume safely.
- Users review unresolved ownership.
- Dual-read comparison remains until differences are accepted or repaired.

Exception handling:

- Interrupted migration: resume checkpoint.
- Unknown ownership: leave unassigned and report.
- Dual-read mismatch: block cutover for affected Roles.
- Rollback: restore backup and retain diagnostics.
- Missing historical assets: preserve available data and mark replay degraded.

Acceptance criteria:

- Migration is idempotent and creates no duplicate ownership.
- Executable assets are assigned or reported.
- Approved Roles pass dual-read comparison.
- Historical replay remains stable.
- End-to-end and real-device acceptance pass.
- Rollback restores compatibility workflow.

### P7-9. Switch Primary Navigation and Retire Legacy Entry Points

Implementation status (2026-07-23): gated implementation complete; cutover intentionally not activated. Added a persisted cutover evidence contract requiring migration completion, approved dual-read results, rollback test, end-to-end pass, single-app real-device pass, and cross-app real-device pass. When enabled, navigation is Role-centered and standalone aggregate asset entries are filtered; Assistant and Topic deep links resolve deterministically to owning Roles or migrated Sessions, while unassigned data opens migration review. Rollback immediately disables redirects and restores compatibility navigation. Compatibility readers cannot be retired until the retention window expires with no rollback active. Automated coverage verifies all gate conditions, redirects, unassigned records, navigation filtering, rollback, and retention. Remaining acceptance: approve P7-8 real-device evidence, run final end-to-end UI QA, then enable the gate; legacy code is deliberately retained until those conditions pass.

Background:

Legacy entry points are removed only after migration, dual-read comparison, rollback testing, and Role-session acceptance pass.

Function:

- Make Role Library, Role-scoped Templates, active runs, run history, and RPA DSL sessions the primary navigation.
- Move asset management into Role-filtered surfaces while reusing existing repositories and editors.
- Redirect legacy links to the owning Role, migrated session, replay, or migration report.
- Remove generic chat creation and assistant-response paths from the primary workflow only after the cutover gate.
- Remove selectors that bypass EffectiveRpaRoleContext.
- Preserve compatibility readers, replay contracts, and rollback data for the retention period.
- Remove dead flags and legacy code only after the rollback window closes.
- Update documentation and QA.

Input:

- Passed migration and acceptance report
- Role/session routes
- Legacy navigation and compatibility readers
- Retention and rollback policy

Output:

- Role-centered navigation
- Redirect and retirement map
- Removed duplicate entry points
- Read-only replay and compatibility boundary
- Final cutover report

How to use:

- Users enter through Role Library, Role Template, active run, run history, or RPA DSL session.
- Unassigned legacy data opens migration review.

Exception handling:

- Gate not satisfied: keep compatibility navigation.
- Migrated deep link: redirect deterministically.
- Unassigned data: open migration review.
- Replay needs removed editor: render immutable snapshot.
- Rollback active: retain compatibility readers.

Acceptance criteria:

- Cutover requires migration, dual-read, rollback, end-to-end, and real-device approval.
- Primary navigation cannot configure automation assets outside a Role.
- Historical runs and unassigned data remain discoverable.
- Aggregate views show Role ownership.
- Tests cover redirects, cutover gating, rollback, filtered editors, replay, and unassigned data.
- Documentation no longer presents generic chat or standalone asset modules as the target workflow.

### P7-10. Consolidate Role Configuration and Scheduled RPA Task Flows

Implementation status: code complete; automated and desktop UI acceptance passed. Real-device immediate and scheduled execution acceptance remains pending.

Background:

The RPA workspace currently exposes Template recommendations in both Assistant settings and Role assets. This reverses the intended ownership model and makes a reusable DSL look like Role configuration. A Role must own the prompts, Skills, Knowledge, providers, model defaults, and policies used to plan and execute work. A reusable task flow must independently own its DSL and select the Role and device scope required at execution time.

Function:

- Bind every RPA conversation session to an immutable `roleId + roleVersion` when the conversation is created.
- Starting a conversation from the Role Library automatically creates or opens a Role-scoped DSL session.
- Switching Role starts a new session instead of mutating the Role provenance of an existing session.
- Replace the right-side Assistant RPA settings with the active Role configuration for Knowledge, Skills, prompts, providers, model defaults, and supporting Roles.
- Remove Template recommendation and Template binding controls from Assistant and Role configuration.
- Stop exposing Template as an Effective Role Context or Planner asset. Keep legacy Template bindings readable only for migration and audit.
- Rename the product surface from `RPA Templates` to `RPA Task Flows`, while retaining compatible storage readers and legacy route redirects.
- Store a task-flow reference to its required `roleId + roleVersion`; never store a task-flow reference on the Role.
- Add one-time, interval, and cron schedules with timezone, enabled state, device/device-group scope, overlap policy, and missed-run policy.
- Restore enabled schedules in the main process when the application starts and publish due-trigger events to the renderer.
- Route manual and scheduled execution through the existing validation, safety confirmation policy, device resolution, `RpaBatchRunner`, correction, verification, audit, and replay chain.
- Persist trigger history with scheduled time, actual trigger time, run ID, outcome, and skip/failure reason.

Input:

- Active Role and immutable Role version
- Role assets and model defaults
- Device-agnostic task DSL
- Schedule type and expression
- Timezone, device IDs or group IDs
- Overlap and missed-run policies

Output:

- Role-scoped conversation and DSL session
- Effective Role configuration shown in the right settings drawer
- Independent RPA task-flow record
- Persistent schedule and calculated next run time
- Trigger audit linked to the resulting RPA run

How to use:

- Create or select an RPA Role, then start a conversation from that Role.
- Configure prompts, Skills, Knowledge, providers, and model defaults in the Role workspace or the bound right settings drawer.
- Generate and save a DSL as an RPA Task Flow.
- Select the required Role, configure a schedule and target devices or groups, then enable it.
- Use `Run now` for an immediate run through the same execution path.

Exception handling:

- Missing or disabled Role: block the trigger and record a dependency failure.
- Role version drift: pause the schedule until the user confirms upgrading to the current Role version.
- Invalid DSL or missing required Skill/Knowledge/provider: block execution and show the dependency report.
- Offline device: apply the configured missed-run policy and keep an actionable audit record.
- Overlapping run: apply `skip`, `queue`, or `forbid overlap`; never start an untracked duplicate.
- Application shutdown or restart: persist schedule state and recalculate missed executions on restore.
- Clock or timezone change: recalculate `nextRunAt` from the schedule expression and stored timezone.
- Execution timeout or correction exhaustion: use the standard retry, VLM correction, LLM replanning, manual intervention, pause, and alert policies.
- Renderer unavailable at trigger time: retain a pending trigger and dispatch it after the RPA execution host is ready.
- Legacy Template binding: preserve it in migration evidence, but do not expose or resolve it into new Role sessions.

Acceptance criteria:

- A new Role-scoped session stores immutable `roleId + roleVersion` and the right drawer edits that Role.
- No new Assistant Profile, Role, Planner, or Effective Role Context record contains a Template recommendation or binding.
- Existing saved Templates remain readable as RPA Task Flows and old routes redirect without data loss.
- Every task flow selects a Role; Role records never select task flows.
- One-time, interval, and cron schedules survive application restart and calculate the correct next run in the configured timezone.
- Scheduled and manual runs both execute through `RpaBatchRunner` and create linked audit records.
- Device/group resolution, overlap, missed-run, offline-device, version-drift, and dependency failures are covered by automated tests.
- Real-device acceptance proves one immediate task flow and one scheduled task flow on a selected device.

### P7-11. Make the RPA Session Orchestrator the Only Role-scoped Input Path

Implementation status: P7-11.1 through P7-11.5 complete. Role-scoped inputs now enter a persisted Session Orchestrator without a mode toggle or generic chat fallback, supported quick device commands compile into one-node DSL tasks, and compatibility sessions retain the legacy intent-gated path. Structured outcomes now separate first generation, immutable revision, bounded clarification, deterministic DSL explanation, session-scoped run control, explicit new-task creation, and non-executable dependency results. Planner revisions receive the active DSL as their immutable base, clarification answers continue the original goal, invalid Planner candidates and issues are retained for audit, and generated messages link Session, Revision, and Run identities through execution. Pause, resume, stop, retry, and approved manual-intervention commands can affect only Runs linked to the current Session; execution and manual editor changes update Session status and immutable revisions. Role-scoped task controls expose explicit New, Duplicate, and End actions, protect unsaved inline DSL through Save, Discard, or Cancel, preserve immutable Role provenance, and duplicate only the active revision into an independent Session without Run or improvement history. Contextual Replan is evidence-gated on validation failure, failed execution, correction exhaustion, or manual intervention and creates a traceable immutable `repair` revision while failed Planner candidates remain auditable. Session planning now follows an explicit `latest_wins` policy across normal planning and Contextual Replan: newer requests cancel older work, late responses fail ownership, base-Revision, and expected-version checks, and pending, accepted, stale, cancelled, timed-out, or failed results remain auditable without changing the optimistic DSL version. Every newly generated, revised, repaired, manually edited, or duplicated Revision retains an immutable request envelope and sanitized model/effective-context provenance; Run snapshots continue to preserve the execution-time model and provider selections. P7-11.6 remains planned. Default cutover remains blocked until P7-8 and P7-9 are approved and P7-10 immediate real-device acceptance passes.

Background:

The current task input still exposes a temporary `RPA workflow planner` mode button. When the mode is disabled, only text recognized by `RpaIntentDetector` enters the Planner; other input can fall through to direct device commands or the legacy generic chat response path. This produces inconsistent behavior and allows a Role-scoped task request to return descriptive text instead of an auditable RPA result.

The replacement must not assume that every input mutates the DSL. Questions, clarification answers, run-control commands, and explicit new-task requests all belong to the RPA task session, but require different deterministic outcomes. The invariant is that every Role-scoped input enters the RPA Session Orchestrator and never falls back to the generic assistant-response path.

#### P7-11.1. Define the Task-session Interaction Protocol and State Machine

Function:

- Define a versioned input envelope containing `requestId`, `sessionId`, `baseRevision`, immutable `roleId + roleVersion`, input text, attachments, active run reference, and resolved model/context references.
- Route each accepted request to one explicit interaction outcome: `create_dsl`, `revise_dsl`, `answer_clarification`, `explain_dsl`, `control_run`, `create_new_task`, or `non_executable`.
- Define task-session states: `empty`, `planning`, `needs_clarification`, `draft`, `validating`, `ready`, `executing`, `paused`, `completed`, `failed`, and `non_executable`.
- Define the allowed transitions and reject state-incompatible requests without silently creating a new session or changing Role provenance.
- Persist every input, outcome, transition, reason, and source revision for replay and audit.

Input:

- Current task-session state and latest accepted revision
- Natural-language request or supported attachment
- Active run state when execution exists
- Immutable Role and effective context references

Output:

- Structured interaction decision and allowed next state
- Persisted audit event linked to the request and source revision
- Bounded rejection when the request is incompatible with the current state

Exception handling:

- Unknown or stale session: require an explicit task selection or new-task action.
- Unsupported transition: preserve the request and return the allowed actions for the current state.
- Invalid interaction decision: do not invoke the Planner; persist a protocol failure and expose retry.

#### P7-11.2. Replace Intent Detection and Generic Chat Fallback with Session Routing

Function:

- Remove the `RPA workflow planner` mode button and the one-shot `rpaMode` state.
- Remove `RpaIntentDetector` from the primary Role-scoped input path.
- Route every non-empty Role-scoped request through the RPA Session Orchestrator before selecting Planner, explanation, clarification, or execution-control behavior.
- Compile an explicit quick device command into an auditable one-node DSL instead of bypassing validation, confirmation, execution, verification, and replay.
- Remove the generic assistant-response fallback from the primary Role-scoped workflow.
- Keep compatibility routing only behind the P7 cutover and rollback gate.

Input:

- Non-empty task input
- Active Role-scoped session
- Current interaction and execution state

Output:

- One structured interaction outcome
- No untracked direct device action or generic assistant response

Exception handling:

- Empty input: keep the current draft without creating an audit event.
- Missing or inactive Role: return `non_executable` with the Role dependency issue.
- Legacy route while cutover is disabled: use the compatibility reader and record that compatibility routing was used.

#### P7-11.3. Implement Generation, Revision, Clarification, Explanation, and Run-control Outcomes

Function:

- `create_dsl`: generate the first validated editable DSL revision for an empty task session.
- `revise_dsl`: apply a bounded change to the current DSL and preserve prior immutable revisions.
- `answer_clarification`: merge the answer into the pending planning request and continue the same request chain without creating a new task.
- `explain_dsl`: answer from the persisted DSL, validation report, provenance, and run evidence without modifying the DSL revision.
- `control_run`: map pause, resume, stop, retry, and approved manual-intervention actions to the existing execution-control APIs without invoking the Planner unless a contextual Replan is explicitly required.
- `create_new_task`: create a new session with a new `sessionId` and independent revision history while retaining the selected Role version.
- `non_executable`: persist dependency, capability, policy, or state issues without falling back to generic chat.
- Return only structured outcomes that the task-session UI can render and audit.

Input:

- Interaction decision
- Existing DSL and pending clarification when present
- Validation, execution, correction, and manual-intervention evidence
- Effective Role context and bounded retrieved evidence

Output:

- New immutable DSL revision, clarification request, explanation, execution-control result, new session, or non-executable result
- Stable request, session, revision, Role, asset, model, provider, and evidence provenance

Exception handling:

- Ambiguous task goal: request only the minimum fields required to produce valid DSL.
- Planner failure or invalid DSL: preserve the failed candidate and expose retry or contextual Replan.
- Explanation request with no DSL: return the valid next actions instead of inventing a workflow.
- Run-control request with no active run: return a state error without modifying the DSL.

#### P7-11.4. Add Explicit Task Lifecycle Actions and Contextual Replan Entry Points

Function:

- Replace chat-shaped `New topic` with explicit `New task`, `Duplicate task`, and `End task` actions.
- Require `New task` when the user wants a different goal, incompatible Role, or independent revision history.
- Keep the chat-header model selector as the default planning model selector; remove only per-message model mentions and controls that can make a revision irreproducible.
- Move `Replan` out of the primary task toolbar and expose it only on the generated DSL, validation failure, execution failure, correction exhaustion, or manual-intervention surfaces.
- Require contextual Replan to include the current DSL, source revision, validation or execution evidence, effective Role context, and replan objective.
- Keep device selection exclusively in execution confirmation; planning remains device-agnostic unless a capability constraint must be declared.

Input:

- Explicit lifecycle action or contextual Replan request
- Current task session, DSL revision, and available evidence

Output:

- New task session, duplicated draft, ended session, or a traceable Replan revision

Exception handling:

- Unsaved draft on new/end task: request discard, save, or cancel without silently losing revisions.
- Role switch: create a new task session instead of mutating the existing session provenance.
- Replan without sufficient evidence: request the missing observation or validation result before invoking the Planner.

Implementation status: complete. Role sessions replace the chat-shaped topic action with explicit New task, Duplicate task, and End task controls while compatibility chats keep the existing topic action. New and duplicated tasks create independent Role-bound Topics and Sessions; duplication copies only the active DSL revision and clears Run, replay, planning-failure, interaction, and improvement history. Ended Sessions are persisted as read-only and cannot accept further revisions. Registered inline DSL editors protect lifecycle transitions with Save, Discard, or Cancel. Contextual Replan is available from validation failures and failed or manual-intervention execution surfaces, requires immutable Role/version alignment plus validation or execution evidence, submits the current DSL and source revision to the Planner, and stores the accepted result as a new `repair` revision. Execution-time temporary correction remains owned by `RpaReplanService`; full Session revision is owned by `RpaContextualReplanService`. Automated coverage verifies lifecycle persistence, draft handling, Role/evidence gates, Planner failure auditing, ended-session routing, and Replan UI visibility. Desktop interaction and real-device acceptance remain part of P7-11.6.

#### P7-11.5. Add Revision Concurrency Control and Immutable Model/context Provenance

Function:

- Use `requestId + sessionId + baseRevision + expectedVersion` for optimistic concurrency control.
- Queue, cancel, or reject overlapping planning requests according to an explicit session policy; never allow an older response to overwrite a newer accepted revision.
- Mark late Planner responses as stale audit evidence when their base revision no longer matches.
- Resolve the chat-header model as the default Planner model, then apply explicit Role model defaults or stage-specific overrides according to the Effective Role Context policy.
- Snapshot the final Planner, visual, verification, and correction model/provider selections on every accepted DSL revision and run.
- Treat a model change as affecting the next revision only; never rewrite historical revision provenance.
- Support cancellation and timeout without leaving the session permanently in `planning` or `validating`.

Input:

- Planning request envelope and current repository version
- Chat-header model, Role defaults, stage overrides, and provider availability

Output:

- Accepted revision, queued request, cancelled request, version conflict, or stale response record
- Immutable resolved model and effective-context snapshot

Exception handling:

- Revision conflict: reject the write and offer rebase against the latest revision.
- Model unavailable after request creation: return `non_executable` or request an approved model replacement.
- Timeout or cancellation: restore the last stable session state and retain partial evidence for retry.

Implementation status: complete. Added a Session-scoped `latest_wins` planning coordinator shared by first-generation, revision, quick-command, and Contextual Replan paths. Each request is ordered by creation time, owns an AbortSignal, cancels older in-flight work, rejects an older request that reaches planning late, and verifies request ownership plus immutable `sessionId`, `baseRevision`, and `expectedVersion` immediately before any Revision write. Planner audit records are version-neutral and persist `pending`, `accepted`, `stale`, `cancelled`, `timed_out`, and `failed` outcomes without causing their own optimistic-concurrency conflict. User stop and bounded timeout abort Planner work; only the still-current request may restore the Session, and overlapping planning events unwind to the last non-planning state. `RpaDslRevision.requestContext` stores the accepted request envelope and sanitized `RpaDslProvenance`, including resolved Planner, visual, verification, and recovery model/provider references, Role/version context, asset versions, warnings, and bounded model-context provenance. Manual edits inherit their source provenance, Contextual Replan snapshots its newly resolved context, and duplication rewrites the envelope for the independent Session while preserving the immutable source model context. Execution continues to create a separate immutable `RpaRunContextSnapshot`, so later model changes affect only subsequent Revisions or Runs. Automated coverage verifies latest-wins ordering, late-old-request rejection, explicit cancellation, timeout, stale Session/version/base checks, stable-state restoration, version-neutral audit persistence, immutable model snapshots, duplicate envelope rewriting, and Contextual Replan provenance. Desktop concurrency interaction and migration/rollback acceptance remain part of P7-11.6.

#### P7-11.6. Complete Gated Migration, Rollback, and Acceptance

Implementation status: implementation and automated acceptance complete; final real-device scenario approval remains pending. Added a single runtime routing policy that binds Role-scoped input to the existing P7 cutover state: an approved gate uses the Session Orchestrator, an active rollback or pending production cutover uses compatibility RPA, and a Role-scoped request can never silently fall back to generic chat. Development preview is explicit and defaults on only in development builds. Added versioned, bounded telemetry for compatibility, cutover, and rollback routing, attempted generic fallback, stale revisions, clarification loops, non-executable outcomes, and successful DSL revisions. Compatibility readers and legacy writers now share an auditable retirement decision and remain active until all evidence is approved, rollback is inactive, and retention has elapsed. Migration rollback captures and restores RPA Sessions, immutable Revisions, planning audits, and linked Runs around legacy backup restoration. Automated unit and gated desktop-integration coverage verifies route selection, rollback, retention, evidence preservation, telemetry, immutable revision persistence, and generic-fallback rejection. Full format, lint, typecheck, i18n, test, and production build checks pass; the Electron development application starts successfully and the bundled ADB detects device `3B6656026JF00000` (`PLR110`). The gate remains disabled by default until the required generated-task, follow-up revision, quick-command, clarification, execution-driven Replan, single-app, and cross-app real-device evidence is reviewed and approved.

Function:

- Implement the new path behind the existing P7 cutover gate.
- Require approved P7-8 migration and dual-read evidence, P7-9 redirect and rollback evidence, and P7-10 immediate real-device acceptance before enabling it by default.
- Retain read-only legacy readers and rollback behavior for the documented retention period.
- Add telemetry and audit counters for compatibility routing, generic fallback attempts, stale revisions, clarification loops, non-executable results, and successful DSL revisions.
- Remove legacy writers only after the retention window expires with no active rollback.

How to use:

- Open or create a Role-scoped task session.
- Describe a new mobile task in the single task input to create the first DSL.
- Use follow-up input to revise or explain the current DSL, answer a clarification, or control an active run.
- Use `New task` for a separate goal and `Duplicate task` to branch from an existing DSL.
- Review and edit the DSL, then choose devices and confirm execution.
- Use contextual `Replan` only when validation or execution evidence requires a new plan.

Acceptance criteria:

- The primary Role-scoped task input contains no RPA mode toggle, `New topic`, or per-message model selection control.
- Every non-empty Role-scoped input enters the RPA Session Orchestrator without keyword-based RPA intent detection or generic chat fallback.
- Not every request mutates the DSL: explanation and run-control requests leave the current revision unchanged.
- Explicit quick device commands compile into one-node DSL tasks and pass through confirmation, execution, verification, audit, and replay.
- `New task` creates a new `sessionId`; clarification answers continue the same request chain; bounded revisions create immutable new versions.
- Rapid consecutive requests cannot allow an older Planner response to overwrite a newer accepted revision.
- The chat-header model remains the default, Role/stage overrides resolve deterministically, and every accepted revision records immutable model/provider provenance.
- Contextual Replan receives the current DSL, source revision, validation or execution evidence, and Effective Role Context.
- Planning, clarification, explanation, revision, execution control, timeout, cancellation, dependency failure, version conflict, rollback, and stale-response behavior are covered by unit and integration tests.
- Desktop UI acceptance covers the task lifecycle, removal of generic chat controls, persisted structured outcomes, and contextual Replan surfaces.
- Real-device acceptance proves one generated task, one follow-up revision, one quick-command one-node DSL, one clarification loop, and one execution-driven Replan without generic fallback.
- Default cutover remains blocked until migration, rollback, end-to-end, and required real-device evidence are approved.

### P7-12. Add Session-scoped Supplemental Context and Federated Retrieval

Implementation status (2026-07-27): feature implementation is complete through P7-12.7. P7-12.8 automated coverage, desktop acceptance, and the temporary-document real-device path have passed. Existing trusted MCP servers are synchronized into the workspace RPA Provider runtime with stable `mcp:<serverId>` identities, health/resource discovery, bounded reads, timeout/cancellation, and discovered-URI enforcement. RPA Roles are independent from concrete Provider instances; a Role session explicitly selects healthy workspace Providers and MCP Resources from Supplemental Context, and the selection is frozen into the Context Snapshot. Final closure remains gated only on a real-device task using a configured healthy workspace URL or MCP retrieval Provider; the current environment has no trusted MCP server exposing Resources, and the UI correctly reports the empty dependency.

Background:

A Role must remain the stable, versioned owner of application manuals, Skills, prompts, model defaults, providers, policies, and other reusable automation assets. Users still need to add task-specific Knowledge, documents, images, URLs, remote retrieval sources, and MCP capabilities from the task input without mutating the Role or weakening reproducibility. The current generic chat tools do not consistently enter the RPA Planner path: attachments are uploaded only by the legacy chat branch, Assistant-level MCP and web-search settings are not resolved into the Role context, and temporary Knowledge selection can diverge from Role ownership. Session Supplements provide an explicit boundary for these user-selected additions.

Design constraints:

- Session Supplements are an evidence and authorized-capability selection layer, not a new asset repository, permission system, model policy, or network gateway.
- A Session may add Knowledge, Artifact, image, URL, retrieval, and execution evidence, but cannot add a Tool Provider or executable tool that is not already authorized by the immutable Role version.
- Session tool selection may only narrow the Role-approved provider and tool allowlist. A new provider or capability requires reviewed Role configuration and a new Role version. A one-time capability exception requires an explicit temporary approval record and never mutates the Role.
- Reuse `RpaArtifactStore`, `RpaKnowledgeRepository`, `RpaModelContextBuilder`, `RpaSecureProviderGateway`, and existing Provider contracts. P7-12 coordinates these services and must not implement parallel storage, redaction, network, or tool-audit systems.
- Keep existing Provider terminology: `RetrievalProvider`, `ArtifactProvider`, and `ToolProvider`. MCP Resources adapt into read-only Artifact or Evidence sources rather than introducing a competing `ResourceProvider` domain.

#### P7-12.1. Define Session Supplement Bindings and Immutable Provenance

Function:

- Add a versioned `RpaSessionSupplements` record owned by one RPA DSL Session.
- Store qualified bindings to Knowledge, Artifacts, temporary indexes, approved URLs, Retrieval Providers, Artifact Providers, and Role-authorized Tool selections; never duplicate the underlying content or credentials.
- Support `request` scope for one logical Session Orchestrator request chain and `session` scope for later revisions.
- Add `supplementRevision` to every planning request and accepted DSL revision alongside `requestId`, `sessionId`, and `baseRevision`.
- Define lifecycle states: `pending`, `ready`, `degraded`, `blocked`, `removed`, `expired`, `retained`, `promotion_proposed`, and `promoted`.
- Persist ownership, source reference, version or content hash, scope, requirement, trust metadata, retention policy, and creation/removal provenance.
- Store credential references only; never persist credentials, tokens, full remote secrets, or provider-local configuration in the Session record.

Input:

- Active RPA DSL Session and immutable Role version
- User-selected evidence or Role-authorized provider/tool reference
- Request/session scope and retention choice

Output:

- Versioned Session Supplement record and `supplementRevision`
- Immutable binding and lifecycle audit events

Exception handling:

- Cross-session reference: reject without exposing another session's metadata.
- Missing Role authorization for a Tool: block the binding and return a permission result.
- Concurrent Supplement update: reject stale writes through optimistic version checks.
- Request-scoped item after success, failure, cancellation, or final retry: expire it according to the logical request-chain policy.

Implementation status (2026-07-27): complete. Added the versioned `RpaSessionSupplements` domain, request/session-scoped qualified bindings, all planned lifecycle states, retention and trust metadata, immutable creation/removal provenance, bounded lifecycle audit history, and atomic Main-process persistence with IPC and local fallback. The Repository initializes one immutable Role-bound record per Session and applies optimistic `supplementRevision` writes. The domain service rejects Role mismatches, cross-session ownership, unapproved providers/tools, unsafe URL credentials, raw credential values, stale writes, and invalid terminal-state transitions; request-chain expiry creates tombstoned audit evidence instead of deleting history. Planning coordination, planning audit, accepted DSL revision provenance, duplication, manual edits, and Contextual Replan now carry `supplementRevision`; final writes reject a changed Supplement revision. Automated coverage verifies versioning, isolation, authorization narrowing, credential-reference policy, lifecycle expiry, terminal states, stale planning output, sanitization, and atomic persistence. Primary task-input selection and effective-context resolution intentionally remain gated on P7-12.2 and P7-12.7.

#### P7-12.2. Resolve Supplements after Effective Role Context without Expanding Permissions

Function:

- Add one `RpaSessionSupplementResolver` after `EffectiveRpaRoleContextResolver` and before model-context construction.
- Merge evidence references while preserving immutable Role identity, Role prompts, fixed DSL contract, model policy, Safety Policy, provider permissions, and tool allowlists.
- Permit Session selections to narrow Role-authorized tools and capabilities but never broaden them.
- Resolve required/optional dependencies, health, version/hash availability, app-package scope, retention state, and request/session applicability.
- Emit one immutable effective Supplement snapshot for the current Planner request.
- Treat all Session and remote content as untrusted evidence regardless of the user-selected source.

Input:

- Immutable Effective Role Context
- Session Supplement record and expected `supplementRevision`
- Provider health and artifact/index availability

Output:

- Effective Supplement snapshot
- Evidence sources and narrowed tool allowlist
- Blocking issues, degraded warnings, permission decisions, and provenance

Exception handling:

- Supplement attempts to override Role policy, model, prompt, provider permission, or DSL schema: ignore the override, record a conflict, and block when malicious or required.
- Role version changed: keep the current Session immutable and require an explicit new task or Role upgrade flow.
- Required source unavailable: return `non_executable`; optional source degrades with an audit warning.

Implementation status (2026-07-27): complete. Added `RpaSessionSupplementResolver` after the immutable Effective Role Context boundary. It validates the expected `supplementRevision`, Session Role version, independent Role permission snapshot, request/session applicability, lifecycle and retention state, source health, version, content hash, and required/optional policy. The Resolver emits a deeply frozen Effective Supplement snapshot containing qualified evidence references, selected Retrieval/Artifact Providers, a strictly narrowed Tool allowlist, blocking issues, degraded warnings, and immutable provenance fields without copying source content, credentials, model policy, prompts, Provider configuration, or DSL schema. Persisted bindings are reauthorized during every resolution so stale or tampered Provider and Tool selections cannot become executable. Required unavailable sources, Role/permission mismatches, authorization violations, and policy override attempts make the snapshot non-executable; optional or degraded sources remain auditable warnings. `RpaPlannerService` accepts the resolved snapshot, refuses to invoke the model when it is non-executable, and exposes only the bounded immutable snapshot to Planner input. Automated coverage verifies request isolation, immutable snapshots, permission narrowing, required/optional degradation, Role changes, policy override attempts, stale Supplement revisions, source version/hash conflicts, Planner blocking, and bounded Planner visibility. Artifact extraction and evidence-content retrieval remain owned by P7-12.3 and P7-12.4.

#### P7-12.3. Add Artifact Extraction, OCR, VLM Evidence, and Temporary Indexes

Function:

- Route every uploaded document, image, or supported structured file through `RpaArtifactStore`; Supplements store only Artifact and extraction/index references.
- Extract bounded text and metadata from text, Markdown, PDF, Office, and supported structured formats through reusable extraction adapters.
- Chunk extracted content into a temporary retrievable index with extractor version, chunk hash, page/section locator, language, and quality metadata.
- Process images through metadata extraction, OCR, and an approved VLM evidence operation when available.
- Store the original image as an Artifact and persist the exact bounded OCR/VLM evidence, model/provider reference, prompt version, content hash, and extraction timestamp used for planning.
- Apply category-specific file size, text budget, privacy, redaction, and retention policy before indexing.
- Never place a complete large file or unrestricted binary payload directly into model context.

Input:

- Uploaded file metadata and Artifact policy
- Approved extractor, OCR, and optional VLM model
- Session and request scope

Output:

- Artifact reference, extraction result, temporary index, and evidence references
- Explicit unsupported, degraded, blocked, or redacted result

Exception handling:

- Unsupported or oversized file: retain metadata or Artifact only when policy permits and expose the conversion/size error.
- Extraction failure: keep the Artifact reference, isolate partial chunks, and do not silently supply incomplete content.
- Image model unavailable: use bounded OCR when sufficient or request a compatible model/human description.
- Sensitive content: redact before model use and retain only policy-approved audit metadata.

Implementation status (2026-07-27): complete. Added Artifact-first document, structured-text, image OCR, and optional VLM evidence extraction; bounded redaction, chunking, hashes, locators, quality and extractor provenance; temporary index persistence, retention, tombstones, and explicit degraded/blocked results. The Planner path registers selected files before retrieval and supplies only bounded temporary-index evidence rather than unrestricted binaries or full source files.

#### P7-12.4. Implement Federated Retrieval, Rank Fusion, and Optional Unified Reranking

Function:

- Query Role Knowledge, Session Knowledge, temporary Artifact indexes, approved remote Retrieval Providers, and relevant execution history independently and in parallel.
- Apply per-source metadata filters, Top-K limits, deadlines, cancellation, and required/optional failure policy.
- Normalize results into one `RpaPlanningEvidence` contract containing source ID/type, owner, version/hash, local rank, native score, authority, relevance, freshness, extraction confidence, timestamps, locator, and retrieval metadata.
- Never compare raw similarity scores from different embedding models or stores directly.
- Use deterministic Reciprocal Rank Fusion as the default cross-source merge and record the fusion algorithm/version and source ranks.
- Optionally apply an approved cross-encoder or model reranker after rank fusion; snapshot the reranker model/provider, input hashes, output ranks, timeout, and fallback decision.
- Deduplicate exact hashes and near-duplicate chunks while preserving every contributing source reference.
- Apply diversity constraints and final bounded context budgets through the existing `RpaModelContextBuilder`.
- Represent authority, relevance, freshness, and extraction confidence independently; do not use one trust score to hide current device evidence or unresolved contradictions.

Input:

- Effective Role Knowledge and Effective Supplement snapshot
- Task goal, app package/state, clarification answers, and execution evidence
- Per-source quotas, global deadline, fusion policy, optional reranker, and context budgets

Output:

- Normalized, fused, optionally reranked, deduplicated, diverse, and bounded evidence
- Source failures, conflicts, omissions, truncation, and ranking provenance

Exception handling:

- Heterogeneous embeddings: preserve local ranks and merge through rank fusion only.
- Optional source timeout: cancel it and continue with degraded evidence; required timeout returns `non_executable`.
- Reranker unavailable or timed out: fall back deterministically to recorded rank-fusion output.
- Contradictory evidence: retain both sources, distinguish authority and freshness, and expose the conflict to Planner and user.
- Prompt injection: quote as untrusted evidence and prevent it from changing system, Role, safety, or DSL instructions.

Implementation status (2026-07-27): complete. Added independent parallel source queries with quotas, deadlines, cancellation, required/optional failure policy, normalized evidence, deterministic RRF, optional reranking with recorded fallback, exact and near-duplicate removal, contributor preservation, conflict retention, diversity limits, bounded model context, and prompt-injection isolation. Automated coverage verifies heterogeneous native scores are never directly compared, optional and required timeouts diverge correctly, reranker failure is deterministic, and duplicate sources remain auditable.

#### P7-12.5. Adapt Approved URL and MCP Sources through Existing Secure Providers

Function:

- Fetch URLs only through an existing workspace-trusted `RetrievalProvider` or `ArtifactProvider` and `RpaSecureProviderGateway`.
- Enforce the Role/provider domain allowlist, TLS, DNS/private-address checks, redirects, MIME, streamed-size, timeout, sanitization, timestamp, final URL, and content hash policy already defined by P7-5.
- User approval of a URL authorizes retrieval intent but never expands the Role/provider domain allowlist or disables network policy.
- Adapt MCP Resources into bounded read-only Artifact/Evidence results and MCP retrieval tools into `RetrievalProvider` adapters when their schemas are approved.
- Expose MCP Tool schemas only when the Tool Provider and tool are already authorized by the Role; Session selection may narrow this list.
- Route every Tool invocation through existing parameter validation, capability checks, confirmation, timeout, rate limits, Safety Policy, and audit.
- Store oversized or binary Tool output as an Artifact and supply only a bounded summary/reference to model context.

Input:

- Workspace-trusted Retrieval and Artifact Providers; Role-authorized Tool Providers
- User-approved URL or MCP source selection
- Effective narrowed allowlist and secure Provider policy

Output:

- Normalized untrusted evidence or policy-checked Tool result
- Provider health, network policy, invocation, and provenance audit

Exception handling:

- URL outside the allowlist, unsafe redirect, private address, MIME/size violation, or timeout: reject and never use unrestricted fallback access.
- MCP source unavailable: apply required/optional dependency policy.
- Tool outside the Role allowlist: block even when selected in the Session UI.
- Provider credential failure: keep only the credential reference and return a repairable dependency issue.

Implementation status (2026-07-27): complete. Added secure approved-URL, MCP Resource, and narrowed Tool adapters over `RpaSecureProviderGateway`, plus a workspace runtime Provider registry containing descriptors and instances without credentials. URL retrieval preserves domain, transport, redirect, MIME, size, timeout, sanitization, and credential-reference policy; MCP Resources become bounded read-only evidence; untrusted workspace Providers and unauthorized Tool invocations are blocked before the existing audited gateway; oversized or binary output is reduced to Artifact-required references. Automated adapter tests pass. A live remote/MCP task remains environment-gated because the current workspace has no healthy Provider exposing evidence Resources.

#### P7-12.6. Add Bounded Context Snapshots, Retention, Privacy, and Replay Policy

Function:

- Persist a per-request and per-accepted-revision Context Snapshot containing Role version, `supplementRevision`, evidence IDs/hashes, exact bounded evidence supplied to each model call when policy permits, source ranks, conflicts, omissions, truncation, redaction, provider/tool calls, and model provenance.
- Separate `audit replay` from `model replay`.
- Audit replay uses references, hashes, ranking decisions, and policy outcomes to explain what happened even when evidence bodies have expired.
- Model replay requires the exact bounded evidence and multimodal references used originally; when they are unavailable, report replay degradation instead of silently retrieving current content.
- Encrypt or protect retained evidence according to data policy and avoid duplicating original Artifact bodies in the Session record.
- Use reference counting or tombstones so Session deletion/expiry cannot leave misleading historical references or delete promoted Role assets.
- Define retention independently for original Artifact, extracted chunks/index, bounded Context Snapshot, provider result, and audit metadata.

Input:

- Effective context and ranked evidence supplied to a model call
- Artifact, privacy, retention, and replay policies

Output:

- Immutable Context Snapshot and replay capability report
- Expiry, deletion, tombstone, and retained-audit records

Exception handling:

- Evidence body expired: allow audit replay and mark model replay unavailable/degraded.
- External content changed: never fetch it silently during replay; require an explicit new retrieval and new revision.
- Artifact still referenced by historical run/revision: preserve a tombstone or approved retained snapshot according to policy.
- Promotion completed: Session cleanup must not delete the new Role-owned version.

Implementation status (2026-07-27): complete. Added atomically persisted per-request Context Snapshots with Role and Supplement revisions, exact bounded evidence and hashes, ranking and reranker provenance, conflicts, omissions, provider calls, redaction, truncation, injection metadata, model identity, independent evidence/audit retention, tombstones, and promotion protection. Audit replay remains available after evidence expiry while exact model replay explicitly degrades. Snapshot identity now propagates through planning requests, accepted DSL revisions, run context, and stale-result checks.

#### P7-12.7. Add Input UI, Source Visibility, Removal, Retention, and Promotion Proposals

Function:

- Replace generic chat Knowledge, file, URL, and MCP selections in Role-scoped sessions with one Supplemental Context control.
- Show Role-owned sources separately from request- and session-scoped Supplements.
- Require an explicit scope choice, requirement level, retention choice, and visible provider/tool permission state.
- Show extraction/indexing status, active sources, evidence counts, conflicts, degraded sources, truncation, redaction, expiry, and unsupported results.
- Prevent selection from mutating Role assets, legacy Assistant defaults, another Session, or provider permissions.
- Support remove, retain as Session evidence, and submit promotion proposal actions.
- Promotion creates a review proposal only; it never directly creates or modifies Role Knowledge, Skill, prompt, provider, Tool permission, or reusable Artifact.
- Require validation, ownership selection, security review where applicable, and a new Role/asset version before approved promotion becomes active.

How to use:

- Open a Role-scoped task session; stable Role assets appear as read-only effective context.
- Add task-specific Knowledge, files, images, approved URLs, or workspace-trusted MCP sources from Supplemental Context.
- Choose `next request` or `session` scope and review extraction/provider status before sending.
- Inspect generated DSL provenance and Context Snapshot summaries.
- Remove or retain temporary evidence, or submit useful material as a reviewed promotion proposal.

Exception handling:

- Unsaved or still-indexing Supplement on Send: wait, send without optional evidence, or cancel; never silently omit a required source.
- Tool permission missing: show the owning Role configuration path instead of enabling it from the Session.
- Promotion conflict or duplicate: merge into a review proposal with source provenance rather than overwriting an asset.

Implementation status (2026-07-27): complete. Role-scoped chat sessions now expose one `Supplemental Context` control and hide the separate attachment, Knowledge, and MCP controls. The modal supports request/session scope, required/optional dependencies, request/session/manual retention, local files, temporary Knowledge, workspace-trusted URL/MCP sources, separate Role and Session visibility, lifecycle status, removal, retention, and review-only promotion proposals. Concrete Providers are selected per Session rather than stored on the Role. Missing healthy workspace Providers are shown as an explicit unavailable state. Desktop acceptance verified the unified control, session-scoped required/manual-retention selection, local file selection, Role-versus-Session separation, and retained ready Artifact/index entries after execution.

#### P7-12.8. Complete Concurrency, Automated Coverage, Desktop UI, and Real-device Acceptance

Function:

- Extend the P7-11 request envelope and optimistic concurrency checks with `supplementRevision` and Context Snapshot identity.
- Reject stale Planner output when the DSL base revision, Role version, Supplement revision, or resolved Context Snapshot changed during planning.
- Add telemetry and audit counters for extraction failures, source degradation, fusion/reranker fallback, conflicts, injection attempts, truncation, redaction, permission blocks, stale results, replay degradation, and promotion outcomes.
- Keep the complete feature behind a Session Supplement feature flag until automated, desktop, migration, privacy, security, and real-device acceptance pass.

Acceptance criteria:

- Selecting task-input materials never mutates the Role, legacy Assistant, provider authorization, or another Session.
- Session tool selection can only narrow the immutable Role-approved allowlist; tests prove an unapproved Tool Provider/tool cannot be added or invoked.
- Every Supplement has request/session scope, ownership, version/hash, `supplementRevision`, requirement, lifecycle state, retention, and provenance.
- Documents and images flow through Artifact storage and extraction/index references rather than duplicated Session content.
- Multiple heterogeneous Knowledge sources are queried independently; raw similarity scores are never directly compared across stores.
- Deterministic rank fusion, optional reranking, source quotas, deadlines, cancellation, filters, deduplication, diversity, conflicts, and bounded budgets are fully auditable.
- Role/provider URL allowlists and P7-5 network protections cannot be expanded or bypassed from the Session UI.
- MCP Resource/Retrieval output is bounded untrusted evidence; MCP Tool access remains Role-authorized, narrowed, validated, confirmed, rate-limited, timed out, and audited.
- Every accepted DSL revision records Role version, `supplementRevision`, Context Snapshot, evidence sources/hashes, ranking decisions, conflicts, omissions, truncation, redaction, provider/tool calls, and model provenance.
- Audit replay remains available from immutable references and policy outcomes; model replay uses exact retained bounded evidence or explicitly reports degradation.
- Supplement changes during planning invalidate stale output through `baseRevision + supplementRevision + contextSnapshotId` checks.
- Temporary material can be removed, retained, or proposed for reviewed promotion without bypassing Role ownership, validation, security review, or versioning.
- Unit and integration tests cover scope isolation, authorization narrowing, heterogeneous stores, fusion/reranking, deadlines, duplicate/conflicting evidence, injection, files, images, URLs, MCP adapters/tools, stale revisions, privacy, retention, tombstones, replay, and promotion.
- Desktop UI acceptance verifies scope selection, Role-versus-Session visibility, indexing/provider status, permissions, provenance, warnings, removal, retention, and promotion proposals.
- Real-device acceptance proves one task generated with Role Knowledge plus a temporary document/image and one task generated with an approved remote or MCP retrieval source, both preserving Context Snapshot provenance through execution and replay.

Implementation and acceptance status (2026-07-27): implementation, concurrency guards, telemetry, automated tests, production build, desktop UI, and one temporary-document real-device flow are complete. Acceptance request `d8a763eb-8747-481f-8aa2-ecea5720b43a` created Context Snapshot `rpa-context-1785143171314-7fff3951`, generated executable task `rpa-task-1785143171335`, and completed batch run `rpa-batch-1785143447575-yyreiutf` on device `3B6656026JF00000`. All four steps passed and the final device screenshot showed the `About phone` page with `OnePlus Ace 6T` and ColorOS version information. The run snapshot preserved `supplementRevision: 2` and `supplementalContextSnapshotId: rpa-context-1785143171314-7fff3951`. Persisted trusted MCP configuration is bridged into `RpaSupplementProviderRuntimeRegistry`; Provider health and Resource catalogs are workspace concerns, and Supplemental Context stores the Session's explicit Provider/Resource selection in immutable provenance. RPA Roles no longer expose or persist concrete Provider bindings, while Role-authorized Tool restrictions remain unchanged. Automated coverage verifies migration of legacy bindings, workspace selection without Role binding, trusted/untrusted registration, disabled and unavailable health, successful bounded reads, and forged Provider/URI rejection. Final P7-12.8 closure remains blocked only on executing the separate live remote-evidence task because this environment currently has no trusted MCP server exposing Resources and no configured approved URL Provider.

## Default Exception Policy

### Timeout

- Every step must have `timeoutMs`.
- Timeout produces structured error with last observation.
- Safe modules may retry automatically.
- Unsafe or state-changing modules require verification before retry.

### Retry

- Use bounded retries only.
- Retry policy should include `maxAttempts`, `backoffMs`, and `retryOn`.
- Retrying a tap should normally require a fresh observation first.

### VLM Correction

- Used when a visual target cannot be found or coordinate confidence is low.
- VLM response must be structured and schema-validated.
- Low confidence pauses the task or asks for human confirmation.

### LLM Reasoning Correction

- Used when the app state differs from the expected flow.
- LLM can propose correction DSL only.
- Correction DSL must pass validation and policy checks.
- Max correction attempts must be enforced.

### Manual Intervention

- Triggered by repeated failure, low confidence, risky action, unknown popup, or user request.
- Task state becomes `needsHuman`.
- UI shows screenshot, failure reason, and action choices.
- Resume requires fresh observation and verification.

### Pause and Alert

- Used when automation cannot safely continue.
- Alert should include device ID, task run ID, failed step, reason, latest screenshot, and suggested next actions.
- If notification fails, in-app state remains visible and actionable.

### P7-13. Harden Run Ownership, Role Asset Onboarding, and Deterministic Flow Reuse

Background:

Production use exposed three closure gaps: a progress dialog could stop unrelated runs, Role asset bindings had no usable creation/import path, and successful visual execution was repeatedly replanned instead of becoming a stable reusable flow. The runtime must isolate each RPA execution, make its required assets discoverable, and treat VLM as bounded failure recovery rather than the default execution path for a verified flow.

Function:

- Cancel only the batch run displayed by the execution-progress dialog; leave every other active RPA run unchanged.
- Provide direct Knowledge creation/import navigation, Skill JSON import, and file/evidence import from the Role asset-binding dialog.
- Execute visual-target modules through deterministic UI Tree resolution first and allow verified task flows to disable normal-path VLM fallback.
- Consolidate a successful one-off run into a versioned, verified deterministic task flow.
- For a successful run derived from an existing task flow, create a reviewable improvement proposal instead of mutating the source flow.
- Compile successful temporary correction actions into deterministic modules and normalized percentage coordinates where screen dimensions are known.
- Preserve source Run, device, correction, execution strategy, and proposal lineage in metadata and audit records.

Input:

- Current batch Run ID and per-device run states
- Role and selected Knowledge, Skill JSON, or file metadata
- Completed run trace, source task-flow reference, correction actions, and screen dimensions
- UI Tree observations and visual-target aliases

Output:

- Cancellation result scoped to one batch Run
- Persisted and selectable Role assets
- Verified deterministic task flow for a successful one-off execution
- Awaiting-review task-flow improvement proposal and new-version patch for an existing flow
- Audit metadata declaring `deterministic_first_vlm_on_failure` and whether correction was used

How to use:

- Open a running RPA progress dialog and choose Stop current RPA to cancel only that Run.
- Open a Role asset tab, choose Bind asset, then create/import Knowledge, import Skill JSON, or import files/evidence before selecting the asset.
- Execute a verified task flow normally; UI Tree and compiled deterministic modules run without a normal-path VLM call.
- If deterministic execution fails, use the existing bounded correction loop, verify every correction group, and continue only after success.
- Review and apply the generated improvement proposal to create a new task-flow version; never silently rewrite the currently published version.

Exception handling:

- Run already terminal or missing: disable cancellation and preserve history.
- One device cancellation fails: retain the Run audit state and do not affect unrelated Runs.
- Invalid Skill JSON: reject the import, show the parser/schema error, and keep the binding dialog open.
- File persistence or artifact registration fails: report the error without creating a broken Role binding.
- Deterministic target not found: fail the module into bounded VLM correction rather than reporting a false pass.
- Correction has no progress, times out, or exhausts retries: transition to failure or human intervention under the existing executor policy.
- Missing screen dimensions: preserve an absolute deterministic tap rather than inventing an unsafe percentage coordinate.
- Proposal persistence fails: preserve the completed Run and do not mutate the source task flow.

Acceptance criteria:

- Automated UI coverage proves the progress dialog calls `cancelBatchRun` with only its own Run ID.
- Automated UI coverage proves all three Role asset onboarding paths are reachable and use the selected file path correctly.
- Deterministic target tests prove VLM is not called when UI Tree resolution succeeds or `fallbackToVlm` is disabled.
- A successful one-off run creates a verified deterministic task flow with visual fallback disabled.
- A corrected source-flow run creates an awaiting-review proposal whose temporary actions compile into deterministic steps.
- Applying a proposal remains an explicit review action that produces repository version lineage.

Implementation status (2026-07-28): complete in code and automated acceptance. The execution dialog now calls `cancelBatchRun(run.id)` and labels the action Stop current RPA. Role binding provides Knowledge management, Skill JSON import through the selected file path, and file/evidence registration. Visual target modules resolve UI Tree aliases before optional VLM use. Successful one-off runs are persisted as verified deterministic task flows, while successful source-flow runs produce reviewable consolidation or correction-parameter proposals. Corrected tap, swipe, navigation, launch, wait, and popup actions compile into deterministic modules; percentage coordinates are used when dimensions are available. Targeted coverage passes for run isolation, asset onboarding, deterministic target execution, successful-flow creation, and proposal generation. Full repository checks and desktop acceptance remain governed by the completion commands and current real-device environment.

### P7-14. Replace Improvement Review and Free-form Run Experience with Automatic Versioned Learning

Background:

The current Run History exposes two parallel actions that do not match the runtime learning model. Improvement proposals delay an already verified deterministic correction behind another manual approval step. Reviewed run experience accepts free-form text and copies event summaries into Knowledge, which can create duplicate, weakly scoped entries and increase retrieval cost. Verified executable changes should become an auditable task-flow version automatically, while operational experience should remain compact, structured, deduplicated, and outside the human-authored Knowledge corpus.

Function:

- Stop creating new manual or Trace Learning improvement proposals from Run History.
- When every device run completes and the learned deterministic DSL validates, automatically create a new version of the source task flow.
- Preserve the previous version, source Run, source device IDs, correction usage, validation result, and deterministic execution strategy for diff and rollback.
- Reject automatic application when the source task-flow version changed after execution, the learned DSL is invalid, the run is incomplete, or the change cannot be compiled deterministically.
- Keep historical proposal records readable for replay compatibility, but remove proposal creation, review, and application from the primary Run History workflow.
- Stop writing per-run summaries and reviewer free text into RPA Knowledge.
- Extend failure fingerprints into a fixed structured experience record containing scope, diagnosis, recovery outcome, verification state, confidence, occurrence counters, bounded source references, and lifecycle state.
- Upsert by stable fingerprint, merge bounded references, and never copy screenshots, raw event payloads, or arbitrary logs into model context.
- Exclude legacy `run_summary` Knowledge entries from retrieval and remove them on the next repository write.

Input:

- Terminal batch Run and per-device trace events
- Source task-flow ID/version and current repository version
- Verified temporary correction actions and screen dimensions
- Failure class, app package/version, task goal, state, failed module/policies, and bounded evidence references

Output:

- New executable task-flow version or an explicit skipped-update audit result
- Immutable task-flow revision for rollback
- One deduplicated structured failure experience per stable fingerprint
- Retrieval context containing only active, scoped, confidence-qualified structured experience

How to use:

- Execute a saved task flow normally. A verified deterministic correction automatically creates the next task-flow version after the batch completes.
- Inspect the task-flow version history or Run trace to see the source Run and automatic update result; rollback uses the preserved previous revision.
- Use Run History only for replay, evidence, debug export, and task-flow status. No separate proposal approval or free-form experience save is required.
- Planner and deterministic recovery consume matching structured fingerprints through existing scoped lookup.

Exception handling:

- Source version conflict: do not overwrite; record `skipped_version_conflict` and retain the successful Run evidence.
- Validation failure: do not save a new version; record `skipped_validation_failed` with bounded issues.
- Incomplete multi-device batch: do not update a shared task flow.
- Repeated analysis of the same Run: return the already-created version and do not create another revision.
- One-off successful Run without a source task flow: create one verified deterministic task flow once.
- Single transient failure: retain it as a low-confidence fingerprint but keep it out of broad retrieval until confidence and scope gates pass.
- Protected state such as login, CAPTCHA, payment, or account security: keep `human_required`; never convert it into an executable automatic patch.
- Legacy free-form run summaries: exclude immediately from retrieval and purge during the next Knowledge repository write.

Acceptance criteria:

- A corrected completed source task flow advances exactly one version without creating an improvement proposal.
- The generated version is executable, deterministic-first, linked to its source Run, and retains the previous revision for rollback.
- Version conflict, invalid DSL, repeated analysis, and incomplete multi-device Run tests prove no unintended overwrite occurs.
- Run History no longer exposes improvement-proposal or reviewed-experience actions.
- Repeated equivalent failures produce one structured experience with increasing occurrence count and bounded unique Run references.
- Structured experience has no arbitrary content field and never stores raw screenshots or event payloads.
- Legacy `run_summary` entries are absent from retrieval and are removed on the next Knowledge save.

Implementation status (2026-07-29): complete. Run History no longer creates or opens improvement proposals and no longer saves reviewer free text as Knowledge. Successful deterministic learning validates the compiled DSL, enforces source-version concurrency, serializes simultaneous device completion per Run, writes exactly one `new_version`, preserves the prior revision, and records created, versioned, already-applied, version-conflict, or validation-failure status in the Run trace and UI. Historical proposal IDs remain replay-compatible but no new proposal is generated by Trace Learning. Failure fingerprints now carry a fixed schema for scope, diagnosis, failed recovery policy IDs, verification state, success count, confidence, bounded source references, and lifecycle. A first transient failure remains below retrieval confidence; repeated or protected failures become eligible through scoped lookup without copying raw screenshots, event payloads, or arbitrary text. Legacy `run_summary` Knowledge entries are filtered immediately and removed on the next repository write. Automated coverage includes automatic versioning, retained revisions, idempotency, source conflicts, incomplete and simultaneous multi-device completion, structured aggregation, retrieval threshold, legacy cleanup, and removal of the two Run History actions.

### P7-15. Add App State Normalization and Versioned App Playbooks

Background:

Many otherwise deterministic task flows fail because the target application is already running on an unknown detail page, nested tab, interrupted form, stale loading screen, or transient overlay. App-state normalization must remain an exceptional runtime recovery capability: it must not replace `launch_app`, become a mandatory preflight phase, or add expensive `app.ensure_*` nodes to every saved business flow. The system needs a compact, versioned App Playbook and executable App Skills that help the Planner produce accurate business steps and help the Executor recover only after an immediate precondition or business node fails.

This task extends `RpaAppStateRecognizer`, `RpaDeterministicRecoveryService`, `RpaVerificationEngine`, `RpaTraceLearningService`, and `RpaDeviceActionRuntimeAdapter`. It must not create a second recovery engine, a second Knowledge store, or a parallel task-flow runtime.

Function:

- Keep idempotent composite modules for `app.ensure_foreground`, `app.ensure_state`, and `app.ensure_home` as runtime-only temporary recovery actions; allow `app.restart` in saved DSL only when restart is explicit user intent.
- Normalize application state through bounded stages: transient cleanup, keyboard/system-overlay cleanup, bounded Back navigation, known home-tab navigation, soft relaunch, and hard restart.
- Observe and verify after every recovery action group; never assume that relaunching or tapping Home reached the requested app state.
- Resolve Launcher Activity and foreground package/activity through the unified device runtime instead of embedding raw ADB commands in task DSL.
- Introduce a versioned App Playbook containing verified app states, fingerprints, navigation edges, launch behavior, common blockers, optional deep links, and compatibility scope.
- Separate three layers: saved Business DSL, executable Skill/App SOP, and hidden Runtime Recovery Policy.
- Allow Planner and Skill compilation to attach lightweight recovery-policy references to business nodes without inserting executable normalization nodes.
- Prefer verified Playbook paths and deterministic recovery; invoke VLM only when observations do not match a known state or deterministic recovery fails.
- Learn stable state fingerprints and navigation edges from successful runs and verified corrections through the existing automatic versioned-learning pipeline.
- Preserve per-device isolation so one device can restart or normalize an app without pausing, restarting, or mutating another device run.

Input:

- Device ID, target package, optional app version, and current foreground package/activity
- Requested target state such as `foreground`, `home`, or a Playbook state ID
- Screenshot, UI Tree, OCR, window/focus, orientation, and screen-dimension observations
- Existing App Playbook version and compatible deterministic Skill policies
- Recovery limits, safety policy, deadline, no-progress threshold, and verification specification
- Current Run, device-run, source task-flow, Role context, and app-state lineage

Output:

- Structured normalization result with previous state, requested state, final recognized state, and confidence
- Recovery strategy used, executed action groups, attempt count, elapsed time, and verification evidence references
- Explicit terminal outcome: `goal_achieved`, `execute_actions`, `replan`, `human_required`, `timeout`, or `failed`
- Versioned App Playbook update candidate derived from verified execution evidence
- Per-device audit events linking precondition failure, recovery stage, action group, verification result, and final disposition

How to use:

- Planner uses `launch_app` for normal app opening and emits only intended business actions in saved DSL.
- A business node may reference a semantic Playbook state, Skill, and fallback order through `recoveryPolicyRef`; this reference is metadata, not an executable preflight node.
- Executor runs the normal business path without normalization overhead. After an immediate precondition or business node fails, it observes the device and invokes bounded deterministic normalization when the referenced Skill/Playbook policy applies.
- Recovery actions are temporary per-device audit nodes. After recovery verification succeeds, Executor retries the original business node once.
- VLM receives the task goal, current observation, requested Playbook state, attempted recovery stages, and allowed action schema only after deterministic recovery is exhausted.
- A successful corrected path can update a new App Playbook version through the existing automatic learning and concurrency controls.

Exception handling:

- Unknown foreground app: bring the target package forward, re-observe, and verify before continuing.
- Unknown target package or missing Launcher Activity: return a structured configuration failure; do not guess package names or execute shell fragments supplied by a model.
- App already in target state: return idempotent success with no device action.
- Splash, animation, or loading state: wait for bounded visual stability before classifying the state or retrying.
- Popup, permission, keyboard, or system overlay: route through registered transient handlers and verify that the blocker disappeared.
- Repeated Back navigation with no progress: stop the Back loop and advance to the next configured recovery stage.
- Hard restart failure: record force-stop and launch results separately, re-observe foreground state, and transition to VLM or human handling according to policy.
- Login, CAPTCHA, payment, account-security, destructive confirmation, or unsupported-version state: pause immediately for human intervention.
- App data reset: never use `pm clear`, uninstall, storage deletion, or account logout as a generic normalization action.
- Device disconnect: abort and pause only that device run; resume requires a fresh observation and state normalization.
- Playbook version conflict: retain the successful Run evidence but do not overwrite the current Playbook version.
- Low-confidence or contradictory recognition: do not report success; request another observation, bounded VLM decision, or human intervention.

#### P7-15.1. Define the App State Normalization Contract

Development tasks:

- Extend RPA types with a bounded `recoveryPolicyRef` and retain normalization module schemas for internal temporary execution.
- Define `targetState`, `packageName`, `recoveryPolicy`, `maxBackCount`, `restartMode`, `deadlineMs`, `stabilityWindowMs`, and verification fields.
- Define structured normalization results and audit event phases without introducing free-form execution output.
- Add DSL validation rules that reject missing packages, unknown recovery stages, unbounded retries, data-clearing commands, and model-provided shell scripts.
- Treat `app.ensure_home` as a specialization of `app.ensure_state`, not a separately implemented recovery engine.

Acceptance criteria:

- Business nodes with recovery-policy references round-trip through schema parsing, persistence, editing, replay, and debug export.
- Primary DSL validation rejects `app.ensure_foreground`, `app.ensure_state`, and `app.ensure_home`; internal recovery execution remains available.
- Invalid packages, recovery modes, retry bounds, and destructive actions are rejected before execution.
- Repeated execution against an already-normalized app performs no unnecessary restart.

#### P7-15.2. Implement the Layered State Normalization Executor

Development tasks:

- Add an `RpaAppStateNormalizationService` that orchestrates existing recognizer, popup handler, deterministic recovery, runtime adapter, and verification engine.
- Execute recovery in configurable order: `dismiss_transient`, `dismiss_keyboard`, `bounded_back`, `known_home_action`, `soft_relaunch`, `hard_restart`.
- Capture a fresh observation and run state verification after every action group.
- Reuse existing deadline, retry, rate-limit, safety, cancellation, and no-progress controls.
- Emit explicit events for initial state, stage selection, actions, verification, escalation, and terminal outcome.

Acceptance criteria:

- Tests cover `UNKNOWN -> HOME`, nested detail page, keyboard overlay, blocking popup, bounded Back recovery, soft relaunch, and hard restart.
- No-progress detection prevents repeated Back, repeated relaunch, and restart loops.
- A verified target state retries the original business node exactly once under the existing executor policy.

#### P7-15.3. Complete App Lifecycle Runtime Capabilities

Development tasks:

- Add typed runtime operations for foreground package/activity query, Launcher Activity resolution, bring-to-front, soft relaunch, force-stop, and hard restart.
- Prefer package-manager and Activity-manager APIs through the current device IPC/runtime boundary.
- Keep ADB command construction inside the runtime adapter and whitelist package/activity arguments.
- Record transport, command class, exit state, foreground result, and observation evidence without logging secrets or arbitrary shell text.
- Preserve one unified scrcpy/ADB toolchain and per-device command routing.

Acceptance criteria:

- Runtime tests cover packages with explicit Launcher Activity, launcher intent fallback, missing packages, failed launch, and foreground mismatch.
- Commands are always scoped to the selected device ID.
- No lifecycle operation can clear app data, uninstall an app, or affect another device.

#### P7-15.4. Add Reusable Blocker and Stability Components

Development tasks:

- Register common handlers for permission dialogs, update prompts, promotional overlays, ads with detectable close controls, keyboards, system panels, loading failures, and retryable network errors.
- Add a visual-stability gate using bounded screenshot/UI Tree/OCR change detection before state recognition.
- Define blocker priority so protected states override generic close/back actions.
- Record handler ID, confidence, action, verification, and whether the handler is globally reusable or app-scoped.
- Allow App Playbooks to disable unsafe generic handlers for specific apps or versions.

Acceptance criteria:

- Each handler proves the blocker disappeared before returning success.
- Unknown or low-confidence overlays are not blindly tapped.
- Login, CAPTCHA, payment, and account-security screens always produce `human_required`.

#### P7-15.5. Build the Versioned App Playbook Repository

Development tasks:

- Define an App Playbook schema with package, version range, locale, state IDs, state fingerprints, navigation edges, launch behavior, blockers, deep links, and provenance.
- Store compact structured fingerprints from Activity, UI Tree selectors, OCR anchors, and bounded perceptual screenshot signatures.
- Keep screenshots and raw UI payloads in Evidence storage and reference them by immutable ID.
- Add repository versioning, optimistic concurrency, rollback, deduplication, compatibility filtering, and migration support.
- Separate app navigation knowledge from Role prompts, task-flow DSL, free-form Knowledge, and device-specific coordinates.

Acceptance criteria:

- Playbooks resolve by package, app version, locale, and compatibility scope.
- Equivalent states and edges deduplicate instead of creating repeated manual-like records.
- Version conflict and invalid fingerprint updates do not mutate the published Playbook.
- Replay can resolve the exact Playbook version used by a historical Run or report explicit degradation.

#### P7-15.6. Integrate Planner, Skills, VLM, and Verification

Development tasks:

- Extend Planner output so business nodes can declare required app state and normalization policy without adding normalization steps.
- Compile matching Skill transitions into business modules and store fallback transitions as runtime deterministic-recovery policies.
- Pass current state, target state, attempted stages, allowed actions, and bounded Playbook context into VLM correction.
- Require VLM to return executable whitelist actions or an explicit terminal decision; descriptive text remains audit-only.
- Force `RpaVerificationEngine` to validate the target state after every deterministic or VLM action group.

Acceptance criteria:

- Planner-generated DSL includes a recovery-policy reference, not an executable normalization node, when an entry point depends on a known home/module state.
- Normal healthy execution invokes no normalization module and no VLM recovery.
- VLM is not called when Playbook recognition and deterministic normalization succeed.
- VLM output without executable actions or a terminal decision is rejected and cannot advance the flow.
- The original business node resumes only after target-state verification succeeds.

#### P7-15.7. Learn Stable States and Navigation Edges Automatically

Development tasks:

- Extend Trace Learning to extract state fingerprints and navigation edges from successful deterministic runs and verified correction groups.
- Promote only evidence-backed, replayable actions that pass DSL validation, safety policy, and confidence thresholds.
- Update Playbooks through immutable version creation and source-version concurrency checks.
- Track success count, failure count, app-version scope, last verification time, and rollback lineage for learned edges.
- Quarantine conflicting, low-confidence, protected-state, or device-specific candidates instead of adding them to normal retrieval.

Acceptance criteria:

- Repeated successful navigation produces one strengthened edge rather than duplicate records.
- A verified correction can create a new Playbook version without modifying the source task-flow semantics.
- A failed learned edge lowers confidence or becomes inactive without deleting historical evidence.
- Protected-state actions never become automatically executable Playbook edges.

#### P7-15.8. Complete Multi-device, UI, and Real-device Acceptance

Development tasks:

- Show normalization stages and recovery reasons in per-device execution details.
- Display `original node -> precondition mismatch -> normalization stage -> action group -> verification -> resume/handoff` in audit order.
- Support stop/continue and device disconnect handling independently for each device.
- Add debug-export coverage for initial/final state, Playbook version, recovery actions, screenshots, verification, and terminal reason.
- Run real-device scenarios with the same app opened on different pages across multiple devices.

Acceptance criteria:

- One device on the home page continues immediately while another device on a detail page normalizes independently.
- A device with a popup, a device in the background, and a device on an unknown page take different bounded recovery paths without cross-device interference.
- Device disconnect aborts only the affected device and requires fresh normalization after reconnection.
- Real-device acceptance covers target state already satisfied, bounded Back recovery, home-tab recovery, hard restart, loading timeout, unknown version, protected state, and VLM-assisted recovery.
- A second execution of a learned stable flow uses deterministic Playbook navigation and avoids normal-path VLM calls.

Planning status (2026-07-30): approved for development. This stage is an integration and hardening layer over the completed P6 recognizer and deterministic recovery work. Implementation must begin with the state-normalization contract and runtime lifecycle tests, then add the composite executor, Playbook repository, planner/VLM integration, learning, UI, and real-device acceptance in that order.

Implementation correction (2026-08-03): the original implementation incorrectly promoted state normalization into the primary DSL and Skill compilation path. The corrected contract keeps `app.ensure_foreground`, `app.ensure_state`, and `app.ensure_home` internal to runtime recovery, restores `launch_app` as the normal opening action, attaches optional `recoveryPolicyRef` metadata to Skill-generated business nodes, preserves Skill fallback rules as deterministic recovery policies, skips secondary verification after timeout/cancellation/human handoff, and requires step-scoped observable verification. Real-device acceptance must prove both zero normalization overhead on the healthy path and bounded temporary recovery after induced state drift.

Superseded real-device baseline (2026-07-31): OnePlus PLR110 (`3B6656026JF00000`, Android 16) completed the legacy four-step Settings workflow `app.ensure_foreground -> app.ensure_home -> app.restart -> screenshot`. This proves the normalization modules can execute, but it no longer qualifies as primary-flow acceptance because normalization was incorrectly embedded in saved DSL. Retained persistence checks found no raw image payloads, UI-node arrays, OCR-block arrays, or text-candidate arrays. New acceptance must use a business-only flow and induce state drift only for the recovery run.

### P7-16. Compile App Skills into Deterministic Navigation Plans

#### Background and goal

Skills are application operating procedures, not long prompt supplements. The Planner should select a compatible Skill once, and the compiler should turn its states, aliases, locators, and navigation policy into deterministic business nodes. The executor should use UI Tree, resource IDs, and OCR before invoking VLM. VLM is a bounded fallback for ambiguity or an exhausted deterministic route; it must receive compact state and attempt context rather than the entire Skill document. Runtime recovery remains temporary and must never be written into the business DSL.

#### Layer responsibilities

- **Skill contract layer**: describes app/version/locale scope, states, aliases, locators, transitions, search policy, fallback routes, and postconditions.
- **Compilation layer**: resolves Skill locator references and parameters into registered modules such as `launch_app`, `list.scan_target`, `tap_by_vlm_target`, and `screenshot`; records immutable Skill provenance.
- **Deterministic navigation layer**: searches the current viewport, resets to a list boundary, scans in the configured direction, deduplicates unchanged viewports, and only then reports deterministic absence.
- **Fallback and correction layer**: sends compact context to VLM, accepts only executable actions or a terminal decision, verifies each action group, and escalates after bounded failure.
- **Learning/version layer**: stores successful routes and verified corrections as versioned Skill or Playbook candidates; never mutates the published primary DSL automatically.

#### P7-16.1. Define the Skill navigation contract

**Background**: Existing locator data identifies text but does not say how a long or virtualized list must be traversed. **Function**: Add backward-compatible navigation policies with locale/device scope, aliases, resource IDs, OCR preference, boundary direction, scan direction, and bounded progress limits. **Input**: Skill JSON and existing locator definitions. **Output**: Validated structured Skill data with safe defaults. **Usage**: A locator referenced by a list navigation step supplies the policy to the compiler. **Exceptions**: Invalid directions, unbounded limits, unknown locator IDs, and conflicting policies make a ready Skill invalid; drafts remain editable with validation issues.

#### P7-16.2. Compile Skill paths into business DSL

**Background**: Model-readable Skill text is repeatedly interpreted and wastes tokens. **Function**: Resolve `locatorId` references and emit deterministic module parameters while keeping `app.ensure_*`, restart, and fallback actions outside the primary path. **Input**: Matched ready Skill, parameters, selected devices, current state. **Output**: Executable task DSL plus Skill/version/navigation provenance. **Usage**: Planner returns `source: skill` and does not call the LLM when compilation succeeds. **Exceptions**: Missing parameters, unknown paths, prohibited modules, or unresolved locators fall back to normal planning and are logged as compile issues.

#### P7-16.3. Implement exhaustive deterministic list scanning

**Background**: A single-direction `swipe_until_vlm_target` cannot prove that a menu item is absent. **Function**: Add `list.scan_target` with current-view search, boundary reset, opposite-direction scan, UI Tree/resource ID/OCR matching, viewport fingerprints, no-progress detection, and hard limits. **Input**: Target aliases, locator IDs, scan policy, runtime observations. **Output**: Match coordinates and an audit record containing scanned viewports, boundary status, swipes, locator source, and VLM usage. **Usage**: Skills use it before visual fallback for menus and feeds. **Exceptions**: Missing UI Tree/OCR, disconnected device, unchanged viewport, timeout, or boundary not reached produces a failed result and compact fallback context; it must not claim target absence prematurely.

#### P7-16.4. Add compact VLM fallback

**Background**: Sending complete Skill documents on every screen is slow and increases reasoning noise. **Function**: Invoke VLM only after deterministic candidates are exhausted or ambiguous, with current state, target aliases, scan coverage, attempted routes, and allowed actions. **Input**: Scanner audit and current observation. **Output**: Executable tap/swipe decision or explicit `goal_achieved`/`human_required`; descriptive text is audit-only. **Usage**: The existing correction loop consumes the decision and verifies it before resuming. **Exceptions**: Invalid action, low confidence, no progress, timeout, or protected screen escalates to human intervention after bounded retries.

#### P7-16.5. Add Android/OnePlus Settings Skill

**Background**: Settings often opens at a retained subpage or scroll position, and “About phone” has locale/vendor aliases. **Function**: Provide a versioned `com.android.settings` zh-CN/OnePlus Skill using `launch_app`, exhaustive list scanning, deterministic text matching, tap, and screenshot, with bounded Back/relaunch as runtime fallback only. **Input**: Device package/version/locale and the goal to open device information. **Output**: Business-only deterministic DSL and verified `ABOUT_DEVICE` postcondition. **Exceptions**: Unknown Settings variant, protected/account screens, failed boundary traversal, or missing target goes to VLM then human handoff.

#### P7-16.6. Learn and version stable navigation

**Background**: A verified correction should reduce future VLM calls without polluting the Skill with unverified guesses. **Function**: Record successful locator/edge evidence, deduplicate equivalent routes, create a new version, and support rollback. **Input**: Run evidence and verified correction events. **Output**: Versioned candidate with confidence, app scope, provenance, and replay reference. **Exceptions**: Conflicting, device-specific, low-confidence, or protected-state routes remain quarantined.

#### P7-16.7. Automated and real-device acceptance

**Automated**: Test policy validation, Skill compilation, locator expansion, current-view matching, boundary reset, bidirectional scan, fingerprint no-progress, OCR fallback, compact VLM invocation, and human escalation. **Real device**: On OnePlus PLR110 (`3B6656026JF00000`), run Settings -> About phone from home, a retained subpage, and a retained scrolled viewport; verify healthy runs make no VLM call, drift is recovered temporarily, the target is found after full scanning, and disconnect/timeout pauses only the affected device. Export logs must show `Skill match -> compiled node -> deterministic coverage -> VLM fallback (if any) -> verification`.

Implementation status (2026-08-04): P7-16.1 through P7-16.6 are implemented. The repository now includes a backward-compatible navigation policy, locator-reference compilation, `list.scan_target`, compact post-scan VLM fallback, a bundled Android/OnePlus Settings Skill, and successful-run consolidation that disables normal-path VLM for verified list routes. Automated format, lint, type, i18n, OpenAPI, unit, integration, and build checks pass. P7-16.7 real-device scenarios remain pending because no device was visible to the bundled ADB at the final acceptance attempt.

## Milestones

### P0. Executable RPA Core

- DSL schema
- Module registry
- Device Runtime wrapper
- Base modules
- Basic Orchestrator execution

Exit criteria:

- A simple task can be represented as DSL and executed on one connected device.

### P1. Observation and Verification Closed Loop

- Observation snapshots
- Verification engine
- Popup handler
- Visual target modules

Exit criteria:

- A task does not continue blindly after a failed click; it verifies and retries or pauses.

### P2. AI Planning and Correction

- Planner prompt contract
- DSL generation from the task input session
- LLM re-planning
- VLM visual correction

Exit criteria:

- A natural language task can generate a validated DSL and recover from at least one common unexpected page state.

### P3. Multi-device RPA Productization

- RPA runner UI
- Multi-device fan-out
- Main-process persistent queue
- Per-device scrcpy video frame capture

Exit criteria:

- The same task can run on multiple devices independently with per-device pause/resume/cancel.

### P4. Safety, Audit, and Replay

- Safety policy engine
- Run replay
- Debug export
- Template generation

Exit criteria:

- High-risk actions are controlled, failed runs are debuggable, and successful runs can become reusable templates.

### P5. Product Closure and RPA Workspace Integration

- RPA workspace information architecture
- Transitional assistant configuration as the RPA profile and asset binding hub
- Versioned Assistant-to-Template/Skill/Knowledge bindings and topic-level overrides
- Effective RPA context resolution, DSL provenance, and immutable run snapshots
- Knowledge base as SOP and experience library
- Files as evidence and asset library
- RPA Templates as the DSL template repository and visual editor
- Task-session-to-RPA-template save flow
- Run history review and application of structured improvement proposals
- Device and group selection consolidated into execution confirmation
- Legacy non-RPA entry-point migration

Exit criteria:

- The transitional task session, assistant profiles, RPA Templates, run history, Knowledge, Files, and Skills form an executable RPA loop that P7 consolidates under Roles.
- Product modules use the shared template, skill, artifact, and improvement proposal repositories without duplicating runtime data.
- The selected transitional assistant profile resolves versioned Template, Skill, and Knowledge references through one effective task context, and every run persists that context for reproducible replay before P7 migrates ownership to Roles.
- The left sidebar contains active RPA runs and chat topics without duplicate assistant/model configuration tabs.
- Generated DSL remains device-agnostic; execution targets are selected, revalidated, and recorded through the confirmation dialog.

### P6. App Flow Closure and Skill Learning

- UI tree and OCR observation signals
- App state recognizer
- RPA skill library and compiler
- Deterministic navigation recovery
- Trace learning and failure feedback

Exit criteria:

- Tasks can recover from common non-home entry states through known app flow skills before falling back to open-ended VLM correction.
- Trace Learning produces reviewable proposals without directly mutating templates, skills, knowledge, or historical runs.

### P7. Role Library and RPA DSL Workspace

- App Automation Role domain with Assistant Profile compatibility
- Primary and supporting Roles for cross-app tasks
- Immutable Effective Role Context with qualified asset ownership
- Versioned Role prompts and bounded untrusted retrieval context
- Role Library and Role-filtered asset management
- Separate secure Retrieval, Artifact, and Tool providers
- Signed Role Pack import with install, replace, fork, quarantine, backup, and rollback
- RPA DSL sessions running alongside Topic compatibility during migration
- Role-scoped RPA Session Orchestrator with explicit generation, revision, clarification, explanation, run-control, and task-lifecycle outcomes
- Optimistic DSL revision concurrency control with immutable Role, model, provider, and evidence provenance
- Session-scoped supplemental evidence with Role-authorized capability narrowing, federated rank fusion, bounded Context Snapshots, and replay policy
- App-state normalization with versioned App Playbooks, deterministic preconditions, and bounded restart recovery
- Idempotent migration, dual-read comparison, end-to-end tests, and real-device acceptance
- Gated navigation cutover and retirement of legacy entry points

Exit criteria:

- Existing Assistant Profile and historical replay data remain available throughout migration.
- Single-app and cross-app sessions resolve reproducible Role, asset, prompt, model, and provider context.
- Imported Role Packs are verified, previewed, and transacted without silently overwriting local changes or enabling untrusted tools.
- Remote retrieval is bounded and provenance-preserving; executable tools remain policy-checked and auditable.
- RPA DSL sessions pass end-to-end and real-device acceptance before legacy navigation is removed.
- Every Role-scoped input is handled by the RPA Session Orchestrator without generic chat fallback, while non-mutating explanation and run-control requests preserve the current DSL revision.
- Session Supplements can add bounded evidence and narrow Role-authorized capabilities, but cannot mutate Role assets, expand tool/network permissions, or create parallel storage and security systems.
- Business nodes declare and verify required app state; known Playbook paths normalize foreground, home, and module-entry states before bounded VLM fallback.
- App restart is idempotent, per-device, verified after launch, and never clears application data or bypasses protected states.
- Audit replay preserves immutable references and policy decisions; model replay uses exact retained bounded evidence or reports explicit degradation.
- The final primary workflow is Role-centered, while rollback and read-only historical compatibility remain available for the documented retention period.
