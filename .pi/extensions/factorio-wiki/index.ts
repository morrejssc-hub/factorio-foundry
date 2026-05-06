import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

const FactorioWikiParams = Type.Object({
  action: StringEnum(["summary", "search", "lookup", "snapshot"] as const),
  query: Type.Optional(Type.String({ description: "Free-text official Factorio Wiki search query" })),
  title: Type.Optional(Type.String({ description: "Exact official Factorio Wiki page title, e.g. Burner mining drill" })),
  name: Type.Optional(Type.String({ description: "Alias for title when looking up an entity or concept page" })),
  titles: Type.Optional(Type.Array(Type.String({ description: "Page titles to snapshot into the local cache" }))),
  section: Type.Optional(Type.String({ description: "Optional page section to extract, e.g. Self-Sustaining Coal Mines" })),
  limit: Type.Optional(Type.Number({ description: "Maximum search results" })),
  maxChars: Type.Optional(Type.Number({ description: "Maximum characters returned from page text" })),
  raw: Type.Optional(Type.Boolean({ description: "Include bounded raw wikitext for exact inspection" })),
  refresh: Type.Optional(Type.Boolean({ description: "Force a fresh fetch even when the page is cached" })),
  offline: Type.Optional(Type.Boolean({ description: "Require a cached page and do not contact the wiki" })),
  includeTranslations: Type.Optional(Type.Boolean({ description: "Include translated wiki subpages such as /de or /zh in search results" })),
});

export default function factorioWikiExtension(pi: ExtensionAPI) {
  const serviceUrl = process.env.FACTORIO_AGENT_SERVICE_URL || "http://127.0.0.1:4317";

  pi.registerTool({
    name: "factorio_wiki",
    label: "Factorio Wiki",
    description: "Search and look up official Factorio Wiki gameplay mechanics with a local revision cache.",
    promptSnippet: "Use factorio_wiki for gameplay mechanics and entity behavior before planning blueprints or layout logic that depends on how Factorio works.",
    promptGuidelines: [
      "Use factorio_wiki when unsure about gameplay mechanics, entity behavior, early-game layouts, fuel behavior, production concepts, or official item/entity pages.",
      "Use factorio_api_docs instead for Lua runtime API classes, methods, attributes, defines, events, prototypes, and script contracts.",
      "Prefer lookup with title for known pages, or search first and then lookup the best result.",
      "Record page title and revision.revid in plans when wiki facts materially affect blueprint decisions.",
      "Treat wiki results as context and validate important layout behavior with live Factorio probes.",
    ],
    parameters: FactorioWikiParams,

    async execute(_toolCallId, params, signal) {
      const response = await fetch(`${serviceUrl}/tool/factorio_wiki`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
        signal,
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.error || `factorio_wiki HTTP ${response.status}`);
      }

      return {
        content: [{ type: "text", text: JSON.stringify(payload.result, null, 2) }],
        details: payload.result,
      };
    },
  });
}
