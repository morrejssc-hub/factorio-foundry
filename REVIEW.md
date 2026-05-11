# factorio-foundry Architectural and Functional Review

This document provides a holistic review of the `factorio-foundry` codebase, evaluating its architecture, strengths, and areas for improvement. The focus is on identifying functional gaps, brittleness, and inefficiencies in the agent's feedback loops and execution pipeline.

## 1. Executive Summary

`factorio-foundry` is a sophisticated, highly structured AI coding agent tailored for Factorio. Its core strength lies in its architectural inversion: the LLM does not play the game interactively; instead, it acts as an offline compiler, generating declarative plans (`plan.yaml`) and Lua probes. The game engine serves purely as a deterministic runtime tester.

The separation of concerns—Probe (read state), Design (plan offline), Dry-Validate (fast deterministic checks), Verify (cloned simulation with injected testing harnesses), and Observe (clean export)—is exceptionally well-thought-out and robust. However, as the complexity of the tasks increases, the architecture begins to show strain, particularly around the cognitive load placed on the LLM during the Design phase and the efficiency of the feedback loops during failures.

## 2. Core Architectural Strengths

*   **Strict Tool Boundary:** The absolute prohibition of the LLM invoking mutating actions (`factorio_action`) during the Design phase prevents runaway "hallucinated gameplay" loops.
*   **Disposable Verification Clones:** Utilizing an `InstancePool` to spin up isolated Factorio instances for verification ensures the primary save remains uncorrupted by failed experiments or the testing harness.
*   **Deterministic Evaluation:** The Observe phase guarantees that the final metrics are gathered without the interference of the testing harness or LLM non-determinism.
*   **Structured Proposals:** The `executor-proposal.js` system is a clever way to translate raw Factorio errors (like "no path" or collisions) into actionable, semantic feedback for the LLM during retry loops.

## 3. Identified Gaps & Weaknesses

### 3.1. The "One-Shot" Placement and Routing Bottleneck
Currently, the `design.js` phase requires the LLM to output both spatial `placements` and topological `connections` in a single `plan.yaml`.
*   **The Problem:** LLMs are notoriously poor at spatial reasoning and precise pathfinding in complex grids. Forcing the LLM to guess the exact routing of belts between modules while simultaneously solving the macro-layout problem is a massive cognitive load. If the routing fails (`route_belt` fails during execute), the entire plan fails, burning a full, expensive `recovery_attempt` simulation cycle.
*   **Symptom:** As noted, the Designer rarely connects belts correctly on the first attempt, leading to wasted simulation time and unnecessary retries for trivial routing fixes.

### 3.2. Sequential vs. Parallel Feedback Parity
As highlighted in `docs/todo.md`, there is a significant asymmetry in how feedback is handled.
*   **The Problem:** In sequential mode, failures accumulate in `previousAttempts`, providing the LLM with a rich history of what went wrong (via `executor_proposal`). In parallel mode (`runParallelCompositionEpoch`), candidates run blindly and independently. If all parallel candidates fail a basic routing check, all that compute is wasted, and no shared learning occurs.

### 3.3. Harness Brittleness in Complex Chains
The Verify harness (via `verify.js` and `placeHarness`) works by injecting chests and bulk inserters at every declared port.
*   **The Problem:** While effective for simple isolated modules, this approach becomes brittle as module chains grow. If an epoch requires a tight coupling of three modules, the injected harness might interfere with the internal logistics of the chain or alter the intended timing/throughput dynamics. The system assumes a very clear demarcation of inputs and outputs that might blur in advanced late-game setups.

### 3.4. Over-Reliance on "Goal-Only" LLM Deduction
The system relies heavily on the LLM deducing the correct module and wiring based purely on the `epoch.md` goal prose.
*   **The Problem:** If the LLM misunderstands the implicit requirements of a downstream consumer (the "capacity-by-consumption principle" noted in the TODOs), the current Verification phase won't catch it until a later epoch completely starves.

## 4. Recommended Architectural Improvements

### 4.1. Separate Placement from Wiring (The Refinement Phase)
**Implement a post-placement "Wiring/Connection Refinement" step.**
Instead of failing the entire attempt when routing fails, or forcing the LLM to guess connections upfront:
1.  **Macro-Design:** The LLM outputs `plan.yaml` focusing *only* on `placements` and the *intent* to connect.
2.  **Verify Placements:** The runner validates and places the modules in the verification clone.
3.  **Algorithmic Routing / Micro-Design:** Attempt algorithmic routing (`route_belt`). If it fails, or if the LLM needs to explicitly define complex wiring (like circuit networks or fluid pipes later on), feed the *actual* placed coordinates back to the Designer in a rapid, cheap LLM call: *"Placements successful. Here are the exact port coordinates. Provide the `connections` array."*
4.  **Benefits:** Drastically reduces the cognitive load on the initial design prompt, reduces expensive simulation retries, and allows the LLM to focus on topological wiring with guaranteed, validated starting points.

### 4.2. Unify the Feedback Loop Architecture
Address the sequential vs. parallel discrepancy.
*   If parallel mode is meant for exploration, it should still have a mechanism to share catastrophic failure states (e.g., "Module X's footprint is fundamentally broken") across the parallel pool before the next wave of designs is generated.

### 4.3. Implement the `upgrade` Verb
As noted in the TODOs, the `plan.preparation` array only supports `deconstruct`.
*   Adding an `upgrade` verb (e.g., fast-replacing burner drills with electric drills) will be critical for mid-game transitions, avoiding the messy and destructive process of completely tearing down and rebuilding infrastructure just to change tiers.

### 4.4. Module Decommissioning Lifecycle
The `module_decommissions` feature exists in the schema but is deferred.
*   It should be fully implemented and tested. Without a clear lifecycle to remove old, inefficient modules from `world.md`, the agent will eventually suffer from "spaghetti creep," building around obsolete structures because it lacks a verified path to cleanly dismantle them.