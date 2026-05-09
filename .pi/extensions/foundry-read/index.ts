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
import { readFile, appendFile } from "node:fs/promises";
import { resolve, normalize, isAbsolute, join } from "node:path";

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
        "lib/probes/find-placement-anchors.lua, lib/probes/player-state.lua, " +
        "lib/probes/research-state.lua.",
      "tile-info accepts {x,y} for a single tile or {area:{x1,y1,x2,y2}} for a rectangle. " +
        "Returns tile name, entities (with bounding_box), and resource tiles (with amount).",
      "validate-placement accepts {entities:[{name,position,direction}]} and returns " +
        "canPlace per entity plus blockingEntities when blocked. Use this AFTER you have " +
        "candidate positions to verify a complete blueprint places without collisions.",
      "find-placement-anchors enumerates LEGAL anchors for a given prototype within a region. " +
        "Use this BEFORE proposing positions for terrain-sensitive entities (offshore-pump, " +
        "burner-mining-drill, electric-mining-drill, pumpjack). " +
        "Params: {entity, region:{left_top,right_bottom} OR {center,radius}, " +
        "mode:'raw'|'edge', max_results, sort_by, directions?, include_blocked_by_clearable?}. " +
        "Returns candidates=[{position, directions[], status, needs_clearing?}] grouped " +
        "by position with one entry per (x,y); pick a direction from the directions array. " +
        "mode='edge' walks only the bbox perimeter — use it for shoreline anchors (offshore-pump). " +
        "mode='raw' scans the bbox interior — use it for area-fill (mining-drill on a coal patch).",
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

      const startedAt = Date.now();
      const ts = new Date().toISOString();
      let ok = true;
      let errorMessage: string | undefined;
      let result: { output?: string } = {};

      try {
        const response = await fetch(`${serviceUrl}/tool/foundry_probe`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lua, params: input.params ?? {} }),
          signal,
        });

        const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        if (!response.ok || payload.ok === false) {
          ok = false;
          errorMessage =
            (payload.error as string) || `foundry_probe HTTP ${response.status}`;
          throw new Error(errorMessage);
        }

        result = (payload.result as { output?: string }) ?? {};
        return {
          content: [{ type: "text" as const, text: result.output ?? "(empty)" }],
          details: result,
        };
      } catch (err) {
        ok = false;
        if (!errorMessage) {
          errorMessage = err instanceof Error ? err.message : String(err);
        }
        throw err;
      } finally {
        const record = {
          ts,
          script_path: scriptPath,
          lua,
          params: input.params ?? {},
          ok,
          elapsed_ms: Date.now() - startedAt,
          ...(ok ? {} : { error: errorMessage }),
        };
        try {
          await appendFile(
            join(cwd, "probe-calls.jsonl"),
            JSON.stringify(record) + "\n"
          );
        } catch {
          // best-effort: never fail the tool because logging failed
        }
      }
    },
  });
}
