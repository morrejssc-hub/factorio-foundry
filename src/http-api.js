import { createServer } from "node:http";
import { URL } from "node:url";

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  return text.trim() ? JSON.parse(text) : {};
}

function send(res, status, payload) {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

export function createApi(config, factorio, apiDocs, wiki) {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", config.serviceUrl);

      if (req.method === "GET" && url.pathname === "/health") {
        return send(res, 200, { ok: true });
      }

      if (req.method === "GET" && url.pathname === "/status") {
        return send(res, 200, {
          service: { host: config.serviceHost, port: config.servicePort },
          factorio: await factorio.status(),
        });
      }

      if (req.method === "POST" && url.pathname === "/tool/factorio_server") {
        const input = await readJson(req);
        const result = await factorio.handleTool(input);
        return send(res, 200, { ok: true, result });
      }

      if (req.method === "POST" && url.pathname === "/tool/factorio_read") {
        const input = await readJson(req);
        const result = await factorio.handleRead(input);
        return send(res, 200, { ok: true, result });
      }

      if (req.method === "POST" && url.pathname === "/tool/factorio_action") {
        const input = await readJson(req);
        const result = await factorio.handleAction(input);
        return send(res, 200, { ok: true, result });
      }

      if (req.method === "POST" && url.pathname === "/tool/factorio_api_docs") {
        const input = await readJson(req);
        const result = await apiDocs.handleTool(input);
        return send(res, 200, { ok: true, result });
      }

      if (req.method === "POST" && url.pathname === "/tool/factorio_wiki") {
        const input = await readJson(req);
        const result = await wiki.handleTool(input);
        return send(res, 200, { ok: true, result });
      }

      return send(res, 404, { ok: false, error: "not found" });
    } catch (error) {
      return send(res, 500, { ok: false, error: error.message });
    }
  });
}
