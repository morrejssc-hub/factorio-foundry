import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

const FactorioApiDocsParams = Type.Object({
  action: StringEnum(["summary", "search", "lookup"] as const),
  query: Type.Optional(Type.String({ description: "Free-text query for action=search, or fallback name for lookup" })),
  name: Type.Optional(Type.String({ description: "Exact or partial API entry name for action=lookup, e.g. LuaEntity" })),
  member: Type.Optional(Type.String({ description: "Optional method/attribute/property/value name filter inside a matched entry" })),
  stage: Type.Optional(StringEnum(["all", "runtime", "prototype"] as const)),
  kind: Type.Optional(StringEnum([
    "all",
    "class",
    "event",
    "concept",
    "define",
    "global_object",
    "global_function",
    "prototype",
    "type",
  ] as const)),
  limit: Type.Optional(Type.Number({ description: "Maximum number of entries to return" })),
  memberLimit: Type.Optional(Type.Number({ description: "Maximum number of members to include in lookup output" })),
  raw: Type.Optional(Type.Boolean({ description: "Include the raw JSON entry for exact detailed inspection" })),
});

export default function factorioApiDocsExtension(pi: ExtensionAPI) {
  const serviceUrl = process.env.FACTORIO_AGENT_SERVICE_URL || "http://127.0.0.1:4317";

  pi.registerTool({
    name: "factorio_api_docs",
    label: "Factorio API Docs",
    description: "Query the local official Factorio runtime/prototype API documentation extracted from archive.zip.",
    promptSnippet: "Search and look up official Factorio runtime/prototype API entries before using uncertain Lua fields, methods, events, prototypes, or defines.",
    promptGuidelines: [
      "Use factorio_api_docs when unsure about a Factorio Lua API class, method, attribute, event, define, prototype, or type.",
      "Prefer lookup with a name and optional member for exact API questions, e.g. name=LuaEntity member=fluidbox.",
      "Use search for broad questions like boiler fluidbox or research queue, then lookup the best match before writing Lua scripts."
    ],
    parameters: FactorioApiDocsParams,

    async execute(_toolCallId, params, signal) {
      const response = await fetch(`${serviceUrl}/tool/factorio_api_docs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
        signal,
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.error || `factorio_api_docs HTTP ${response.status}`);
      }

      return {
        content: [{ type: "text", text: JSON.stringify(payload.result, null, 2) }],
        details: payload.result,
      };
    },
  });
}
