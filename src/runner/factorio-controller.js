// factorio-controller.js — single-Factorio-instance facade for the runner.
//
// Composes a FactorioServer + its config so phases stop reaching directly
// into config.rconHost/Port, factorio.handleAction(), raw fetch(serviceUrl),
// and rconExec. Phases call controller methods; the controller hides the
// transport choice (in-process handleAction vs HTTP) and binds RCON
// credentials to one place.
//
// Snapshot/rollback are exposed but unused by phases in this PR. Their
// intended consumer is verify.js, which will (in a follow-up) replace the
// reload-input-save + second-execute pattern with snapshot-before-harness +
// rollback-after-measure.
import { mkdir, copyFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { rconExec, buildLuaCommand } from "../rcon.js";

const TICKS_PER_SECOND = 60;
const SNAPSHOT_NAME_RE = /^[a-zA-Z0-9_-]+$/;
const ENTITY_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

export class FactorioController {
  constructor(factorio, config) {
    this.factorio = factorio;
    this.config = config;
  }

  // -------- process lifecycle --------

  isRunning() {
    return this.factorio.isRunning();
  }

  async start() {
    return this.factorio.start();
  }

  async stop() {
    return this.factorio.stop();
  }

  savePath() {
    return this.factorio.savePath();
  }

  // Stop the running process, replace runtime save with the supplied zip,
  // and start fresh. ~10s wall (mostly Factorio mod load).
  async loadSave(zipPath) {
    if (this.isRunning()) await this.stop();
    if (zipPath) {
      const target = this.savePath();
      await mkdir(resolve(target, ".."), { recursive: true });
      await copyFile(zipPath, target);
    }
    await this.start();
  }

  // -------- mutating actions --------

  // In-process call into the parent FactorioServer. Skips HTTP serialization
  // overhead — the runner is always co-located with its FactorioServer.
  // `name` is forced last so a stray `action` key in `params` cannot
  // override the chosen action.
  async action(name, params = {}) {
    return this.factorio.handleAction({ ...params, action: name });
  }

  // -------- RCON --------

  async rcon(command, timeoutMs = 15000) {
    return rconExec({
      host: this.config.rconHost,
      port: this.config.rconPort,
      password: this.config.rconPassword,
      command,
      timeoutMs,
    });
  }

  // Read a Lua script from disk, wrap with buildLuaCommand, RCON it, parse
  // the JSON response. Replaces the duplicated rconRunScript helper that
  // previously lived in both observe.js and verify.js.
  async runLuaScript(scriptPath, params = {}, timeoutMs = 15000) {
    const lua = await readFile(scriptPath, "utf8");
    const command = buildLuaCommand(scriptPath.split("/").pop(), lua, params);
    const body = await this.rcon(command, timeoutMs);
    let parsed;
    try {
      parsed = JSON.parse(body.trim());
    } catch {
      throw new Error(`lua script returned non-JSON: ${body.slice(0, 200)}`);
    }
    return parsed;
  }

  // -------- reads (factorio_read endpoint) --------

  // Goes through HTTP because factorio_read maps to a different handler
  // (handleTool / handleRead) and the existing dry-validate call site uses
  // the HTTP shape. Keeping it HTTP preserves byte-for-byte behaviour.
  async read(actionName, params = {}, { timeoutMs = 60_000 } = {}) {
    const response = await fetch(`${this.config.serviceUrl}/tool/factorio_read`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: actionName, ...params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      const err = new Error(payload?.error || `${actionName} HTTP ${response.status}`);
      err.payload = payload;
      err.status = response.status;
      throw err;
    }
    return payload.result;
  }

  // -------- entity counts (RCON helpers) --------

  // Total entities on surfaces[1] (nauvis). Used as a sanity sample at the
  // end of a meter window.
  async countEntities(timeoutMs = 10000) {
    const command = `/silent-command rcon.print(#game.surfaces[1].find_entities())`;
    const body = await this.rcon(command, timeoutMs);
    return parseInt(body.trim(), 10) || 0;
  }

  // Count entities matching a prototype name on a named surface. Both inputs
  // are validated against an identifier regex before interpolation; we do not
  // accept anything that could be Lua-injected.
  async countEntitiesByName({ name, surface = "nauvis", timeoutMs = 10000 }) {
    if (!ENTITY_NAME_RE.test(name)) {
      throw new Error(`refusing to query entity name with unsafe chars: ${JSON.stringify(name)}`);
    }
    if (!ENTITY_NAME_RE.test(surface)) {
      throw new Error(`refusing to query surface with unsafe chars: ${JSON.stringify(surface)}`);
    }
    const command = `/silent-command rcon.print(#game.surfaces["${surface}"].find_entities_filtered{name="${name}"})`;
    const body = await this.rcon(command, timeoutMs);
    const n = parseInt(body.trim(), 10);
    return Number.isFinite(n) ? n : 0;
  }

  // -------- time control --------

  // Advance the simulation by N ticks. Goes through HTTP because the
  // wait_ticks action drives factorio-server's stepper (and the existing
  // implementation already uses HTTP). Replaces observe.js's local waitTicks.
  async advanceTicks(ticks) {
    const timeoutMs = Math.ceil((ticks / TICKS_PER_SECOND) * 1000) + 60_000;
    const response = await fetch(`${this.config.serviceUrl}/tool/factorio_action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "wait_ticks", ticks }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      throw new Error(`wait_ticks failed: ${payload.error || response.statusText}`);
    }
    return payload.result;
  }

  // -------- snapshot / rollback / export --------

  // Save the current world and stash the resulting zip under
  // <savesDir>/snapshots/<name>.zip. Returns the snapshot's absolute path.
  // Restricts name to [a-zA-Z0-9_-]+ to keep the join below safe.
  async snapshot(name) {
    if (typeof name !== "string" || !SNAPSHOT_NAME_RE.test(name)) {
      throw new Error(`snapshot name must match ${SNAPSHOT_NAME_RE.source}: ${JSON.stringify(name)}`);
    }
    const latest = await this.factorio.save();
    const snapshotsDir = resolve(this.config.savesDir, "snapshots");
    await mkdir(snapshotsDir, { recursive: true });
    const dest = join(snapshotsDir, `${name}.zip`);
    await copyFile(latest.path, dest);
    return dest;
  }

  // Stop, replace runtime save with snapshot zip, restart. ~10s wall.
  async rollback(name) {
    if (typeof name !== "string" || !SNAPSHOT_NAME_RE.test(name)) {
      throw new Error(`snapshot name must match ${SNAPSHOT_NAME_RE.source}: ${JSON.stringify(name)}`);
    }
    const snapshotsDir = resolve(this.config.savesDir, "snapshots");
    const src = join(snapshotsDir, `${name}.zip`);
    await this.loadSave(src);
  }

  // Save the current world and copy the resulting zip to `destination`.
  // Replaces the save → findNewestSave → copyFile dance in execute.js and
  // bootstrap.
  async exportZip(destination) {
    const latest = await this.factorio.save();
    await mkdir(resolve(destination, ".."), { recursive: true });
    await copyFile(latest.path, destination);
    return destination;
  }
}
