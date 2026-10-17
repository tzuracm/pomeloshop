/**
 * Vercel serverless function: /api/admin/payment-qr
 *
 *   POST — decode an uploaded bank PromptPay QR image (admin/owner)
 *          Body: { image: "data:image/png;base64,…" }
 *          Returns the parsed EMVCo receiving information so the admin can
 *          eyeball it before confirming.
 *
 *   PUT  — confirm a decoded payload and make it the storefront's payment QR
 *          Body: { payload: "<EMVCo TLV string>" }
 *          Stores it as the `promptpay_qr_payload` setting (owner only).
 *
 *   DELETE — clear the confirmed payload, falling back to the PromptPay ID
 *            (owner only).
 *
 * Why decode server-side?
 * -----------------------
 * The admin uploads a screenshot of the bank's "receive money" QR. We must
 * show the *actual* receiving account (PromptPay ID / bank / account name)
 * before it is trusted, so the admin can catch a wrong or malicious QR. The
 * decoding is pure TLV parsing — no image library is needed because the
 * browser reads the QR pixels and sends us the raw payload string.
 *
 * The storefront then rebuilds the QR from this confirmed payload, injecting
 * the order amount into field 54 (transaction amount) and recomputing the
 * CRC. This guarantees the buyer pays the confirmed account, not whatever
 * `promptpay_id` happens to be set to.
 */

import { requireRole, withErrors, sendJson, readBody, HttpError } from "./_auth.js";

/** Max size of the base64 image we accept (≈ 6 MB of image data). */
const MAX_IMAGE_CHARS = 8 * 1024 * 1024;

/** Max length of a stored EMVCo payload. */
const MAX_PAYLOAD = 1000;

/** Setting key that holds the confirmed payload. */
export const PAYLOAD_SETTING_KEY = "promptpay_qr_payload";

function handler(req, res) {
  if (req.method === "POST") return decodeQr(req, res);
  if (req.method === "PUT") return confirmQr(req, res);
  if (req.method === "DELETE") return clearQr(req, res);
  res.setHeader("Allow", "POST, PUT, DELETE");
  return sendJson(res, 405, { error: "Method not allowed." });
}

// -----------------------------------------------------------------------------
// EMVCo TLV parsing
// -----------------------------------------------------------------------------

/**
 * Parse a flat TLV string into an ordered list of { id, value }.
 * Each field is: 2-char id + 2-char zero-padded length + value.
 * Throws on malformed input so a corrupt QR is never silently accepted.
 */
function parseTlv(str) {
  const out = [];
  let i = 0;
  while (i < str.length) {
    if (i + 4 > str.length) throw new HttpError(400, "QR payload is truncated.");
    const id = str.slice(i, i + 2);
    const lenStr = str.slice(i + 2, i + 4);
    if (!/^\d{2}$/.test(id) || !/^\d{2}$/.test(lenStr)) {
      throw new HttpError(400, "QR payload is not valid EMVCo TLV.");
    }
    const len = parseInt(lenStr, 10);
    const start = i + 4;
    const end = start + len;
    if (end > str.length) throw new HttpError(400, "QR payload field overruns its length.");
    out.push({ id, value: str.slice(start, end) });
    i = end;
  }
  return out;
}

/** CRC16-XMODEM (poly 0x1021, init 0xFFFF) — the checksum PromptPay requires. */
function crc16xmodem(str, crc) {
  let c = crc || 0;
  for (let i = 0; i < str.length; i++) {
    c ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      c = c & 0x8000 ? (c << 1) ^ 0x1021 : c << 1;
      c &= 0xffff;
    }
  }
  return c;
}

/**
 * Verify the trailing CRC (field 63). The checksum covers everything up to and
 * including the "6304" header, so we recompute over that prefix.
 */
function verifyCrc(payload) {
  const idx = payload.lastIndexOf("6304");
  if (idx < 0) return false;
  const prefix = payload.slice(0, idx + 4);
  const expected = payload.slice(idx + 4, idx + 8).toUpperCase();
  const actual = ("0000" + crc16xmodem(prefix, 0xffff).toString(16).toUpperCase()).slice(-4);
  return expected === actual;
}

/** Find a top-level field by id. */
function field(fields, id) {
  const f = fields.find((x) => x.id === id);
  return f ? f.value : "";
}

/**
 * Turn a PromptPay target (as encoded in field 29) back into a human-readable
 * identifier. PromptPay stores mobile numbers as 13 digits with the leading 0
 * replaced by 66, e.g. 0812345678 -> 0066812345678.
 */
function formatTarget(raw) {
  const digits = String(raw || "").replace(/[^0-9]/g, "");
  if (!digits) return "";
  if (digits.length === 13 && digits.startsWith("0066")) {
    return "0" + digits.slice(4);
  }
  if (digits.length === 13 && digits.startsWith("66")) {
    return "0" + digits.slice(2);
  }
  return digits;
}

/**
 * Classify the PromptPay target type.
 *
 * Length alone is ambiguous: a mobile number is padded to 13 digits with the
 * leading 0 replaced by 66 (e.g. 0066812345678), which is the same length as a
 * national ID. So we check the mobile prefix first.
 */
function targetType(digits) {
  const d = String(digits || "").replace(/[^0-9]/g, "");
  if (d.length >= 15) return "e-wallet";
  if (d.length === 13 && (d.startsWith("0066") || d.startsWith("66"))) return "mobile";
  if (d.length >= 13) return "national-id";
  return "mobile";
}

/**
 * Decode a PromptPay EMVCo payload into the receiving information an admin
 * needs to verify: the PromptPay ID, its type, the amount (if any), and the
 * merchant account GUID.
 */
function decodePayload(payload) {
  const clean = String(payload || "").trim();
  if (!clean) throw new HttpError(400, "QR payload is empty.");
  if (clean.length > MAX_PAYLOAD) throw new HttpError(400, "QR payload is too long.");

  const fields = parseTlv(clean);
  const crcOk = verifyCrc(clean);

  const merchant = field(fields, "29");
  if (!merchant) {
    throw new HttpError(400, "This QR is not a PromptPay QR (missing merchant field 29).");
  }

  const merchantFields = parseTlv(merchant);
  const guid = field(merchantFields, "00");
  if (guid !== "A000000677010111") {
    throw new HttpError(400, "This QR is not a PromptPay QR (unexpected merchant GUID).");
  }

  // The target lives in 01 (mobile), 02 (national ID) or 03 (e-wallet).
  const rawTarget = field(merchantFields, "01") || field(merchantFields, "02") || field(merchantFields, "03");
  if (!rawTarget) {
    throw new HttpError(400, "This PromptPay QR has no receiving account.");
  }

  const target = formatTarget(rawTarget);
  const amountRaw = field(fields, "54");
  const amount = amountRaw ? Number(amountRaw) : null;

  return {
    payload: clean,
    crcOk,
    promptPayId: target,
    targetType: targetType(rawTarget),
    amount: Number.isFinite(amount) ? amount : null,
    currency: field(fields, "53") || "",
    country: field(fields, "58") || "",
    merchantGuid: guid,
    // "11" = static (no amount), "12" = dynamic (amount baked in).
    pointOfInitiation: field(fields, "01") || "",
  };
}

// -----------------------------------------------------------------------------
// Handlers
// -----------------------------------------------------------------------------

/**
 * POST — decode a QR image.
 *
 * The browser cannot reliably decode QR pixels without a heavy library, so the
 * admin UI reads the QR with the BarcodeDetector API (or a lightweight
 * fallback) and posts the raw payload here for authoritative parsing and
 * validation. If the client sends an image instead, we reject it with a clear
 * message rather than pretending to decode it.
 */
async function decodeQr(req, res) {
  await requireRole(req, "admin");
  const body = readBody(req);

  const payload = String(body.payload || "").trim();
  if (!payload) {
    throw new HttpError(
      400,
      "No QR payload supplied. The browser could not read the image — try a clearer screenshot."
    );
  }
  if (payload.length > MAX_PAYLOAD) throw new HttpError(400, "QR payload is too long.");

  const decoded = decodePayload(payload);
  return sendJson(res, 200, { decoded });
}

/** PUT — confirm a decoded payload as the storefront's payment QR. */
async function confirmQr(req, res) {
  const { user, admin } = await requireRole(req, "owner");
  const body = readBody(req);

  const payload = String(body.payload || "").trim();
  if (!payload) throw new HttpError(400, "payload is required.");
  if (payload.length > MAX_PAYLOAD) throw new HttpError(400, "payload is too long.");

  // Re-validate server-side: never trust a client-supplied "decoded" object.
  const decoded = decodePayload(payload);
  if (!decoded.crcOk) {
    throw new HttpError(400, "QR checksum is invalid; refusing to save a corrupt payload.");
  }

  const now = new Date().toISOString();
  const { error } = await admin
    .from("pomelo_settings")
    .upsert(
      { key: PAYLOAD_SETTING_KEY, value: decoded.payload, updated_at: now, updated_by: user.id },
      { onConflict: "key" }
    );

  if (error) throw new HttpError(500, "Failed to save payment QR: " + error.message);
  return sendJson(res, 200, { ok: true, decoded });
}

/** DELETE — remove the confirmed payload (revert to the PromptPay ID). */
async function clearQr(req, res) {
  const { admin } = await requireRole(req, "owner");
  const { error } = await admin
    .from("pomelo_settings")
    .delete()
    .eq("key", PAYLOAD_SETTING_KEY);

  if (error) throw new HttpError(500, "Failed to clear payment QR: " + error.message);
  return sendJson(res, 200, { ok: true });
}

export default withErrors(handler);
