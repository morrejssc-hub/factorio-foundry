import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

const FactorioServerParams = Type.Object({
  action: StringEnum(["status", "rcon", "run_lua", "save", "logs"] as const),
  command: Type.Optional(Type.String({ description: "Factorio console command for action=rcon" })),
  script: Type.Optional(Type.String({ description: "Lua script under scripts/ for action=run_lua" })),
  params: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Lua query params for run_lua" })),
  lines: Type.Optional(Type.Number({ description: "Log lines for action=logs" })),
  timeoutMs: Type.Optional(Type.Number({ description: "Optional command timeout in milliseconds" })),
});

const PositionParams = Type.Object({
  x: Type.Number({ description: "X coordinate" }),
  y: Type.Number({ description: "Y coordinate" }),
});

const FactorioReadParams = Type.Object({
  action: StringEnum(["status", "logs", "query_script", "inspect_area", "inspect_position", "inspect_inventory", "early_game_catalog", "production_stats", "measure_production_window", "validate_placement"] as const),
  script: Type.Optional(Type.String({ description: "Read-only Lua query script under scripts/ for action=query_script" })),
  params: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Params for query_script" })),
  lines: Type.Optional(Type.Number({ description: "Log lines for action=logs" })),
  position: Type.Optional(PositionParams),
  area: Type.Optional(Type.Object({
    leftTop: PositionParams,
    rightBottom: PositionParams,
  }, { description: "Area for inspect_area" })),
  target: Type.Optional(Type.Any({ description: "Inventory target for inspect_inventory" })),
  item: Type.Optional(Type.String({ description: "Item name for inventory, production stats, or production measurement" })),
  items: Type.Optional(Type.Array(Type.String(), { description: "Item names for production_stats or early_game_catalog" })),
  entities: Type.Optional(Type.Array(Type.Any(), { description: "Entity/resource prototype names for early_game_catalog, or placement entries for validate_placement" })),
  recipes: Type.Optional(Type.Array(Type.String(), { description: "Recipe names for early_game_catalog" })),
  force: Type.Optional(Type.String({ description: "Force name for production_stats or early_game_catalog, default player" })),
  surface: Type.Optional(Type.String({ description: "Surface name for production_stats or early_game_catalog, default nauvis" })),
  precision: Type.Optional(Type.String({ description: "Production stats precision such as five_seconds, one_minute, or ten_minutes" })),
  includeZero: Type.Optional(Type.Boolean({ description: "Include zero-activity rows in production_stats" })),
  sources: Type.Optional(Type.Array(Type.Any(), { description: "Inventory sources for measure_production_window" })),
  ticks: Type.Optional(Type.Number({ description: "Game ticks to wait for measure_production_window" })),
  timeoutMs: Type.Optional(Type.Number({ description: "Optional HTTP timeout override for long read operations" })),
  limit: Type.Optional(Type.Number({ description: "Maximum entities to list for inspect_area, or sample rows for early_game_catalog" })),
});

const FactorioActionParams = Type.Object({
  action: StringEnum([
    "move_to",
    "mine_resource",
    "craft",
    "place_from_inventory",
    "mine_entity_to_inventory",
    "transfer_inventory",
    "execute_blueprint",
    "compose_capability",
    "compose_chain",
    "connect_belt",
    "connect_power",
    "route_belt",
    "wait_ticks",
    "save",
    "propose_capability",
  ] as const),
  position: Type.Optional(PositionParams),
  anchor: Type.Optional(PositionParams),
  blueprint: Type.Optional(Type.Any({ description: "Blueprint name under blueprints/*.json, or an inline blueprint object" })),
  capability: Type.Optional(Type.String({ description: "Capability id from agent-workspace/capabilities/index.json for action=compose_capability" })),
  chain: Type.Optional(Type.Any({ description: "Geometry Layer v1 chain DSL for action=compose_chain" })),
  dryRun: Type.Optional(Type.Boolean({ description: "For execute_blueprint/connect_belt/connect_power, verify without changing the world" })),
  resource: Type.Optional(Type.String({ description: "Resource to manually mine" })),
  item: Type.Optional(Type.String({ description: "Item to craft/place/transfer" })),
  count: Type.Optional(Type.Number({ description: "Positive integer count" })),
  direction: Type.Optional(Type.String({ description: "Placement direction such as north/east/south/west" })),
  entity: Type.Optional(Type.Any({ description: "Entity ref: {name, position:{x,y}}" })),
  entityRef: Type.Optional(Type.Any({ description: "Entity ref for mine_entity_to_inventory" })),
  from: Type.Optional(Type.Any({ description: "Transfer source: {type:'worker'} or {type:'entity', name, position, inventory}" })),
  to: Type.Optional(Type.Any({ description: "Transfer destination: {type:'worker'} or {type:'entity', name, position, inventory}" })),
  start: Type.Optional(PositionParams),
  end: Type.Optional(PositionParams),
  mode: Type.Optional(Type.String({ description: "For connect_belt: x_then_y or y_then_x" })),
  maxLength: Type.Optional(Type.Number({ description: "For connect_belt/connect_power: maximum path length" })),
  maxSpacing: Type.Optional(Type.Number({ description: "For connect_power: maximum pole spacing, default 7" })),
  allowUnderground: Type.Optional(Type.Boolean({ description: "For route_belt: allow underground belts to bypass obstacles" })),
  undergroundMaxDistance: Type.Optional(Type.Number({ description: "For route_belt: max underground belt span, default 4" })),
  occupied: Type.Optional(Type.Array(Type.Any({ description: "For route_belt: blocked tile positions" }))),
  inventory: Type.Optional(Type.String({ description: "Inventory kind: chest, fuel, furnace_source, furnace_result, burnt_result" })),
  ticks: Type.Optional(Type.Number({ description: "Ticks for wait_ticks" })),
  timeoutMs: Type.Optional(Type.Number({ description: "Optional HTTP timeout override for long action operations" })),
  name: Type.Optional(Type.String({ description: "Capability proposal name" })),
  useCase: Type.Optional(Type.String({ description: "Capability proposal use case" })),
  missingReason: Type.Optional(Type.String({ description: "Why existing actions are insufficient" })),
  desiredSchema: Type.Optional(Type.Any({ description: "Suggested schema for the missing action" })),
  validationPlan: Type.Optional(Type.String({ description: "How the proposed capability should be validated" })),
});

export default function factorioServerExtension(pi: ExtensionAPI) {
  const serviceUrl = process.env.FACTORIO_AGENT_SERVICE_URL || "http://127.0.0.1:4317";

  function timeoutForParams(params: unknown) {
    if (!params || typeof params !== "object") return 0;
    const record = params as Record<string, unknown>;
    const explicitTimeoutMs = Number(record.timeoutMs);
    if (Number.isFinite(explicitTimeoutMs) && explicitTimeoutMs > 0) return explicitTimeoutMs;

    const action = String(record.action || "");
    const ticks = Number(record.ticks);
    if ((action === "measure_production_window" || action === "wait_ticks") && Number.isFinite(ticks) && ticks > 0) {
      return Math.ceil((ticks / 60) * 1000) + 60000;
    }
    return 0;
  }

  async function callTool(path: string, params: unknown, signal: AbortSignal) {
    const timeoutMs = timeoutForParams(params);
    const controller = timeoutMs ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    const requestSignal = controller?.signal || signal;

    const response = await fetch(`${serviceUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
      signal: requestSignal,
    }).finally(() => {
      if (timer) clearTimeout(timer);
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error || `${path} HTTP ${response.status}`);
    }

    return {
      content: [{ type: "text" as const, text: JSON.stringify(payload.result, null, 2) }],
      details: payload.result,
    };
  }

  pi.registerTool({
    name: "factorio_read",
    label: "Factorio Read",
    description: "Read live Factorio state through safe read-only queries.",
    promptSnippet: "Inspect status, connected players, logs, areas, UI-like position hover details, inventories, early-game entity/recipe catalog data, UI-backed production statistics, read-only query scripts, and production windows.",
    promptGuidelines: [
      "Use factorio_read for live state, logs, and read-only Lua query scripts.",
      "Use early_game_catalog before planner-created early-game blueprints; it reports live item/entity/recipe prototypes, enabled recipes, supported local craft/place coverage, and optional area resources.",
      "Use production_stats for game production UI counters; it is backed by LuaForce.get_item_production_statistics(surface).",
      "Use validate_placement to ask the engine whether planned entities can be placed without mutating the world.",
      "Long measure_production_window calls are allowed; the extension sets an HTTP timeout from ticks so a 36000-tick validation window can complete.",
      "Use inspect_position with a position before writing ad hoc Lua to inspect a hovered entity or resource tile; prefer selected.summary and selected.ports.output/input for layout decisions before using lower-level fields.",
      "query_script rejects mutating Lua; use it only for probes and measurements.",
      "For world changes, use factorio_action. Do not request raw RCON or unrestricted Lua.",
    ],
    parameters: FactorioReadParams,

    async execute(_toolCallId, params, signal) {
      return callTool("/tool/factorio_read", params, signal);
    },
  });

  pi.registerTool({
    name: "factorio_action",
    label: "Factorio Action",
    description: "Perform controlled Factorio actions through structured parameters.",
    promptSnippet: "Move the tagged worker character, manually mine, craft, place from inventory, compose capabilities or geometry chains into execute_blueprint-ready blueprints, execute workspace blueprints, connect belt routes, route belts with A* pathfinding, connect power poles, mine entities, transfer inventories, wait, save, or propose a missing capability.",
    promptGuidelines: [
      "Use factorio_action for every world-changing operation.",
      "Use compose_capability with a capability id and params to turn a registered Geometry Layer v1 capability blob into an inline blueprint_json; then pass blueprint_json to execute_blueprint with dryRun=true before mutating.",
      "Use compose_chain to turn a Geometry Layer v1 chain DSL into an inline blueprint_json after static solving and engine placement validation; then pass blueprint_json to execute_blueprint with dryRun=true before mutating.",
      "Use execute_blueprint with dryRun=true before placing reusable blueprints when the anchor or inventory is uncertain.",
      "Use connect_belt with dryRun=true to lay a directed Manhattan transport-belt route between two belt endpoints; the service material policy decides whether new belts must come from worker inventory.",
      "Use route_belt to find an A* path between two positions, optionally using underground belts to bypass obstacles; returns path entities but does not place them.",
      "Use connect_power with dryRun=true to lay a Manhattan small-electric-pole route between two endpoints; the service material policy decides whether new poles must come from worker inventory.",
      "Actions operate through the tagged worker character inventory in Factorio; JSON state is only a worker handle/cache.",
      "The worker is a standalone character entity, not a LuaPlayer. Do not search game.players for it; use inspect_inventory target={type:'worker'} or move_to to ensure it.",
      "When real players are connected, world-changing actions are blocked unless the supervisor explicitly enables FACTORIO_AGENT_ALLOW_MUTATION_WITH_CONNECTED_PLAYERS.",
      "If a needed operation is missing, call propose_capability instead of using raw Lua.",
      "Long wait_ticks calls are allowed only when a task explicitly requires elapsed game time; the extension sets an HTTP timeout from ticks.",
      "Do not treat diagnostic inventory transfers or manually inserted items as production proof.",
    ],
    parameters: FactorioActionParams,

    async execute(_toolCallId, params, signal) {
      return callTool("/tool/factorio_action", params, signal);
    },
  });

  pi.registerTool({
    name: "factorio_server",
    label: "Factorio Server",
    description: "Operator-only legacy Factorio server control. Prefer factorio_read and factorio_action for agent tasks.",
    promptSnippet: "Legacy raw RCON/Lua/debug tool. Do not use for normal agent tasks.",
    promptGuidelines: [
      "This is a legacy operator/debug surface.",
      "For normal tasks, use factorio_read for reads and factorio_action for changes.",
      "Do not use rcon or run_lua to bypass the controlled action set.",
      "Do not use normal file tools to inspect runtime/ or the repository parent; keep durable notes in memory/ and state/."
    ],
    parameters: FactorioServerParams,

    async execute(_toolCallId, params, signal) {
      return callTool("/tool/factorio_server", params, signal);
    },
  });

  pi.registerCommand("factorio-status", {
    description: "Show Factorio supervisor status",
    handler: async (_args, ctx) => {
      const response = await fetch(`${serviceUrl}/status`);
      const payload = await response.json();
      ctx.ui.notify(JSON.stringify(payload.factorio || payload, null, 2), "info");
    },
  });
}
