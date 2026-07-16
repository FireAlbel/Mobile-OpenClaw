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
- [ ] P3-4. Implement Per-device Scrcpy Video Frame Capture
- [ ] P4-1. Integrate DeerFlow as Optional Planner/Workflow Backend
- [ ] P4-2. Add Multi-agent Roles
- [ ] P5-1. Add Safety Policy Engine
- [ ] P5-2. Add Run Replay and Debug Export

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

- Correction DSL fragment
- Retry decision
- Human handoff decision

How to use:

- Orchestrator calls Planner correction after module recovery fails.

Exception handling:

- Correction plan invalid: ask repair once, then pause.
- Correction loops: enforce max correction attempts.
- Risky correction: require human approval.
- No useful correction: pause and notify human.

Acceptance criteria:

- Tests cover successful correction, invalid correction, loop prevention, and human handoff.

### P2-3. Implement VLM Visual Correction

Background:

VLM is useful for visual target recognition and page state correction, but should be bounded and structured.

Function:

- Provide screenshot and target prompt to VLM.
- Require structured response: target found, bbox, confidence, reasoning, suggested action.
- Validate bbox and confidence.
- Convert bbox center to device coordinates.

Input:

- Screenshot
- Target description
- Screen metadata
- Optional previous failed coordinate

Output:

- Visual correction result
- Candidate coordinates
- Confidence

How to use:

- Visual modules call this when OCR/UI tree cannot find the target.

Exception handling:

- VLM timeout: retry once with compressed image or lower detail.
- Invalid response: ask repair once.
- Low confidence: request human confirmation.
- Candidate outside bounds: reject and retry observation.

Acceptance criteria:

- Tests mock VLM result for valid bbox, invalid bbox, low confidence, and timeout.

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

- From chat or taskflow page, generated tasks can be opened in RPA runner.

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

### P4-1. Integrate DeerFlow as Optional Planner/Workflow Backend

Background:

DeerFlow can be used for richer multi-agent planning and workflow orchestration, but should remain optional.

Function:

- Extend current DeerFlow adapter from availability check to concrete plan/run integration.
- Support sending task goal, module catalog, observations, and execution history.
- Receive structured workflow steps or correction proposals.
- Keep local Planner fallback when DeerFlow is unavailable.

Input:

- DeerFlow endpoint and API key
- Task goal
- Module catalog
- Observations
- Run history

Output:

- DeerFlow plan
- DeerFlow correction
- DeerFlow trace ID

How to use:

- User enables DeerFlow in settings.
- Planner chooses DeerFlow backend when available.

Exception handling:

- DeerFlow unavailable: fallback to local Planner.
- Invalid DeerFlow response: validate and request repair once.
- Long-running DeerFlow task: show pending state and allow cancel.
- Network failure: retry with backoff and fallback.

Acceptance criteria:

- Adapter tests cover success, unavailable fallback, invalid response, and timeout.

### P4-2. Add Multi-agent Roles

Background:

Splitting roles can improve reliability for planning, visual recognition, verification, and recovery.

Function:

- Define Planner Agent, Visual Agent, Verifier Agent, Recovery Agent, and Safety Agent.
- Route model calls through explicit role prompts and schemas.
- Store agent outputs as artifacts.

Input:

- Task context
- Observation
- Execution history
- Module catalog

Output:

- Role-specific structured decisions

How to use:

- Orchestrator requests role outputs only when needed.

Exception handling:

- Agent disagreement: prefer deterministic verifier, then Safety Agent, then human.
- Agent timeout: fallback to simpler local rule.
- Repeated disagreement: pause and notify human.

Acceptance criteria:

- Tests cover routing, schema validation, disagreement policy, and timeout fallback.

### P5-1. Add Safety Policy Engine

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

- Tests cover high-risk confirmation, rate limit, blocked action, and emergency stop.

### P5-2. Add Run Replay and Debug Export

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
- DSL generation from chat
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

### P4. DeerFlow and Multi-agent Integration

- DeerFlow planner backend
- Multi-agent role routing

Exit criteria:

- DeerFlow can optionally produce or repair task plans while local execution remains functional without it.

### P5. Safety, Audit, and Replay

- Safety policy engine
- Run replay
- Debug export
- Template generation

Exit criteria:

- High-risk actions are controlled, failed runs are debuggable, and successful runs can become reusable templates.
