/**
 * Vercel serverless function: /api/admin/orders-export
 *
 *   GET — export orders as a real Excel workbook (.xlsx)
 *
 * Query params:
 *   status  optional — one of pending|paid|delivered|cancelled
 *   limit   optional — max rows (default 5000, capped at 20000)
 *   mode    optional — "inline" (default, opens in the browser) or "download"
 *
 * Auth: any staff role (user/admin/owner), verified server-side by requireRole().
 *
 * The .xlsx is built by hand (SpreadsheetML + a minimal ZIP writer) so the
 * project needs no extra dependency. The output opens natively in Excel,
 * Numbers, Google Sheets, LibreOffice and the browser's built-in viewer.
 */

import { requireRole, withErrors, HttpError } from "./_auth.js";

const ORDER_STATUSES = ["pending", "paid", "delivered", "cancelled"];

const STATUS_LABEL = {
  pending: "待付款",
  paid: "已付款",
  delivered: "已送达",
  cancelled: "已取消",
};

/** Fallback labels for method codes that no longer exist in the table. */
const FULFILMENT_LABEL = {
  self_pickup: "自提",
  grab_cod: "Grab 到付",
};

function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ error: "Method not allowed." });
    return;
  }
  return exportOrders(req, res);
}

async function exportOrders(req, res) {
  const { admin } = await requireRole(req, "user");

  const status = req.query.status;
  const limit = Math.min(parseInt(req.query.limit, 10) || 5000, 20000);
  const mode = req.query.mode === "download" ? "download" : "inline";

  let query = admin
    .from("pomelo_orders")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (status && ORDER_STATUSES.includes(status)) {
    query = query.eq("status", status);
  }

  const { data, error } = await query;
  if (error) throw new HttpError(500, "Failed to load orders: " + error.message);

  const orders = data || [];

  // Resolve delivery-method labels from the live table so renamed/added
  // methods export with their current name. Codes missing from the table
  // (e.g. a deleted method on an old order) fall back to the built-in map.
  const labels = { ...FULFILMENT_LABEL };
  const { data: methods } = await admin
    .from("pomelo_delivery_methods")
    .select("code, label");
  for (const m of methods || []) {
    if (m.code && m.label) labels[m.code] = m.label;
  }

  const xlsx = buildWorkbook(orders, status, labels);

  const stamp = new Date().toISOString().slice(0, 10);
  const suffix = status ? "-" + status : "";
  const filename = `pomelo-orders${suffix}-${stamp}.xlsx`;

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  res.setHeader(
    "Content-Disposition",
    `${mode}; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`
  );
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Length", String(xlsx.length));
  res.status(200).send(Buffer.from(xlsx));
}

// ---------------------------------------------------------------------------
// Workbook construction
// ---------------------------------------------------------------------------

/** Build the column definitions, closing over the resolved label map. */
function buildColumns(labels) {
  return [
    { header: "订单号", width: 38, value: (o) => String(o.id || "") },
    { header: "下单时间", width: 20, value: (o) => fmtDateTime(o.created_at) },
    { header: "客户微信名", width: 18, value: (o) => o.wechat_name || "" },
    { header: "电话", width: 16, value: (o) => o.phone || "" },
    { header: "交货方式", width: 16, value: (o) => labels[o.fulfilment] || o.fulfilment || "" },
    { header: "商品明细", width: 40, value: (o) => itemsText(o.items) },
    { header: "总金额 (THB)", width: 14, numeric: true, value: (o) => (Number(o.total_satang) || 0) / 100 },
    { header: "状态", width: 12, value: (o) => STATUS_LABEL[o.status] || o.status || "" },
    { header: "备注", width: 30, value: (o) => o.note || "" },
    { header: "水单链接", width: 50, value: (o) => o.slip_url || "" },
  ];
}

function itemsText(items) {
  if (!Array.isArray(items)) return "";
  return items
    .map((it) => {
      const label = it.label || it.sku || "?";
      const qty = it.qty || 1;
      return `${label} × ${qty}`;
    })
    .join("; ");
}

function fmtDateTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  // Bangkok time (UTC+7), formatted as YYYY-MM-DD HH:mm:ss
  const t = new Date(d.getTime() + 7 * 60 * 60 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ` +
    `${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}`
  );
}

function buildWorkbook(orders, statusFilter, labels) {
  const sheetName = statusFilter ? `订单-${statusFilter}` : "订单";
  const sheetXml = buildSheetXml(orders, buildColumns(labels || FULFILMENT_LABEL));
  const files = {
    "[Content_Types].xml": contentTypesXml(),
    "_rels/.rels": rootRelsXml(),
    "xl/workbook.xml": workbookXml(sheetName),
    "xl/_rels/workbook.xml.rels": workbookRelsXml(),
    "xl/styles.xml": stylesXml(),
    "xl/worksheets/sheet1.xml": sheetXml,
  };
  return zipStore(files);
}

// Build entity strings without literal "&" so editors/tooling cannot decode them.
const ENT_AMP = String.fromCharCode(38) + "amp;";
const ENT_LT = String.fromCharCode(38) + "lt;";
const ENT_GT = String.fromCharCode(38) + "gt;";
const ENT_QUOT = String.fromCharCode(38) + "quot;";
const ENT_APOS = String.fromCharCode(38) + "#39;";

function xmlEscape(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, ENT_AMP)
    .replace(/</g, ENT_LT)
    .replace(/>/g, ENT_GT)
    .replace(/"/g, ENT_QUOT)
    .replace(/'/g, ENT_APOS)
    // Strip control chars that are illegal in XML 1.0.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

function colLetter(index) {
  // 0 -> A, 25 -> Z, 26 -> AA ...
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function buildSheetXml(orders, columns) {
  const lastCol = colLetter(columns.length - 1);
  const lastRow = orders.length + 1;

  const cols = columns.map((c, i) => {
    const n = i + 1;
    return `<col min="${n}" max="${n}" width="${c.width}" customWidth="1"/>`;
  }).join("");

  const headerCells = columns.map((c, i) => {
    const ref = colLetter(i) + "1";
    return `<c r="${ref}" s="1" t="inlineStr"><is><t>${xmlEscape(c.header)}</t></is></c>`;
  }).join("");

  const rows = orders.map((o, ri) => {
    const rowNum = ri + 2;
    const cells = columns.map((c, ci) => {
      const ref = colLetter(ci) + rowNum;
      const raw = c.value(o);
      if (c.numeric) {
        const num = Number(raw);
        if (Number.isFinite(num)) {
          return `<c r="${ref}" s="2"><v>${num}</v></c>`;
        }
      }
      return `<c r="${ref}" s="0" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(raw)}</t></is></c>`;
    }).join("");
    return `<row r="${rowNum}">${cells}</row>`;
  }).join("");

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetViews><sheetView workbookViewId="0">` +
    `<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>` +
    `</sheetView></sheetViews>` +
    `<cols>${cols}</cols>` +
    `<sheetData>` +
    `<row r="1">${headerCells}</row>` +
    rows +
    `</sheetData>` +
    `<autoFilter ref="A1:${lastCol}${lastRow}"/>` +
    `</worksheet>`
  );
}

function contentTypesXml() {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    `</Types>`
  );
}

function rootRelsXml() {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`
  );
}

function workbookXml(sheetName) {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets><sheet name="${xmlEscape(sheetName)}" sheetId="1" r:id="rId1"/></sheets>` +
    `</workbook>`
  );
}

function workbookRelsXml() {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    `</Relationships>`
  );
}

function stylesXml() {
  // s=0 default, s=1 bold header, s=2 money (#,##0.00)
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<fonts count="2">` +
    `<font><sz val="11"/><name val="Calibri"/></font>` +
    `<font><b/><sz val="11"/><name val="Calibri"/></font>` +
    `</fonts>` +
    `<fills count="3">` +
    `<fill><patternFill patternType="none"/></fill>` +
    `<fill><patternFill patternType="gray125"/></fill>` +
    `<fill><patternFill patternType="solid"><fgColor rgb="FFF7B500"/><bgColor indexed="64"/></patternFill></fill>` +
    `</fills>` +
    `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="3">` +
    `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
    `<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>` +
    `<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
    `</cellXfs>` +
    `</styleSheet>`
  );
}

// ---------------------------------------------------------------------------
// Minimal ZIP writer (STORE method — no compression, no dependencies)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const time =
    ((date.getHours() & 0x1f) << 11) |
    ((date.getMinutes() & 0x3f) << 5) |
    ((Math.floor(date.getSeconds() / 2)) & 0x1f);
  const day =
    (((date.getFullYear() - 1980) & 0x7f) << 9) |
    (((date.getMonth() + 1) & 0x0f) << 5) |
    (date.getDate() & 0x1f);
  return { time, day };
}

function zipStore(files) {
  const encoder = new TextEncoder();
  const now = new Date();
  const { time, day } = dosDateTime(now);

  const entries = Object.keys(files).map((name) => {
    const nameBytes = encoder.encode(name);
    const data = encoder.encode(files[name]);
    return { nameBytes, data, crc: crc32(data) };
  });

  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const e of entries) {
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
    local.writeUInt16LE(0, 8); // method: store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(e.crc, 14);
    local.writeUInt32LE(e.data.length, 18); // compressed size
    local.writeUInt32LE(e.data.length, 22); // uncompressed size
    local.writeUInt16LE(e.nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // extra length

    localParts.push(local, Buffer.from(e.nameBytes), Buffer.from(e.data));

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central dir signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8); // flags
    central.writeUInt16LE(0, 10); // method
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(e.crc, 16);
    central.writeUInt32LE(e.data.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(e.nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // local header offset

    centralParts.push(central, Buffer.from(e.nameBytes));

    offset += local.length + e.nameBytes.length + e.data.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central dir signature
  end.writeUInt16LE(0, 4); // disk number
  end.writeUInt16LE(0, 6); // disk with central dir
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localParts, centralDir, end]);
}

export default withErrors(handler);
