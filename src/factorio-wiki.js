import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(parsed, max));
}

function normalizeTitle(value) {
  return String(value || "")
    .trim()
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function pageUrl(title) {
  return `https://wiki.factorio.com/${encodeURIComponent(String(title || "").replace(/\s+/g, "_"))}`;
}

function safeSlug(value) {
  const slug = String(value || "page")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "page";
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function stripHtml(value) {
  return decodeHtml(String(value || "").replace(/<[^>]+>/g, ""));
}

function stripTemplates(value) {
  let text = String(value || "");
  for (let i = 0; i < 8; i += 1) {
    const next = text.replace(/\{\{[^{}]*\}\}/g, "");
    if (next === text) break;
    text = next;
  }
  return text;
}

function cleanInline(value) {
  return stripHtml(String(value || ""))
    .replace(/\[\[(?:File|Image):[^\]]+\]\]/gi, "")
    .replace(/\[\[[^\]|]+\|([^\]]+)\]\]/g, "$1")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[(https?:\/\/[^\s\]]+)\s+([^\]]+)\]/g, "$2")
    .replace(/\[(https?:\/\/[^\s\]]+)\]/g, "$1")
    .replace(/'''?/g, "")
    .replace(/__[A-Z_]+__/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanSnippet(value) {
  return cleanInline(stripTemplates(stripHtml(value)));
}

function wikitextToPlainText(value) {
  let text = String(value || "");
  text = text.replace(/<!--[\s\S]*?-->/g, "");
  text = text.replace(/<ref\b[\s\S]*?<\/ref>/gi, "");
  text = text.replace(/<ref\b[^/>]*\/>/gi, "");
  text = text.replace(/\{\|[\s\S]*?\|\}/g, "");
  text = stripTemplates(text);
  text = text.replace(/^\[\[(?:File|Image):.*$/gim, "");
  text = text.replace(/^(={2,6})\s*(.*?)\s*\1\s*$/gm, (_, marks, heading) => {
    const level = Math.max(1, marks.length - 1);
    return `${"#".repeat(level)} ${cleanInline(heading)}`;
  });
  text = text.replace(/\[\[(?:File|Image):[^\]]+\]\]/gi, "");
  text = text.replace(/\[\[[^\]|]+\|([^\]]+)\]\]/g, "$1");
  text = text.replace(/\[\[([^\]]+)\]\]/g, "$1");
  text = text.replace(/\[(https?:\/\/[^\s\]]+)\s+([^\]]+)\]/g, "$2");
  text = text.replace(/\[(https?:\/\/[^\s\]]+)\]/g, "$1");
  text = text.replace(/'''?/g, "");
  text = text.replace(/<[^>]+>/g, "");
  text = decodeHtml(text);
  return text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function sectionsFromWikitext(value) {
  const text = String(value || "");
  const regex = /^(={2,6})\s*(.*?)\s*\1\s*$/gm;
  const headings = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    headings.push({
      level: match[1].length,
      title: cleanInline(match[2]),
      headingStart: match.index,
      bodyStart: regex.lastIndex,
    });
  }
  return headings.map((heading, index) => {
    const next = headings
      .slice(index + 1)
      .find((candidate) => candidate.level <= heading.level);
    return {
      title: heading.title,
      level: heading.level,
      start: heading.bodyStart,
      end: next ? next.headingStart : text.length,
    };
  });
}

function selectSection(wikitext, sectionQuery) {
  const sections = sectionsFromWikitext(wikitext);
  if (!sectionQuery) {
    return { wikitext, sections, matched: null };
  }
  const needle = normalizeTitle(sectionQuery);
  const match = sections.find((section) => normalizeTitle(section.title) === needle)
    || sections.find((section) => normalizeTitle(section.title).includes(needle));
  if (!match) {
    return { wikitext: "", sections, matched: null };
  }
  return {
    wikitext: wikitext.slice(match.start, match.end),
    sections,
    matched: { title: match.title, level: match.level },
  };
}

function limitText(value, maxChars) {
  const text = String(value || "");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1).trim()}...`;
}

export class FactorioWiki {
  constructor(config) {
    this.config = config;
    this.apiUrl = config.wikiApiUrl || "https://wiki.factorio.com/api.php";
    this.cacheDir = config.wikiCacheDir;
    this.pagesDir = join(this.cacheDir, "pages");
    this.indexPath = join(this.cacheDir, "index.json");
  }

  async ensureCacheDir() {
    await mkdir(this.pagesDir, { recursive: true });
  }

  async readIndex() {
    try {
      const text = await readFile(this.indexPath, "utf8");
      return JSON.parse(text);
    } catch (error) {
      if (error.code === "ENOENT") {
        return { version: 1, updatedAt: null, titles: {}, pageids: {} };
      }
      throw error;
    }
  }

  async writeIndex(index) {
    await this.ensureCacheDir();
    await writeFile(this.indexPath, `${JSON.stringify(index, null, 2)}\n`);
  }

  async request(params) {
    const url = new URL(this.apiUrl);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    url.searchParams.set("format", "json");
    url.searchParams.set("formatversion", "2");
    const response = await fetch(url);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.error) {
      throw new Error(payload.error?.info || `Factorio Wiki HTTP ${response.status}`);
    }
    return payload;
  }

  async summary() {
    const index = await this.readIndex();
    return {
      apiUrl: this.apiUrl,
      cacheDir: resolve(this.cacheDir),
      cachedPages: Object.keys(index.titles || {}).length,
      updatedAt: index.updatedAt,
      actions: ["summary", "search", "lookup", "snapshot"],
    };
  }

  async search(input = {}) {
    const query = String(input.query || input.title || "").trim();
    if (!query) throw new Error("query is required for factorio_wiki search");
    const limit = clampInt(input.limit, 8, 1, 20);
    const includeTranslations = Boolean(input.includeTranslations);
    const fetchLimit = includeTranslations ? limit : Math.min(50, Math.max(limit * 4, limit));
    const payload = await this.request({
      action: "query",
      list: "search",
      srsearch: query,
      srnamespace: 0,
      srlimit: fetchLimit,
    });
    const rows = (payload.query?.search || [])
      .filter((row) => includeTranslations || !/\/[a-z][a-z](?:-[a-z]+)?$/i.test(row.title))
      .slice(0, limit);
    return {
      query,
      totalHits: payload.query?.searchinfo?.totalhits || rows.length,
      count: rows.length,
      results: rows.map((row) => ({
        title: row.title,
        pageid: row.pageid,
        size: row.size,
        wordcount: row.wordcount,
        timestamp: row.timestamp,
        snippet: cleanSnippet(row.snippet),
        url: pageUrl(row.title),
      })),
    };
  }

  async readCachedPage(title) {
    const index = await this.readIndex();
    const relPath = index.titles?.[normalizeTitle(title)];
    if (!relPath) return null;
    try {
      const text = await readFile(join(this.cacheDir, relPath), "utf8");
      return JSON.parse(text);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async writeCachedPage(page) {
    await this.ensureCacheDir();
    const filename = `${safeSlug(page.title)}-${page.pageid || "unknown"}.json`;
    const path = join(this.pagesDir, filename);
    const relPath = relative(this.cacheDir, path);
    await writeFile(path, `${JSON.stringify(page, null, 2)}\n`);
    const index = await this.readIndex();
    index.updatedAt = new Date().toISOString();
    index.titles = index.titles || {};
    index.pageids = index.pageids || {};
    index.titles[normalizeTitle(page.title)] = relPath;
    if (page.pageid) index.pageids[String(page.pageid)] = relPath;
    await this.writeIndex(index);
    return { path, relPath };
  }

  async fetchPage(title) {
    const payload = await this.request({
      action: "query",
      prop: "revisions|info",
      titles: title,
      rvslots: "main",
      rvprop: "ids|timestamp|content",
      inprop: "url",
      redirects: 1,
    });
    const page = payload.query?.pages?.[0];
    if (!page || page.missing) {
      throw new Error(`Factorio Wiki page not found: ${title}`);
    }
    const revision = page.revisions?.[0];
    const wikitext = revision?.slots?.main?.content || "";
    const record = {
      source: "official_factorio_wiki",
      sourceUrl: page.fullurl || pageUrl(page.title),
      apiUrl: this.apiUrl,
      fetchedAt: new Date().toISOString(),
      title: page.title,
      pageid: page.pageid,
      revision: {
        revid: revision?.revid || null,
        parentid: revision?.parentid || null,
        timestamp: revision?.timestamp || null,
      },
      sections: sectionsFromWikitext(wikitext).map((section) => ({
        title: section.title,
        level: section.level,
      })),
      wikitext,
    };
    const cache = await this.writeCachedPage(record);
    return { record, cache };
  }

  async resolveTitle(input) {
    const title = String(input.title || input.name || "").trim();
    if (title) return title;
    const query = String(input.query || "").trim();
    if (!query) throw new Error("title, name, or query is required for factorio_wiki lookup");
    if (input.offline) throw new Error("offline lookup requires an exact cached title");
    const result = await this.search({ query, limit: 1 });
    const first = result.results[0];
    if (!first) throw new Error(`no Factorio Wiki search result for: ${query}`);
    return first.title;
  }

  formatPage(record, input = {}, cacheStatus = "miss", cachePath = null) {
    const sectionResult = selectSection(record.wikitext, input.section);
    const maxChars = clampInt(input.maxChars, 4000, 500, 20000);
    const plain = wikitextToPlainText(sectionResult.wikitext);
    const result = {
      title: record.title,
      pageid: record.pageid,
      source: record.source,
      sourceUrl: record.sourceUrl,
      revision: record.revision,
      fetchedAt: record.fetchedAt,
      cache: {
        status: cacheStatus,
        path: cachePath ? resolve(cachePath) : null,
      },
      sections: record.sections || [],
      section: input.section ? {
        query: input.section,
        matched: sectionResult.matched,
      } : null,
      text: limitText(plain, maxChars),
      truncated: plain.length > maxChars,
    };
    if (input.raw) {
      result.wikitext = limitText(sectionResult.wikitext, maxChars);
      result.rawTruncated = sectionResult.wikitext.length > maxChars;
    }
    return result;
  }

  async lookup(input = {}) {
    const title = await this.resolveTitle(input);
    if (!input.refresh) {
      const cached = await this.readCachedPage(title);
      if (cached) {
        const index = await this.readIndex();
        const relPath = index.titles?.[normalizeTitle(cached.title)];
        return this.formatPage(cached, input, "hit", relPath ? join(this.cacheDir, relPath) : null);
      }
    }
    if (input.offline) throw new Error(`cached Factorio Wiki page not found: ${title}`);
    const { record, cache } = await this.fetchPage(title);
    return this.formatPage(record, input, "miss", cache.path);
  }

  async snapshot(input = {}) {
    const titles = Array.isArray(input.titles)
      ? input.titles
      : String(input.title || input.name || "")
        .split(",")
        .map((title) => title.trim())
        .filter(Boolean);
    if (!titles.length) throw new Error("titles or title is required for factorio_wiki snapshot");
    const results = [];
    for (const title of titles.slice(0, 20)) {
      const lookup = await this.lookup({ title, refresh: input.refresh, maxChars: 500 });
      results.push({
        title: lookup.title,
        pageid: lookup.pageid,
        sourceUrl: lookup.sourceUrl,
        revision: lookup.revision,
        cache: lookup.cache,
      });
    }
    return { count: results.length, results };
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
      case "snapshot":
        return this.snapshot(input);
      default:
        throw new Error(`unknown factorio_wiki action: ${action}`);
    }
  }
}
