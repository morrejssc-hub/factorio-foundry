// instance-pool.js — manages N isolated FactorioServer instances for parallel
// candidate evaluation. Each slot gets distinct RCON/game/HTTP ports and its
// own runtime directory so instances never share file state.
import { mkdir, copyFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { FactorioServer } from "../factorio-server.js";
import { FactorioApiDocs } from "../factorio-api-docs.js";
import { FactorioWiki } from "../factorio-wiki.js";
import { createApi } from "../http-api.js";
import { FactorioController } from "./factorio-controller.js";

const PORT_STRIDE = 10;

function slotConfig(baseConfig, i) {
  // Offset starts at (i+1)*stride so slot 0 = base+10, avoiding collision with
  // the primary bootFactorioService instance still holding the base ports.
  const offset = (i + 1) * PORT_STRIDE;
  const runtimeDir = `${baseConfig.runtimeDir}-slot${i}`;
  const configDir = resolve(runtimeDir, "config");
  const servicePort = baseConfig.servicePort + offset;
  return {
    ...baseConfig,
    runtimeDir,
    savesDir:  resolve(runtimeDir, "saves"),
    configDir,
    logsDir:   resolve(runtimeDir, "logs"),
    modsDir:   resolve(runtimeDir, "mods"),
    // Per-slot config.ini sets write-data=runtimeDir so each Factorio instance
    // gets its own .lock file and script-output, avoiding conflicts between slots.
    configFile: join(configDir, "config.ini"),
    // agentWorkspace is read-only (blueprints/probes symlinks) — share the main one.
    rconPort:   baseConfig.rconPort  + offset,
    gamePort:   baseConfig.gamePort  + offset,
    servicePort,
    serviceUrl: `http://${baseConfig.serviceHost}:${servicePort}`,
  };
}

function makeSlotConfigIni(writeDataPath) {
  return [
    "; version=13",
    "[path]",
    "read-data=__PATH__executable__/../../data",
    `write-data=${writeDataPath}`,
  ].join("\n") + "\n";
}

export class InstancePool {
  constructor(baseConfig, size) {
    this._slots = Array.from({ length: size }, (_, i) => ({
      index: i,
      config: slotConfig(baseConfig, i),
      factorio: null,
      controller: null,
      api: null,
    }));
    this._available = [];
    this._waiters = [];
  }

  /**
   * Start all N instances from the given save and mark them ready.
   * @param {string} inputSavePath — .zip to load into each slot
   */
  async init(inputSavePath) {
    // apiDocs and wiki are config-only (no Factorio dependency) — share one copy.
    const apiDocs = new FactorioApiDocs(this._slots[0].config);
    const wiki = new FactorioWiki(this._slots[0].config);

    try {
      await Promise.all(this._slots.map(async (slot) => {
        const { config } = slot;
        for (const dir of [config.savesDir, config.configDir, config.logsDir, config.modsDir]) {
          await mkdir(dir, { recursive: true });
        }

        const factorio = new FactorioServer(config);
        await factorio.ensureLayout();
        // Isolate write-data so each slot has its own .lock file, script-output,
        // and player-data — prevents "exclusive lock" conflicts between slots.
        await writeFile(config.configFile, makeSlotConfigIni(config.runtimeDir));

        if (inputSavePath) {
          const target = factorio.savePath();
          await mkdir(resolve(target, ".."), { recursive: true });
          await copyFile(inputSavePath, target);
        }

        const api = createApi(config, factorio, apiDocs, wiki);
        await new Promise((res) => api.listen(config.servicePort, config.serviceHost, res));

        await factorio.start();

        slot.factorio = factorio;
        slot.controller = new FactorioController(factorio, config);
        slot.api = api;
      }));
    } catch (err) {
      // Partial init: clean up any slots that did start before re-throwing.
      await this.shutdown();
      throw err;
    }

    this._available = [...this._slots];
  }

  /**
   * Acquire an idle slot. Resolves immediately if one is free, otherwise
   * waits until a running candidate calls release().
   * @returns {Promise<{index, config, factorio, api}>}
   */
  acquire() {
    if (this._available.length > 0) return Promise.resolve(this._available.pop());
    return new Promise((res) => this._waiters.push(res));
  }

  /**
   * Return a slot to the pool after its candidate's execute+audit completes.
   * The slot's Factorio process was already stopped by runBenchmarkAudit.
   */
  release(slot) {
    if (this._waiters.length > 0) {
      this._waiters.shift()(slot);
    } else {
      this._available.push(slot);
    }
  }

  /** Stop all instances and close HTTP servers. */
  async shutdown() {
    await Promise.all(this._slots.map(async (slot) => {
      if (slot.api) slot.api.close();
      if (slot.factorio?.isRunning()) await slot.factorio.stop().catch(() => {});
    }));
  }
}
