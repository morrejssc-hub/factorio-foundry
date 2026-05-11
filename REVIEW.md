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

### 3.1. The "One-Shot" Placement and Connection Bottleneck
Currently, the `design.js` phase requires the LLM to output both spatial `placements` and topological `connections` (defining what connects to what) in a single `plan.yaml`.
*   **The Problem:** Even though the runner handles the actual A* pathfinding for belts (`route_belt`), the LLM still has to perform macro-layout positioning and identify the correct topological pairings (`from` port to `to` port) simultaneously. This combined cognitive load frequently leads to mistakes where the LLM either forgets the connections or mis-pairs them on the first attempt.
*   **Symptom:** As noted, the Designer rarely gets the connections right alongside the placements on the first attempt, leading to wasted simulation time and unnecessary retries to fix logical topology.

### 3.2. Management of Parallel Failure Data
Parallel mode (`runParallelCompositionEpoch`) correctly runs independent designers to find the best candidate. However, there is a gap in how failure data is managed.
*   **The Problem:** While failure experiences are technically preserved in `pi-coding-agent` sessions and `.jsonl` files, there is a lack of unified aggregation and management for these failures. Since parallel mode drops failures instead of accumulating them in a structured way for the next attempt (unlike sequential mode's `previousAttempts`), valuable lessons about edge cases or impossible layouts are scattered and not easily utilized for broader agent learning.

### 3.3. Harness Brittleness in Complex Chains
The Verify harness (via `verify.js` and `placeHarness`) works by injecting chests and bulk inserters at every declared port.
*   **The Problem:** While effective for simple isolated modules, this approach becomes brittle as module chains grow. If an epoch requires a tight coupling of three modules, the injected harness might interfere with the internal logistics of the chain or alter the intended timing/throughput dynamics. The system assumes a very clear demarcation of inputs and outputs that might blur in advanced late-game setups.

### 3.4. Over-Reliance on "Goal-Only" LLM Deduction
The system relies heavily on the LLM deducing the correct module and wiring based purely on the `epoch.md` goal prose.
*   **The Problem:** If the LLM misunderstands the implicit requirements of a downstream consumer (the "capacity-by-consumption principle" noted in the TODOs), the current Verification phase won't catch it until a later epoch completely starves.

## 4. Recommended Architectural Improvements

### 4.1. Separate Placement from Wiring (The Refinement Phase)
**Implement a post-placement "Wiring/Connection Refinement" step.**
Instead of failing the entire attempt when connections are missing or mis-paired, or forcing the LLM to define them simultaneously with placement:
1.  **Macro-Design:** The LLM outputs `plan.yaml` focusing *only* on `placements` first.
2.  **Verify Placements:** The runner validates and places the modules in the verification clone.
3.  **Connection Refinement:** Feed the successful placement data (and actual port coordinates) back to the Designer in a rapid, cheap LLM call: *"Placements successful. Here are the placed modules and their ports. Provide the `connections` array to link them."*
4.  **Benefits:** Drastically reduces the cognitive load on the initial design prompt. The LLM handles topology *after* layout is locked in. The runner then uses its existing A* pathfinding to execute the provided connections, avoiding expensive simulation retries due to simple omission or mis-pairing in the first step.

### 4.2. Aggregate and Manage Failure Experience
Build a structured system to extract and aggregate failure data.
*   Since parallel exploration naturally produces discarded attempts (saved in raw sessions/jsonl), implement a process to parse, summarize, and manage these failures. This centralized "failure index" can be used to inform future epochs or long-term agent learning, rather than leaving the data siloed.

### 4.3. Implement the `upgrade` Verb
As noted in the TODOs, the `plan.preparation` array only supports `deconstruct`.
*   Adding an `upgrade` verb (e.g., fast-replacing burner drills with electric drills) will be critical for mid-game transitions, avoiding the messy and destructive process of completely tearing down and rebuilding infrastructure just to change tiers.

### 4.4. Module Decommissioning Lifecycle
The `module_decommissions` feature exists in the schema but is deferred.
*   It should be fully implemented and tested. Without a clear lifecycle to remove old, inefficient modules from `world.md`, the agent will eventually suffer from "spaghetti creep," building around obsolete structures because it lacks a verified path to cleanly dismantle them.