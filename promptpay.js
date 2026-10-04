/*!
 * promptpay.js — browser build of the PromptPay payload algorithm
 * ============================================================================
 * Vendored from `promptpay-qr` v0.5.0 (MIT, © Thai Pangsakulyanont)
 *   https://github.com/dtinth/promptpay-qr
 *
 * Why vendored instead of loaded from a CDN?
 * ------------------------------------------
 * `promptpay-qr` ships CommonJS only (`module.exports = generatePayload`) and
 * has no UMD/browser bundle on jsDelivr or unpkg. Rather than pull in a
 * bundler, we inline the ~60 lines of pure algorithm here. It has zero
 * dependencies (the original's only dep, `crc`, is replaced by the 12-line
 * CRC16-XMODEM implementation below).
 *
 * Exposes: window.generatePayload(target, { amount })
 *
 * EMVCo Merchant-Presented Mode TLV layout produced:
 *   00  payload format indicator ("01")
 *   01  point of initiation  ("11" static / "12" dynamic when amount given)
 *   29  merchant account information (PromptPay AID + target)
 *   53  transaction currency ("764" = THB)
 *   58  country code ("TH")
 *   54  transaction amount (only when amount is provided)
 *   63  CRC16-XMODEM checksum
 * ============================================================================
 */
(function (global) {
  "use strict";

  var ID_PAYLOAD_FORMAT = "00";
  var ID_POI_METHOD = "01";
  var ID_MERCHANT_INFORMATION_BOT = "29";
  var ID_TRANSACTION_CURRENCY = "53";
  var ID_TRANSACTION_AMOUNT = "54";
  var ID_COUNTRY_CODE = "58";
  var ID_CRC = "63";

  var PAYLOAD_FORMAT_EMV_QRCPS_MERCHANT_PRESENTED_MODE = "01";
  var POI_METHOD_STATIC = "11";
  var POI_METHOD_DYNAMIC = "12";
  var MERCHANT_INFORMATION_TEMPLATE_ID_GUID = "00";
  var BOT_ID_MERCHANT_PHONE_NUMBER = "01";
  var BOT_ID_MERCHANT_TAX_ID = "02";
  var BOT_ID_MERCHANT_EWALLET_ID = "03";
  var GUID_PROMPTPAY = "A000000677010111";
  var TRANSACTION_CURRENCY_THB = "764";
  var COUNTRY_CODE_TH = "TH";

  /** TLV field: 2-char id + 2-char zero-padded length + value. */
  function f(id, value) {
    return [id, ("00" + value.length).slice(-2), value].join("");
  }

  /** Concatenate non-empty TLV fields. */
  function serialize(xs) {
    return xs.filter(function (x) { return x; }).join("");
  }

  /** Strip everything but digits. */
  function sanitizeTarget(id) {
    return String(id).replace(/[^0-9]/g, "");
  }

  /**
   * Normalise the target to the form PromptPay expects:
   *   - 13+ digits (national ID / e-Wallet) are used as-is
   *   - a mobile number is left-padded to 13 digits, with a leading 0
   *     replaced by the country code 66
   */
  function formatTarget(id) {
    var numbers = sanitizeTarget(id);
    if (numbers.length >= 13) return numbers;
    return ("0000000000000" + numbers.replace(/^0/, "66")).slice(-13);
  }

  function formatAmount(amount) {
    return Number(amount).toFixed(2);
  }

  function formatCrc(crcValue) {
    return ("0000" + crcValue.toString(16).toUpperCase()).slice(-4);
  }

  /**
   * CRC16-XMODEM (poly 0x1021, init 0xFFFF) — the checksum PromptPay requires.
   * Equivalent to the `crc.crc16xmodem(str, 0xffff)` call in the original.
   */
  function crc16xmodem(str, crc) {
    crc = crc || 0;
    for (var i = 0; i < str.length; i++) {
      crc ^= str.charCodeAt(i) << 8;
      for (var j = 0; j < 8; j++) {
        crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
        crc &= 0xffff;
      }
    }
    return crc;
  }

  /**
   * Build a PromptPay payload string.
   *
   * @param {string} target  mobile number, national ID or e-Wallet ID
   * @param {{amount?: number}} [options]
   * @returns {string} EMVCo payload ready to be encoded as a QR code
   */
  function generatePayload(target, options) {
    options = options || {};
    target = sanitizeTarget(target);

    var amount = options.amount;
    var targetType = (
      target.length >= 15 ? BOT_ID_MERCHANT_EWALLET_ID :
      target.length >= 13 ? BOT_ID_MERCHANT_TAX_ID :
      BOT_ID_MERCHANT_PHONE_NUMBER
    );

    var data = [
      f(ID_PAYLOAD_FORMAT, PAYLOAD_FORMAT_EMV_QRCPS_MERCHANT_PRESENTED_MODE),
      f(ID_POI_METHOD, amount ? POI_METHOD_DYNAMIC : POI_METHOD_STATIC),
      f(ID_MERCHANT_INFORMATION_BOT, serialize([
        f(MERCHANT_INFORMATION_TEMPLATE_ID_GUID, GUID_PROMPTPAY),
        f(targetType, formatTarget(target))
      ])),
      f(ID_COUNTRY_CODE, COUNTRY_CODE_TH),
      f(ID_TRANSACTION_CURRENCY, TRANSACTION_CURRENCY_THB),
      amount && f(ID_TRANSACTION_AMOUNT, formatAmount(amount))
    ];

    var dataToCrc = serialize(data) + ID_CRC + "04";
    data.push(f(ID_CRC, formatCrc(crc16xmodem(dataToCrc, 0xffff))));
    return serialize(data);
  }

  global.generatePayload = generatePayload;
})(typeof window !== "undefined" ? window : this);
