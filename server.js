"use strict";

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { spawn } = require("child_process");
const { Store, AppError } = require("./db");

const store = new Store(path.join(__dirname, "data"));
const webRoot = path.resolve(__dirname, "web");
const port = Number(process.env.PORT || 5173);

const routes = [];

function route(method, pattern, handler) {
  const keys = [];
  const re = new RegExp(
    "^" + pattern.replace(/:([A-Za-z_]+)/g, (_, key) => {
      keys.push(key);
      return "([^/]+)";
    }) + "$"
  );
  routes.push({ method, re, keys, handler });
}

function contentDisposition(filename) {
  const star = encodeURIComponent(filename).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  const ascii = filename.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${star}`;
}

function send(res, status, payload, extra) {
  const body = JSON.stringify(payload ?? {});
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...(extra || {}),
  });
  res.end(body);
}

function readCookie(req, name) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return "";
}

function sessionCookie(token) {
  const maxAge = token ? 60 * 60 * 24 * 30 : 0;
  return `ruida_session=${token || ""}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}`;
}

const PUBLIC_API = new Set(["/api/health", "/api/brand", "/api/login", "/api/setup"]);

function assertAccess(user, method, pathname) {
  if (user.role === "viewer" && method !== "GET" && method !== "HEAD") {
    throw new AppError("forbidden", 403);
  }
  if (pathname.startsWith("/api/users") && user.role !== "boss") throw new AppError("forbidden", 403);
  if (pathname === "/api/factory-reset" && user.role !== "boss") throw new AppError("forbidden", 403);
  if (pathname === "/api/settings" && method !== "GET" && user.role !== "boss") throw new AppError("forbidden", 403);
}

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new AppError("too_large", 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 8_000_000) {
        reject(new AppError("too_large", 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (_) {
        reject(new AppError("bad_json"));
      }
    });
    req.on("error", reject);
  });
}

function numId(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new AppError("not_found", 404);
  return n;
}

async function handle(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  const token = readCookie(req, "ruida_session");
  if (url.pathname.startsWith("/uploads/")) {
    if (!store.userFromToken(token)) {
      res.writeHead(401, { "Cache-Control": "no-store" });
      return res.end();
    }
    return serveUpload(url.pathname, res);
  }
  let user = null;
  if (url.pathname.startsWith("/api/") && !PUBLIC_API.has(url.pathname)) {
    user = store.userFromToken(token);
    if (!user) throw new AppError("unauthorized", 401);
    assertAccess(user, req.method, url.pathname);
  }
  for (const entry of routes) {
    if (entry.method !== req.method) continue;
    const match = entry.re.exec(url.pathname);
    if (!match) continue;
    const params = Object.fromEntries(entry.keys.map((key, i) => [key, decodeURIComponent(match[i + 1])]));
    const importing = req.method === "POST" && url.pathname === "/api/backups/import";
    const body = req.method === "GET" || req.method === "HEAD" ? {} : importing ? await readRaw(req, 80_000_000) : await readBody(req);
    if (user && body && typeof body === "object" && !Buffer.isBuffer(body)) {
      const signed = String(body.operator || "").trim();
      body.operator = signed || user.name || user.username;
    }
    const result = await entry.handler({ params, query: url.searchParams, body, user, token });
    const extra = {};
    if (result && result.token) {
      extra["Set-Cookie"] = sessionCookie(result.token);
      delete result.token;
    }
    if (result && result.clearSession) {
      extra["Set-Cookie"] = sessionCookie("");
      delete result.clearSession;
    }
    if (result && result.file) {
      res.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Disposition": contentDisposition(result.filename || "backup.zip"),
        "Content-Length": result.file.length,
        "Cache-Control": "no-store",
        ...extra,
      });
      return res.end(result.file);
    }
    if (result && result.csv) {
      res.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": contentDisposition(result.filename || "export.csv"),
        "Cache-Control": "no-store",
        ...extra,
      });
      return res.end("\uFEFF" + result.csv);
    }
    return send(res, 200, result ?? {}, extra);
  }
  if (req.method === "GET") return serveWeb(url.pathname, res, req);
  send(res, 404, { error: "not_found" });
}

function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".json": "application/json; charset=utf-8",
  }[ext] || "application/octet-stream";
}

const webCache = new Map();
const GZIP_EXT = new Set([".html", ".css", ".js", ".svg", ".json"]);

function acceptsGzip(header) {
  return String(header || "").split(",").some((part) => {
    const [name, ...params] = part.trim().toLowerCase().split(";");
    if (name.trim() !== "gzip") return false;
    for (const param of params) {
      const match = /q\s*=\s*([0-9.]+)/.exec(param);
      if (match && Number(match[1]) <= 0) return false;
    }
    return true;
  });
}

function loadWebFile(file, stat) {
  const cached = webCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached;
  const body = fs.readFileSync(file);
  const ext = path.extname(file).toLowerCase();
  const gzip = GZIP_EXT.has(ext) && body.length >= 1024 ? zlib.gzipSync(body) : null;
  const entry = { mtimeMs: stat.mtimeMs, size: stat.size, body, gzip };
  webCache.set(file, entry);
  return entry;
}

function serveWeb(pathname, res, req) {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const file = path.resolve(webRoot, rel);
  if (file !== webRoot && !file.startsWith(webRoot + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  let stat = null;
  try {
    stat = fs.statSync(file);
  } catch (_) {}
  if (!stat || !stat.isFile()) {
    res.writeHead(404);
    return res.end("Not found");
  }
  let entry;
  try {
    entry = loadWebFile(file, stat);
  } catch (_) {
    res.writeHead(404);
    return res.end("Not found");
  }
  const headers = {
    "Content-Type": contentType(file),
    "Cache-Control": "no-store",
  };
  if (entry.gzip && acceptsGzip(req.headers["accept-encoding"])) {
    headers["Content-Encoding"] = "gzip";
    headers["Content-Length"] = entry.gzip.length;
    headers.Vary = "Accept-Encoding";
    res.writeHead(200, headers);
    return res.end(entry.gzip);
  }
  headers["Content-Length"] = entry.body.length;
  res.writeHead(200, headers);
  res.end(entry.body);
}

function serveUpload(pathname, res) {
  const name = path.basename(pathname);
  const file = path.resolve(store.uploadDir, name);
  if (!file.startsWith(store.uploadDir + path.sep) || !fs.existsSync(file)) {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, { "Content-Type": contentType(file), "Cache-Control": "no-store" });
  fs.createReadStream(file).pipe(res);
}

route("GET", "/api/health", () => ({ ok: true }));
route("GET", "/api/brand", () => store.brand());
route("GET", "/api/session", ({ user }) => ({ user, company: store.getSettings() }));
route("POST", "/api/login", ({ body }) => store.login(body));
route("POST", "/api/setup", ({ body }) => store.setup(body));
route("POST", "/api/logout", ({ token }) => {
  store.logout(token);
  return { ok: true, clearSession: true };
});
route("GET", "/api/users", () => ({ users: store.listUsers() }));
route("POST", "/api/users", ({ body }) => store.saveUser(0, body));
route("PUT", "/api/users/:id", ({ params, body }) => store.saveUser(numId(params.id), body));
route("GET", "/api/bootstrap", () => store.bootstrap());
route("GET", "/api/home", () => store.home());
route("GET", "/api/settings", () => store.getSettings());
route("PUT", "/api/settings", ({ body }) => store.updateSettings(body));
route("GET", "/api/items", ({ query }) => ({
  items: store.listItems({
    q: query.get("q") || "",
    categoryId: Number(query.get("cat") || 0),
    consumableOnly: query.get("consume") === "1",
  }),
}));
route("POST", "/api/items", ({ body }) => store.saveItem(0, body));
route("GET", "/api/items/:id", ({ params }) => {
  const item = store.getItem(numId(params.id));
  if (!item) throw new AppError("not_found", 404);
  return item;
});
route("PUT", "/api/items/:id", ({ params, body }) => store.saveItem(numId(params.id), body));
route("DELETE", "/api/items/:id", ({ params, body }) => store.deleteItem(numId(params.id), body.operator));
route("PUT", "/api/items/:id/bom", ({ params, body }) => store.saveBom(numId(params.id), body));
route("GET", "/api/resolve", ({ query }) => store.resolve(query.get("code") || ""));
route("POST", "/api/inbound", ({ body }) => store.postInbound(body));
route("POST", "/api/outbound", ({ body }) => store.postOutbound(body));
route("POST", "/api/assemble", ({ body }) => store.postAssemble(body));
route("POST", "/api/move", ({ body }) => store.postMove(body));
route("POST", "/api/count", ({ body }) => store.postCount(body));
route("GET", "/api/documents/:id", ({ params }) => {
  const doc = store.getDocument(numId(params.id));
  if (!doc) throw new AppError("not_found", 404);
  return doc;
});
route("POST", "/api/documents/:id/void", ({ params, body }) => store.voidDocument(numId(params.id), body));
route("GET", "/api/logs", ({ query }) => ({
  logs: store.listLogs({ itemId: Number(query.get("item_id") || 0), limit: 200 }),
}));
route("GET", "/api/locations/:id/stock", ({ params }) => store.locationStock(numId(params.id)));
route("POST", "/api/categories", ({ body }) => store.saveCategory(0, body));
route("PUT", "/api/categories/:id", ({ params, body }) => store.saveCategory(numId(params.id), body));
route("DELETE", "/api/categories/:id", ({ params, body }) => store.deleteCategory(numId(params.id), body.operator));
route("POST", "/api/warehouses", ({ body }) => store.saveWarehouse(0, body));
route("PUT", "/api/warehouses/:id", ({ params, body }) => store.saveWarehouse(numId(params.id), body));
route("DELETE", "/api/warehouses/:id", ({ params, body }) => store.deleteWarehouse(numId(params.id), body.operator));
route("GET", "/api/backups", () => ({ backups: store.listBackups(), settings: store.getSettings() }));
route("GET", "/api/backups/download", () => store.backupDownload());
route("POST", "/api/backups/import", ({ body }) => store.importBackup(body));
route("POST", "/api/backups", () => store.backupNow());
route("POST", "/api/backups/:stamp/restore", ({ params }) => ({
  ...store.restoreBackup(params.stamp),
  clearSession: true,
}));
route("GET", "/api/export/:kind", ({ params }) => store.exportCsv(params.kind));
route("POST", "/api/locations", ({ body }) => store.saveLocation(0, body));
route("PUT", "/api/locations/:id", ({ params, body }) => store.saveLocation(numId(params.id), body));
route("DELETE", "/api/locations/:id", ({ params, body }) => store.deleteLocation(numId(params.id), body.operator));
route("POST", "/api/units", ({ body }) => store.saveSimple("units", 0, body));
route("PUT", "/api/units/:id", ({ params, body }) => store.saveSimple("units", numId(params.id), body));
route("DELETE", "/api/units/:id", ({ params, body }) => store.deleteSimple("units", numId(params.id), body.operator));
route("POST", "/api/source-types", ({ body }) => store.saveSimple("source_types", 0, body));
route("PUT", "/api/source-types/:id", ({ params, body }) => store.saveSimple("source_types", numId(params.id), body));
route("DELETE", "/api/source-types/:id", ({ params, body }) => store.deleteSimple("source_types", numId(params.id), body.operator));
route("POST", "/api/purposes", ({ body }) => store.saveSimple("purposes", 0, body));
route("PUT", "/api/purposes/:id", ({ params, body }) => store.saveSimple("purposes", numId(params.id), body));
route("DELETE", "/api/purposes/:id", ({ params, body }) => store.deleteSimple("purposes", numId(params.id), body.operator));
route("POST", "/api/factory-reset", ({ body }) => ({
  ...store.factoryReset(body.confirm, body.operator),
  clearSession: true,
}));

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (err instanceof AppError) {
      send(res, err.status, { error: err.code, ...err.extra });
      return;
    }
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: "http" });
  });
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`端口 ${port} 已被占用`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(port, "0.0.0.0", () => {
  const urls = lanUrls(port);
  console.log("锐达3500 已启动");
  console.log(`本机  http://127.0.0.1:${port}`);
  for (const url of urls) console.log(`手机  ${url}`);
  if (process.argv.includes("--open")) {
    spawn("cmd", ["/c", "start", "", `http://127.0.0.1:${port}`], { detached: true, stdio: "ignore" }).unref();
  }
});

function lanUrls(listenPort) {
  const urls = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) urls.push(`http://${entry.address}:${listenPort}`);
    }
  }
  return urls;
}
