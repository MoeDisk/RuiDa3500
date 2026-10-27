"use strict";

const state = {
  lang: localStorage.getItem("ruida.lang") === "en" ? "en" : "zh-CN",
  user: null,
  company: null,
};
let boot = null;
let busy = false;
let scanRAF = 0;
let scanStream = null;
let toastTimer = 0;
const actions = {};

const ICON = {
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5 8 12l7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  gear: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  scan: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8V5h3M16 5h3v3M19 16v3h-3M8 19H5v-3M7 12h10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  home: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11.5 12 5l8 6.5V20H4Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
  in: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 11l5 5 5-5M5 20h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  out: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V4M7 8l5-5 5 5M5 20h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  box: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8l9-4 9 4-9 4-9-4Z M3 8v8l9 4 9-4V8 M12 12v8" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
  qr: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2.2v2.2H14zM18 14H20.2v2.2H18zM14 18h2.2V20.2H14zM18 18h2.2V20.2H18z" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
  count: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3.5h8.5A2 2 0 0 1 18.5 5.5V21l-3.2-2-3.3 2-3.3-2L5.5 21V5.5A2 2 0 0 1 7.5 3.5H8z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M9 9h6M9 13h4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  move: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h11M15 8l-3-3M15 8l-3 3M20 16H9M9 16l3-3M9 16l3 3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  recipe: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M5 12h14M5 17h8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 16.5V20h3.5L19 8.5 15.5 5 4 16.5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
};

function t(key) {
  const pack = I18N[state.lang] || I18N["zh-CN"];
  if (pack[key] != null) return pack[key];
  if (I18N["zh-CN"][key] != null) return I18N["zh-CN"][key];
  return key;
}
function tf(key, vars) {
  return t(key).replace(/\{(\w+)\}/g, (_, name) => (vars[name] == null ? "" : vars[name]));
}
function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));
}
function isPart(row) {
  return !!row && (row.category_code === "part" || row.category_name === "零部件");
}
function label(row) {
  if (!row) return "";
  if (state.lang === "en" && row.name_en) return row.name_en;
  return row.name || row.name_en || "";
}
function unitOf(row) {
  if (!row) return "";
  if (state.lang === "en" && row.unit_en) return row.unit_en;
  return row.unit || "";
}
function catOf(row) {
  if (!row) return "";
  if (state.lang === "en" && row.category_name_en) return row.category_name_en;
  return row.category_name || "";
}
function qtyText(n) {
  const x = Math.round(Number(n) * 1000) / 1000;
  if (!Number.isFinite(x)) return "0";
  return String(x);
}
function parseQty(v) {
  const n = Number(String(v ?? "").trim().replace(",", "."));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 1000) / 1000;
}
function shortTime(iso) {
  return iso ? iso.slice(5, 16).replace("T", " ") : "";
}
function operator() {
  const signed = (localStorage.getItem("ruida.operator") || "").trim();
  if (signed) return signed;
  if (state.user) return state.user.name || state.user.username || "";
  return "";
}
function isBoss() {
  return !!(state.user && state.user.role === "boss");
}
function lastLoc() {
  return localStorage.getItem("ruida.lastLoc") || "";
}
function rememberLoc(id) {
  if (id) localStorage.setItem("ruida.lastLoc", String(id));
}
function lastWh() {
  return localStorage.getItem("ruida.lastWh") || "";
}
function rememberWh(id) {
  if (id) localStorage.setItem("ruida.lastWh", String(id));
}
function placeName(row) {
  const bin = state.lang === "en" && row.name_en ? row.name_en : (row.name || "");
  const wh = state.lang === "en" && row.warehouse_name_en ? row.warehouse_name_en : (row.warehouse_name || "");
  return wh ? `${wh} / ${bin}` : bin;
}
function wireWarehouse(form, whName, locName) {
  const wh = form.elements[whName];
  const loc = form.elements[locName];
  if (!wh || !loc) return;
  const apply = () => {
    let keep = "";
    for (const opt of loc.options) {
      const ok = !opt.dataset.wh || opt.dataset.wh === wh.value;
      opt.hidden = !ok;
      opt.disabled = !ok;
      if (ok && !keep) keep = opt.value;
    }
    if (!loc.selectedOptions.length || loc.selectedOptions[0].disabled) loc.value = keep;
  };
  wh.addEventListener("change", () => {
    apply();
    rememberWh(wh.value);
  });
  apply();
}
let noticeTimer = 0;
function showNotice(kind, title, body) {
  const el = document.getElementById("notice");
  el.className = `show ${kind}`;
  el.innerHTML = `<b>${esc(title)}</b><p>${esc(body)}</p><button type="button" class="notice-x" data-act="closeNotice" aria-label="${esc(t("close"))}">×</button>`;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => el.classList.remove("show"), kind === "warn" ? 12000 : 7000);
}
function alertLine(row) {
  const unit = unitOf(row) ? " " + unitOf(row) : "";
  if (row.level === "low") {
    return tf("alertLow", { name: label(row), have: qtyText(row.total_qty) + unit, min: qtyText(row.min_qty) + unit, gap: qtyText(row.gap) + unit });
  }
  return tf("alertHigh", { name: label(row), have: qtyText(row.total_qty) + unit, max: qtyText(row.max_qty) + unit, gap: qtyText(row.gap) + unit });
}
function locPath(id) {
  if (!boot) return "";
  const by = Object.fromEntries(boot.locations.map((row) => [row.id, row]));
  const parts = [];
  const guard = new Set();
  let cur = by[id];
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id);
    parts.unshift(label(cur));
    cur = cur.parent_id ? by[cur.parent_id] : null;
  }
  const base = parts.join(" / ");
  const leaf = by[id];
  if (!leaf || !boot.warehouses) return base;
  const wh = boot.warehouses.find((row) => row.id === leaf.warehouse_id);
  return wh ? `${label(wh)} / ${base}` : base;
}
function activeRows(rows, extraId) {
  return rows.filter((row) => row.active || String(row.id) === String(extraId));
}
function toast(message) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}
function explain(err) {
  if (!err || err.offline) return t("offline");
  const data = err.data || {};
  if (data.error === "insufficient") {
    const lines = data.lines || [data];
    return lines.map((line) => tf("err_insufficient", {
      name: label(line),
      have: qtyText(line.have),
      need: qtyText(line.need),
    })).join("\n");
  }
  if (data.error === "cannot_consume") return tf("err_cannot_consume", { name: label(data) });
  return t("err_" + (data.error || "http"));
}
async function api(url, opt = {}) {
  let res;
  try {
    res = await fetch(url, {
      method: opt.method || "GET",
      headers: opt.body ? { "Content-Type": "application/json" } : undefined,
      body: opt.body ? JSON.stringify(opt.body) : undefined,
    });
  } catch (_) {
    const err = new Error("offline");
    err.offline = true;
    throw err;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && data.error === "unauthorized") {
      state.user = null;
      state.company = null;
    }
    const err = new Error(data.error || "http");
    err.data = data;
    throw err;
  }
  return data;
}
function apiSend(method, url, body) {
  return api(url, { method, body: { ...body, operator: operator() } });
}
function askDelete(run, afterHash, hint) {
  openSheet(`<h3>${esc(t("delete"))}</h3><p class="hint">${esc(hint || t("deleteHint"))}</p><button type="button" class="danger" id="doDelete">${esc(t("confirmDelete"))}</button>`, (root) => {
    root.querySelector("#doDelete").onclick = () => guard(async () => {
      await run();
      closeSheet();
      invalidate();
      toast(t("deleted"));
      if (location.hash === afterHash) draw();
      else location.hash = afterHash;
    });
  });
}
async function loadBoot(force) {
  if (!boot || force) boot = await api("/api/bootstrap");
  return boot;
}
function invalidate() { boot = null; }
async function guard(fn) {
  if (busy) return;
  busy = true;
  try { await fn(); }
  catch (err) { toast(explain(err)); }
  finally { busy = false; }
}
function setActions(map) {
  for (const key of Object.keys(actions)) delete actions[key];
  Object.assign(actions, map || {});
}
function field(name, inner) {
  return `<label class="field"><span>${esc(name)}</span>${inner}</label>`;
}
function textInput(name, value, opt = {}) {
  const placeholder = opt.placeholder ? ` placeholder="${esc(opt.placeholder)}"` : "";
  return `<input name="${name}" value="${esc(value ?? "")}" maxlength="${opt.max || 80}" autocomplete="off"${placeholder}>`;
}
function secretInput(name, opt = {}) {
  const placeholder = opt.placeholder ? ` placeholder="${esc(opt.placeholder)}"` : "";
  return `<input name="${name}" type="password" maxlength="72" autocomplete="${opt.auto || "current-password"}"${placeholder}>`;
}
function roleSelect(selected) {
  return `<select name="role">${["boss", "warehouse", "viewer"].map((role) =>
    `<option value="${role}"${role === selected ? " selected" : ""}>${esc(t("role_" + role))}</option>`
  ).join("")}</select>`;
}
function selectBox(name, rows, selected, opt = {}) {
  const options = [];
  if (opt.allowEmpty) options.push(`<option value="">${esc(opt.empty || t("none"))}</option>`);
  for (const row of rows) {
    const text = opt.path ? locPath(row.id) : label(row);
    const wh = opt.wh ? ` data-wh="${row.warehouse_id || ""}"` : "";
    options.push(`<option value="${row.id}"${String(selected) === String(row.id) ? " selected" : ""}${wh}>${esc(text)}</option>`);
  }
  return `<select name="${name}"${opt.attr || ""}>${options.join("")}</select>`;
}
function stepper(value) {
  return `<div class="stepper"><button type="button" data-act="minus">−</button><input name="qty" inputmode="decimal" value="${esc(value)}" autocomplete="off"><button type="button" data-act="plus">+</button></div>`;
}
function step(form, dir) {
  const input = form.querySelector("[name=qty]");
  const next = Math.max(0, Math.round(((parseQty(input.value) || 0) + dir) * 1000) / 1000);
  input.value = qtyText(next);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
function photoField(url) {
  const img = url
    ? `<img id="photoPrev" src="${esc(url)}" alt="">`
    : `<img id="photoPrev" alt="" hidden>`;
  const remove = url ? `<button type="button" class="link" data-act="clearPhoto">${esc(t("removePhoto"))}</button>` : "";
  return `<div class="photo-field">${img}<input id="photoFile" type="file" accept="image/*">${remove}</div>`;
}
async function fileToDataUrl(file) {
  const bitmap = await createImageBitmap(file);
  const max = 1280;
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.82);
}
function bindPhoto(onChange) {
  const input = document.getElementById("photoFile");
  if (!input) return;
  input.addEventListener("change", async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    try {
      const url = await fileToDataUrl(file);
      const img = document.getElementById("photoPrev");
      img.src = url;
      img.hidden = false;
      onChange("set", url);
    } catch (_) {
      toast(t("err_bad_photo"));
    }
  });
}
function langButtons() {
  return `<div class="langs"><button type="button" data-lang="zh-CN" class="${state.lang === "en" ? "" : "on"}" aria-label="中">中</button><button type="button" data-lang="en" class="${state.lang === "en" ? "on" : ""}" aria-label="EN">EN</button></div>`;
}
function headerHTML(page) {
  const langs = (page.tab || page.lang || page.auth) ? langButtons() : "";
  if (page.auth) {
    return `<div class="bar auth-bar"><div class="bar-right">${langs}</div></div>`;
  }
  if (page.tab) {
    const sub = page.subtitle ? `<p class="bar-sub">${esc(page.subtitle)}</p>` : "";
    return `<div class="bar root"><div class="bar-title"><h1>${esc(page.title || "")}</h1>${sub}</div><div class="bar-right">${langs}</div></div>`;
  }
  const back = page.back
    ? `<button type="button" class="icon-btn" data-go="${esc(page.back)}" aria-label="${esc(t("back"))}">${ICON.back}</button>`
    : `<span class="icon-spacer"></span>`;
  return `<div class="bar">${back}<h1>${esc(page.title || "")}</h1><div class="bar-right">${langs || `<span class="icon-spacer"></span>`}</div></div>`;
}
function tabsHTML(active) {
  const company = state.company && state.company.company_name;
  const brand = `<button type="button" class="rail-brand" data-credit="1"><span class="mark">3500</span><div><b>${esc(company || t("brand"))}</b><small>${esc(company ? t("brand") : t("warehouse"))}</small></div></button>`;
  const items = [
    ["home", "#/", "home", t("tabHome")],
    ["in", "#/in", "in", t("tabIn")],
    ["out", "#/out", "out", t("tabOut")],
    ["items", "#/items", "box", t("tabItems")],
  ].map(([id, href, icon, name]) =>
    `<a href="${href}" class="${active === id ? "on" : ""}">${ICON[icon]}<span>${esc(name)}</span></a>`
  ).join("");
  const user = state.user
    ? `<button type="button" class="rail-user" data-account="1"><b>${esc(state.user.name || state.user.username)}</b><small>${esc(t("role_" + state.user.role))}</small></button>`
    : "";
  return `${brand}<div class="rail-nav">${items}</div>${user}`;
}
function parseHash() {
  const raw = (location.hash || "#/").replace(/^#/, "");
  const [path, qs] = raw.split("?");
  const parts = path.split("/").filter(Boolean);
  const query = Object.fromEntries(new URLSearchParams(qs || ""));
  return { parts, query };
}
function logButton(row) {
  const msg = state.lang === "en" ? row.message_en : row.message_zh;
  const href = row.doc_id ? `#/docs/${row.doc_id}` : "#/logs";
  return `<button type="button" class="log" data-go="${href}"><small>${esc(shortTime(row.created_at))}</small><span>${esc(msg)}</span></button>`;
}
function opBtn(href, icon, name) {
  return `<button type="button" class="op" data-go="${esc(href)}"><span class="op-ico">${ICON[icon]}</span><span>${esc(name)}</span></button>`;
}
function itemRow(item, href) {
  return `<button type="button" class="row" data-go="${href}"><span><b>${esc(label(item))}</b><small>${esc(item.code)}${catOf(item) ? " · " + esc(catOf(item)) : ""}</small></span><strong>${esc(qtyText(item.total_qty))}<i>${esc(unitOf(item))}</i></strong></button>`;
}

function homeActions() {
  return `<div class="home-actions"><button type="button" class="ghost" data-go="#/extra">${esc(t("extra"))}</button><button type="button" class="ghost" data-go="#/settings">${esc(t("settings"))}</button></div>`;
}
function exportSection() {
  return `<div class="export-row">
    <button type="button" class="ghost" data-act="csv" data-kind="items">${esc(t("exportItems"))}</button>
    <button type="button" class="ghost" data-act="csv" data-kind="stock">${esc(t("exportStock"))}</button>
    <button type="button" class="ghost" data-act="csv" data-kind="documents">${esc(t("exportDocs"))}</button>
    <button type="button" class="ghost" data-act="csv" data-kind="logs">${esc(t("exportLogs"))}</button>
  </div>`;
}
function goodCard(item) {
  const where = (item.places || []).map((place) => `${placeName(place)} ${qtyText(place.qty)}`).join(" · ");
  return `<button type="button" class="good ${item.level || ""}" data-go="#/items/${item.id}"><small>${esc(item.code)}${catOf(item) ? " · " + esc(catOf(item)) : ""}</small><b>${esc(label(item))}</b><span class="qty">${esc(qtyText(item.total_qty))}<i>${esc(unitOf(item))}</i></span>${where ? `<em>${esc(where)}</em>` : `<em>${esc(t("noBalances"))}</em>`}${item.level ? `<span class="flag">${esc(alertLine(item))}</span>` : ""}</button>`;
}
function stockFolds(data) {
  const buckets = new Map();
  for (const cat of data.categories || []) buckets.set(cat.id, { name: label(cat), items: [] });
  const extra = [];
  for (const item of data.goods || []) {
    const bucket = buckets.get(item.category_id);
    if (bucket) bucket.items.push(item);
    else extra.push(item);
  }
  const blocks = [];
  for (const bucket of buckets.values()) {
    if (bucket.items.length) blocks.push(foldBlock(bucket.name, bucket.items));
  }
  if (extra.length) blocks.push(foldBlock(t("otherCat"), extra));
  return blocks.join("");
}
function foldBlock(name, items) {
  const short = items.some((item) => item.level === "low");
  return `<details class="fold${short ? " short" : ""}"${short ? " open" : ""}><summary><b>${esc(name)}</b><span>${items.length}</span>${short ? `<em>${esc(t("shortStock"))}</em>` : ""}</summary><div class="goods">${items.map(goodCard).join("")}</div></details>`;
}
function downloadExport(kind) {
  const a = document.createElement("a");
  a.href = "/api/export/" + kind;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
async function viewHome() {
  const data = await api("/api/home");
  state.company = data;
  const hasItems = (data.goods || []).length > 0;
  let body;
  if (!hasItems) {
    body = `<div class="hero-empty"><p>${esc(t("emptyHome"))}</p><button type="button" class="primary block" data-go="#/items/new">${esc(t("newItem"))}</button></div>`;
  } else {
    const alerts = data.alerts.map((row) =>
      `<button type="button" class="alert ${row.level}" data-go="#/items/${row.id}"><span><b>${esc(label(row))}</b><small>${esc(alertLine(row))}</small></span><strong>${esc(qtyText(row.total_qty))}<i>${esc(unitOf(row))}</i></strong></button>`
    ).join("");
    const recent = data.recent.map(logButton).join("") || `<p class="empty">${esc(t("noActivity"))}</p>`;
    body = `${alerts ? `<section><h2>${esc(t("attention"))}</h2><div class="stack">${alerts}</div></section>` : ""}
      <section><h2>${esc(t("stock"))}</h2>${stockFolds(data)}</section>
      ${exportSection()}
      <section><div class="section-head"><h2>${esc(t("recent"))}</h2><button type="button" class="link" data-go="#/logs">${esc(t("all"))}</button></div><div class="stack">${recent}</div></section>`;
  }
  return {
    title: data.company_name || t("brand"),
    tab: "home",
    html: homeActions() + body + (hasItems ? "" : exportSection()),
    bind() {
      if (hasItems) {
        if (!data.alerts.length) showNotice("ok", t("allStockOkTitle"), t("allStockOk"));
        else showNotice("warn", t("stockWarnTitle"), data.alerts.map(alertLine).join("\n"));
      }
      setActions({
        closeNotice: () => document.getElementById("notice").classList.remove("show"),
        csv: (el) => downloadExport(el.dataset.kind),
      });
    },
  };
}

async function viewItems(query) {
  await loadBoot();
  const cat = query.cat || "";
  const data = await api("/api/items" + (cat ? `?cat=${encodeURIComponent(cat)}` : ""));
  const chips = [`<button type="button" class="chip ${cat ? "" : "on"}" data-go="#/items">${esc(t("allCats"))}</button>`]
    .concat(boot.categories.filter((row) => row.active).map((row) =>
      `<button type="button" class="chip ${String(cat) === String(row.id) ? "on" : ""}" data-go="#/items?cat=${row.id}">${esc(label(row))}</button>`
    )).join("");
  const list = data.items.map((item) => itemRow(item, `#/items/${item.id}`)).join("") || `<p class="empty">${esc(t("noMatch"))}</p>`;
  return {
    title: t("itemsTitle"),
    tab: "items",
    html: `<div class="search-row field"><input id="find" placeholder="${esc(t("search"))}" autocomplete="off"></div><div class="chips" style="margin:12px 0">${chips}</div><div class="stack" id="results">${list}</div><div class="dock"><button type="button" class="primary block" data-go="#/items/new${cat ? `?cat=${cat}` : ""}">${esc(t("newItem"))}</button></div>`,
    bind() {
      const input = document.getElementById("find");
      const all = data.items.map((item) => ({
        blob: [item.name, item.name_en, item.code, item.spec].join(" ").toLowerCase(),
        html: itemRow(item, `#/items/${item.id}`),
      }));
      input.addEventListener("input", () => {
        const q = input.value.trim().toLowerCase();
        const rows = all.filter((item) => !q || item.blob.includes(q));
        document.getElementById("results").innerHTML = rows.map((item) => item.html).join("") || `<p class="empty">${esc(t("noMatch"))}</p>`;
      });
    },
  };
}

async function viewPick(mode) {
  return {
    title: t(mode === "in" ? "tabIn" : "tabOut"),
    tab: mode,
    html: `<div class="search-line"><input id="find" placeholder="${esc(t("search"))}" autocomplete="off"><button type="button" class="ghost icon-btn" data-act="scan" aria-label="${esc(t("scan"))}">${ICON.scan}</button></div><div class="stack" id="results"></div>`,
    bind() {
      const input = document.getElementById("find");
      let timer = 0;
      const fill = async (q) => {
        const data = await api("/api/items?q=" + encodeURIComponent(q));
        const box = document.getElementById("results");
        if (!box) return;
        box.innerHTML = data.items.length
          ? data.items.map((item) => itemRow(item, `#/${mode}/${item.id}`)).join("")
          : `<p class="empty">${esc(t("noMatch"))}</p>`;
      };
      input.addEventListener("input", () => {
        clearTimeout(timer);
        timer = setTimeout(() => fill(input.value.trim()), 160);
      });
      input.addEventListener("keydown", async (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        const found = await api("/api/resolve?code=" + encodeURIComponent(text));
        if (found.type === "item") location.hash = `#/${mode}/${found.item.id}`;
        else if (found.type === "location") {
          rememberLoc(found.location.id);
          toast(t("pickedLater"));
        } else toast(t("notFoundCode"));
      });
      setActions({
        scan: () => startScan(async (code) => {
          input.value = code;
          input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
        }),
      });
      input.focus();
      fill("");
    },
  };
}

async function viewStockForm(mode, id) {
  await loadBoot();
  const item = await api("/api/items/" + id);
  const isIn = mode === "in";
  const locs = activeRows(boot.locations, item.default_location_id || lastLoc());
  const prefLoc = boot.locations.find((row) => String(row.id) === String(item.default_location_id || lastLoc())) || locs[0];
  const warehouses = activeRows(boot.warehouses || []);
  const prefWh = (prefLoc && prefLoc.warehouse_id) || lastWh() || (warehouses[0] && warehouses[0].id);
  const types = activeRows(isIn ? boot.source_types : boot.purposes);
  const preset = types.find((row) => row.code === (isIn ? "purchase" : "issue")) || types[0];
  const html = `<form data-form="1" class="form">
    <div class="who"><b>${esc(label(item))}</b><small>${esc(item.code)} · ${esc(tf("currentStock", { n: qtyText(item.total_qty) + (unitOf(item) ? " " + unitOf(item) : "") }))}</small></div>
    ${field(t("qty"), stepper(1))}
    ${field(t("warehouses"), selectBox("warehouse_id", warehouses, prefWh))}
    ${field(t("location"), selectBox("location_id", locs, prefLoc && prefLoc.id, { path: true, wh: true }))}
    ${field(t(isIn ? "sourceType" : "purpose"), selectBox(isIn ? "source_type_id" : "purpose_id", types, preset && preset.id))}
    ${field(t(isIn ? "sourceName" : "destName"), textInput(isIn ? "source_name" : "dest_name", isIn ? item.supplier_name : "", { placeholder: t(isIn ? "sourcePh" : "destPh") }))}
    <details class="more"><summary>${esc(t("more"))}</summary>
      ${field(t("note"), `<textarea name="note" maxlength="500"></textarea>`)}
      ${field(t("photo"), photoField(""))}
    </details>
    <div class="dock"><button class="primary" type="submit">${esc(t(isIn ? "confirmIn" : "confirmOut"))}</button></div>
  </form>`;
  return {
    title: label(item),
    back: `#/${mode}`,
    html,
    bind() {
      const form = document.querySelector("form");
      let photo = "";
      bindPhoto((_, url) => { photo = url; });
      wireWarehouse(form, "warehouse_id", "location_id");
      setActions({
        minus: () => step(form, -1),
        plus: () => step(form, 1),
        submit: (current) => guard(async () => {
          const qty = parseQty(current.qty.value);
          const locationId = Number(current.location_id.value);
          const warehouseId = Number(current.warehouse_id.value);
          if (!qty || qty <= 0) return toast(t("err_qty_invalid"));
          if (!warehouseId) return toast(t("err_warehouse_required"));
          if (!locationId) return toast(t("err_location_required"));
          const body = { item_id: item.id, qty, location_id: locationId, warehouse_id: warehouseId, note: current.note.value };
          if (photo) body.photo_base64 = photo;
          if (isIn) {
            body.source_type_id = Number(current.source_type_id.value) || null;
            body.source_name = current.source_name.value;
          } else {
            body.purpose_id = Number(current.purpose_id.value) || null;
            body.dest_name = current.dest_name.value;
          }
          const doc = await apiSend("POST", isIn ? "/api/inbound" : "/api/outbound", body);
          rememberLoc(locationId);
          rememberWh(warehouseId);
          toast(t("saved"));
          location.hash = `#/docs/${doc.id}`;
        }),
      });
    },
  };
}

async function viewItem(id) {
  const item = await api("/api/items/" + id);
  const places = item.balances.length
    ? item.balances.map((row) => `<div class="row"><span>${esc(placeName(row))}</span><strong>${esc(qtyText(row.qty))}</strong></div>`).join("")
    : `<p class="empty">${esc(t("noBalances"))}</p>`;
  const activity = item.activity.length
    ? item.activity.map((row) => {
      const type = row.effect === "void" ? t("voidEffect") : t("doc_" + row.doc_type);
      const qty = (row.qty_delta > 0 ? "+" : "") + qtyText(row.qty_delta);
      const place = state.lang === "en" && row.name_en ? row.name_en : row.name;
      return `<button type="button" class="log" data-go="#/docs/${row.doc_id}"><small>${esc(shortTime(row.created_at))}</small><span>${esc(tf("moveLine", { type, qty, place }))}</span></button>`;
    }).join("")
    : `<p class="empty">${esc(t("noActivity"))}</p>`;
  const alert = item.level
    ? `<div class="banner">${esc(item.level === "low" ? tf("minShort", { n: qtyText(item.min_qty) }) : tf("maxShort", { n: qtyText(item.max_qty) }))}</div>`
    : "";
  const hasBom = !!(item.bom && item.bom.length);
  const asm = item.can_assemble || hasBom
    ? `<button type="button" class="primary block" data-go="#/items/${item.id}/assemble">${esc(t("assemble"))}</button>`
    : "";
  const facts = [];
  if (item.spec) facts.push(item.spec);
  if (item.remark) facts.push(item.remark);
  return {
    title: label(item),
    back: "#/items",
    html: `${item.photo_url ? `<img class="hero-photo" src="${esc(item.photo_url)}" alt="">` : ""}
      <small class="muted">${esc(item.code)} · ${esc(catOf(item))}</small>
      <div class="qty-hero">${esc(qtyText(item.total_qty))}<span>${esc(unitOf(item))}</span></div>
      ${alert}
      <div class="pair" style="margin:12px 0">
        <button type="button" class="${item.can_assemble ? "ghost" : "primary"}" data-go="#/in/${item.id}">${esc(t("tabIn"))}</button>
        <button type="button" class="ghost" data-go="#/out/${item.id}">${esc(t("tabOut"))}</button>
      </div>
      ${asm}
      <div class="ops">
        ${opBtn(`#/items/${item.id}/qr`, "qr", t("qr"))}
        ${opBtn(`#/items/${item.id}/count`, "count", t("count"))}
        ${opBtn(`#/items/${item.id}/move`, "move", t("move"))}
        ${item.can_assemble || item.can_consume || hasBom ? opBtn(`#/items/${item.id}/bom`, "recipe", t("recipe")) : ""}
        ${opBtn(`#/items/${item.id}/edit`, "edit", t("edit"))}
      </div>
      ${facts.length ? `<p>${esc(facts.join(" · "))}</p>` : ""}
      <h2>${esc(t("balances"))}</h2><div class="stack">${places}</div>
      <h2>${esc(t("activity"))}</h2><div class="stack">${activity}</div>`,
  };
}

async function viewItemForm(id, query) {
  await loadBoot();
  const item = id ? await api("/api/items/" + id) : null;
  const cats = activeRows(boot.categories, item && item.category_id);
  const units = activeRows(boot.units, item && item.unit_id);
  const locs = activeRows(boot.locations, item && item.default_location_id);
  const catSelected = item ? item.category_id : Number(query.cat || cats[0]?.id || 0);
  const openMore = !!(item && (item.spec || item.photo_url || item.remark || item.min_qty != null || item.max_qty != null));
  const chips = cats.map((cat) =>
    `<label class="chip"><input type="radio" name="category_id" value="${cat.id}"${cat.id === catSelected ? " checked" : ""}><span>${esc(label(cat))}</span></label>`
  ).join("");
  const partItems = ((await api("/api/items?consume=1")).items || []).filter((row) => isPart(row) && (!item || row.id !== item.id));
  const wantBom = !!(item && item.bom && item.bom.length);
  const adder = partItems.length
    ? `<div class="search-line">${selectBox("component_id", partItems, partItems[0].id)}<button type="button" class="ghost" data-act="addPart">${esc(t("addPart"))}</button></div>${field(t("perOne"), `<input id="addQty" inputmode="decimal" value="1" autocomplete="off">`)}`
    : `<p class="empty">${esc(t("addPartFirst"))}</p>`;
  return {
    title: item ? t("editItem") : t("newItem"),
    back: item ? `#/items/${item.id}` : "#/items",
    html: `<form data-form="1" class="form">
      ${field(t("nameZh"), textInput("name", item ? item.name : ""))}
      <div class="field"><span>${esc(t("category"))}</span><div class="chips">${chips}</div></div>
      ${field(t("unit"), selectBox("unit_id", units, item ? item.unit_id : units[0]?.id, { allowEmpty: true }))}
      ${field(t("defaultLoc"), selectBox("default_location_id", locs, item ? item.default_location_id : (lastLoc() || locs[0]?.id), { allowEmpty: true, path: true }))}
      <div id="bomPanel">
        <label class="check"><input name="want_bom" type="checkbox"${wantBom ? " checked" : ""}> ${esc(t("wantBom"))}</label>
        <p class="hint">${esc(t("wantBomHint"))}</p>
        <div id="bomEditor"${wantBom ? "" : " hidden"}>
          <div id="bomList" class="stack"></div>
          <h2>${esc(t("addPart"))}</h2>
          ${adder}
        </div>
      </div>
      <details class="more" ${openMore ? "open" : ""}><summary>${esc(t("more"))}</summary>
        ${field(t("spec"), textInput("spec", item ? item.spec : "", { max: 120 }))}
        ${field(t("catalogPhoto"), photoField(item ? item.photo_url : ""))}
        ${field(t("remark"), `<textarea name="remark" maxlength="500">${esc(item ? item.remark : "")}</textarea>`)}
        <p class="hint">${esc(t("thresholdHint"))}</p>
        ${field(t("minQty"), `<input name="min_qty" inputmode="decimal" value="${item && item.min_qty != null ? esc(item.min_qty) : ""}" autocomplete="off">`)}
        ${field(t("maxQty"), `<input name="max_qty" inputmode="decimal" value="${item && item.max_qty != null ? esc(item.max_qty) : ""}" autocomplete="off">`)}
      </details>
      ${item ? `<label class="check"><input name="active" type="checkbox" ${item.active ? "checked" : ""}> ${esc(t("active"))}</label>` : ""}
      <div class="dock"><button class="primary" type="submit">${esc(t("save"))}</button>${item ? `<button type="button" class="danger" data-act="remove">${esc(t("delete"))}</button>` : ""}</div>
    </form>`,
    bind() {
      let photoMode = "keep";
      let photoData = null;
      bindPhoto((mode, url) => { photoMode = mode; photoData = url; });
      const form = document.querySelector("form");
      let lines = (item && item.bom ? item.bom : []).map((row) => ({
        component_item_id: row.component_item_id,
        qty_per: row.qty_per,
        name: row.name,
      }));
      const known = new Map(partItems.map((row) => [row.id, label(row)]));
      for (const line of lines) known.set(line.component_item_id, line.name);
      const paint = () => {
        const box = document.getElementById("bomList");
        if (!box) return;
        box.innerHTML = lines.length ? lines.map((line, index) =>
          `<div class="bom-line"><span>${esc(known.get(line.component_item_id) || line.name)}</span><input data-i="${index}" inputmode="decimal" value="${esc(qtyText(line.qty_per))}"><button type="button" data-act="rm" data-i="${index}">${esc(t("remove"))}</button></div>`
        ).join("") : `<p class="empty">${esc(t("recipeEmpty"))}</p>`;
        box.querySelectorAll("input").forEach((input) => {
          input.addEventListener("input", () => {
            const qty = parseQty(input.value);
            if (qty && qty > 0) lines[Number(input.dataset.i)].qty_per = qty;
          });
        });
      };
      const syncBom = () => {
        document.getElementById("bomEditor").hidden = !form.want_bom.checked;
      };
      form.addEventListener("change", syncBom);
      paint();
      syncBom();
      setActions({
        clearPhoto: () => {
          photoMode = "clear";
          const img = document.getElementById("photoPrev");
          if (img) { img.hidden = true; img.removeAttribute("src"); }
        },
        rm: (el) => { lines.splice(Number(el.dataset.i), 1); paint(); },
        addPart: () => {
          const sel = form.querySelector("[name=component_id]");
          const qty = parseQty(document.getElementById("addQty").value);
          if (!sel || !qty || qty <= 0) return toast(t("err_qty_invalid"));
          const cid = Number(sel.value);
          const found = lines.find((line) => line.component_item_id === cid);
          if (found) found.qty_per = qty;
          else lines.push({ component_item_id: cid, qty_per: qty, name: label(partItems.find((row) => row.id === cid)) });
          paint();
        },
        remove: () => askDelete(() => apiSend("DELETE", "/api/items/" + item.id, {}), "#/items", t("deleteItemHint")),
        submit: (current) => guard(async () => {
          const picked = current.querySelector("input[name=category_id]:checked");
          if (!String(current.name.value).trim()) return toast(t("err_name_required"));
          if (!picked) return toast(t("err_category"));
          const body = {
            name: current.name.value,
            category_id: Number(picked.value),
            unit_id: current.unit_id.value || null,
            default_location_id: current.default_location_id.value || null,
            spec: current.spec.value,
            remark: current.remark.value,
            min_qty: current.min_qty.value,
            max_qty: current.max_qty.value,
            active: item ? current.active.checked : true,
          };
          if (photoMode === "set") body.photo_base64 = photoData;
          if (photoMode === "clear") body.photo_base64 = null;
          const saved = item
            ? await apiSend("PUT", "/api/items/" + item.id, body)
            : await apiSend("POST", "/api/items", body);
          const recipe = current.want_bom.checked ? lines : [];
          try {
            await apiSend("PUT", `/api/items/${saved.id}/bom`, {
              lines: recipe.map((line) => ({ component_item_id: line.component_item_id, qty_per: line.qty_per })),
            });
          } catch (err) {
            invalidate();
            if (!item) location.hash = `#/items/${saved.id}/edit`;
            throw err;
          }
          invalidate();
          toast(t("saved"));
          location.hash = `#/items/${saved.id}`;
        }),
      });
    },
  };
}

async function viewBom(id) {
  const item = await api("/api/items/" + id);
  const pool = (await api("/api/items?consume=1")).items.filter((row) => isPart(row) && row.id !== item.id);
  let lines = item.bom.map((row) => ({ component_item_id: row.component_item_id, qty_per: row.qty_per, name: label(row) }));
  const known = new Map(pool.map((row) => [row.id, label(row)]));
  for (const line of lines) known.set(line.component_item_id, line.name);
  function paint() {
    const box = document.getElementById("bomList");
    if (!box) return;
    box.innerHTML = lines.length ? lines.map((line, index) =>
      `<div class="bom-line"><span>${esc(known.get(line.component_item_id) || line.name)}</span><input data-i="${index}" inputmode="decimal" value="${esc(qtyText(line.qty_per))}"><button type="button" data-act="rm" data-i="${index}">${esc(t("remove"))}</button></div>`
    ).join("") : `<p class="empty">${esc(t("recipeEmpty"))}</p>`;
    box.querySelectorAll("input").forEach((input) => {
      input.addEventListener("input", () => {
        const qty = parseQty(input.value);
        if (qty && qty > 0) lines[Number(input.dataset.i)].qty_per = qty;
      });
    });
  }
  const adder = pool.length
    ? `<div class="search-line">${selectBox("component_id", pool, pool[0].id)}<button type="button" class="ghost" data-act="add">${esc(t("addPart"))}</button></div>${field(tf("perUnit", { n: "" }).trim(), `<input id="addQty" inputmode="decimal" value="1" autocomplete="off">`)}`
    : `<p class="empty">${esc(t("addConsumableFirst"))}</p>`;
  return {
    title: t("recipe"),
    back: `#/items/${id}`,
    html: `<div class="who"><b>${esc(label(item))}</b></div><div id="bomList" class="stack"></div><h2>${esc(t("addPart"))}</h2>${adder}<div class="dock"><button type="button" class="primary block" data-act="save">${esc(t("save"))}</button></div>`,
    bind() {
      paint();
      setActions({
        rm: (el) => { lines.splice(Number(el.dataset.i), 1); paint(); },
        add: () => {
          const sel = document.querySelector("[name=component_id]");
          const qty = parseQty(document.getElementById("addQty").value);
          if (!sel || !qty || qty <= 0) return toast(t("err_qty_invalid"));
          const cid = Number(sel.value);
          const found = lines.find((line) => line.component_item_id === cid);
          if (found) found.qty_per = qty;
          else lines.push({ component_item_id: cid, qty_per: qty, name: label(pool.find((row) => row.id === cid)) });
          paint();
        },
        save: () => guard(async () => {
          const saved = await apiSend("PUT", `/api/items/${id}/bom`, {
            lines: lines.map((line) => ({ component_item_id: line.component_item_id, qty_per: line.qty_per })),
          });
          toast(t("saved"));
          location.hash = `#/items/${saved.id}`;
        }),
      });
    },
  };
}

async function viewAssemble(id) {
  await loadBoot();
  const item = await api("/api/items/" + id);
  if (!item.bom.length) {
    return { title: t("assemble"), back: `#/items/${id}`, html: `<div class="hero-empty"><p>${esc(t("noBom"))}</p><button type="button" class="primary" data-go="#/items/${id}/bom">${esc(t("setBom"))}</button></div>` };
  }
  const locs = activeRows(boot.locations, item.default_location_id);
  const parts = item.bom.map((line) => {
    const options = locsFor(line);
    const chosen = chooseLoc(line, line.qty_per);
    return `<div class="part"><header><b>${esc(label(line))}</b><small>${esc(tf("perUnit", { n: qtyText(line.qty_per) }))}</small></header>${selectBox("loc_" + line.component_item_id, options, chosen, { path: true, attr: ` data-comp="${line.component_item_id}"` })}<p class="need" data-need="${line.component_item_id}"></p></div>`;
  }).join("");
  return {
    title: t("assemble"),
    back: `#/items/${id}`,
    html: `<form data-form="1" class="form"><div class="who"><b>${esc(label(item))}</b></div><p class="hint">${esc(t("asmDeduct"))}</p>${field(t("made"), stepper(1))}${field(t("outputAt"), selectBox("output_location_id", locs, item.default_location_id || locs[0]?.id, { path: true }))}<h2>${esc(t("willUse"))}</h2>${parts}<div class="dock"><button class="primary" type="submit">${esc(t("confirmAsm"))}</button></div></form>`,
    bind() {
      const form = document.querySelector("form");
      const refresh = () => {
        const made = parseQty(form.qty.value) || 0;
        let blocked = !(made > 0);
        for (const line of item.bom) {
          const need = Math.round(line.qty_per * made * 1000) / 1000;
          const locId = Number(form.querySelector(`[data-comp="${line.component_item_id}"]`).value);
          const have = (line.balances.find((row) => row.location_id === locId) || {}).qty || 0;
          const el = form.querySelector(`[data-need="${line.component_item_id}"]`);
          const bad = !boot.settings.allow_negative && have + 1e-9 < need;
          el.textContent = tf("needHave", { need: qtyText(need), have: qtyText(have) });
          el.classList.toggle("bad", bad);
          if (bad) blocked = true;
        }
        form.querySelector(".primary").disabled = blocked;
      };
      form.addEventListener("input", refresh);
      form.addEventListener("change", refresh);
      refresh();
      setActions({
        minus: () => step(form, -1),
        plus: () => step(form, 1),
        submit: () => guard(async () => {
          const made = parseQty(form.qty.value);
          if (!made || made <= 0) return toast(t("err_qty_invalid"));
          const doc = await apiSend("POST", "/api/assemble", {
            item_id: item.id,
            qty: made,
            output_location_id: Number(form.output_location_id.value),
            components: item.bom.map((line) => ({
              item_id: line.component_item_id,
              location_id: Number(form.querySelector(`[data-comp="${line.component_item_id}"]`).value),
            })),
          });
          toast(t("saved"));
          location.hash = `#/docs/${doc.id}`;
        }),
      });
    },
  };
}

function locsFor(line) {
  const ids = new Set(activeRows(boot.locations).map((row) => row.id));
  for (const row of line.balances || []) ids.add(row.location_id);
  return boot.locations.filter((row) => ids.has(row.id));
}
function chooseLoc(line, need) {
  const enough = (line.balances || []).find((row) => row.qty + 1e-9 >= need);
  if (enough) return enough.location_id;
  if (line.default_location_id) return line.default_location_id;
  const locs = activeRows(boot.locations);
  return locs[0] ? locs[0].id : "";
}

async function viewCount(id) {
  await loadBoot();
  const item = await api("/api/items/" + id);
  const locs = activeRows(boot.locations, item.default_location_id);
  const first = (item.balances[0] && item.balances[0].location_id) || item.default_location_id || locs[0]?.id;
  return {
    title: t("count"),
    back: `#/items/${id}`,
    html: `<form data-form="1" class="form"><div class="who"><b>${esc(label(item))}</b></div>${field(t("location"), selectBox("location_id", locs, first, { path: true }))}<p id="book" class="hint"></p>${field(t("actual"), `<input name="actual_qty" inputmode="decimal" autocomplete="off">`)}${field(t("note"), `<textarea name="note" maxlength="500"></textarea>`)}<div class="dock"><button class="primary" type="submit">${esc(t("confirmCount"))}</button></div></form>`,
    bind() {
      const form = document.querySelector("form");
      const book = document.getElementById("book");
      const show = () => {
        const locId = Number(form.location_id.value);
        const row = item.balances.find((entry) => entry.location_id === locId);
        book.textContent = tf("book", { n: qtyText(row ? row.qty : 0) });
      };
      form.location_id.addEventListener("change", show);
      show();
      setActions({
        submit: () => guard(async () => {
          const actual = parseQty(form.actual_qty.value);
          if (actual == null || actual < 0) return toast(t("err_qty_invalid"));
          const doc = await apiSend("POST", "/api/count", {
            item_id: item.id,
            location_id: Number(form.location_id.value),
            actual_qty: actual,
            note: form.note.value,
          });
          toast(t("saved"));
          location.hash = `#/docs/${doc.id}`;
        }),
      });
    },
  };
}

async function viewTransfer(id) {
  await loadBoot();
  const item = await api("/api/items/" + id);
  const fromRows = item.balances.filter((row) => row.qty > 0);
  if (!fromRows.length) {
    return { title: t("move"), back: `#/items/${id}`, html: `<p class="empty">${esc(t("noStockMove"))}</p>` };
  }
  const fromLocs = boot.locations.filter((row) => fromRows.some((bal) => bal.location_id === row.id));
  const toLocs = activeRows(boot.locations);
  return {
    title: t("move"),
    back: `#/items/${id}`,
    html: `<form data-form="1" class="form"><div class="who"><b>${esc(label(item))}</b></div>${field(t("from"), selectBox("from_location_id", fromLocs, fromLocs[0].id, { path: true }))}${field(t("to"), selectBox("to_location_id", toLocs, toLocs.find((row) => row.id !== fromLocs[0].id)?.id || "", { path: true }))}${field(t("qty"), stepper(1))}<div class="dock"><button class="primary" type="submit">${esc(t("confirmMove"))}</button></div></form>`,
    bind() {
      const form = document.querySelector("form");
      setActions({
        minus: () => step(form, -1),
        plus: () => step(form, 1),
        submit: () => guard(async () => {
          const qty = parseQty(form.qty.value);
          if (!qty || qty <= 0) return toast(t("err_qty_invalid"));
          const doc = await apiSend("POST", "/api/move", {
            item_id: item.id,
            qty,
            from_location_id: Number(form.from_location_id.value),
            to_location_id: Number(form.to_location_id.value),
          });
          toast(t("saved"));
          location.hash = `#/docs/${doc.id}`;
        }),
      });
    },
  };
}

async function viewQr(kind, id) {
  let code = "";
  let title = "";
  let back = "#/";
  if (kind === "item") {
    const item = await api("/api/items/" + id);
    code = item.code;
    title = label(item);
    back = `#/items/${id}`;
  } else {
    await loadBoot();
    const loc = boot.locations.find((row) => String(row.id) === String(id));
    code = loc ? loc.code : "";
    title = loc ? label(loc) : t("location");
    back = `#/settings/locations/${id}`;
  }
  return {
    title: t("qr"),
    back,
    html: `<div class="qr-wrap" id="qrbox"></div><div class="code-big">${esc(code)}</div><p class="hint">${esc(t("qrHint"))}</p><p class="muted" style="text-align:center">${esc(title)}</p><div class="dock no-print"><button type="button" class="primary block" data-act="print">${esc(t("print"))}</button></div>`,
    bind() {
      const box = document.getElementById("qrbox");
      if (typeof qrcode === "function" && code) {
        const qr = qrcode(0, "M");
        qr.addData(code);
        qr.make();
        box.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
      }
      setActions({ print: () => window.print() });
    },
  };
}

function slipTitle(doc) {
  if (doc.doc_type === "in") return t("slipIn");
  if (doc.doc_type === "out") return t("slipOut");
  return t("doc_" + doc.doc_type);
}
function slipHTML(doc) {
  const formal = doc.doc_type === "in" || doc.doc_type === "out";
  const company = (state.company && state.company.company_name) || t("brand");
  const party = doc.doc_type === "in" ? (doc.meta.source_name || "") : (doc.meta.dest_name || "");
  const partyLabel = doc.doc_type === "in" ? t("sourceName") : t("destName");
  const rows = doc.lines.map((line, index) => {
    const qty = Math.abs(line.qty_delta);
    const price = line.unit_price == null ? "" : Number(line.unit_price).toFixed(2);
    const amount = line.unit_price == null ? "" : (Math.round(Number(line.unit_price) * qty * 100) / 100).toFixed(2);
    const place = placeName({
      name: line.location_name,
      name_en: line.location_name_en,
      warehouse_name: line.warehouse_name,
      warehouse_name_en: line.warehouse_name_en,
    });
    return `<tr><td>${index + 1}</td><td>${esc(line.code)}</td><td>${esc(label(line))}</td><td>${esc(line.spec || "")}</td><td>${esc(place)}</td><td>${esc(unitOf(line))}</td><td class="num">${esc(qtyText(qty))}</td>${formal ? `<td class="num">${esc(price)}</td><td class="num">${esc(amount)}</td>` : ""}</tr>`;
  }).join("");
  const head = formal
    ? `<tr><th>${esc(t("lineNo"))}</th><th>${esc(t("code"))}</th><th>${esc(t("itemName"))}</th><th>${esc(t("spec"))}</th><th>${esc(t("warehouses"))}</th><th>${esc(t("unit"))}</th><th>${esc(t("qty"))}</th><th>${esc(t("refPrice"))}</th><th>${esc(t("amount"))}</th></tr>`
    : `<tr><th>${esc(t("lineNo"))}</th><th>${esc(t("code"))}</th><th>${esc(t("itemName"))}</th><th>${esc(t("spec"))}</th><th>${esc(t("warehouses"))}</th><th>${esc(t("unit"))}</th><th>${esc(t("qty"))}</th></tr>`;
  const info = [
    `${t("docNo")} ${doc.doc_no}`,
    `${t("when")} ${doc.created_at.replace("T", " ")}`,
    party ? `${partyLabel} ${party}` : "",
    doc.operator ? `${t("madeBy")} ${doc.operator}` : "",
    doc.note ? `${t("note")} ${doc.note}` : "",
  ].filter(Boolean).map((line) => `<span>${esc(line)}</span>`).join("");
  const signs = formal
    ? `<div class="signs"><span>${esc(t("madeBy"))} ______</span><span>${esc(t("keeper"))} ______</span><span>${esc(t("receiver"))} ______</span></div>`
    : "";
  return `<article class="slip">
    <p class="co">${esc(company)}</p>
    <h2>${esc(slipTitle(doc))}</h2>
    <div class="slip-meta">${info}</div>
    ${doc.status === "voided" ? `<p class="void-mark">${esc(t("voided"))}${doc.void_reason ? " · " + esc(doc.void_reason) : ""}</p>` : ""}
    <table>${head}${rows}</table>
    ${signs}
    <p class="slip-foot">${esc(t("brand"))}</p>
  </article>`;
}
async function viewDoc(id) {
  const doc = await api("/api/documents/" + id);
  const photo = doc.photo_url ? `<img class="hero-photo no-print" src="${esc(doc.photo_url)}" alt="">` : "";
  const voidBtn = doc.status === "posted" ? `<button type="button" class="ghost block" data-act="void">${esc(t("void"))}</button>` : "";
  const slipBack = doc.doc_type === "in" ? "#/in" : doc.doc_type === "out" ? "#/out" : "#/";
  const backBtn = doc.doc_type === "in" || doc.doc_type === "out"
    ? `<button type="button" class="ghost back-doc no-print" data-go="${slipBack}">${esc(t("back"))}</button>`
    : "";
  return {
    title: doc.doc_no,
    back: slipBack,
    html: `${backBtn}${slipHTML(doc)}${photo}<div class="dock no-print"><button type="button" class="primary block" data-act="print">${esc(t("printSlip"))}</button>${voidBtn}</div>`,
    bind() {
      setActions({
        print: () => window.print(),
        void: () => openSheet(`<h3>${esc(t("void"))}</h3><p class="hint">${esc(t("voidHint"))}</p>${field(t("reason"), `<input id="voidReason" maxlength="200" autocomplete="off">`)}<button type="button" class="danger" id="doVoid">${esc(t("confirmVoid"))}</button>`, (root) => {
          root.querySelector("#doVoid").onclick = () => guard(async () => {
            const reason = root.querySelector("#voidReason").value.trim();
            if (!reason) return toast(t("err_reason_required"));
            await apiSend("POST", `/api/documents/${id}/void`, { reason });
            closeSheet();
            toast(t("saved"));
            draw();
          });
        }),
      });
    },
  };
}

async function viewLogs(query) {
  const data = await api("/api/logs" + (query.item ? `?item_id=${encodeURIComponent(query.item)}` : ""));
  const list = data.logs.map(logButton).join("") || `<p class="empty">${esc(t("noActivity"))}</p>`;
  return { title: t("logs"), back: "#/", lang: true, html: `<div class="stack">${list}</div>` };
}

async function viewLocStock(id) {
  const data = await api("/api/locations/" + id + "/stock");
  const title = label(data.location);
  const list = data.items.length
    ? data.items.map((item) => itemRow(item, `#/items/${item.id}`)).join("")
    : `<p class="empty">${esc(t("noBalances"))}</p>`;
  return { title, back: "#/", html: `<p class="muted">${esc(data.location.code || "")}</p><div class="stack">${list}</div>` };
}

function enterSession(me) {
  state.user = me.user;
  state.company = me.company;
  invalidate();
  draw();
}
function viewLogin(brand) {
  const who = brand.company_name || t("brand");
  const sub = t("loginSub");
  return {
    title: who,
    auth: true,
    html: `<div class="auth">
      <div class="auth-mark">3500</div>
      <h1>${esc(who)}</h1>
      <p class="auth-sub">${esc(sub)}</p>
      <form data-form="1" class="form">
        ${field(t("username"), `<input name="username" maxlength="32" autocomplete="username" required>`)}
        ${field(t("password"), secretInput("password"))}
        <button class="primary" type="submit">${esc(t("signIn"))}</button>
      </form>
    </div>`,
    bind() {
      setActions({
        submit: (form) => guard(async () => {
          const me = await api("/api/login", {
            method: "POST",
            body: { username: form.username.value, password: form.password.value },
          });
          enterSession(me);
        }),
      });
    },
  };
}
function viewSetup(brand) {
  return {
    title: t("setupTitle"),
    auth: true,
    html: `<div class="auth">
      <div class="auth-mark">3500</div>
      <h1>${esc(t("brand"))}</h1>
      <p class="auth-sub">${esc(t("setupSub"))}</p>
      <form data-form="1" class="form">
        <h2>${esc(t("company"))}</h2>
        ${field(t("companyName"), textInput("company_name", brand.company_name || "", { max: 40 }))}
        <p class="hint">${esc(t("companyOnlyHint"))}</p>
        <h2>${esc(t("admin"))}</h2>
        ${field(t("adminName"), textInput("name", "", { max: 40 }))}
        ${field(t("adminUser"), `<input name="username" maxlength="32" autocomplete="username" required>`)}
        ${field(t("adminPass"), secretInput("password", { auto: "new-password" }))}
        <button class="primary" type="submit">${esc(t("openSystem"))}</button>
      </form>
    </div>`,
    bind() {
      setActions({
        submit: (form) => guard(async () => {
          const me = await api("/api/setup", {
            method: "POST",
            body: {
              company_name: form.company_name.value,
              name: form.name.value,
              username: form.username.value,
              password: form.password.value,
            },
          });
          enterSession(me);
        }),
      });
    },
  };
}
async function authPage() {
  const brand = await api("/api/brand");
  return brand.needs_setup ? viewSetup(brand) : viewLogin(brand);
}
function companyFields(settings) {
  return [
    field(t("companyName"), textInput("company_name", settings.company_name, { max: 40 })),
    `<p class="hint">${esc(t("companyOnlyHint"))}</p>`,
    `<label class="check"><input name="allow_negative" type="checkbox" ${settings.allow_negative ? "checked" : ""}> ${esc(t("allowNegative"))}</label>`,
  ].join("");
}
function profileCard(settings) {
  const lines = [settings.company_full, [settings.company_contact, settings.company_phone].filter(Boolean).join(" "), settings.company_address]
    .filter(Boolean)
    .map((line) => `<p>${esc(line)}</p>`)
    .join("");
  return `<section class="profile-card"><h2>${esc(t("company"))}</h2><p><b>${esc(settings.company_name || t("brand"))}</b></p>${lines}</section>`;
}
async function viewSettings() {
  const settings = await api("/api/settings");
  state.company = settings;
  const boss = isBoss();
  const links = [
    ...(boss ? [["#/settings/users", t("admins")]] : []),
    ["#/settings/warehouses", t("warehouses")],
    ["#/settings/categories", t("categories")],
    ["#/settings/locations", t("locations")],
    ["#/settings/units", t("units")],
    ["#/settings/sources", t("sources")],
    ["#/settings/purposes", t("purposes")],
    ["#/logs", t("logs")],
  ].map(([href, name]) => `<button type="button" class="row" data-go="${href}"><span>${esc(name)}</span></button>`).join("");
  const signed = (localStorage.getItem("ruida.operator") || "").trim();
  const who = state.user
    ? `<p class="who"><b>${esc(state.user.name || state.user.username)}</b><small>${esc(state.user.username)} · ${esc(t("role_" + state.user.role))}</small></p>`
    : "";
  const company = boss
    ? `<h2>${esc(t("company"))}</h2>${companyFields(settings)}`
    : profileCard(settings);
  return {
    title: t("settings"),
    back: "#/",
    lang: true,
    html: `${who}<form data-form="1" class="form">
      ${company}
      ${field(t("signature"), textInput("operator", signed, { placeholder: t("signatureHint") }))}
      <p class="hint">${esc(t("signatureHint"))}</p>
      <button class="primary" type="submit">${esc(t("save"))}</button>
    </form>
    <div class="stack" style="margin-top:16px">${links}</div>
    <p class="credit">made by MoeDisk<br><a href="mailto:moedisk@outlook.com">moedisk@outlook.com</a><br><a data-site href="http://ohayou.aimo.moe" target="_blank" rel="noopener">ohayou.aimo.moe</a></p>
    <div class="dock">
      <button type="button" class="ghost block" data-act="logout">${esc(t("logout"))}</button>
      ${boss ? `<button type="button" class="ghost block" data-act="reset">${esc(t("factory"))}</button>` : ""}
    </div>`,
    bind() {
      rememberSiteProtocol();
      setActions({
        submit: (form) => guard(async () => {
          localStorage.setItem("ruida.operator", form.operator.value.trim());
          if (boss) {
            const saved = await apiSend("PUT", "/api/settings", {
              company_name: form.company_name.value,
              allow_negative: form.allow_negative.checked,
            });
            state.company = saved;
            invalidate();
          }
          toast(t("saved"));
          draw();
        }),
        logout: () => doLogout(),
        reset: () => openSheet(`<h3>${esc(t("factory"))}</h3><p class="hint">${esc(t("factoryWarn"))}</p>${field(t("typeToConfirm"), `<input id="resetWord" autocomplete="off" placeholder="RESET">`)}<button type="button" class="danger" id="doReset">${esc(t("confirmFactory"))}</button>`, (root) => {
          root.querySelector("#doReset").onclick = () => guard(async () => {
            if (root.querySelector("#resetWord").value.trim() !== "RESET") return toast(t("err_confirm_reset"));
            const result = await apiSend("POST", "/api/factory-reset", { confirm: "RESET" });
            state.user = null;
            state.company = null;
            invalidate();
            closeSheet();
            toast(tf("factoryDone", { id: result.backup }));
            if ((location.hash || "#/") !== "#/") location.hash = "#/";
            else draw();
          });
        }),
      });
    },
  };
}
async function viewUserList() {
  if (!isBoss()) return { title: t("users"), back: "#/settings", html: `<p class="empty">${esc(t("err_forbidden"))}</p>` };
  const data = await api("/api/users");
  const rows = data.users.map((user) =>
    `<button type="button" class="row" data-go="#/settings/users/${user.id}"><span><b>${esc(user.name)}</b><small>${esc(user.username)} · ${esc(t("admins"))}${user.active ? "" : " · " + esc(t("inactiveMark"))}</small></span></button>`
  ).join("");
  return {
    title: t("users"),
    back: "#/settings",
    html: `<div class="stack">${rows}</div><div class="dock"><button type="button" class="primary block" data-go="#/settings/users/new">${esc(t("newUser"))}</button></div>`,
  };
}
async function viewUserForm(id) {
  if (!isBoss()) return { title: t("users"), back: "#/settings", html: `<p class="empty">${esc(t("err_forbidden"))}</p>` };
  let user = null;
  if (id !== "new") {
    const data = await api("/api/users");
    user = data.users.find((row) => String(row.id) === String(id));
    if (!user) return { title: t("users"), back: "#/settings/users", html: `<p class="empty">${esc(t("err_not_found"))}</p>` };
  }
  return {
    title: user ? user.name : t("newUser"),
    back: "#/settings/users",
    html: `<form data-form="1" class="form">
      ${user ? `<p class="muted">${esc(user.username)}</p>` : field(t("username"), `<input name="username" maxlength="32" autocomplete="off" required>`)}
      ${field(t("adminName"), textInput("name", user ? user.name : "", { max: 40 }))}
      ${field(t("password"), secretInput("password", { auto: "new-password", placeholder: user ? t("passwordOptional") : "" }))}
      ${user ? `<label class="check"><input name="active" type="checkbox" ${user.active ? "checked" : ""}> ${esc(t("active"))}</label>` : ""}
      <div class="dock"><button class="primary" type="submit">${esc(t("save"))}</button></div>
    </form>`,
    bind() {
      setActions({
        submit: (form) => guard(async () => {
          const body = {
            name: form.name.value,
            password: form.password.value,
            active: user ? form.active.checked : true,
          };
          if (user) await apiSend("PUT", `/api/users/${user.id}`, body);
          else {
            body.username = form.username.value;
            await apiSend("POST", "/api/users", body);
          }
          toast(t("saved"));
          location.hash = "#/settings/users";
        }),
      });
    },
  };
}

const DICT = {
  units: { title: "units", api: "/api/units", boot: "units", create: "newUnit" },
  sources: { title: "sources", api: "/api/source-types", boot: "source_types", create: "newSource" },
  purposes: { title: "purposes", api: "/api/purposes", boot: "purposes", create: "newPurpose" },
};

async function viewDictList(kind) {
  await loadBoot(true);
  const spec = DICT[kind];
  const rows = boot[spec.boot].map((row) =>
    `<button type="button" class="row" data-go="#/settings/${kind}/${row.id}"><span><b>${esc(label(row))}</b>${row.active ? "" : `<small>${esc(t("inactiveMark"))}</small>`}</span></button>`
  ).join("");
  return {
    title: t(spec.title),
    back: "#/settings",
    html: `<div class="stack">${rows}</div><div class="dock"><button type="button" class="primary block" data-go="#/settings/${kind}/new">${esc(t(spec.create))}</button></div>`,
  };
}

async function viewDictForm(kind, id) {
  await loadBoot();
  const spec = DICT[kind];
  const row = id === "new" ? null : boot[spec.boot].find((item) => String(item.id) === String(id));
  return {
    title: row ? label(row) : t(spec.create),
    back: `#/settings/${kind}`,
    html: `<form data-form="1" class="form">
      ${field(t("nameZh"), textInput("name", row ? row.name : ""))}
      ${row ? `<label class="check"><input name="active" type="checkbox" ${row.active ? "checked" : ""}> ${esc(t("active"))}</label>` : ""}
      <div class="dock"><button class="primary" type="submit">${esc(t("save"))}</button>${row ? `<button type="button" class="danger" data-act="remove">${esc(t("delete"))}</button>` : ""}</div>
    </form>`,
    bind() {
      setActions({
        submit: (form) => guard(async () => {
          const body = { name: form.name.value, active: row ? form.active.checked : true };
          if (row) await apiSend("PUT", `${spec.api}/${row.id}`, body);
          else await apiSend("POST", spec.api, body);
          invalidate();
          toast(t("saved"));
          location.hash = `#/settings/${kind}`;
        }),
        remove: () => askDelete(() => apiSend("DELETE", `${spec.api}/${row.id}`, {}), `#/settings/${kind}`),
      });
    },
  };
}

async function viewCategoryList() {
  await loadBoot(true);
  const rows = boot.categories.map((row) =>
    `<button type="button" class="row" data-go="#/settings/categories/${row.id}"><span><b>${esc(label(row))}</b><small>${[row.can_assemble ? t("canAssemble") : "", row.can_consume ? t("canConsume") : "", row.active ? "" : t("inactiveMark")].filter(Boolean).join(" · ")}</small></span></button>`
  ).join("");
  return {
    title: t("categories"),
    back: "#/settings",
    html: `<div class="stack">${rows}</div><div class="dock"><button type="button" class="primary block" data-go="#/settings/categories/new">${esc(t("newCategory"))}</button></div>`,
  };
}

async function viewCategoryForm(id) {
  await loadBoot();
  const row = id === "new" ? null : boot.categories.find((item) => String(item.id) === String(id));
  return {
    title: row ? label(row) : t("newCategory"),
    back: "#/settings/categories",
    html: `<form data-form="1" class="form">
      ${field(t("nameZh"), textInput("name", row ? row.name : ""))}
      <label class="check"><input name="can_assemble" type="checkbox" ${row && row.can_assemble ? "checked" : ""}> ${esc(t("canAssemble"))}</label>
      <label class="check"><input name="can_consume" type="checkbox" ${row && row.can_consume ? "checked" : ""}> ${esc(t("canConsume"))}</label>
      <p class="hint">${esc(t("flagHint"))}</p>
      ${row ? `<label class="check"><input name="active" type="checkbox" ${row.active ? "checked" : ""}> ${esc(t("active"))}</label>` : ""}
      <div class="dock"><button class="primary" type="submit">${esc(t("save"))}</button>${row ? `<button type="button" class="danger" data-act="remove">${esc(t("delete"))}</button>` : ""}</div>
    </form>`,
    bind() {
      setActions({
        submit: (form) => guard(async () => {
          const body = {
            name: form.name.value,
            can_assemble: form.can_assemble.checked,
            can_consume: form.can_consume.checked,
            active: row ? form.active.checked : true,
          };
          if (row) await apiSend("PUT", "/api/categories/" + row.id, body);
          else await apiSend("POST", "/api/categories", body);
          invalidate();
          toast(t("saved"));
          location.hash = "#/settings/categories";
        }),
        remove: () => askDelete(() => apiSend("DELETE", "/api/categories/" + row.id, {}), "#/settings/categories"),
      });
    },
  };
}

async function viewExtra() {
  return {
    title: t("extra"),
    back: "#/",
    html: `<section><h2>${esc(t("backupNow"))}</h2><p class="hint">${esc(t("backupHint"))}</p><button type="button" class="primary block" data-act="backup">${esc(t("backupNow"))}</button></section>
      <section><h2>${esc(t("importBackup"))}</h2><p class="hint">${esc(t("importHint"))}</p><button type="button" class="ghost block" data-act="import">${esc(t("importBackup"))}</button>
      <input id="importFile" class="scan-file" type="file" accept=".zip,application/zip"></section>`,
    bind() {
      const input = document.getElementById("importFile");
      input.addEventListener("change", () => {
        const file = input.files && input.files[0];
        input.value = "";
        if (!file) return;
        openSheet(`<h3>${esc(t("importBackup"))}</h3><p class="hint">${esc(t("importWarn"))}</p><p>${esc(file.name)}</p><button type="button" class="danger" id="doImport">${esc(t("importBackup"))}</button>`, (root) => {
          root.querySelector("#doImport").onclick = () => guard(async () => {
            const res = await fetch("/api/backups/import", {
              method: "POST",
              headers: { "Content-Type": "application/zip" },
              body: file,
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
              const err = new Error(data.error || "http");
              err.data = data;
              throw err;
            }
            state.user = null;
            state.company = null;
            invalidate();
            closeSheet();
            toast(t("restored"));
            if ((location.hash || "#/") !== "#/") location.hash = "#/";
            else draw();
          });
        });
      });
      setActions({
        backup: () => {
          const a = document.createElement("a");
          a.href = "/api/backups/download";
          document.body.appendChild(a);
          a.click();
          a.remove();
        },
        import: () => input.click(),
      });
    },
  };
}
async function viewWarehouseList() {
  await loadBoot(true);
  const rows = boot.warehouses.map((row) =>
    `<button type="button" class="row" data-go="#/settings/warehouses/${row.id}"><span><b>${esc(label(row))}</b><small>${esc(row.code || "")}${row.active ? "" : " · " + esc(t("inactiveMark"))}</small></span></button>`
  ).join("");
  return {
    title: t("warehouses"),
    back: "#/settings",
    html: `<p class="hint">${esc(t("warehouseHint"))}</p><div class="stack">${rows}</div><div class="dock"><button type="button" class="primary block" data-go="#/settings/warehouses/new">${esc(t("newWarehouse"))}</button></div>`,
  };
}
async function viewWarehouseForm(id) {
  await loadBoot();
  const row = id === "new" ? null : boot.warehouses.find((item) => String(item.id) === String(id));
  if (id !== "new" && !row) return { title: t("warehouses"), back: "#/settings/warehouses", html: `<p class="empty">${esc(t("err_not_found"))}</p>` };
  return {
    title: row ? label(row) : t("newWarehouse"),
    back: "#/settings/warehouses",
    html: `<form data-form="1" class="form">
      ${field(t("nameZh"), textInput("name", row ? row.name : ""))}
      ${row ? `<p class="muted">${esc(row.code || "")}</p><label class="check"><input name="active" type="checkbox" ${row.active ? "checked" : ""}> ${esc(t("active"))}</label>` : `<p class="hint">${esc(t("warehouseNewHint"))}</p>`}
      <div class="dock"><button class="primary" type="submit">${esc(t("save"))}</button>${row ? `<button type="button" class="danger" data-act="remove">${esc(t("delete"))}</button>` : ""}</div>
    </form>`,
    bind() {
      setActions({
        submit: (form) => guard(async () => {
          const body = { name: form.name.value, active: row ? form.active.checked : true };
          if (row) await apiSend("PUT", `/api/warehouses/${row.id}`, body);
          else await apiSend("POST", "/api/warehouses", body);
          invalidate();
          toast(t("saved"));
          location.hash = "#/settings/warehouses";
        }),
        remove: () => askDelete(() => apiSend("DELETE", `/api/warehouses/${row.id}`, {}), "#/settings/warehouses"),
      });
    },
  };
}
async function viewLocationList() {
  await loadBoot(true);
  const rows = boot.locations.map((row) =>
    `<button type="button" class="row" data-go="#/settings/locations/${row.id}"><span><b>${esc(locPath(row.id))}</b><small>${esc(row.code || "")}${row.active ? "" : " · " + esc(t("inactiveMark"))}</small></span></button>`
  ).join("");
  return {
    title: t("locations"),
    back: "#/settings",
    html: `<div class="stack">${rows}</div><div class="dock"><button type="button" class="primary block" data-go="#/settings/locations/new">${esc(t("newLocation"))}</button></div>`,
  };
}

async function viewLocationForm(id) {
  await loadBoot();
  const row = id ? boot.locations.find((item) => String(item.id) === String(id)) : null;
  const parents = boot.locations.filter((item) => {
    if (row && (item.id === row.id || isDescendant(item.id, row.id))) return false;
    if (row && item.warehouse_id !== row.warehouse_id) return false;
    return true;
  });
  const warehouses = activeRows(boot.warehouses || []);
  const whNow = row
    ? (boot.warehouses || []).find((item) => item.id === row.warehouse_id)
    : null;
  const whField = row
    ? `<p class="muted">${esc(whNow ? label(whNow) : "")}</p>`
    : field(t("warehouses"), selectBox("warehouse_id", warehouses, lastWh() || (warehouses[0] && warehouses[0].id)));
  return {
    title: row ? label(row) : t("newLocation"),
    back: "#/settings/locations",
    html: `<form data-form="1" class="form">
      ${whField}
      ${field(t("nameZh"), textInput("name", row ? row.name : ""))}
      ${field(t("parent"), selectBox("parent_id", parents, row ? row.parent_id : "", { allowEmpty: true, empty: t("topLevel"), path: true, wh: !row }))}
      ${row ? `<p class="muted">${esc(row.code || "")}</p><button type="button" class="link" data-go="#/settings/locations/${row.id}/qr">${esc(t("locationQr"))}</button>` : ""}
      ${row ? `<label class="check"><input name="active" type="checkbox" ${row.active ? "checked" : ""}> ${esc(t("active"))}</label>` : ""}
      <div class="dock"><button class="primary" type="submit">${esc(t("save"))}</button>${row ? `<button type="button" class="danger" data-act="remove">${esc(t("delete"))}</button>` : ""}</div>
    </form>`,
    bind() {
      const form = document.querySelector("form");
      if (!row && form.warehouse_id) wireWarehouse(form, "warehouse_id", "parent_id");
      setActions({
        submit: (form) => guard(async () => {
          const body = {
            name: form.name.value,
            parent_id: form.parent_id.value || null,
            active: row ? form.active.checked : true,
          };
          if (!row) body.warehouse_id = Number(form.warehouse_id.value);
          if (row) await apiSend("PUT", "/api/locations/" + row.id, body);
          else await apiSend("POST", "/api/locations", body);
          invalidate();
          toast(t("saved"));
          location.hash = "#/settings/locations";
        }),
        remove: () => askDelete(() => apiSend("DELETE", "/api/locations/" + row.id, {}), "#/settings/locations"),
      });
    },
  };
}

function isDescendant(id, ancestorId) {
  const by = Object.fromEntries(boot.locations.map((row) => [row.id, row]));
  let cur = by[id];
  const guard = new Set();
  while (cur && !guard.has(cur.id)) {
    if (cur.id === ancestorId) return true;
    guard.add(cur.id);
    cur = cur.parent_id ? by[cur.parent_id] : null;
  }
  return false;
}

function openSheet(html, bind) {
  const root = document.getElementById("sheet");
  root.classList.remove("hidden");
  root.innerHTML = `<div class="sheet-back"><div class="sheet-panel">${html}</div></div>`;
  root.querySelector(".sheet-back").addEventListener("click", (event) => {
    if (event.target.classList.contains("sheet-back")) closeSheet();
  });
  if (bind) bind(root);
}
function closeSheet() {
  const root = document.getElementById("sheet");
  root.classList.add("hidden");
  root.innerHTML = "";
}

let scanOnCode = null;
let scanToken = 0;
function stopScan() {
  scanToken += 1;
  if (scanRAF) cancelAnimationFrame(scanRAF);
  scanRAF = 0;
  if (scanStream) {
    for (const track of scanStream.getTracks()) track.stop();
    scanStream = null;
  }
  const video = document.getElementById("scanVideo");
  if (video) video.srcObject = null;
  const layer = document.getElementById("scan");
  if (layer) layer.classList.add("hidden");
}
function phoneScan() {
  const ua = navigator.userAgent || "";
  if (/Android|iPhone|iPad|iPod/i.test(ua)) return true;
  return navigator.maxTouchPoints > 1 && /Macintosh/i.test(ua);
}
function finishScan(text) {
  const cb = scanOnCode;
  scanOnCode = null;
  stopScan();
  if (cb && text) cb(String(text).trim());
}
function readQrCanvas(canvas) {
  if (typeof jsQR !== "function") return "";
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const code = jsQR(image.data, canvas.width, canvas.height, { inversionAttempts: "attemptBoth" });
  return code && code.data ? code.data : "";
}
function frameOf(source, maxSide, rotate) {
  const rad = ((rotate || 0) * Math.PI) / 180;
  const swap = rotate === 90 || rotate === 270;
  const srcW = source.videoWidth || source.naturalWidth || source.width;
  const srcH = source.videoHeight || source.naturalHeight || source.height;
  const boxW = swap ? srcH : srcW;
  const boxH = swap ? srcW : srcH;
  const scale = Math.min(1, maxSide / Math.max(boxW, boxH));
  const w = Math.max(1, Math.round(boxW * scale));
  const h = Math.max(1, Math.round(boxH * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.translate(w / 2, h / 2);
  if (rad) ctx.rotate(rad);
  ctx.drawImage(source, -srcW * scale / 2, -srcH * scale / 2, srcW * scale, srcH * scale);
  return canvas;
}
async function decodeQrFile(file) {
  let bitmap = null;
  try {
    if (typeof createImageBitmap === "function") bitmap = await createImageBitmap(file);
  } catch (_) {
    bitmap = null;
  }
  if (!bitmap) {
    bitmap = await new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("image")); };
      img.src = url;
    });
  }
  if ("BarcodeDetector" in window) {
    try {
      const detector = new BarcodeDetector({ formats: ["qr_code"] });
      const found = await detector.detect(bitmap);
      if (found && found[0] && found[0].rawValue) return found[0].rawValue;
    } catch (_) {}
  }
  for (const angle of [0, 90, 270, 180]) {
    for (const size of [640, 960]) {
      const text = readQrCanvas(frameOf(bitmap, size, angle));
      if (text) return text;
    }
  }
  if (bitmap.close) bitmap.close();
  return "";
}
function openCapture() {
  const token = scanToken;
  const input = document.getElementById("scanFile");
  input.value = "";
  input.onchange = async () => {
    const file = input.files && input.files[0];
    input.value = "";
    if (!file || token !== scanToken) return;
    let text = "";
    try { text = await decodeQrFile(file); }
    catch (_) { text = ""; }
    if (token !== scanToken) return;
    if (!text) {
      toast(t("scanMiss"));
      return;
    }
    finishScan(text);
  };
  input.click();
}
function startScan(onCode) {
  scanOnCode = onCode;
  const secure = window.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getUserMedia;
  if (!secure || phoneScan()) {
    openCapture();
    return;
  }
  liveScan();
}
async function liveScan() {
  const token = scanToken;
  const layer = document.getElementById("scan");
  layer.classList.remove("hidden");
  document.getElementById("scanClose").textContent = t("close");
  document.getElementById("scanShot").textContent = t("scanShot");
  document.getElementById("scanHint").textContent = t("scanLiveHint");
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
  } catch (_) {
    try {
      scanStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    } catch (_) {
      if (token === scanToken) {
        stopScan();
        toast(t("openCameraFail"));
      }
      return;
    }
  }
  if (token !== scanToken) return;
  const video = document.getElementById("scanVideo");
  video.muted = true;
  video.setAttribute("playsinline", "");
  video.srcObject = scanStream;
  try { await video.play(); }
  catch (_) {}
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  let detector = null;
  if ("BarcodeDetector" in window) {
    try { detector = new BarcodeDetector({ formats: ["qr_code"] }); }
    catch (_) { detector = null; }
  }
  let detecting = false;
  let last = 0;
  const tick = async (now) => {
    if (!scanStream || token !== scanToken) return;
    if (!detecting && video.videoWidth && now - last > 140) {
      detecting = true;
      last = now;
      try {
        let text = "";
        if (detector) {
          const codes = await detector.detect(video);
          text = codes && codes[0] ? codes[0].rawValue : "";
        }
        if (!text && typeof jsQR === "function") {
          const side = Math.min(video.videoWidth, video.videoHeight);
          const sx = (video.videoWidth - side) / 2;
          const sy = (video.videoHeight - side) / 2;
          canvas.width = 420;
          canvas.height = 420;
          ctx.drawImage(video, sx, sy, side, side, 0, 0, 420, 420);
          const image = ctx.getImageData(0, 0, 420, 420);
          const code = jsQR(image.data, 420, 420, { inversionAttempts: "attemptBoth" });
          text = code && code.data ? code.data : "";
        }
        if (text && token === scanToken) {
          finishScan(text);
          return;
        }
      } catch (_) {
        detector = null;
      }
      detecting = false;
    }
    scanRAF = requestAnimationFrame(tick);
  };
  scanRAF = requestAnimationFrame(tick);
}
const CREDIT_SITE = "ohayou.aimo.moe";
let creditSiteHref = `http://${CREDIT_SITE}`;
let creditSiteChecked = false;
function paintSiteLinks() {
  document.querySelectorAll("[data-site]").forEach((node) => { node.href = creditSiteHref; });
}
function rememberSiteProtocol() {
  if (creditSiteChecked) {
    paintSiteLinks();
    return;
  }
  const apply = (httpsOk, cache) => {
    if (!httpsOk && creditSiteHref.startsWith("https:")) return;
    creditSiteHref = `${httpsOk ? "https" : "http"}://${CREDIT_SITE}`;
    if (cache || httpsOk) creditSiteChecked = true;
    paintSiteLinks();
  };
  const slow = setTimeout(() => apply(false, false), 800);
  fetch(`https://${CREDIT_SITE}`, { mode: "no-cors", cache: "no-store" })
    .then(() => { clearTimeout(slow); apply(true, true); })
    .catch(() => { clearTimeout(slow); apply(false, true); });
}
function openCredit() {
  openSheet(`<h3>made by MoeDisk</h3><p><a class="credit-link" href="mailto:moedisk@outlook.com">moedisk@outlook.com</a></p><p><a class="credit-link" data-site href="${esc(creditSiteHref)}" target="_blank" rel="noopener">${CREDIT_SITE}</a></p>`);
  rememberSiteProtocol();
}
function openAccount() {
  if (!state.user) return;
  const name = state.user.name || state.user.username;
  openSheet(
    `<h3>${esc(name)}</h3><p class="hint">${esc(state.user.username)} · ${esc(t("role_" + state.user.role))}</p><button type="button" class="danger" id="doLogout">${esc(t("logout"))}</button>`,
    (root) => { root.querySelector("#doLogout").onclick = () => doLogout(); }
  );
}
function doLogout() {
  guard(async () => {
    await api("/api/logout", { method: "POST", body: {} });
    state.user = null;
    state.company = null;
    invalidate();
    closeSheet();
    if ((location.hash || "#/") !== "#/") location.hash = "#/";
    else draw();
  });
}

async function routeToPage(route) {
  const [a, b, c, d] = route.parts;
  if (!a) return viewHome();
  if (a === "in") return b ? viewStockForm("in", b) : viewPick("in");
  if (a === "out") return b ? viewStockForm("out", b) : viewPick("out");
  if (a === "items" && !b) return viewItems(route.query);
  if (a === "items" && b === "new") return viewItemForm(null, route.query);
  if (a === "items" && b && !c) return viewItem(b);
  if (a === "items" && c === "edit") return viewItemForm(b);
  if (a === "items" && c === "bom") return viewBom(b);
  if (a === "items" && c === "assemble") return viewAssemble(b);
  if (a === "items" && c === "qr") return viewQr("item", b);
  if (a === "items" && c === "count") return viewCount(b);
  if (a === "items" && c === "move") return viewTransfer(b);
  if (a === "logs") return viewLogs(route.query);
  if (a === "docs" && b) return viewDoc(b);
  if (a === "loc" && b) return viewLocStock(b);
  if (a === "extra") return viewExtra();
  if (a === "settings" && !b) return viewSettings();
  if (a === "settings" && b === "warehouses") return c ? viewWarehouseForm(c) : viewWarehouseList();
  if (a === "settings" && b === "users") return c ? viewUserForm(c) : viewUserList();
  if (a === "settings" && b === "categories") return c ? viewCategoryForm(c) : viewCategoryList();
  if (a === "settings" && b === "locations" && d === "qr") return viewQr("location", c);
  if (a === "settings" && b === "locations" && c === "new") return viewLocationForm(null);
  if (a === "settings" && b === "locations" && c) return viewLocationForm(c);
  if (a === "settings" && b === "locations") return viewLocationList();
  if (a === "settings" && DICT[b]) return c ? viewDictForm(b, c) : viewDictList(b);
  return { title: t("brand"), tab: "home", html: `<p class="empty">${esc(t("err_not_found"))}</p>` };
}

let seq = 0;
async function draw() {
  const token = ++seq;
  stopScan();
  const notice = document.getElementById("notice");
  if (notice) notice.classList.remove("show");
  const view = document.getElementById("view");
  view.innerHTML = `<p class="muted">${esc(t("loading"))}</p>`;
  let page;
  try {
    if (!state.user) {
      try {
        const me = await api("/api/session");
        state.user = me.user;
        state.company = me.company;
      } catch (err) {
        if (err.offline) throw err;
        page = await authPage();
      }
    }
    if (!page) page = await routeToPage(parseHash());
  } catch (err) {
    if (err.data && err.data.error === "unauthorized") {
      state.user = null;
      state.company = null;
      page = await authPage();
    } else {
      page = {
        title: t("brand"),
        tab: "home",
        html: `<div class="hero-empty"><p>${esc(explain(err))}</p><button type="button" class="primary" data-act="reload">${esc(t("retry"))}</button></div>`,
        bind() { setActions({ reload: () => draw() }); },
      };
    }
  }
  if (token !== seq) return;
  document.documentElement.lang = state.lang === "en" ? "en" : "zh-CN";
  document.title = page.title ? `${page.title} · ${t("brand")}` : t("brand");
  document.getElementById("top").innerHTML = headerHTML(page);
  view.innerHTML = page.html;
  const tabs = document.getElementById("tabs");
  tabs.classList.toggle("auth-hide", !!page.auth);
  tabs.classList.toggle("sub", !page.auth && !page.tab);
  tabs.innerHTML = page.auth ? "" : tabsHTML(page.tab || "");
  setActions({});
  if (page.bind) page.bind();
  view.scrollTop = 0;
}

document.body.addEventListener("click", (event) => {
  if (event.target.closest("[data-credit]")) {
    openCredit();
    return;
  }
  if (event.target.closest("[data-account]")) {
    openAccount();
    return;
  }
  const lang = event.target.closest("[data-lang]");
  if (lang) {
    state.lang = lang.dataset.lang;
    localStorage.setItem("ruida.lang", state.lang);
    draw();
    return;
  }
  const go = event.target.closest("[data-go]");
  if (go) {
    const href = go.getAttribute("data-go");
    if (location.hash === href) draw();
    else location.hash = href;
    return;
  }
  const act = event.target.closest("[data-act]");
  if (act && typeof actions[act.dataset.act] === "function") actions[act.dataset.act](act, event);
});
document.body.addEventListener("submit", (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || !form.dataset.form) return;
  event.preventDefault();
  if (typeof actions.submit === "function") actions.submit(form);
});
document.getElementById("scanClose").addEventListener("click", () => {
  scanOnCode = null;
  stopScan();
});
document.getElementById("scanShot").addEventListener("click", () => openCapture());
window.addEventListener("hashchange", draw);
window.addEventListener("load", () => {
  if (!location.hash) location.hash = "#/";
  else draw();
});
