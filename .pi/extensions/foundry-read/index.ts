/**
 * foundry-read: pi extension for the Design phase.
 *
 * Registers a single `factorio_read` tool that lets the designer run
 * read-only Lua probe scripts against the live Factorio game.
 *
 * Script resolution: paths are resolved relative to the pi process cwd
 * (the design phase outDir). The design phase symlinks lib/ → foundry/lib/
 * so canonical probes are at "lib/probes/tile-info.lua" etc.  Scripts the
 * designer writes itself live at the cwd root.
 *
 * The extension reads the Lua file locally and sends the raw content to
 * the foundry HTTP service at /tool/foundry_probe. The server validates
 * read-only safety and runs the script via RCON.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { readFile } from "node:fs/promises";
import { resolve, normalize, isAbsolute } from "node:path";

export default function foundryReadExtension(pi: ExtensionAPI) {
  const serviceUrl =
    process.env.FOUNDRY_SERVICE_URL ||
    process.env.FACTORIO_AGENT_SERVICE_URL ||
    "http://127.0.0.1:4317";

  const Params = Type.Object({
    script: Type.String({
      description:
        'Path to a read-only Lua probe script. Use "lib/probes/<name>.lua" for ' +
        "canonical atomic probes (tile-info, validate-placement, player-state, " +
        "research-state). Use a relative path for scripts you write yourself in " +
        "the current working directory.",
    }),
    params: Type.Optional(
      Type.Record(Type.String(), Type.Any(), {
        description: "Parameters passed to the script's query(params) function.",
      })
    ),
  });

  pi.registerTool({
    name: "factorio_read",
    label: "Factorio Read (probe)",
    description:
      "Run a read-only Lua probe script against the live Factorio game. " +
      "Use canonical probes from lib/probes/ or write a custom .lua script " +
      "to compose multiple queries in one call. factorio_action is not available " +
      "in the Design phase — this tool is read-only only.",
    promptSnippet:
      "Query tile type, entities, resources, player inventory, research state, " +
      "or run a custom multi-query probe script from the current directory.",
    promptGuidelines: [
      "Canonical probes: lib/probes/tile-info.lua, lib/probes/validate-placement.lua, " +
        "lib/probes/player-state.lua, lib/probes/research-state.lua.",
      "tile-info accepts {x,y} for a single tile or {area:{x1,y1,x2,y2}} for a rectangle. " +
        "Returns tile name, entities (with bounding_box), and resource tiles (with amount).",
      "validate-placement accepts {entities:[{name,position,direction}]} and returns " +
        "canPlace per entity plus blockingEntities when blocked.",
      "player-state returns worker position and inventory (sorted by item name).",
      "research-state returns completed technologies, current research, and all enabled recipes.",
      "To combine multiple queries in one RCON round-trip, write a .lua file using the write " +
        "tool, then call factorio_read with your script path.",
      "Scripts must be read-only — no game.surfaces[1].create_entity, no rcon.exec, no " +
        "game.speed changes. Mutating Lua is rejected by the server.",
    ],
    parameters: Params,

    async execute(_toolCallId, input, signal) {
      const cwd = process.cwd();
      const scriptPath = input.script;

      // Prevent path traversal outside cwd
      const absolute = isAbsolute(scriptPath)
        ? scriptPath
        : resolve(cwd, scriptPath);
      const normalized = normalize(absolute);
      if (!normalized.startsWith(normalize(cwd) + "/") && normalized !== normalize(cwd)) {
        throw new Error(`script path escapes working directory: ${scriptPath}`);
      }

      const lua = await readFile(absolute, "utf8");

      const response = await fetch(`${serviceUrl}/tool/foundry_probe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lua, params: input.params ?? {} }),
        signal,
      });

      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok || payload.ok === false) {
        throw new Error(
          (payload.error as string) || `foundry_probe HTTP ${response.status}`
        );
      }

      const result = payload.result as { output?: string };
      return {
        content: [{ type: "text" as const, text: result.output ?? "(empty)" }],
        details: result,
      };
    },
  });
}
