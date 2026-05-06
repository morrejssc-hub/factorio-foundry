import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

function normalize(value) {
  return String(value || "").toLowerCase();
}

function excerpt(text, max = 420) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trim()}...`;
}

function typeName(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(typeName).filter(Boolean).join(" | ");
  if (typeof value !== "object") return String(value);
  if (value.complex_type === "literal") return JSON.stringify(value.value);
  if (value.complex_type === "union") return (value.options || []).map(typeName).filter(Boolean).join(" | ");
  if (value.complex_type === "array") return `${typeName(value.value) || "any"}[]`;
  if (value.complex_type === "dictionary") {
    return `{[${typeName(value.key) || "key"}]: ${typeName(value.value) || "value"}}`;
  }
  if (value.complex_type) return value.complex_type;
  return excerpt(JSON.stringify(value), 120);
}

function listNames(values, limit = 30) {
  const rows = (values || []).map((value) => value?.name).filter(Boolean);
  if (rows.length <= limit) return rows;
  return [...rows.slice(0, limit), `... ${rows.length - limit} more`];
}

function methodSignature(method) {
  const params = (method.parameters || [])
    .map((param) => `${param.name}: ${typeName(param.type) || "any"}${param.optional ? "?" : ""}`)
    .join(", ");
  const returns = (method.return_values || [])
    .map((ret) => typeName(ret.type) || ret.name || "value")
    .filter(Boolean);
  return `${method.name}(${params})${returns.length ? ` -> ${returns.join(", ")}` : ""}`;
}

function propertySummary(property) {
  const bits = [property.name];
  const readType = property.read_type || property.type;
  const writeType = property.write_type;
  if (readType) bits.push(`: ${typeName(readType)}`);
  if (writeType) bits.push(`, write: ${typeName(writeType)}`);
  if (property.optional) bits.push(" optional");
  return bits.join("");
}

function memberText(member) {
  const summary = member.parameters ? methodSignature(member) : propertySummary(member);
  const desc = excerpt(member.description, 180);
  return desc ? `${summary} - ${desc}` : summary;
}

function collectMembers(item) {
  return [
    ...(item.methods || []).map((member) => ({ group: "methods", member })),
    ...(item.attributes || []).map((member) => ({ group: "attributes", member })),
    ...(item.operators || []).map((member) => ({ group: "operators", member })),
    ...(item.properties || []).map((member) => ({ group: "properties", member })),
    ...(item.data || []).map((member) => ({ group: "data", member })),
    ...(item.values || []).map((member) => ({ group: "values", member })),
    ...(item.parameters || []).map((member) => ({ group: "parameters", member })),
    ...(item.return_values || []).map((member) => ({ group: "return_values", member })),
  ];
}

function matchMember(item, memberQuery) {
  const query = normalize(memberQuery);
  if (!query) return [];
  return collectMembers(item)
    .filter(({ member }) => normalize(member.name).includes(query))
    .map(({ group, member }) => ({ group, ...member, summary: memberText(member) }));
}

function compactEntry(entry, options = {}) {
  const item = entry.item;
  const result = {
    stage: entry.stage,
    kind: entry.kind,
    name: item.name,
    description: excerpt(item.description),
  };

  if (item.parent) result.parent = item.parent;
  if (item.typename) result.typename = item.typename;
  if (item.type) result.type = typeName(item.type);
  if (item.read_type) result.read_type = typeName(item.read_type);
  if (item.write_type) result.write_type = typeName(item.write_type);

  const memberQuery = options.member || "";
  const matchedMembers = matchMember(item, memberQuery);
  if (memberQuery) {
    result.members = matchedMembers;
  } else {
    result.member_counts = {
      methods: item.methods?.length || 0,
      attributes: item.attributes?.length || 0,
      operators: item.operators?.length || 0,
      properties: item.properties?.length || 0,
      data: item.data?.length || 0,
      values: item.values?.length || 0,
    };
    result.members = collectMembers(item)
      .slice(0, options.memberLimit || 16)
      .map(({ group, member }) => ({ group, name: member.name, summary: memberText(member) }));
  }

  if (item.examples && options.examples !== false) {
    result.examples = item.examples.slice(0, 2);
  }
  if (options.raw) result.raw = item;
  return result;
}

function entryHaystack(entry) {
  const item = entry.item;
  const members = collectMembers(item)
    .map(({ member }) => `${member.name || ""} ${member.description || ""} ${typeName(member.type || member.read_type || "") || ""}`)
    .join(" ");
  return normalize(`${entry.stage} ${entry.kind} ${item.name || ""} ${item.description || ""} ${members}`);
}

function scoreEntry(entry, query) {
  const q = normalize(query).trim();
  if (!q) return 0;
  const name = normalize(entry.item.name);
  const desc = normalize(entry.item.description);
  const haystack = entryHaystack(entry);
  const tokens = q.split(/\s+/).filter(Boolean);
  let score = 0;
  if (name === q) score += 1000;
  if (name.startsWith(q)) score += 500;
  if (name.includes(q)) score += 320;
  if (desc.includes(q)) score += 120;
  for (const token of tokens) {
    if (name.includes(token)) score += 80;
    if (haystack.includes(token)) score += 20;
  }
  if (tokens.length > 1 && tokens.every((token) => haystack.includes(token))) score += 120;
  return score;
}

export class FactorioApiDocs {
  constructor(config) {
    this.config = config;
    this.loaded = null;
  }

  async readJson(name) {
    const path = join(this.config.apiDocsDir, name);
    const text = await readFile(path, "utf8");
    return JSON.parse(text);
  }

  async load() {
    if (this.loaded) return this.loaded;
    const [runtime, prototype] = await Promise.all([
      this.readJson("runtime-api.json"),
      this.readJson("prototype-api.json"),
    ]);
    const entries = [];
    const addMany = (stage, kind, values = []) => {
      for (const item of values) entries.push({ stage, kind, item });
    };
    addMany("runtime", "class", runtime.classes);
    addMany("runtime", "event", runtime.events);
    addMany("runtime", "concept", runtime.concepts);
    addMany("runtime", "define", runtime.defines);
    addMany("runtime", "global_object", runtime.global_objects);
    addMany("runtime", "global_function", runtime.global_functions);
    addMany("prototype", "prototype", prototype.prototypes);
    addMany("prototype", "type", prototype.types);
    addMany("prototype", "define", prototype.defines);
    this.loaded = { runtime, prototype, entries };
    return this.loaded;
  }

  async summary() {
    const { runtime, prototype } = await this.load();
    return {
      docsDir: resolve(this.config.apiDocsDir),
      runtime: {
        applicationVersion: runtime.application_version,
        apiVersion: runtime.api_version,
        classes: runtime.classes?.length || 0,
        events: runtime.events?.length || 0,
        concepts: runtime.concepts?.length || 0,
        defines: runtime.defines?.length || 0,
        globalObjects: runtime.global_objects?.length || 0,
        globalFunctions: runtime.global_functions?.length || 0,
      },
      prototype: {
        applicationVersion: prototype.application_version,
        apiVersion: prototype.api_version,
        prototypes: prototype.prototypes?.length || 0,
        types: prototype.types?.length || 0,
        defines: prototype.defines?.length || 0,
      },
    };
  }

  filterEntries(entries, input = {}) {
    return entries.filter((entry) => {
      if (input.stage && input.stage !== "all" && entry.stage !== input.stage) return false;
      if (input.kind && input.kind !== "all" && entry.kind !== input.kind) return false;
      return true;
    });
  }

  async search(input = {}) {
    const query = String(input.query || "").trim();
    if (!query) throw new Error("query is required for factorio_api_docs search");
    const { entries } = await this.load();
    const scored = this.filterEntries(entries, input)
      .map((entry) => ({ entry, score: scoreEntry(entry, query) }))
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score || a.entry.item.name.localeCompare(b.entry.item.name));
    const limit = Math.max(1, Math.min(Number(input.limit) || 8, 30));
    return {
      query,
      count: scored.length,
      results: scored.slice(0, limit).map(({ entry, score }) => ({
        score,
        ...compactEntry(entry, { member: input.member, memberLimit: 8, examples: false }),
      })),
    };
  }

  async lookup(input = {}) {
    const name = String(input.name || input.query || "").trim();
    if (!name) throw new Error("name or query is required for factorio_api_docs lookup");
    const { entries } = await this.load();
    const filtered = this.filterEntries(entries, input);
    const exact = filtered.filter((entry) => normalize(entry.item.name) === normalize(name));
    const matches = exact.length > 0
      ? exact
      : filtered.filter((entry) => normalize(entry.item.name).includes(normalize(name)));
    const limit = Math.max(1, Math.min(Number(input.limit) || 5, 20));
    return {
      query: name,
      count: matches.length,
      results: matches.slice(0, limit).map((entry) => compactEntry(entry, {
        member: input.member,
        memberLimit: Number(input.memberLimit) || 24,
        raw: Boolean(input.raw),
      })),
    };
  }

  async handleTool(input = {}) {
    const action = input.action || "search";
    switch (action) {
      case "summary":
        return this.summary();
      case "search":
        return this.search(input);
      case "lookup":
        return this.lookup(input);
      default:
        throw new Error(`unknown factorio_api_docs action: ${action}`);
    }
  }
}
