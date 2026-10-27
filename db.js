"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { DatabaseSync } = require("node:sqlite");

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, 32).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return false;
  const next = crypto.scryptSync(String(password), salt, 32);
  const prev = Buffer.from(hash, "hex");
  if (next.length !== prev.length) return false;
  return crypto.timingSafeEqual(next, prev);
}

function futureStamp(days) {
  const d = new Date(Date.now() + days * 86400000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

class AppError extends Error {
  constructor(code, status = 400, extra = {}) {
    super(code);
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

function pad(n, w = 2) {
  return String(n).padStart(w, "0");
}

function nowStamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function roundQty(v) {
  const n = Number(String(v ?? "").trim().replace(",", "."));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 1000) / 1000;
}

function qtyText(n) {
  const x = Math.round(Number(n) * 1000) / 1000;
  return String(x);
}

function clip(v, n) {
  return String(v ?? "").trim().slice(0, n);
}

function opsOf(input) {
  const raw = clip(input?.operator, 40);
  return { raw, zh: raw || "现场", en: raw || "Shop" };
}

function namesOf(input) {
  let name = clip(input?.name, 80);
  let nameEn = clip(input?.name_en, 80);
  if (!name && nameEn) name = nameEn;
  if (!name) throw new AppError("name_required");
  return { name, name_en: nameEn };
}

function photoUrl(file) {
  return file ? `/uploads/${file}` : "";
}

class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.uploadDir = path.join(dataDir, "uploads");
    this.backupDir = path.join(dataDir, "backups");
    fs.mkdirSync(this.uploadDir, { recursive: true });
    fs.mkdirSync(this.backupDir, { recursive: true });
    this.openDb();
    this.migrate();
  }

  openDb() {
    this.db = new DatabaseSync(path.join(this.dataDir, "ruida.db"));
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA cache_size = -16000");
    this.db.exec("PRAGMA temp_store = MEMORY");
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS categories (
        id INTEGER PRIMARY KEY,
        code TEXT,
        name TEXT NOT NULL,
        name_en TEXT NOT NULL DEFAULT '',
        track_stock INTEGER NOT NULL DEFAULT 1,
        can_assemble INTEGER NOT NULL DEFAULT 0,
        can_consume INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS units (
        id INTEGER PRIMARY KEY,
        code TEXT,
        name TEXT NOT NULL,
        name_en TEXT NOT NULL DEFAULT '',
        sort_order INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS locations (
        id INTEGER PRIMARY KEY,
        code TEXT,
        parent_id INTEGER REFERENCES locations(id),
        name TEXT NOT NULL,
        name_en TEXT NOT NULL DEFAULT '',
        sort_order INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS source_types (
        id INTEGER PRIMARY KEY,
        code TEXT,
        name TEXT NOT NULL,
        name_en TEXT NOT NULL DEFAULT '',
        sort_order INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS purposes (
        id INTEGER PRIMARY KEY,
        code TEXT,
        name TEXT NOT NULL,
        name_en TEXT NOT NULL DEFAULT '',
        sort_order INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS items (
        id INTEGER PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        category_id INTEGER NOT NULL REFERENCES categories(id),
        unit_id INTEGER REFERENCES units(id),
        name TEXT NOT NULL,
        name_en TEXT NOT NULL DEFAULT '',
        spec TEXT NOT NULL DEFAULT '',
        remark TEXT NOT NULL DEFAULT '',
        photo TEXT NOT NULL DEFAULT '',
        supplier_name TEXT NOT NULL DEFAULT '',
        ref_price REAL,
        purchase_note TEXT NOT NULL DEFAULT '',
        default_location_id INTEGER REFERENCES locations(id),
        min_qty REAL,
        max_qty REAL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bom_lines (
        id INTEGER PRIMARY KEY,
        parent_item_id INTEGER NOT NULL REFERENCES items(id),
        component_item_id INTEGER NOT NULL REFERENCES items(id),
        qty_per REAL NOT NULL,
        UNIQUE(parent_item_id, component_item_id)
      );
      CREATE TABLE IF NOT EXISTS balances (
        item_id INTEGER NOT NULL REFERENCES items(id),
        location_id INTEGER NOT NULL REFERENCES locations(id),
        qty REAL NOT NULL,
        PRIMARY KEY (item_id, location_id)
      );
      CREATE TABLE IF NOT EXISTS documents (
        id INTEGER PRIMARY KEY,
        doc_no TEXT NOT NULL UNIQUE,
        doc_type TEXT NOT NULL,
        status TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        photo TEXT NOT NULL DEFAULT '',
        meta_json TEXT NOT NULL DEFAULT '{}',
        operator TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        voided_at TEXT,
        void_reason TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS document_lines (
        id INTEGER PRIMARY KEY,
        document_id INTEGER NOT NULL REFERENCES documents(id),
        item_id INTEGER NOT NULL REFERENCES items(id),
        location_id INTEGER NOT NULL REFERENCES locations(id),
        qty_delta REAL NOT NULL,
        unit_price REAL
      );
      CREATE TABLE IF NOT EXISTS movements (
        id INTEGER PRIMARY KEY,
        document_id INTEGER NOT NULL REFERENCES documents(id),
        item_id INTEGER NOT NULL REFERENCES items(id),
        location_id INTEGER NOT NULL REFERENCES locations(id),
        qty_delta REAL NOT NULL,
        effect TEXT NOT NULL DEFAULT 'post',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY,
        created_at TEXT NOT NULL,
        action TEXT NOT NULL,
        message_zh TEXT NOT NULL,
        message_en TEXT NOT NULL,
        doc_id INTEGER NOT NULL DEFAULT 0,
        item_id INTEGER NOT NULL DEFAULT 0,
        operator TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS sequences (
        name TEXT PRIMARY KEY,
        n INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'boss',
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_items_cat ON items(category_id);
      CREATE INDEX IF NOT EXISTS idx_items_code_nocase ON items(code COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS idx_moves_item ON movements(item_id);
      CREATE INDEX IF NOT EXISTS idx_moves_doc ON movements(document_id);
      CREATE INDEX IF NOT EXISTS idx_moves_loc ON movements(location_id);
      CREATE INDEX IF NOT EXISTS idx_logs_time ON logs(created_at);
      CREATE INDEX IF NOT EXISTS idx_logs_item ON logs(item_id, id);
      CREATE INDEX IF NOT EXISTS idx_balances_loc ON balances(location_id);
      CREATE INDEX IF NOT EXISTS idx_doc_lines_doc ON document_lines(document_id);
      CREATE INDEX IF NOT EXISTS idx_doc_lines_item ON document_lines(item_id);
      CREATE INDEX IF NOT EXISTS idx_doc_lines_loc ON document_lines(location_id);
      CREATE INDEX IF NOT EXISTS idx_bom_component ON bom_lines(component_item_id);
      CREATE INDEX IF NOT EXISTS idx_locations_parent ON locations(parent_id);
      CREATE INDEX IF NOT EXISTS idx_locations_code ON locations(code COLLATE NOCASE);
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS warehouses (
        id INTEGER PRIMARY KEY,
        code TEXT,
        name TEXT NOT NULL,
        name_en TEXT NOT NULL DEFAULT '',
        sort_order INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1
      );
    `);
    const cols = this.db.prepare("PRAGMA table_info(locations)").all();
    if (!cols.some((col) => col.name === "warehouse_id")) {
      this.db.exec("ALTER TABLE locations ADD COLUMN warehouse_id INTEGER");
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_locations_wh ON locations(warehouse_id)");
    const n = this.db.prepare("SELECT COUNT(*) AS n FROM categories").get().n;
    if (!n) this.seed();
    this.ensureWarehouseAnchor();
    this.db.prepare("UPDATE users SET role = 'boss' WHERE role <> 'boss'").run();
  }

  seed() {
    const cats = [
      ["product", "产品", "Product", 1, 0, 1],
      ["part", "零部件", "Component", 0, 1, 2],
      ["consumable", "低值易耗品", "Consumable", 0, 1, 3],
    ];
    const insCat = this.db.prepare(
      "INSERT INTO categories(code, name, name_en, can_assemble, can_consume, sort_order) VALUES(?,?,?,?,?,?)"
    );
    for (const row of cats) insCat.run(...row);

    const units = [
      ["pc", "个", "pc", 1],
      ["slice", "片", "slice", 2],
      ["ea", "颗", "ea", 3],
      ["box", "盒", "box", 4],
      ["set", "套", "set", 5],
    ];
    const insUnit = this.db.prepare(
      "INSERT INTO units(code, name, name_en, sort_order) VALUES(?,?,?,?)"
    );
    for (const row of units) insUnit.run(...row);

    this.db.prepare(
      "INSERT INTO warehouses(code, name, name_en, sort_order, active) VALUES('W0001', '主仓库', 'Main warehouse', 1, 1)"
    ).run();
    const warehouseId = this.db.prepare("SELECT id FROM warehouses WHERE code = 'W0001'").get().id;
    this.db.prepare(
      "INSERT INTO locations(code, warehouse_id, name, name_en, sort_order) VALUES('L0001', ?, '默认位置', 'Default location', 1)"
    ).run(warehouseId);
    this.db.prepare("INSERT INTO sequences(name, n) VALUES('item', 0), ('location', 1), ('warehouse', 1)").run();

    const sources = [
      ["purchase", "采购", "Purchase", 1],
      ["return", "退回", "Return", 2],
      ["gain", "盘盈", "Count gain", 3],
    ];
    const purposes = [
      ["issue", "领用", "Issue", 1],
      ["sale", "销售", "Sale", 2],
      ["scrap", "报废", "Scrap", 3],
    ];
    const insS = this.db.prepare(
      "INSERT INTO source_types(code, name, name_en, sort_order) VALUES(?,?,?,?)"
    );
    const insP = this.db.prepare(
      "INSERT INTO purposes(code, name, name_en, sort_order) VALUES(?,?,?,?)"
    );
    for (const row of sources) insS.run(...row);
    for (const row of purposes) insP.run(...row);

    const insSet = this.db.prepare("INSERT INTO settings(key, value) VALUES(?, ?)");
    insSet.run("allow_negative", "0");
    insSet.run("company_name", "");
    insSet.run("schema_version", "1");
  }

  tx(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch (_) {}
      throw err;
    }
  }

  nextSeq(name) {
    this.db.prepare(
      "INSERT INTO sequences(name, n) VALUES(?, 0) ON CONFLICT(name) DO NOTHING"
    ).run(name);
    this.db.prepare("UPDATE sequences SET n = n + 1 WHERE name = ?").run(name);
    return this.db.prepare("SELECT n FROM sequences WHERE name = ?").get(name).n;
  }

  setting(key, fallback = "") {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
    return row ? row.value : fallback;
  }

  allowNegative() {
    return this.setting("allow_negative", "0") === "1";
  }

  setSetting(key, value) {
    this.db.prepare(
      "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(key, value);
  }

  getSettings() {
    return {
      company_name: this.setting("company_name", ""),
      allow_negative: this.allowNegative(),
      backup_every: this.setting("backup_every", "off"),
      backup_time: this.setting("backup_time", "02:00"),
      backup_weekday: this.setting("backup_weekday", "1"),
    };
  }

  updateSettings(input, operator) {
    return this.tx(() => {
      const op = opsOf(operator ? { operator } : input);
      if (input.company_name != null) this.setSetting("company_name", clip(input.company_name, 40));
      if (input.allow_negative != null) this.setSetting("allow_negative", input.allow_negative ? "1" : "0");
      if (input.backup_every != null) {
        const every = ["off", "daily", "weekly"].includes(input.backup_every) ? input.backup_every : "off";
        this.setSetting("backup_every", every);
      }
      if (input.backup_time != null && /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(input.backup_time))) {
        this.setSetting("backup_time", String(input.backup_time));
      }
      if (input.backup_weekday != null && /^[0-6]$/.test(String(input.backup_weekday))) {
        this.setSetting("backup_weekday", String(input.backup_weekday));
      }
      this.insertLog({
        action: "config",
        message_zh: `${op.zh} 修改了系统设置`,
        message_en: `${op.en} updated system settings`,
        operator: op.raw,
      });
      return this.getSettings();
    });
  }

  insertLog(entry) {
    this.db.prepare(
      `INSERT INTO logs(created_at, action, message_zh, message_en, doc_id, item_id, operator)
       VALUES(?,?,?,?,?,?,?)`
    ).run(
      nowStamp(),
      entry.action,
      entry.message_zh,
      entry.message_en,
      entry.doc_id || 0,
      entry.item_id || 0,
      entry.operator || ""
    );
  }

  must(table, id) {
    const allowed = new Set([
      "categories",
      "units",
      "locations",
      "source_types",
      "purposes",
      "items",
      "documents",
      "warehouses",
    ]);
    if (!allowed.has(table)) throw new AppError("not_found", 404);
    const row = this.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
    if (!row) throw new AppError("not_found", 404);
    return row;
  }

  listCategories() {
    return this.db.prepare("SELECT * FROM categories ORDER BY sort_order, id").all();
  }

  saveCategory(id, input) {
    return this.tx(() => {
      const names = namesOf(input);
      const canAssemble = input.can_assemble ? 1 : 0;
      const canConsume = input.can_consume ? 1 : 0;
      const active = input.active === false || input.active === 0 ? 0 : 1;
      if (id) {
        const cur = this.must("categories", id);
        if (!active) this.assertCategoryFree(id);
        this.db.prepare(
          `UPDATE categories SET name=?, name_en=?, can_assemble=?, can_consume=?, active=? WHERE id=?`
        ).run(names.name, names.name_en, canAssemble, canConsume, active, id);
        const op = opsOf(input);
        this.insertLog({
          action: "config",
          message_zh: `${op.zh} 修改了分类 ${names.name}`,
          message_en: `${op.en} updated category ${names.name_en || names.name}`,
          operator: op.raw,
        });
        return this.must("categories", id);
      }
      const sort = this.db.prepare("SELECT COALESCE(MAX(sort_order),0) AS m FROM categories").get().m + 1;
      const info = this.db.prepare(
        `INSERT INTO categories(name, name_en, can_assemble, can_consume, sort_order, active)
         VALUES(?,?,?,?,?,1)`
      ).run(names.name, names.name_en, canAssemble, canConsume, sort);
      const newId = Number(info.lastInsertRowid);
      const op = opsOf(input);
      this.insertLog({
        action: "config",
        message_zh: `${op.zh} 新增了分类 ${names.name}`,
        message_en: `${op.en} added category ${names.name_en || names.name}`,
        operator: op.raw,
      });
      return this.must("categories", newId);
    });
  }

  listSimple(table) {
    if (!["units", "source_types", "purposes"].includes(table)) throw new AppError("not_found", 404);
    return this.db.prepare(`SELECT * FROM ${table} ORDER BY sort_order, id`).all();
  }

  saveSimple(table, id, input) {
    if (!["units", "source_types", "purposes"].includes(table)) throw new AppError("not_found", 404);
    return this.tx(() => {
      const names = namesOf(input);
      const active = input.active === false || input.active === 0 ? 0 : 1;
      const label = table === "units" ? "单位" : table === "source_types" ? "来处类型" : "出库用途";
      const labelEn = table === "units" ? "unit" : table === "source_types" ? "source type" : "purpose";
      const op = opsOf(input);
      if (id) {
        this.must(table, id);
        this.db.prepare(`UPDATE ${table} SET name=?, name_en=?, active=? WHERE id=?`).run(
          names.name,
          names.name_en,
          active,
          id
        );
        this.insertLog({
          action: "config",
          message_zh: `${op.zh} 修改了${label} ${names.name}`,
          message_en: `${op.en} updated ${labelEn} ${names.name_en || names.name}`,
          operator: op.raw,
        });
        return this.must(table, id);
      }
      const sort = this.db.prepare(`SELECT COALESCE(MAX(sort_order),0) AS m FROM ${table}`).get().m + 1;
      const info = this.db.prepare(
        `INSERT INTO ${table}(name, name_en, sort_order, active) VALUES(?,?,?,1)`
      ).run(names.name, names.name_en, sort);
      const newId = Number(info.lastInsertRowid);
      this.insertLog({
        action: "config",
        message_zh: `${op.zh} 新增了${label} ${names.name}`,
        message_en: `${op.en} added ${labelEn} ${names.name_en || names.name}`,
        operator: op.raw,
      });
      return this.must(table, newId);
    });
  }

  listLocations() {
    return this.db.prepare(
      `SELECT l.*, w.name AS warehouse_name, w.name_en AS warehouse_name_en
       FROM locations l LEFT JOIN warehouses w ON w.id = l.warehouse_id
       ORDER BY w.sort_order, w.id, l.sort_order, l.id`
    ).all();
  }

  listWarehouses() {
    return this.db.prepare("SELECT * FROM warehouses ORDER BY sort_order, id").all();
  }

  ensureWarehouseAnchor() {
    const orphan = this.db.prepare("SELECT COUNT(*) AS n FROM locations WHERE warehouse_id IS NULL").get().n;
    let row = this.db.prepare("SELECT id FROM warehouses ORDER BY id LIMIT 1").get();
    if (!row && orphan) {
      this.db.prepare(
        "INSERT INTO warehouses(code, name, name_en, sort_order, active) VALUES('W0001', '主仓库', 'Main warehouse', 1, 1)"
      ).run();
      this.db.prepare(
        "INSERT INTO sequences(name, n) VALUES('warehouse', 1) ON CONFLICT(name) DO NOTHING"
      ).run();
      row = this.db.prepare("SELECT id FROM warehouses ORDER BY id LIMIT 1").get();
    }
    if (row && orphan) this.db.prepare("UPDATE locations SET warehouse_id = ? WHERE warehouse_id IS NULL").run(row.id);
  }

  assertCategoryFree(id) {
    const used = this.db.prepare("SELECT COUNT(*) AS n FROM items WHERE category_id = ?").get(id).n;
    if (used) throw new AppError("category_in_use");
  }

  assertSimpleFree(table, id) {
    if (table === "units") {
      const used = this.db.prepare("SELECT COUNT(*) AS n FROM items WHERE unit_id = ?").get(id).n;
      if (used) throw new AppError("unit_in_use");
      return;
    }
    const key = table === "source_types" ? "source_type_id" : "purpose_id";
    const code = table === "source_types" ? "source_in_use" : "purpose_in_use";
    const used = this.db.prepare(
      `SELECT COUNT(*) AS n FROM documents WHERE json_extract(meta_json, '$.${key}') = ?`
    ).get(id).n;
    if (used) throw new AppError(code);
  }

  assertLocationFree(id) {
    const kids = this.db.prepare("SELECT COUNT(*) AS n FROM locations WHERE parent_id = ?").get(id).n;
    if (kids) throw new AppError("has_children");
    const qty = this.db.prepare("SELECT COALESCE(SUM(qty),0) AS n FROM balances WHERE location_id = ?").get(id).n;
    if (qty) throw new AppError("has_stock");
    const docs = this.db.prepare(
      "SELECT COUNT(*) AS n FROM document_lines WHERE location_id = ?"
    ).get(id).n;
    const moves = this.db.prepare(
      "SELECT COUNT(*) AS n FROM movements WHERE location_id = ?"
    ).get(id).n;
    if (docs || moves) throw new AppError("location_used");
    const defaults = this.db.prepare(
      "SELECT COUNT(*) AS n FROM items WHERE default_location_id = ?"
    ).get(id).n;
    if (defaults) throw new AppError("location_default");
  }

  deleteCategory(id, operator) {
    return this.tx(() => {
      const row = this.must("categories", id);
      this.assertCategoryFree(id);
      this.db.prepare("DELETE FROM categories WHERE id = ?").run(id);
      const op = opsOf({ operator });
      this.insertLog({
        action: "config",
        message_zh: `${op.zh} 删除了分类 ${row.name}`,
        message_en: `${op.en} deleted category ${row.name_en || row.name}`,
        operator: op.raw,
      });
      return { ok: true };
    });
  }

  deleteSimple(table, id, operator) {
    if (!["units", "source_types", "purposes"].includes(table)) throw new AppError("not_found", 404);
    return this.tx(() => {
      const row = this.must(table, id);
      this.assertSimpleFree(table, id);
      const label = table === "units" ? "单位" : table === "source_types" ? "来处类型" : "出库用途";
      const labelEn = table === "units" ? "unit" : table === "source_types" ? "source type" : "purpose";
      this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
      const op = opsOf({ operator });
      this.insertLog({
        action: "config",
        message_zh: `${op.zh} 删除了${label} ${row.name}`,
        message_en: `${op.en} deleted ${labelEn} ${row.name_en || row.name}`,
        operator: op.raw,
      });
      return { ok: true };
    });
  }

  deleteLocation(id, operator) {
    return this.tx(() => {
      const row = this.must("locations", id);
      this.assertLocationFree(id);
      this.db.prepare("DELETE FROM balances WHERE location_id = ?").run(id);
      this.db.prepare("DELETE FROM locations WHERE id = ?").run(id);
      const op = opsOf({ operator });
      this.insertLog({
        action: "config",
        message_zh: `${op.zh} 删除了位置 ${row.name}`,
        message_en: `${op.en} deleted location ${row.name_en || row.name}`,
        operator: op.raw,
      });
      return { ok: true };
    });
  }

  deleteWarehouse(id, operator) {
    return this.tx(() => {
      const row = this.must("warehouses", id);
      const locs = this.db.prepare("SELECT COUNT(*) AS n FROM locations WHERE warehouse_id = ?").get(id).n;
      if (locs) throw new AppError("warehouse_has_locations");
      this.db.prepare("DELETE FROM warehouses WHERE id = ?").run(id);
      const op = opsOf({ operator });
      this.insertLog({
        action: "config",
        message_zh: `${op.zh} 删除了仓库 ${row.name}`,
        message_en: `${op.en} deleted warehouse ${row.name_en || row.name}`,
        operator: op.raw,
      });
      return { ok: true };
    });
  }

  removePhoto(file) {
    if (!file || !/^[\w.-]+$/.test(file)) return;
    const full = path.join(this.uploadDir, file);
    if (fs.existsSync(full)) fs.unlinkSync(full);
  }

  deleteItem(id, operator) {
    const photo = this.tx(() => {
      const row = this.must("items", id);
      const qty = this.db.prepare(
        "SELECT COALESCE(SUM(ABS(qty)), 0) AS n FROM balances WHERE item_id = ?"
      ).get(id).n;
      if (qty > 1e-9) throw new AppError("item_has_stock");
      const docs = this.db.prepare("SELECT COUNT(*) AS n FROM document_lines WHERE item_id = ?").get(id).n;
      const moves = this.db.prepare("SELECT COUNT(*) AS n FROM movements WHERE item_id = ?").get(id).n;
      if (docs || moves) throw new AppError("item_used");
      const used = this.db.prepare(
        "SELECT COUNT(*) AS n FROM bom_lines WHERE component_item_id = ?"
      ).get(id).n;
      if (used) throw new AppError("item_in_bom");
      this.db.prepare("DELETE FROM bom_lines WHERE parent_item_id = ?").run(id);
      this.db.prepare("DELETE FROM balances WHERE item_id = ?").run(id);
      this.db.prepare("DELETE FROM items WHERE id = ?").run(id);
      const op = opsOf({ operator });
      this.insertLog({
        action: "item",
        message_zh: `${op.zh} 删除了货品 ${row.name}`,
        message_en: `${op.en} deleted item ${row.name_en || row.name}`,
        operator: op.raw,
      });
      return row.photo;
    });
    this.removePhoto(photo);
    return { ok: true };
  }

  placeText(loc) {
    const wh = loc.warehouse_id
      ? this.db.prepare("SELECT name, name_en FROM warehouses WHERE id = ?").get(loc.warehouse_id)
      : null;
    if (!wh) return { zh: loc.name, en: loc.name_en || loc.name };
    return {
      zh: `${wh.name} / ${loc.name}`,
      en: `${wh.name_en || wh.name} / ${loc.name_en || loc.name}`,
    };
  }

  saveWarehouse(id, input) {
    return this.tx(() => {
      const names = namesOf(input);
      const active = input.active === false || input.active === 0 ? 0 : 1;
      const op = opsOf(input);
      if (id) {
        this.must("warehouses", id);
        if (!active) {
          const qty = this.db.prepare(
            `SELECT COALESCE(SUM(b.qty),0) AS n FROM balances b
             JOIN locations l ON l.id = b.location_id WHERE l.warehouse_id = ?`
          ).get(id).n;
          if (qty) throw new AppError("has_stock");
        }
        this.db.prepare("UPDATE warehouses SET name=?, name_en=?, active=? WHERE id=?").run(names.name, names.name_en, active, id);
        this.insertLog({
          action: "config",
          message_zh: `${op.zh} 修改了仓库 ${names.name}`,
          message_en: `${op.en} updated warehouse ${names.name_en || names.name}`,
          operator: op.raw,
        });
        return this.must("warehouses", id);
      }
      const code = `W${pad(this.nextSeq("warehouse"), 4)}`;
      const sort = this.db.prepare("SELECT COALESCE(MAX(sort_order),0) AS m FROM warehouses").get().m + 1;
      const info = this.db.prepare(
        "INSERT INTO warehouses(code, name, name_en, sort_order, active) VALUES(?,?,?,?,1)"
      ).run(code, names.name, names.name_en, sort);
      const warehouseId = Number(info.lastInsertRowid);
      const locCode = `L${pad(this.nextSeq("location"), 4)}`;
      this.db.prepare(
        "INSERT INTO locations(code, warehouse_id, name, name_en, sort_order, active) VALUES(?,?,?,?,?,1)"
      ).run(locCode, warehouseId, "默认位置", "Default location", 1);
      this.insertLog({
        action: "config",
        message_zh: `${op.zh} 新增了仓库 ${names.name}`,
        message_en: `${op.en} added warehouse ${names.name_en || names.name}`,
        operator: op.raw,
      });
      return this.must("warehouses", warehouseId);
    });
  }

  locationCycle(id, parentId) {
    let cur = parentId;
    const guard = new Set();
    while (cur) {
      if (id && cur === id) return true;
      if (guard.has(cur)) return true;
      guard.add(cur);
      const row = this.db.prepare("SELECT parent_id FROM locations WHERE id = ?").get(cur);
      if (!row) throw new AppError("not_found", 404);
      cur = row.parent_id;
    }
    return false;
  }

  saveLocation(id, input) {
    return this.tx(() => {
      const names = namesOf(input);
      const parentId = input.parent_id ? Number(input.parent_id) : null;
      const active = input.active === false || input.active === 0 ? 0 : 1;
      if (parentId && this.locationCycle(id || 0, parentId)) throw new AppError("bom_cycle");
      if (id && parentId === id) throw new AppError("bom_cycle");
      const op = opsOf(input);
      let warehouseId = input.warehouse_id ? Number(input.warehouse_id) : null;
      if (id) {
        warehouseId = this.must("locations", id).warehouse_id;
      }
      if (parentId) {
        const parent = this.must("locations", parentId);
        if (warehouseId && parent.warehouse_id && Number(parent.warehouse_id) !== Number(warehouseId)) {
          throw new AppError("bad_warehouse");
        }
        warehouseId = parent.warehouse_id || warehouseId;
      }
      if (!warehouseId) throw new AppError("warehouse_required");
      this.ensureActive("warehouses", Number(warehouseId));
      if (id) {
        this.must("locations", id);
        if (!active) {
          const qty = this.db.prepare(
            "SELECT COALESCE(SUM(qty),0) AS n FROM balances WHERE location_id = ?"
          ).get(id).n;
          if (qty) throw new AppError("has_stock");
          const kids = this.db.prepare(
            "SELECT COUNT(*) AS n FROM locations WHERE parent_id = ? AND active = 1"
          ).get(id).n;
          if (kids) throw new AppError("has_children");
        }
        this.db.prepare(
          "UPDATE locations SET name=?, name_en=?, parent_id=?, active=? WHERE id=?"
        ).run(names.name, names.name_en, parentId, active, id);
        this.insertLog({
          action: "config",
          message_zh: `${op.zh} 修改了位置 ${names.name}`,
          message_en: `${op.en} updated location ${names.name_en || names.name}`,
          operator: op.raw,
        });
        return this.must("locations", id);
      }
      const code = `L${pad(this.nextSeq("location"), 4)}`;
      const sort = this.db.prepare("SELECT COALESCE(MAX(sort_order),0) AS m FROM locations").get().m + 1;
      const info = this.db.prepare(
        "INSERT INTO locations(code, warehouse_id, parent_id, name, name_en, sort_order, active) VALUES(?,?,?,?,?,?,1)"
      ).run(code, warehouseId, parentId, names.name, names.name_en, sort);
      const newId = Number(info.lastInsertRowid);
      this.insertLog({
        action: "config",
        message_zh: `${op.zh} 新增了位置 ${names.name}`,
        message_en: `${op.en} added location ${names.name_en || names.name}`,
        operator: op.raw,
      });
      return this.must("locations", newId);
    });
  }

  optionalQty(v) {
    if (v == null || v === "") return null;
    const n = roundQty(v);
    if (n == null || n < 0) throw new AppError("qty_invalid");
    return n;
  }

  positiveQty(v) {
    const n = roundQty(v);
    if (n == null || n <= 0 || n > 1e9) throw new AppError("qty_invalid");
    return n;
  }

  priceOf(v) {
    if (v == null || v === "") return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 1e9) throw new AppError("bad_price");
    return Math.round(n * 10000) / 10000;
  }

  savePhoto(dataUrl) {
    const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=\r\n]+)$/i.exec(String(dataUrl || ""));
    if (!m) throw new AppError("bad_photo");
    const buf = Buffer.from(m[2], "base64");
    if (!buf.length || buf.length > 2_000_000) throw new AppError("photo_too_large");
    const ext = m[1].toLowerCase() === "jpeg" ? "jpg" : m[1].toLowerCase();
    const name = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}.${ext}`;
    fs.writeFileSync(path.join(this.uploadDir, name), buf);
    return name;
  }

  presentItem(row, total) {
    if (!row) return null;
    const qty = total == null ? this.totalQty(row.id) : total;
    let level = "";
    if (row.min_qty != null && qty < row.min_qty - 1e-9) level = "low";
    else if (row.max_qty != null && qty > row.max_qty + 1e-9) level = "high";
    return {
      id: row.id,
      code: row.code,
      category_id: row.category_id,
      unit_id: row.unit_id,
      name: row.name,
      name_en: row.name_en,
      spec: row.spec,
      remark: row.remark,
      photo_url: photoUrl(row.photo),
      supplier_name: row.supplier_name,
      ref_price: row.ref_price,
      purchase_note: row.purchase_note,
      default_location_id: row.default_location_id,
      min_qty: row.min_qty,
      max_qty: row.max_qty,
      active: !!row.active,
      total_qty: qty,
      level,
      can_assemble: !!row.can_assemble,
      can_consume: !!row.can_consume,
      unit: row.unit || "",
      unit_en: row.unit_en || "",
      category_code: row.category_code || "",
      category_name: row.category_name || "",
      category_name_en: row.category_name_en || "",
    };
  }

  totalQty(itemId) {
    return this.db.prepare(
      "SELECT COALESCE(SUM(qty),0) AS n FROM balances WHERE item_id = ?"
    ).get(itemId).n;
  }

  itemSelect(extraSelect = "") {
    return `
      SELECT i.*, c.can_assemble, c.can_consume, c.code AS category_code, c.name AS category_name, c.name_en AS category_name_en,
             u.name AS unit, u.name_en AS unit_en${extraSelect}
      FROM items i
      JOIN categories c ON c.id = i.category_id
      LEFT JOIN units u ON u.id = i.unit_id
    `;
  }

  listItems({ q = "", categoryId = 0, consumableOnly = false } = {}) {
    const where = ["i.active = 1"];
    const params = [];
    if (categoryId) {
      where.push("i.category_id = ?");
      params.push(categoryId);
    }
    if (consumableOnly) where.push("c.can_consume = 1");
    if (q) {
      const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
      where.push(
        "(i.name LIKE ? ESCAPE '\\' OR i.name_en LIKE ? ESCAPE '\\' OR i.code LIKE ? ESCAPE '\\' OR i.spec LIKE ? ESCAPE '\\')"
      );
      params.push(like, like, like, like);
    }
    const rows = this.db.prepare(
      `${this.itemSelect(", COALESCE((SELECT SUM(qty) FROM balances b WHERE b.item_id = i.id), 0) AS total_qty")} WHERE ${where.join(" AND ")} ORDER BY i.id DESC LIMIT 500`
    ).all(...params);
    return rows.map((row) => this.presentItem(row, row.total_qty));
  }

  balancesOf(itemId) {
    return this.db.prepare(
      `SELECT b.location_id, b.qty, l.name, l.name_en, l.code, l.active, l.warehouse_id,
              w.name AS warehouse_name, w.name_en AS warehouse_name_en
       FROM balances b JOIN locations l ON l.id = b.location_id
       LEFT JOIN warehouses w ON w.id = l.warehouse_id
       WHERE b.item_id = ? ORDER BY w.sort_order, l.sort_order, l.id`
    ).all(itemId);
  }

  balancesFor(itemIds) {
    const grouped = new Map();
    if (!itemIds.length) return grouped;
    const marks = itemIds.map(() => "?").join(",");
    const rows = this.db.prepare(
      `SELECT b.item_id, b.location_id, b.qty, l.name, l.name_en, l.code, l.active, l.warehouse_id,
              w.name AS warehouse_name, w.name_en AS warehouse_name_en
       FROM balances b JOIN locations l ON l.id = b.location_id
       LEFT JOIN warehouses w ON w.id = l.warehouse_id
       WHERE b.item_id IN (${marks})
       ORDER BY b.item_id, w.sort_order, l.sort_order, l.id`
    ).all(...itemIds);
    for (const row of rows) {
      let list = grouped.get(row.item_id);
      if (!list) {
        list = [];
        grouped.set(row.item_id, list);
      }
      list.push({
        location_id: row.location_id,
        qty: row.qty,
        name: row.name,
        name_en: row.name_en,
        code: row.code,
        active: row.active,
        warehouse_id: row.warehouse_id,
        warehouse_name: row.warehouse_name,
        warehouse_name_en: row.warehouse_name_en,
      });
    }
    return grouped;
  }

  totalsFor(itemIds) {
    const grouped = new Map();
    if (!itemIds.length) return grouped;
    const marks = itemIds.map(() => "?").join(",");
    const rows = this.db.prepare(
      `SELECT item_id, COALESCE(SUM(qty), 0) AS n FROM balances WHERE item_id IN (${marks}) GROUP BY item_id`
    ).all(...itemIds);
    for (const row of rows) grouped.set(row.item_id, row.n);
    return grouped;
  }

  getItem(id) {
    const row = this.db.prepare(`${this.itemSelect()} WHERE i.id = ?`).get(id);
    if (!row) return null;
    const item = this.presentItem(row);
    item.balances = this.balancesOf(id);
    const lines = this.db.prepare(
      `SELECT b.component_item_id, b.qty_per, i.name, i.name_en, i.code, i.default_location_id,
              c.can_consume, u.name AS unit, u.name_en AS unit_en
       FROM bom_lines b
       JOIN items i ON i.id = b.component_item_id
       JOIN categories c ON c.id = i.category_id
       LEFT JOIN units u ON u.id = i.unit_id
       WHERE b.parent_item_id = ?
       ORDER BY b.id`
    ).all(id);
    const componentIds = lines.map((line) => line.component_item_id);
    const totals = this.totalsFor(componentIds);
    const grouped = this.balancesFor(componentIds);
    item.bom = lines.map((line) => ({
      ...line,
      balances: grouped.get(line.component_item_id) || [],
      total_qty: totals.has(line.component_item_id) ? totals.get(line.component_item_id) : 0,
    }));
    item.activity = this.db.prepare(
      `SELECT m.qty_delta, m.created_at, m.effect, m.location_id, d.id AS doc_id, d.doc_no, d.doc_type, d.status,
              l.name, l.name_en
       FROM movements m
       JOIN documents d ON d.id = m.document_id
       JOIN locations l ON l.id = m.location_id
       WHERE m.item_id = ?
       ORDER BY m.id DESC LIMIT 12`
    ).all(id);
    return item;
  }

  ensureActive(table, id, label) {
    const row = this.must(table, id);
    if (!row.active) throw new AppError("inactive", 400, { name: row.name, name_en: row.name_en });
    return row;
  }

  saveItem(id, input) {
    let photoChange;
    if (input.photo_base64 === null) photoChange = "";
    else if (typeof input.photo_base64 === "string" && input.photo_base64) {
      photoChange = this.savePhoto(input.photo_base64);
    }
    return this.tx(() => {
      const names = namesOf(input);
      const category = this.ensureActive("categories", Number(input.category_id));
      let unitId = input.unit_id ? Number(input.unit_id) : null;
      if (unitId) this.ensureActive("units", unitId);
      let locId = input.default_location_id ? Number(input.default_location_id) : null;
      if (locId) this.ensureActive("locations", locId);
      const minQty = this.optionalQty(input.min_qty);
      const maxQty = this.optionalQty(input.max_qty);
      if (minQty != null && maxQty != null && maxQty < minQty) throw new AppError("bad_threshold");
      const spec = clip(input.spec, 120);
      const remark = clip(input.remark, 500);
      const sentSupplier = Object.prototype.hasOwnProperty.call(input, "supplier_name");
      const sentPurchase = Object.prototype.hasOwnProperty.call(input, "purchase_note");
      const supplier = sentSupplier ? clip(input.supplier_name, 80) : "";
      const purchase = sentPurchase ? clip(input.purchase_note, 500) : "";
      const sentPrice = Object.prototype.hasOwnProperty.call(input, "ref_price");
      const price = sentPrice ? this.priceOf(input.ref_price) : null;
      const active = input.active === false || input.active === 0 ? 0 : 1;
      const op = opsOf(input);
      const stamp = nowStamp();
      if (id) {
        const cur = this.must("items", id);
        const photo = photoChange == null ? cur.photo : photoChange;
        const keptPrice = sentPrice ? price : cur.ref_price;
        const keptSupplier = sentSupplier ? supplier : cur.supplier_name;
        const keptPurchase = sentPurchase ? purchase : cur.purchase_note;
        this.db.prepare(
          `UPDATE items SET category_id=?, unit_id=?, name=?, name_en=?, spec=?, remark=?, photo=?,
             supplier_name=?, ref_price=?, purchase_note=?, default_location_id=?, min_qty=?, max_qty=?,
             active=?, updated_at=? WHERE id=?`
        ).run(
          category.id, unitId, names.name, names.name_en, spec, remark, photo,
          keptSupplier, keptPrice, keptPurchase, locId, minQty, maxQty, active, stamp, id
        );
        this.insertLog({
          action: "item",
          message_zh: `${op.zh} 修改了货品 ${names.name}`,
          message_en: `${op.en} updated item ${names.name_en || names.name}`,
          item_id: id,
          operator: op.raw,
        });
        return this.getItem(id);
      }
      const code = `A${pad(this.nextSeq("item"), 4)}`;
      const info = this.db.prepare(
        `INSERT INTO items(code, category_id, unit_id, name, name_en, spec, remark, photo, supplier_name,
           ref_price, purchase_note, default_location_id, min_qty, max_qty, active, created_at, updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`
      ).run(
        code, category.id, unitId, names.name, names.name_en, spec, remark, photoChange || "",
        supplier, price, purchase, locId, minQty, maxQty, stamp, stamp
      );
      const newId = Number(info.lastInsertRowid);
      this.insertLog({
        action: "item",
        message_zh: `${op.zh} 新建货品 ${names.name}`,
        message_en: `${op.en} created item ${names.name_en || names.name}`,
        item_id: newId,
        operator: op.raw,
      });
      return this.getItem(newId);
    });
  }

  bomCycle(parentId, componentIds) {
    const edges = new Map();
    for (const row of this.db.prepare("SELECT parent_item_id, component_item_id FROM bom_lines").all()) {
      if (row.parent_item_id === parentId) continue;
      if (!edges.has(row.parent_item_id)) edges.set(row.parent_item_id, []);
      edges.get(row.parent_item_id).push(row.component_item_id);
    }
    edges.set(parentId, componentIds);
    const visiting = new Set();
    const visited = new Set();
    const dfs = (node) => {
      if (visiting.has(node)) return true;
      if (visited.has(node)) return false;
      visiting.add(node);
      for (const next of edges.get(node) || []) {
        if (dfs(next)) return true;
      }
      visiting.delete(node);
      visited.add(node);
      return false;
    };
    return dfs(parentId);
  }

  saveBom(parentId, input) {
    return this.tx(() => {
      const parent = this.must("items", parentId);
      const merged = new Map();
      for (const line of input.lines || []) {
        const cid = Number(line.component_item_id);
        const qty = this.positiveQty(line.qty_per);
        if (!cid || cid === parentId) throw new AppError("bom_cycle");
        merged.set(cid, qty);
      }
      const ids = [...merged.keys()];
      for (const cid of ids) {
        const comp = this.must("items", cid);
        const ccat = this.must("categories", comp.category_id);
        if (!ccat.can_consume) {
          throw new AppError("cannot_consume", 400, { name: comp.name, name_en: comp.name_en });
        }
      }
      if (this.bomCycle(parentId, ids)) throw new AppError("bom_cycle");
      this.db.prepare("DELETE FROM bom_lines WHERE parent_item_id = ?").run(parentId);
      const ins = this.db.prepare(
        "INSERT INTO bom_lines(parent_item_id, component_item_id, qty_per) VALUES(?,?,?)"
      );
      for (const [cid, qty] of merged) ins.run(parentId, cid, qty);
      const op = opsOf(input);
      this.insertLog({
        action: "bom",
        message_zh: `${op.zh} 更新了 ${parent.name} 的用料`,
        message_en: `${op.en} updated the recipe for ${parent.name_en || parent.name}`,
        item_id: parentId,
        operator: op.raw,
      });
      return this.getItem(parentId);
    });
  }

  qtyAt(itemId, locationId) {
    const row = this.db.prepare(
      "SELECT qty FROM balances WHERE item_id = ? AND location_id = ?"
    ).get(itemId, locationId);
    return row ? row.qty : 0;
  }

  apply(itemId, locationId, delta) {
    const next = Math.round((this.qtyAt(itemId, locationId) + delta) * 1000) / 1000;
    if (Math.abs(next) < 0.0005) {
      this.db.prepare("DELETE FROM balances WHERE item_id = ? AND location_id = ?").run(itemId, locationId);
      return;
    }
    this.db.prepare(
      `INSERT INTO balances(item_id, location_id, qty) VALUES(?,?,?)
       ON CONFLICT(item_id, location_id) DO UPDATE SET qty = excluded.qty`
    ).run(itemId, locationId, next);
  }

  assertEnough(plan) {
    if (this.allowNegative()) return;
    const shortages = [];
    for (const line of plan) {
      if (line.delta >= -1e-9) continue;
      const have = this.qtyAt(line.item_id, line.location_id);
      if (have + line.delta < -1e-9) {
        const item = this.must("items", line.item_id);
        const loc = this.must("locations", line.location_id);
        shortages.push({
          item_id: item.id,
          name: item.name,
          name_en: item.name_en,
          location_id: loc.id,
          location_name: loc.name,
          location_name_en: loc.name_en,
          have,
          need: Math.abs(line.delta),
        });
      }
    }
    if (shortages.length) throw new AppError("insufficient", 409, { lines: shortages });
  }

  writeDoc({ type, note, photo, meta, operator, lines }) {
    const docNo = this.nextDocNo(type);
    const stamp = nowStamp();
    const info = this.db.prepare(
      `INSERT INTO documents(doc_no, doc_type, status, note, photo, meta_json, operator, created_at)
       VALUES(?,?, 'posted', ?, ?, ?, ?, ?)`
    ).run(docNo, type, note || "", photo || "", JSON.stringify(meta || {}), operator || "", stamp);
    const docId = Number(info.lastInsertRowid);
    const insL = this.db.prepare(
      "INSERT INTO document_lines(document_id, item_id, location_id, qty_delta, unit_price) VALUES(?,?,?,?,?)"
    );
    const insM = this.db.prepare(
      "INSERT INTO movements(document_id, item_id, location_id, qty_delta, effect, created_at) VALUES(?,?,?,?, 'post', ?)"
    );
    for (const line of lines) {
      insL.run(docId, line.item_id, line.location_id, line.delta, line.unit_price ?? null);
      insM.run(docId, line.item_id, line.location_id, line.delta, stamp);
      this.apply(line.item_id, line.location_id, line.delta);
    }
    return { id: docId, doc_no: docNo };
  }

  nextDocNo(type) {
    const prefix = { in: "RK", out: "CK", asm: "ZZ", move: "YK", count: "PD" }[type];
    const d = new Date();
    const day = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
    const n = this.nextSeq(prefix + day);
    return `${prefix}-${day}-${pad(n, 3)}`;
  }

  postInbound(input) {
    let photo = "";
    if (input.photo_base64) photo = this.savePhoto(input.photo_base64);
    return this.tx(() => {
      const item = this.ensureActive("items", Number(input.item_id));
      const loc = this.ensureActive("locations", Number(input.location_id));
      if (input.warehouse_id && Number(input.warehouse_id) !== Number(loc.warehouse_id)) throw new AppError("bad_warehouse");
      const qty = this.positiveQty(input.qty);
      const source = input.source_type_id ? this.ensureActive("source_types", Number(input.source_type_id)) : null;
      const sourceName = clip(input.source_name, 80);
      const price = this.priceOf(input.unit_price);
      const note = clip(input.note, 500);
      const op = opsOf(input);
      const plan = [{ item_id: item.id, location_id: loc.id, delta: qty, unit_price: price }];
      const doc = this.writeDoc({
        type: "in",
        note,
        photo,
        operator: op.raw,
        meta: { source_type_id: source ? source.id : null, source_name: sourceName, unit_price: price },
        lines: plan,
      });
      const place = this.placeText(loc);
      let zh = `${op.zh} 入库 ${item.name} +${qtyText(qty)} 到 ${place.zh}`;
      let en = `${op.en} stocked in ${item.name_en || item.name} +${qtyText(qty)} to ${place.en}`;
      if (sourceName) {
        zh += `，来自 ${sourceName}`;
        en += `, from ${sourceName}`;
      }
      this.insertLog({
        action: "in",
        message_zh: zh,
        message_en: en,
        doc_id: doc.id,
        item_id: item.id,
        operator: op.raw,
      });
      return this.getDocument(doc.id);
    });
  }

  postOutbound(input) {
    let photo = "";
    if (input.photo_base64) photo = this.savePhoto(input.photo_base64);
    return this.tx(() => {
      const item = this.ensureActive("items", Number(input.item_id));
      const loc = this.ensureActive("locations", Number(input.location_id));
      if (input.warehouse_id && Number(input.warehouse_id) !== Number(loc.warehouse_id)) throw new AppError("bad_warehouse");
      const qty = this.positiveQty(input.qty);
      const purpose = input.purpose_id ? this.ensureActive("purposes", Number(input.purpose_id)) : null;
      const dest = clip(input.dest_name, 80);
      const note = clip(input.note, 500);
      const op = opsOf(input);
      const plan = [{ item_id: item.id, location_id: loc.id, delta: -qty }];
      this.assertEnough(plan);
      const doc = this.writeDoc({
        type: "out",
        note,
        photo,
        operator: op.raw,
        meta: { purpose_id: purpose ? purpose.id : null, dest_name: dest },
        lines: plan,
      });
      const place = this.placeText(loc);
      let zh = `${op.zh} 出库 ${item.name} -${qtyText(qty)} 从 ${place.zh}`;
      let en = `${op.en} stocked out ${item.name_en || item.name} -${qtyText(qty)} from ${place.en}`;
      if (purpose) {
        zh += `，用途 ${purpose.name}`;
        en += `, for ${purpose.name_en || purpose.name}`;
      }
      if (dest) {
        zh += `，去向 ${dest}`;
        en += `, to ${dest}`;
      }
      this.insertLog({
        action: "out",
        message_zh: zh,
        message_en: en,
        doc_id: doc.id,
        item_id: item.id,
        operator: op.raw,
      });
      return this.getDocument(doc.id);
    });
  }

  postMove(input) {
    return this.tx(() => {
      const item = this.ensureActive("items", Number(input.item_id));
      const from = this.ensureActive("locations", Number(input.from_location_id));
      const to = this.ensureActive("locations", Number(input.to_location_id));
      if (from.id === to.id) throw new AppError("same_location");
      const qty = this.positiveQty(input.qty);
      const op = opsOf(input);
      const plan = [
        { item_id: item.id, location_id: from.id, delta: -qty },
        { item_id: item.id, location_id: to.id, delta: qty },
      ];
      this.assertEnough(plan);
      const doc = this.writeDoc({
        type: "move",
        note: clip(input.note, 500),
        operator: op.raw,
        meta: {},
        lines: plan,
      });
      this.insertLog({
        action: "move",
        message_zh: `${op.zh} 移库 ${item.name} ${qtyText(qty)}，从 ${this.placeText(from).zh} 到 ${this.placeText(to).zh}`,
        message_en: `${op.en} moved ${item.name_en || item.name} ${qtyText(qty)} from ${this.placeText(from).en} to ${this.placeText(to).en}`,
        doc_id: doc.id,
        item_id: item.id,
        operator: op.raw,
      });
      return this.getDocument(doc.id);
    });
  }

  postCount(input) {
    return this.tx(() => {
      const item = this.ensureActive("items", Number(input.item_id));
      const loc = this.ensureActive("locations", Number(input.location_id));
      const actual = this.optionalQty(input.actual_qty);
      if (actual == null) throw new AppError("qty_invalid");
      const before = this.qtyAt(item.id, loc.id);
      const delta = Math.round((actual - before) * 1000) / 1000;
      if (Math.abs(delta) < 0.0005) throw new AppError("no_change");
      const op = opsOf(input);
      const plan = [{ item_id: item.id, location_id: loc.id, delta }];
      this.assertEnough(plan);
      const doc = this.writeDoc({
        type: "count",
        note: clip(input.note, 500),
        operator: op.raw,
        meta: { before, actual },
        lines: plan,
      });
      this.insertLog({
        action: "count",
        message_zh: `${op.zh} 盘点 ${item.name} 在 ${this.placeText(loc).zh}：${qtyText(before)} 改为 ${qtyText(actual)}`,
        message_en: `${op.en} counted ${item.name_en || item.name} at ${this.placeText(loc).en}: ${qtyText(before)} → ${qtyText(actual)}`,
        doc_id: doc.id,
        item_id: item.id,
        operator: op.raw,
      });
      return this.getDocument(doc.id);
    });
  }

  postAssemble(input) {
    return this.tx(() => {
      const parent = this.ensureActive("items", Number(input.item_id));
      const made = this.positiveQty(input.qty);
      let outId = Number(input.output_location_id || 0);
      if (!outId) outId = parent.default_location_id || this.pickLocation(parent.id, 0, null);
      const outLoc = this.ensureActive("locations", outId);
      const bom = this.db.prepare(
        `SELECT b.component_item_id, b.qty_per, i.name, i.name_en, i.default_location_id
         FROM bom_lines b JOIN items i ON i.id = b.component_item_id
         WHERE b.parent_item_id = ?`
      ).all(parent.id);
      if (!bom.length) throw new AppError("no_bom");
      const chosen = new Map();
      for (const row of input.components || []) {
        chosen.set(Number(row.item_id), Number(row.location_id));
      }
      const plan = [{ item_id: parent.id, location_id: outLoc.id, delta: made }];
      const parts = [];
      for (const line of bom) {
        const used = Math.round(line.qty_per * made * 1000) / 1000;
        let locId = chosen.get(line.component_item_id);
        if (!locId) locId = this.pickLocation(line.component_item_id, used, line.default_location_id);
        this.ensureActive("locations", locId);
        plan.push({ item_id: line.component_item_id, location_id: locId, delta: -used });
        parts.push({ ...line, used, location_id: locId });
      }
      this.assertEnough(plan);
      const op = opsOf(input);
      const doc = this.writeDoc({
        type: "asm",
        note: clip(input.note, 500),
        operator: op.raw,
        meta: { made },
        lines: plan,
      });
      const partZh = parts.map((p) => `${p.name} -${qtyText(p.used)}`).join("；");
      const partEn = parts.map((p) => `${p.name_en || p.name} -${qtyText(p.used)}`).join("; ");
      this.insertLog({
        action: "asm",
        message_zh: `${op.zh} 组装 ${parent.name} +${qtyText(made)}；${partZh}`,
        message_en: `${op.en} assembled ${parent.name_en || parent.name} +${qtyText(made)}; ${partEn}`,
        doc_id: doc.id,
        item_id: parent.id,
        operator: op.raw,
      });
      for (const p of parts) {
        const loc = this.must("locations", p.location_id);
        this.insertLog({
          action: "asm_part",
          message_zh: `${op.zh} 组装 ${parent.name} 用掉 ${p.name} -${qtyText(p.used)}，从 ${this.placeText(loc).zh}`,
          message_en: `${op.en} assembly of ${parent.name_en || parent.name} used ${p.name_en || p.name} -${qtyText(p.used)} from ${this.placeText(loc).en}`,
          doc_id: doc.id,
          item_id: p.component_item_id,
          operator: op.raw,
        });
      }
      return this.getDocument(doc.id);
    });
  }

  pickLocation(itemId, need, fallbackId) {
    const rows = this.balancesOf(itemId).sort((a, b) => b.qty - a.qty);
    const enough = rows.find((r) => r.qty + 1e-9 >= need && r.active);
    if (enough) return enough.location_id;
    if (rows[0]) return rows[0].location_id;
    if (fallbackId) return fallbackId;
    const loc = this.db.prepare("SELECT id FROM locations WHERE active = 1 ORDER BY sort_order, id LIMIT 1").get();
    if (!loc) throw new AppError("location_required");
    return loc.id;
  }

  getDocument(id) {
    const doc = this.db.prepare("SELECT * FROM documents WHERE id = ?").get(id);
    if (!doc) return null;
    const lines = this.db.prepare(
      `SELECT l.*, i.name, i.name_en, i.code, i.spec,
              loc.name AS location_name, loc.name_en AS location_name_en,
              w.name AS warehouse_name, w.name_en AS warehouse_name_en,
              u.name AS unit, u.name_en AS unit_en
       FROM document_lines l
       JOIN items i ON i.id = l.item_id
       JOIN locations loc ON loc.id = l.location_id
       LEFT JOIN warehouses w ON w.id = loc.warehouse_id
       LEFT JOIN units u ON u.id = i.unit_id
       WHERE l.document_id = ? ORDER BY l.id`
    ).all(id);
    let meta = {};
    try { meta = JSON.parse(doc.meta_json || "{}"); } catch (_) {}
    if (meta.source_type_id) {
      const s = this.db.prepare("SELECT name, name_en FROM source_types WHERE id = ?").get(meta.source_type_id);
      if (s) Object.assign(meta, { source_type_name: s.name, source_type_name_en: s.name_en });
    }
    if (meta.purpose_id) {
      const p = this.db.prepare("SELECT name, name_en FROM purposes WHERE id = ?").get(meta.purpose_id);
      if (p) Object.assign(meta, { purpose_name: p.name, purpose_name_en: p.name_en });
    }
    return {
      id: doc.id,
      doc_no: doc.doc_no,
      doc_type: doc.doc_type,
      status: doc.status,
      note: doc.note,
      photo_url: photoUrl(doc.photo),
      operator: doc.operator,
      created_at: doc.created_at,
      voided_at: doc.voided_at,
      void_reason: doc.void_reason,
      meta,
      lines,
    };
  }

  voidDocument(id, input) {
    return this.tx(() => {
      const doc = this.must("documents", id);
      if (doc.status !== "posted") throw new AppError("already_void");
      const reason = clip(input.reason, 200);
      if (!reason) throw new AppError("reason_required");
      const lines = this.db.prepare(
        "SELECT item_id, location_id, qty_delta FROM document_lines WHERE document_id = ?"
      ).all(id);
      const grouped = new Map();
      for (const line of lines) {
        const key = `${line.item_id}:${line.location_id}`;
        grouped.set(key, (grouped.get(key) || 0) + line.qty_delta);
      }
      const plan = [...grouped.entries()].map(([key, delta]) => {
        const [itemId, locationId] = key.split(":").map(Number);
        return { item_id: itemId, location_id: locationId, delta: Math.round(-delta * 1000) / 1000 };
      }).filter((line) => Math.abs(line.delta) >= 0.0005);
      this.assertEnough(plan);
      const stamp = nowStamp();
      const ins = this.db.prepare(
        "INSERT INTO movements(document_id, item_id, location_id, qty_delta, effect, created_at) VALUES(?,?,?,?, 'void', ?)"
      );
      for (const line of plan) {
        this.apply(line.item_id, line.location_id, line.delta);
        ins.run(id, line.item_id, line.location_id, line.delta, stamp);
      }
      this.db.prepare(
        "UPDATE documents SET status = 'voided', voided_at = ?, void_reason = ? WHERE id = ?"
      ).run(stamp, reason, id);
      const op = opsOf(input);
      const mainItem = lines[0] ? lines[0].item_id : 0;
      this.insertLog({
        action: "void",
        message_zh: `${op.zh} 作废 ${doc.doc_no}，原因 ${reason}`,
        message_en: `${op.en} voided ${doc.doc_no}, reason ${reason}`,
        doc_id: id,
        item_id: mainItem,
        operator: op.raw,
      });
      return this.getDocument(id);
    });
  }

  listLogs({ itemId = 0, limit = 200 } = {}) {
    if (itemId) {
      return this.db.prepare(
        "SELECT * FROM logs WHERE item_id = ? ORDER BY id DESC LIMIT ?"
      ).all(itemId, limit);
    }
    return this.db.prepare("SELECT * FROM logs ORDER BY id DESC LIMIT ?").all(limit);
  }

  resolve(code) {
    const text = clip(code, 80);
    if (!text) return { type: "none" };
    const item = this.db.prepare(`${this.itemSelect()} WHERE i.code = ? COLLATE NOCASE`).get(text);
    if (item) return { type: "item", item: this.presentItem(item) };
    const loc = this.db.prepare("SELECT * FROM locations WHERE code = ? COLLATE NOCASE").get(text);
    if (loc) return { type: "location", location: loc };
    return { type: "none" };
  }

  locationStock(id) {
    const loc = this.must("locations", id);
    const rows = this.db.prepare(
      `SELECT i.id, i.code, i.name, i.name_en, b.qty, u.name AS unit, u.name_en AS unit_en
       FROM balances b
       JOIN items i ON i.id = b.item_id
       LEFT JOIN units u ON u.id = i.unit_id
       WHERE b.location_id = ? AND i.active = 1
       ORDER BY i.name`
    ).all(id);
    return { location: loc, items: rows };
  }

  home() {
    const categories = this.db.prepare(
      `SELECT c.*,
         COALESCE(g.sku_count, 0) AS sku_count,
         COALESCE(g.total_qty, 0) AS total_qty
       FROM categories c
       LEFT JOIN (
         SELECT i.category_id AS category_id,
                COUNT(*) AS sku_count,
                COALESCE(SUM(s.qty), 0) AS total_qty
         FROM items i
         LEFT JOIN (
           SELECT item_id, SUM(qty) AS qty FROM balances GROUP BY item_id
         ) s ON s.item_id = i.id
         WHERE i.active = 1
         GROUP BY i.category_id
       ) g ON g.category_id = c.id
       WHERE c.active = 1
       ORDER BY c.sort_order, c.id`
    ).all();
    const alerts = this.db.prepare(
      `SELECT * FROM (
         SELECT i.id, i.name, i.name_en, i.code, i.min_qty, i.max_qty,
                u.name AS unit, u.name_en AS unit_en,
                COALESCE(s.total_qty, 0) AS total_qty
         FROM items i
         LEFT JOIN units u ON u.id = i.unit_id
         LEFT JOIN (
           SELECT item_id, SUM(qty) AS total_qty FROM balances GROUP BY item_id
         ) s ON s.item_id = i.id
         WHERE i.active = 1
       ) t
       WHERE (min_qty IS NOT NULL AND total_qty < min_qty)
          OR (max_qty IS NOT NULL AND total_qty > max_qty)
       ORDER BY (CASE WHEN min_qty IS NOT NULL AND total_qty < min_qty THEN 0 ELSE 1 END), name`
    ).all().map((row) => ({
      ...row,
      level: row.min_qty != null && row.total_qty < row.min_qty - 1e-9 ? "low" : "high",
    }));
    const recent = this.db.prepare(
      `SELECT * FROM logs WHERE action IN ('in','out','asm','move','count','void')
       ORDER BY id DESC LIMIT 10`
    ).all();
    const goods = this.db.prepare(
      `SELECT i.id, i.code, i.name, i.name_en, i.spec, i.min_qty, i.max_qty, i.category_id,
              c.name AS category_name, c.name_en AS category_name_en,
              u.name AS unit, u.name_en AS unit_en,
              COALESCE(s.total_qty, 0) AS total_qty
       FROM items i
       LEFT JOIN categories c ON c.id = i.category_id
       LEFT JOIN units u ON u.id = i.unit_id
       LEFT JOIN (
         SELECT item_id, SUM(qty) AS total_qty FROM balances GROUP BY item_id
       ) s ON s.item_id = i.id
       WHERE i.active = 1
       ORDER BY c.sort_order, i.name`
    ).all();
    const places = this.db.prepare(
      `SELECT b.item_id, b.qty, l.name, l.name_en, w.name AS warehouse_name, w.name_en AS warehouse_name_en
       FROM balances b
       JOIN locations l ON l.id = b.location_id
       LEFT JOIN warehouses w ON w.id = l.warehouse_id
       WHERE ABS(b.qty) > 0.0005
       ORDER BY w.sort_order, l.sort_order`
    ).all();
    const byItem = new Map();
    for (const place of places) {
      if (!byItem.has(place.item_id)) byItem.set(place.item_id, []);
      byItem.get(place.item_id).push(place);
    }
    for (const row of goods) {
      row.places = byItem.get(row.id) || [];
      const low = row.min_qty != null && row.total_qty < row.min_qty - 1e-9;
      const high = row.max_qty != null && row.total_qty > row.max_qty + 1e-9;
      row.level = low ? "low" : high ? "high" : "";
      row.gap = low
        ? Math.round((row.min_qty - row.total_qty) * 1000) / 1000
        : high
          ? Math.round((row.total_qty - row.max_qty) * 1000) / 1000
          : 0;
    }
    const alertRows = alerts.map((row) => {
      const low = row.level === "low";
      return {
        ...row,
        gap: low
          ? Math.round((row.min_qty - row.total_qty) * 1000) / 1000
          : Math.round((row.total_qty - row.max_qty) * 1000) / 1000,
      };
    });
    return { ...this.getSettings(), alerts: alertRows, categories, recent, goods };
  }

  bootstrap() {
    return {
      categories: this.listCategories(),
      units: this.listSimple("units"),
      locations: this.listLocations(),
      warehouses: this.listWarehouses(),
      source_types: this.listSimple("source_types"),
      purposes: this.listSimple("purposes"),
      settings: this.getSettings(),
    };
  }

  factoryReset(confirm, operator) {
    if (String(confirm || "") !== "RESET") throw new AppError("confirm_reset");
    const d = new Date();
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const dir = path.join(this.backupDir, stamp);
    fs.mkdirSync(dir, { recursive: true });
    const dbFile = path.join(dir, "ruida.db").replace(/\\/g, "/").replace(/'/g, "''");
    this.db.exec(`VACUUM INTO '${dbFile}'`);
    fs.cpSync(this.uploadDir, path.join(dir, "uploads"), { recursive: true });
    this.db.exec("PRAGMA foreign_keys = OFF");
    try {
      this.tx(() => {
        for (const table of [
          "logs", "movements", "document_lines", "documents", "balances", "bom_lines",
          "items", "locations", "warehouses", "categories", "units", "source_types", "purposes", "sequences", "settings",
          "sessions", "users",
        ]) {
          this.db.exec(`DELETE FROM ${table}`);
        }
        try { this.db.exec("DELETE FROM sqlite_sequence"); } catch (_) {}
        this.seed();
        const op = opsOf({ operator });
        this.insertLog({
          action: "reset",
          message_zh: `${op.zh} 恢复了出厂设置`,
          message_en: `${op.en} restored factory settings`,
          operator: op.raw,
        });
      });
    } finally {
      this.db.exec("PRAGMA foreign_keys = ON");
    }
    for (const file of fs.readdirSync(this.uploadDir)) {
      fs.rmSync(path.join(this.uploadDir, file), { force: true });
    }
    return { backup: stamp };
  }

  userCount() {
    return this.db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
  }

  publicUser(row) {
    if (!row) return null;
    return { id: row.id, username: row.username, name: row.name, role: row.role, active: !!row.active };
  }

  brand() {
    const company = this.getSettings();
    return {
      needs_setup: this.userCount() === 0,
      company_name: company.company_name,
    };
  }

  passwordOf(value, required) {
    const password = String(value || "");
    if (!password && !required) return "";
    if (password.length < 6 || password.length > 72) throw new AppError("bad_password");
    return password;
  }

  usernameOf(value) {
    const username = String(value || "").trim();
    if (username.length < 2 || username.length > 32 || /\s/.test(username)) throw new AppError("bad_username");
    return username;
  }

  roleOf(value) {
    const role = String(value || "warehouse");
    if (!["boss", "warehouse", "viewer"].includes(role)) throw new AppError("bad_role");
    return role;
  }

  createSession(userId) {
    const token = crypto.randomBytes(32).toString("hex");
    this.db.prepare(
      "INSERT INTO sessions(token, user_id, created_at, expires_at) VALUES(?,?,?,?)"
    ).run(token, userId, nowStamp(), futureStamp(30));
    return token;
  }

  userFromToken(token) {
    if (!token) return null;
    const row = this.db.prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > ? AND u.active = 1`
    ).get(token, nowStamp());
    return this.publicUser(row);
  }

  logout(token) {
    if (token) this.db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
  }

  setup(input) {
    return this.tx(() => {
      if (this.userCount() > 0) throw new AppError("already_setup");
      const companyName = clip(input.company_name, 40);
      if (!companyName) throw new AppError("name_required");
      const username = this.usernameOf(input.username);
      const password = this.passwordOf(input.password, true);
      const name = clip(input.name, 40) || companyName;
      this.setSetting("company_name", companyName);
      const info = this.db.prepare(
        "INSERT INTO users(username, name, password_hash, role, active, created_at) VALUES(?,?,?,?,1,?)"
      ).run(username, name, hashPassword(password), "boss", nowStamp());
      const user = this.publicUser(this.db.prepare("SELECT * FROM users WHERE id = ?").get(Number(info.lastInsertRowid)));
      this.insertLog({
        action: "config",
        message_zh: `${name} 开通了系统`,
        message_en: `${name} set up the system`,
        operator: name,
      });
      return { token: this.createSession(user.id), user, company: this.getSettings() };
    });
  }

  login(input) {
    const username = String(input.username || "").trim();
    const row = username
      ? this.db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE").get(username)
      : null;
    if (!row || !row.active || !verifyPassword(input.password || "", row.password_hash)) {
      throw new AppError("bad_login", 400);
    }
    return { token: this.createSession(row.id), user: this.publicUser(row), company: this.getSettings() };
  }

  listUsers() {
    return this.db.prepare("SELECT * FROM users ORDER BY id").all().map((row) => this.publicUser(row));
  }

  saveUser(id, input) {
    return this.tx(() => {
      const name = clip(input.name, 40);
      if (!name) throw new AppError("name_required");
      const role = "boss";
      const active = input.active === false || input.active === 0 ? 0 : 1;
      if (id) {
        const cur = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id);
        if (!cur) throw new AppError("not_found", 404);
        if (cur.role === "boss" && cur.active && (role !== "boss" || !active)) {
          const others = this.db.prepare(
            "SELECT COUNT(*) AS n FROM users WHERE role = 'boss' AND active = 1 AND id <> ?"
          ).get(id).n;
          if (!others) throw new AppError("last_boss");
        }
        const password = this.passwordOf(input.password, false);
        if (password) {
          this.db.prepare(
            "UPDATE users SET name=?, role=?, active=?, password_hash=? WHERE id=?"
          ).run(name, role, active, hashPassword(password), id);
        } else {
          this.db.prepare("UPDATE users SET name=?, role=?, active=? WHERE id=?").run(name, role, active, id);
        }
        return this.publicUser(this.db.prepare("SELECT * FROM users WHERE id = ?").get(id));
      }
      const username = this.usernameOf(input.username);
      const password = this.passwordOf(input.password, true);
      const exists = this.db.prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE").get(username);
      if (exists) throw new AppError("username_taken");
      const info = this.db.prepare(
        "INSERT INTO users(username, name, password_hash, role, active, created_at) VALUES(?,?,?,?,1,?)"
      ).run(username, name, hashPassword(password), role, nowStamp());
      return this.publicUser(this.db.prepare("SELECT * FROM users WHERE id = ?").get(Number(info.lastInsertRowid)));
    });
  }

  clockStamp() {
    const d = new Date();
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  }

  backupStamp() {
    const base = this.clockStamp();
    let stamp = base;
    let n = 2;
    while (fs.existsSync(path.join(this.backupDir, stamp))) {
      stamp = `${base}-${n}`;
      n += 1;
    }
    return stamp;
  }

  backupNow() {
    const stamp = this.backupStamp();
    const dir = path.join(this.backupDir, stamp);
    fs.mkdirSync(dir, { recursive: true });
    const dbFile = path.join(dir, "ruida.db").replace(/\\/g, "/").replace(/'/g, "''");
    this.db.exec(`VACUUM INTO '${dbFile}'`);
    fs.cpSync(this.uploadDir, path.join(dir, "uploads"), { recursive: true });
    return { stamp, at: nowStamp() };
  }

  backupDownload() {
    const saved = this.backupNow();
    const dir = path.join(this.backupDir, saved.stamp);
    const zipPath = path.join(os.tmpdir(), `ruida-${saved.stamp}.zip`);
    const packed = spawnSync("tar", ["-a", "-cf", zipPath, "-C", dir, "."], { windowsHide: true });
    if (packed.status !== 0 || !fs.existsSync(zipPath)) throw new AppError("backup_failed");
    const file = fs.readFileSync(zipPath);
    fs.rmSync(zipPath, { force: true });
    return { file, filename: `备份-${saved.stamp}.zip` };
  }

  findBackupRoot(dir, depth = 0) {
    if (depth > 3 || !fs.existsSync(dir)) return null;
    if (fs.existsSync(path.join(dir, "ruida.db"))) return dir;
    for (const name of fs.readdirSync(dir)) {
      const child = path.join(dir, name);
      if (!fs.statSync(child).isDirectory()) continue;
      const hit = this.findBackupRoot(child, depth + 1);
      if (hit) return hit;
    }
    return null;
  }

  restoreFromDir(dir) {
    const src = path.join(dir, "ruida.db");
    if (!fs.existsSync(src)) throw new AppError("bad_backup");
    this.backupNow();
    const dbPath = path.join(this.dataDir, "ruida.db");
    this.db.close();
    try {
      for (const ext of ["-wal", "-shm"]) fs.rmSync(dbPath + ext, { force: true });
      fs.copyFileSync(src, dbPath);
      fs.rmSync(this.uploadDir, { recursive: true, force: true });
      fs.mkdirSync(this.uploadDir, { recursive: true });
      const uploads = path.join(dir, "uploads");
      if (fs.existsSync(uploads)) fs.cpSync(uploads, this.uploadDir, { recursive: true });
    } finally {
      this.openDb();
      this.migrate();
    }
    return { ok: true, clearSession: true };
  }

  importBackup(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 22 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
      throw new AppError("bad_backup");
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ruida-in-"));
    try {
      const zipPath = path.join(tmp, "in.zip");
      const dest = path.join(tmp, "out");
      fs.writeFileSync(zipPath, buf);
      fs.mkdirSync(dest);
      const unpacked = spawnSync("tar", ["-xf", zipPath, "-C", dest], { windowsHide: true });
      if (unpacked.status !== 0) throw new AppError("bad_backup");
      const root = this.findBackupRoot(dest);
      if (!root) throw new AppError("bad_backup");
      return this.restoreFromDir(root);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  listBackups() {
    if (!fs.existsSync(this.backupDir)) return [];
    return fs.readdirSync(this.backupDir)
      .filter((name) => /^\d{8}-\d{6}(?:-\d+)?$/.test(name) && fs.existsSync(path.join(this.backupDir, name, "ruida.db")))
      .sort()
      .reverse()
      .map((stamp) => {
        const file = path.join(this.backupDir, stamp, "ruida.db");
        return { stamp, bytes: fs.statSync(file).size, at: fs.statSync(file).mtime.toISOString() };
      });
  }

  restoreBackup(stamp) {
    const safe = String(stamp || "");
    if (!/^\d{8}-\d{6}(?:-\d+)?$/.test(safe)) throw new AppError("not_found", 404);
    const dir = path.join(this.backupDir, safe);
    if (!fs.existsSync(path.join(dir, "ruida.db"))) throw new AppError("not_found", 404);
    return this.restoreFromDir(dir);
  }

  maybeScheduledBackup() {
    const every = this.setting("backup_every", "off");
    if (every !== "daily" && every !== "weekly") return null;
    const match = /^(\d{1,2}):([0-5]\d)$/.exec(this.setting("backup_time", "02:00"));
    if (!match) return null;
    const now = new Date();
    const hh = Number(match[1]);
    const mm = Number(match[2]);
    const passed = now.getHours() > hh || (now.getHours() === hh && now.getMinutes() >= mm);
    if (!passed) return null;
    if (every === "weekly" && String(now.getDay()) !== this.setting("backup_weekday", "1")) return null;
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    if (this.setting("last_auto_backup", "") === today) return null;
    const result = this.backupNow();
    this.setSetting("last_auto_backup", today);
    return result;
  }

  csvCell(value) {
    const text = value == null ? "" : String(value);
    if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
    return text;
  }

  csvTable(rows) {
    return rows.map((row) => row.map((cell) => this.csvCell(cell)).join(",")).join("\r\n");
  }

  exportCsv(kind) {
    const stamp = this.clockStamp();
    const docType = { in: "入库", out: "出库", asm: "组装", move: "移库", count: "盘点" };
    const docStatus = { posted: "已确认", voided: "已作废" };
    const logAction = {
      config: "设置", item: "货品", bom: "用料", in: "入库", out: "出库", move: "移库",
      count: "盘点", asm: "组装", asm_part: "组装用料", void: "作废", reset: "恢复出厂",
    };
    if (kind === "items") {
      const rows = this.db.prepare(
        `SELECT i.code, i.name, c.name AS category, u.name AS unit, i.spec, i.supplier_name,
                i.min_qty, i.max_qty,
                COALESCE((SELECT SUM(qty) FROM balances b WHERE b.item_id = i.id),0) AS qty
         FROM items i
         LEFT JOIN categories c ON c.id = i.category_id
         LEFT JOIN units u ON u.id = i.unit_id
         WHERE i.active = 1
         ORDER BY i.code`
      ).all();
      return {
        filename: `货品-${stamp}.csv`,
        csv: this.csvTable([
          ["编码", "名称", "分类", "单位", "规格", "供应商", "最低库存", "最高库存", "库存"],
          ...rows.map((row) => [row.code, row.name, row.category, row.unit, row.spec, row.supplier_name, row.min_qty, row.max_qty, row.qty]),
        ]),
      };
    }
    if (kind === "stock") {
      const rows = this.db.prepare(
        `SELECT i.code, i.name, w.name AS warehouse, l.name AS location, b.qty
         FROM balances b
         JOIN items i ON i.id = b.item_id
         JOIN locations l ON l.id = b.location_id
         LEFT JOIN warehouses w ON w.id = l.warehouse_id
         WHERE ABS(b.qty) > 0.0005
         ORDER BY i.code, w.name, l.name`
      ).all();
      return {
        filename: `库存-${stamp}.csv`,
        csv: this.csvTable([
          ["编码", "名称", "仓库", "位置", "数量"],
          ...rows.map((row) => [row.code, row.name, row.warehouse, row.location, row.qty]),
        ]),
      };
    }
    if (kind === "documents") {
      const rows = this.db.prepare(
        `SELECT d.doc_no, d.doc_type, d.status, d.created_at, d.operator, i.code, i.name,
                w.name AS warehouse, l.name AS location, lne.qty_delta, lne.unit_price, d.note
         FROM document_lines lne
         JOIN documents d ON d.id = lne.document_id
         JOIN items i ON i.id = lne.item_id
         JOIN locations l ON l.id = lne.location_id
         LEFT JOIN warehouses w ON w.id = l.warehouse_id
         ORDER BY d.id, lne.id`
      ).all();
      return {
        filename: `单据-${stamp}.csv`,
        csv: this.csvTable([
          ["单号", "类型", "状态", "时间", "操作人", "编码", "名称", "仓库", "位置", "数量", "单价", "备注"],
          ...rows.map((row) => [
            row.doc_no, docType[row.doc_type] || row.doc_type, docStatus[row.status] || row.status,
            row.created_at, row.operator, row.code, row.name, row.warehouse, row.location,
            row.qty_delta, row.unit_price, row.note,
          ]),
        ]),
      };
    }
    if (kind === "logs") {
      const rows = this.listLogs({ limit: 5000 });
      return {
        filename: `日志-${stamp}.csv`,
        csv: this.csvTable([
          ["时间", "动作", "内容", "操作人"],
          ...rows.map((row) => [row.created_at, logAction[row.action] || row.action, row.message_zh, row.operator]),
        ]),
      };
    }
    throw new AppError("not_found", 404);
  }
}

module.exports = { Store, AppError };
