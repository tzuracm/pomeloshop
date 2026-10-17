/* ==========================================================================
 * Pomelo Shop — application logic
 * ==========================================================================
 * Boot order:
 *   1. wire up the UI and paint the static shell
 *   2. wait for window.__pomeloConfigReady (set by /config.js)
 *   3. apply the live config (text, catalogue, delivery, payment QR)
 *
 * Nothing config-driven is rendered before step 3. index.html ships
 * <body class="config-pending"> and styles.css hides the hard-coded fallback
 * text until applyConfig() swaps in `config-ready`, so buyers never see the
 * defaults flash on load.
 *
 * Everything is plain ES5-compatible JS (no build step, no modules) so the
 * page works when opened directly from Vercel's static file server.
 * ========================================================================== */
(function () {
  "use strict";

  // ---------------------------------------------------------------------
  // 0. Catalogue — DEFAULT fallback only.
  //    The live catalogue is loaded from /api/config (backed by the
  //    pomelo_catalogue table) so the owner can edit products in /admin.html
  //    without a redeploy. If that read fails, we keep this built-in list.
  //    unitPrice is in THB. Internally we convert to satang (x100) so no
  //    floating-point rounding creeps into the stored total.
  // ---------------------------------------------------------------------
  var DEFAULT_CATALOGUE = [
    { sku: "POM-5KG-001",  label: "5 kg 装",  unitPrice: 180 },
    { sku: "POM-10KG-001", label: "10 kg 装", unitPrice: 330 }
  ];

  // Mutable working copy — replaced by the live catalogue once config loads.
  var CATALOGUE = DEFAULT_CATALOGUE.slice();

  // ---------------------------------------------------------------------
  // 0b. Delivery methods (交货方式) — DEFAULT fallback only.
  //     The live list is loaded from /api/config (backed by the
  //     pomelo_delivery_methods table) so admins can add/remove methods in
  //     /admin.html without a redeploy. `mapUrl` and `timeWindow` are shown
  //     under the selected option (used by 自提 / pickup).
  // ---------------------------------------------------------------------
  var DEFAULT_DELIVERY_METHODS = [
    {
      code: "self_pickup",
      label: "自提",
      description: "Self-Pickup",
      mapUrl: "",
      timeWindow: ""
    }
  ];

  // Mutable working copy — replaced by the live list once config loads.
  var DELIVERY_METHODS = DEFAULT_DELIVERY_METHODS.slice();

  var STORAGE_KEY = "pomelo_shop_buyer_v1";
  var BUCKET = "pomelo-slips";
  var TABLE = "pomelo_orders";
  var MAX_SLIP_BYTES = 8 * 1024 * 1024; // 8 MB

  // How long to wait for /api/config before falling back to the built-in
  // defaults. Only matters when the request hangs rather than failing.
  var CONFIG_TIMEOUT_MS = 6000;

  // ---------------------------------------------------------------------
  // 1. DOM refs
  // ---------------------------------------------------------------------
  function $(id) { return document.getElementById(id); }

  var el = {
    shopName:    $("shopName"),
    shopSubtitle: $("shopSubtitle"),
    footerShop:  $("footerShop"),
    configAlert: $("configAlert"),
    formAlert:   $("formAlert"),
    wechatName:  $("wechatName"),
    phone:       $("phone"),
    deliverySelect:  $("deliverySelect"),
    deliveryTrigger: $("deliveryTrigger"),
    deliveryValue:   $("deliveryValue"),
    deliveryMenu:    $("deliveryMenu"),
    deliveryDetails: $("deliveryDetails"),
    catalogue:   $("catalogue"),
    totalAmount: $("totalAmount"),
    qrFrame:     $("qrFrame"),
    qrAmount:    $("qrAmount"),
    ppId:        $("ppId"),
    dropzone:    $("dropzone"),
    slipInput:   $("slipInput"),
    slipPreview: $("slipPreview"),
    slipImg:     $("slipImg"),
    removeSlip:  $("removeSlip"),
    submitBtn:   $("submitBtn"),
    submitLabel: $("submitLabel"),
    orderFlow:   $("orderFlow"),
    success:     $("successScreen"),
    orderRef:    $("orderRef"),
    spToast:     $("socialProofToast"),
    spIcon:      $("spIcon"),
    spText:      $("spText"),
    spClose:     $("spClose")
  };

  // ---------------------------------------------------------------------
  // 2. State
  // ---------------------------------------------------------------------
  var state = {
    config: null,
    supabase: null,
    qty: {},            // { sku: qty }
    slipFile: null,     // File | null
    slipPreviewUrl: null,
    submitting: false,
    lastQrPayload: null,
    paymentReady: false, // true only when a confirmed QR is rendered
    deliveryCode: ""    // currently selected delivery method code
  };

  function resetQty() {
    state.qty = {};
    CATALOGUE.forEach(function (item) { state.qty[item.sku] = 0; });
  }
  resetQty();

  // ---------------------------------------------------------------------
  // 3. Helpers
  // ---------------------------------------------------------------------
  function thb(satang) {
    // satang -> "1,234.50" (no currency symbol)
    var baht = satang / 100;
    return baht.toLocaleString("en-US", {
      minimumFractionDigits: baht % 1 === 0 ? 0 : 2,
      maximumFractionDigits: 2
    });
  }

  function totalSatang() {
    return CATALOGUE.reduce(function (sum, item) {
      return sum + item.unitPrice * 100 * (state.qty[item.sku] || 0);
    }, 0);
  }

  function showAlert(node, kind, html) {
    node.className = "alert " + kind + " show";
    node.innerHTML = html;
  }
  function hideAlert(node) {
    node.className = "alert";
    node.innerHTML = "";
  }

  // Built with char codes so the source file never contains literal quote
  // characters that some editors/tooling mangle.
  var AMP = String.fromCharCode(38);   // &
  var LT  = String.fromCharCode(60);   // <
  var GT  = String.fromCharCode(62);   // >
  var DQ  = String.fromCharCode(34);   // double quote
  var SQ  = String.fromCharCode(39);   // single quote

  var HTML_ESCAPES = {};
  HTML_ESCAPES[AMP] = AMP + "amp;";
  HTML_ESCAPES[LT]  = AMP + "lt;";
  HTML_ESCAPES[GT]  = AMP + "gt;";
  HTML_ESCAPES[DQ]  = AMP + "quot;";
  HTML_ESCAPES[SQ]  = AMP + "#39;";

  var HTML_ESCAPE_RE = new RegExp("[" + AMP + LT + GT + DQ + SQ + "]", "g");

  function escapeHtml(s) {
    return String(s).replace(HTML_ESCAPE_RE, function (c) {
      return HTML_ESCAPES[c];
    });
  }

  // ---------------------------------------------------------------------
  // 4. localStorage prefill (name + phone)
  // ---------------------------------------------------------------------
  function loadBuyer() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      var saved = JSON.parse(raw);
      if (saved.wechatName) el.wechatName.value = saved.wechatName;
      if (saved.phone) el.phone.value = saved.phone;
    } catch (e) {
      console.warn("[pomelo] could not read saved buyer info:", e);
    }
  }

  function saveBuyer() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        wechatName: el.wechatName.value.trim(),
        phone: el.phone.value.trim()
      }));
    } catch (e) {
      console.warn("[pomelo] could not persist buyer info:", e);
    }
  }

  // ---------------------------------------------------------------------
  // 5. Catalogue rendering
  // ---------------------------------------------------------------------
  function renderCatalogue() {
    if (!CATALOGUE.length) {
      el.catalogue.innerHTML = '<div class="empty">暂无在售商品，请稍后再来。</div>';
      return;
    }

    el.catalogue.innerHTML = CATALOGUE.map(function (item) {
      var q = state.qty[item.sku] || 0;
      return (
        '<div class="sku" data-sku="' + item.sku + '">' +
          '<div class="info">' +
            '<div class="name">' + escapeHtml(item.label) + '</div>' +
            '<div class="price">฿' + thb(item.unitPrice * 100) + ' / 份</div>' +
          '</div>' +
          '<div class="stepper">' +
            '<button type="button" data-act="dec" aria-label="减少" ' + (q <= 0 ? "disabled" : "") + '>−</button>' +
            '<span class="qty">' + q + '</span>' +
            '<button type="button" data-act="inc" aria-label="增加">+</button>' +
          '</div>' +
          '<div class="subtotal">฿' + thb(item.unitPrice * 100 * q) + '</div>' +
        '</div>'
      );
    }).join("");
  }

  function onCatalogueClick(ev) {
    var btn = ev.target.closest("button[data-act]");
    if (!btn) return;
    var row = btn.closest(".sku");
    var sku = row.getAttribute("data-sku");
    var act = btn.getAttribute("data-act");

    if (act === "inc") state.qty[sku] = (state.qty[sku] || 0) + 1;
    if (act === "dec") state.qty[sku] = Math.max(0, (state.qty[sku] || 0) - 1);

    renderCatalogue();
    refreshTotals();
  }

  // ---------------------------------------------------------------------
  // 6. Totals + QR refresh
  // ---------------------------------------------------------------------
  function refreshTotals() {
    var satang = totalSatang();
    el.totalAmount.textContent = thb(satang);
    el.qrAmount.textContent = satang > 0 ? "应付 ฿" + thb(satang) : "";
    updateSubmitState();
    renderQr(satang);
  }

  function updateSubmitState() {
    var ok =
      state.paymentReady &&
      totalSatang() > 0 &&
      el.wechatName.value.trim().length > 0 &&
      el.phone.value.trim().length > 0 &&
      !!state.slipFile &&
      !state.submitting;
    el.submitBtn.disabled = !ok;
  }

  // ---------------------------------------------------------------------
  // 7. PromptPay QR generation
  //    The confirmed bank-QR payload is the ONLY payment source. We inject the
  //    order amount into field 54 and recompute the CRC, so the buyer pays the
  //    exact account the owner verified in /admin.html. When no payload is
  //    confirmed, payment is unavailable and checkout is blocked.
  // ---------------------------------------------------------------------

  /** CRC16-XMODEM (poly 0x1021, init 0xFFFF) — the checksum PromptPay requires. */
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

  /** TLV field: 2-char id + 2-char zero-padded length + value. */
  function tlv(id, value) {
    return id + ("00" + value.length).slice(-2) + value;
  }

  /**
   * Rebuild a confirmed EMVCo payload with a specific amount.
   *
   * The stored payload may be static (no field 54) or dynamic (amount baked
   * in). Either way we drop any existing amount, append the order amount, and
   * recompute the CRC over the new prefix. Field order is preserved so the
   * result stays spec-compliant.
   */
  function applyAmountToPayload(basePayload, amountBaht) {
    var str = String(basePayload || "").trim();
    if (!str) throw new Error("empty payload");

    // Strip the trailing CRC field (63) — we recompute it below.
    var crcIdx = str.lastIndexOf("6304");
    if (crcIdx < 0) throw new Error("payload has no CRC field");
    var body = str.slice(0, crcIdx);

    // Remove any existing transaction-amount field (54) from the body.
    var out = "";
    var i = 0;
    while (i < body.length) {
      var id = body.slice(i, i + 2);
      var len = parseInt(body.slice(i + 2, i + 4), 10);
      var field = body.slice(i, i + 4 + len);
      if (id !== "54") out += field;
      i += 4 + len;
    }

    // Append the amount, then the CRC header, then the checksum.
    out += tlv("54", Number(amountBaht).toFixed(2));
    var toCrc = out + "6304";
    var crc = ("0000" + crc16xmodem(toCrc, 0xffff).toString(16).toUpperCase()).slice(-4);
    return toCrc + crc;
  }

  function renderQr(satang) {
    if (!state.config) return;

    // No confirmed QR means the seller cannot be paid. Say so explicitly and
    // keep checkout disabled rather than rendering a QR to an unknown account.
    if (!state.config.promptPayQrPayload) {
      state.paymentReady = false;
      state.lastQrPayload = null;
      el.qrFrame.innerHTML =
        '<div class="placeholder">卖家尚未配置收款二维码<br />请联系卖家</div>';
      updateSubmitState();
      return;
    }

    if (satang <= 0) {
      el.qrFrame.innerHTML =
        '<div class="placeholder">选择规格后<br />自动生成支付二维码</div>';
      state.lastQrPayload = null;
      state.paymentReady = false;
      updateSubmitState();
      return;
    }

    var amountBaht = satang / 100;
    var payload;
    try {
      // Confirmed bank QR: reuse its account, inject the order amount.
      payload = applyAmountToPayload(state.config.promptPayQrPayload, amountBaht);
    } catch (e) {
      console.error("[pomelo] promptpay payload error:", e);
      state.paymentReady = false;
      el.qrFrame.innerHTML =
        '<div class="placeholder">收款信息无效<br />请联系卖家</div>';
      updateSubmitState();
      return;
    }

    // Avoid re-rendering the same QR on every keystroke.
    if (payload === state.lastQrPayload) return;
    state.lastQrPayload = payload;
    state.paymentReady = true;

    // qrcode-generator API:
    //   var qr = qrcode(typeNumber, errorCorrectionLevel)
    //   qr.addData(payload); qr.make();
    //   qr.createDataURL(cellSize, margin) -> image data URL
    // typeNumber 0 = auto-detect the smallest version that fits.
    var qr;
    try {
      qr = window.qrcode(0, "M");
      qr.addData(payload);
      qr.make();
    } catch (e) {
      console.error("[pomelo] QR encode error:", e);
      state.paymentReady = false;
      el.qrFrame.innerHTML =
        '<div class="placeholder">二维码生成失败<br />请刷新重试</div>';
      updateSubmitState();
      return;
    }

    var dataUrl = qr.createDataURL(6, 8);
    el.qrFrame.innerHTML = "";
    var img = document.createElement("img");
    img.alt = "PromptPay 支付二维码";
    img.src = dataUrl;
    el.qrFrame.appendChild(img);
    updateSubmitState();
  }

  // ---------------------------------------------------------------------
  // 8. Slip selection
  // ---------------------------------------------------------------------
  function setSlip(file) {
    if (!file) return;

    if (!/^image\//.test(file.type)) {
      showAlert(el.formAlert, "error", "请上传图片格式的转账凭证。");
      return;
    }
    if (file.size > MAX_SLIP_BYTES) {
      showAlert(el.formAlert, "error", "图片过大，请上传小于 8 MB 的图片。");
      return;
    }

    hideAlert(el.formAlert);
    state.slipFile = file;

    if (state.slipPreviewUrl) URL.revokeObjectURL(state.slipPreviewUrl);
    state.slipPreviewUrl = URL.createObjectURL(file);
    el.slipImg.src = state.slipPreviewUrl;
    el.slipPreview.classList.add("show");

    updateSubmitState();
  }

  function clearSlip() {
    state.slipFile = null;
    if (state.slipPreviewUrl) {
      URL.revokeObjectURL(state.slipPreviewUrl);
      state.slipPreviewUrl = null;
    }
    el.slipImg.removeAttribute("src");
    el.slipPreview.classList.remove("show");
    el.slipInput.value = "";
    updateSubmitState();
  }

  // ---------------------------------------------------------------------
  // 9. Submit: upload slip -> insert order
  // ---------------------------------------------------------------------
  function buildItems() {
    return CATALOGUE
      .filter(function (item) { return (state.qty[item.sku] || 0) > 0; })
      .map(function (item) {
        var q = state.qty[item.sku];
        return {
          sku: item.sku,
          label: item.label,
          qty: q,
          unit_price: item.unitPrice,
          subtotal: item.unitPrice * q
        };
      });
  }

  // ---------------------------------------------------------------------
  // 9b. Delivery methods (交货方式)
  // ---------------------------------------------------------------------
  function findMethod(code) {
    for (var i = 0; i < DELIVERY_METHODS.length; i++) {
      if (DELIVERY_METHODS[i].code === code) return DELIVERY_METHODS[i];
    }
    return null;
  }

  function selectedMethodCode() {
    if (state.deliveryCode && findMethod(state.deliveryCode)) return state.deliveryCode;
    return DELIVERY_METHODS.length ? DELIVERY_METHODS[0].code : "";
  }

  function renderDeliveryMethods() {
    if (!el.deliveryMenu) return;

    if (!DELIVERY_METHODS.length) {
      state.deliveryCode = "";
      el.deliveryValue.textContent = "暂无可用交货方式";
      el.deliveryMenu.innerHTML = "";
      el.deliveryDetails.innerHTML = "";
      return;
    }

    // Keep the current choice when it still exists; otherwise fall back to
    // the first method.
    if (!findMethod(state.deliveryCode)) {
      state.deliveryCode = DELIVERY_METHODS[0].code;
    }

    var current = selectedMethodCode();
    var currentMethod = findMethod(current);

    // Collapsed trigger shows the current choice.
    el.deliveryValue.innerHTML =
      escapeHtml(currentMethod.label) +
      (currentMethod.description
        ? "<small>" + escapeHtml(currentMethod.description) + "</small>"
        : "");

    // Expanded menu lists every option; exactly one is selected.
    el.deliveryMenu.innerHTML = DELIVERY_METHODS.map(function (m) {
      var isSel = m.code === current;
      return (
        '<button type="button" class="select-option" role="option"' +
          ' data-code="' + escapeHtml(m.code) + '"' +
          ' aria-selected="' + (isSel ? "true" : "false") + '">' +
          '<span class="opt-text">' + escapeHtml(m.label) +
            (m.description ? "<small>" + escapeHtml(m.description) + "</small>" : "") +
          "</span>" +
          (isSel ? '<span class="opt-check" aria-hidden="true">✓</span>' : "") +
        "</button>"
      );
    }).join("");

    renderDeliveryDetails();
  }

  function openDeliveryMenu(open) {
    if (!el.deliverySelect) return;
    el.deliverySelect.classList.toggle("open", open);
    el.deliveryTrigger.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function onDeliveryMenuClick(ev) {
    var btn = ev.target.closest(".select-option");
    if (!btn) return;
    var code = btn.getAttribute("data-code");
    if (!findMethod(code)) return;

    state.deliveryCode = code;
    openDeliveryMenu(false);
    renderDeliveryMethods();
  }

  function renderDeliveryDetails() {
    if (!el.deliveryDetails) return;
    var m = findMethod(selectedMethodCode());
    if (!m) { el.deliveryDetails.innerHTML = ""; return; }

    var parts = [];
    if (m.timeWindow) {
      parts.push(
        '<div class="delivery-row"><span class="k">取货时间</span>' +
          '<span class="v">' + escapeHtml(m.timeWindow) + "</span></div>"
      );
    }
    if (m.mapUrl) {
      parts.push(
        '<div class="delivery-row"><span class="k">取货地点</span>' +
          '<a class="v" href="' + escapeHtml(m.mapUrl) + '" target="_blank" rel="noopener">' +
            "在 Google Maps 中查看 ↗</a></div>"
      );
    }

    el.deliveryDetails.innerHTML = parts.length
      ? '<div class="delivery-info">' + parts.join("") + "</div>"
      : "";
  }

  function fulfilmentValue() {
    return selectedMethodCode();
  }

  function extOf(file) {
    var m = /\.([a-z0-9]+)$/i.exec(file.name || "");
    if (m) return m[1].toLowerCase();
    if (file.type === "image/png") return "png";
    if (file.type === "image/webp") return "webp";
    if (file.type === "image/heic") return "heic";
    return "jpg";
  }

  function setSubmitting(on) {
    state.submitting = on;
    el.submitBtn.disabled = on;
    el.submitLabel.innerHTML = on
      ? '<span class="spinner"></span> 提交中…'
      : "提交订单";
    if (!on) updateSubmitState();
  }

  function submitOrder() {
    if (state.submitting) return;

    // --- validate ---
    var wechatName = el.wechatName.value.trim();
    var phone = el.phone.value.trim();

    if (!wechatName) { showAlert(el.formAlert, "error", "请填写微信名 / 称呼。"); el.wechatName.focus(); return; }
    if (!phone)      { showAlert(el.formAlert, "error", "请填写联系电话。"); el.phone.focus(); return; }
    if (totalSatang() <= 0) { showAlert(el.formAlert, "error", "请至少选择一份商品。"); return; }
    if (!state.slipFile)    { showAlert(el.formAlert, "error", "请上传转账凭证。"); return; }

    if (!state.supabase) {
      showAlert(el.formAlert, "error", "系统未配置完成，暂时无法提交。");
      return;
    }

    hideAlert(el.formAlert);
    setSubmitting(true);

    // Persist buyer info for next visit.
    saveBuyer();

    // A client-generated folder id keeps uploads isolated per order and
    // avoids needing to read the inserted row back (anon has no SELECT).
    var orderId = (window.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : String(Date.now()) + "-" + Math.random().toString(16).slice(2);

    var objectPath = orderId + "/slip." + extOf(state.slipFile);
    var satang = totalSatang();

    // --- 9a. upload the slip to Supabase Storage ---
    state.supabase.storage
      .from(BUCKET)
      .upload(objectPath, state.slipFile, {
        cacheControl: "3600",
        upsert: false,
        contentType: state.slipFile.type || "image/jpeg"
      })
      .then(function (up) {
        if (up.error) throw new Error("上传凭证失败：" + up.error.message);

        // --- 9b. resolve the public URL ---
        var pub = state.supabase.storage.from(BUCKET).getPublicUrl(objectPath);
        var slipUrl = pub.data && pub.data.publicUrl;
        if (!slipUrl) throw new Error("无法获取凭证链接，请重试。");

        // --- 9c. insert the order row ---
        // NOTE: deliberately NO `.select()` here. The anon role has an INSERT
        // policy but no SELECT policy (see 0001_pomelo_orders.sql), so asking
        // PostgREST to return the inserted row would fail RLS and surface as a
        // spurious "提交订单失败" even though the row was written.
        //
        // We DO send the client-generated `id` explicitly: the slip was already
        // uploaded to the `<orderId>/` storage folder, so the row must carry the
        // same id. Otherwise Postgres generates a different UUID and the slip
        // folder no longer corresponds to the order it belongs to.
        return state.supabase.from(TABLE).insert({
          id: orderId,
          wechat_name: wechatName,
          phone: phone,
          fulfilment: fulfilmentValue(),
          items: buildItems(),
          total_satang: satang,
          slip_url: slipUrl,
          status: "pending"
        });
      })
      .then(function (ins) {
        if (ins.error) throw new Error("提交订单失败：" + ins.error.message);
        onSuccess(orderId);
      })
      .catch(function (err) {
        console.error("[pomelo] submit failed:", err);
        setSubmitting(false);
        showAlert(el.formAlert, "error", escapeHtml(err.message || String(err)));
      });
  }

  function onSuccess(orderId) {
    setSubmitting(false);
    spHide();
    el.orderFlow.style.display = "none";
    hideAlert(el.formAlert);
    hideAlert(el.configAlert);
    el.orderRef.textContent = "订单号：" + orderId;
    el.success.classList.add("show");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // ---------------------------------------------------------------------
  // 9d. Social proof toast (simulated)
  // ---------------------------------------------------------------------
  // A floating card that periodically announces "someone just ordered" or
  // "N people are browsing". All numbers are simulated client-side — there is
  // no real-time presence source, and anon cannot read orders (see
  // 0001_pomelo_orders.sql). The owner can tune the ranges via
  // pomelo_page_content keys (see CONTENT_KEYS in admin.js).
  //
  // Behaviour:
  //   * first card appears after a short delay, then every 9–16s
  //   * each card stays ~5s, then slides out
  //   * pauses while the tab is hidden, while submitting, and on success
  //   * after the visitor dismisses it twice, it stops for the session
  var SP_DISMISS_KEY = "pomelo_sp_dismissed_v1";
  var SP_MAX_DISMISSALS = 2;

  var sp = {
    timer: null,
    hideTimer: null,
    visible: false,
    stopped: false,
    dismissals: 0,
    viewers: 0,
    ordersToday: 0
  };

  function spRandomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function spReadNumber(content, key, fallback) {
    var n = parseInt(content && content[key], 10);
    return isFinite(n) && n >= 0 ? n : fallback;
  }

  function spLoadDismissals() {
    try {
      sp.dismissals = parseInt(sessionStorage.getItem(SP_DISMISS_KEY), 10) || 0;
    } catch (e) {
      sp.dismissals = 0;
    }
    if (sp.dismissals >= SP_MAX_DISMISSALS) sp.stopped = true;
  }

  function spSaveDismissals() {
    try {
      sessionStorage.setItem(SP_DISMISS_KEY, String(sp.dismissals));
    } catch (e) { /* private mode — ignore */ }
  }

  /** Pick a random catalogue label, falling back to a generic phrase. */
  function spRandomSkuLabel() {
    if (!CATALOGUE.length) return "柚子";
    return CATALOGUE[spRandomInt(0, CATALOGUE.length - 1)].label;
  }

  /** Build one message: { icon, html }. */
  function spNextMessage() {
    var roll = Math.random();

    // ~45%: someone just ordered
    if (roll < 0.45) {
      var mins = spRandomInt(1, 12);
      var qty = spRandomInt(1, 3);
      return {
        icon: "🛒",
        html: "<strong>" + mins + " 分钟前</strong>有人下单了 " +
              escapeHtml(spRandomSkuLabel()) + " × " + qty
      };
    }

    // ~30%: browsing now
    if (roll < 0.75) {
      return {
        icon: "👀",
        html: "约 <strong>" + sp.viewers + " 人</strong>正在浏览"
      };
    }

    // ~25%: sold today
    return {
      icon: "🍊",
      html: "今天已售出 <strong>" + sp.ordersToday + " 份</strong>"
    };
  }

  function spShow() {
    if (sp.stopped || sp.visible || !el.spToast) return;
    if (document.visibilityState === "hidden") return;
    if (state.submitting || el.success.classList.contains("show")) return;

    var msg = spNextMessage();
    el.spIcon.textContent = msg.icon;
    el.spText.innerHTML = msg.html;
    el.spToast.classList.add("show");
    sp.visible = true;

    sp.hideTimer = setTimeout(spHide, 5000);
  }

  function spHide() {
    clearTimeout(sp.hideTimer);
    sp.hideTimer = null;
    if (!el.spToast) return;
    el.spToast.classList.remove("show");
    sp.visible = false;
  }

  function spScheduleNext(delay) {
    clearTimeout(sp.timer);
    if (sp.stopped) return;
    sp.timer = setTimeout(function () {
      spShow();
      spScheduleNext(spRandomInt(9000, 16000));
    }, delay);
  }

  function spDismiss() {
    spHide();
    sp.dismissals += 1;
    spSaveDismissals();
    if (sp.dismissals >= SP_MAX_DISMISSALS) {
      sp.stopped = true;
      clearTimeout(sp.timer);
      sp.timer = null;
    } else {
      spScheduleNext(spRandomInt(12000, 20000));
    }
  }

  function initSocialProof(content) {
    if (!el.spToast) return;

    spLoadDismissals();
    if (sp.stopped) return;

    // Seed the simulated counters from owner-editable config.
    var baseOrders = spReadNumber(content, "social_proof_orders_base", 120);
    var vMin = spReadNumber(content, "social_proof_viewers_min", 8);
    var vMax = spReadNumber(content, "social_proof_viewers_max", 24);
    if (vMax < vMin) vMax = vMin;

    // Daily cap: the "sold today" figure never exceeds this. 0 = no cap.
    var dailyMax = spReadNumber(content, "social_proof_orders_daily_max", 0);
    sp.ordersToday = baseOrders + spRandomInt(0, 9);
    if (dailyMax > 0) {
      sp.ordersToday = Math.min(sp.ordersToday, dailyMax);
    }
    sp.viewers = spRandomInt(vMin, vMax);

    // Nudge the browsing count a little over time so it feels alive.
    setInterval(function () {
      var delta = spRandomInt(-2, 2);
      sp.viewers = Math.max(vMin, Math.min(vMax, sp.viewers + delta));
    }, 20000);

    el.spClose.addEventListener("click", spDismiss);

    // Pause while the tab is hidden; resume when it comes back.
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden") {
        spHide();
        clearTimeout(sp.timer);
        sp.timer = null;
      } else if (!sp.stopped) {
        spScheduleNext(spRandomInt(3000, 6000));
      }
    });

    spScheduleNext(4000);
  }

  // ---------------------------------------------------------------------
  // 10. Wiring
  // ---------------------------------------------------------------------
  function wireEvents() {
    el.catalogue.addEventListener("click", onCatalogueClick);

    el.wechatName.addEventListener("input", updateSubmitState);
    el.phone.addEventListener("input", updateSubmitState);

    // Collapsible single-select for 交货方式.
    if (el.deliveryTrigger) {
      el.deliveryTrigger.addEventListener("click", function (ev) {
        ev.stopPropagation();
        openDeliveryMenu(!el.deliverySelect.classList.contains("open"));
      });
    }
    if (el.deliveryMenu) {
      el.deliveryMenu.addEventListener("click", onDeliveryMenuClick);
    }
    // Click outside closes the menu.
    document.addEventListener("click", function (ev) {
      if (!el.deliverySelect) return;
      if (!el.deliverySelect.contains(ev.target)) openDeliveryMenu(false);
    });
    // Esc closes the menu.
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") openDeliveryMenu(false);
    });

    el.slipInput.addEventListener("change", function (ev) {
      setSlip(ev.target.files && ev.target.files[0]);
    });

    el.removeSlip.addEventListener("click", function (ev) {
      ev.preventDefault();
      clearSlip();
    });

    // Drag & drop onto the dropzone
    ["dragenter", "dragover"].forEach(function (name) {
      el.dropzone.addEventListener(name, function (ev) {
        ev.preventDefault();
        el.dropzone.classList.add("dragover");
      });
    });
    ["dragleave", "drop"].forEach(function (name) {
      el.dropzone.addEventListener(name, function (ev) {
        ev.preventDefault();
        el.dropzone.classList.remove("dragover");
      });
    });
    el.dropzone.addEventListener("drop", function (ev) {
      var dt = ev.dataTransfer;
      if (dt && dt.files && dt.files[0]) setSlip(dt.files[0]);
    });

    el.submitBtn.addEventListener("click", submitOrder);
  }

  /**
   * Reveal the config-driven text.
   *
   * index.html starts with <body class="config-pending">, and styles.css hides
   * #shopName / #shopSubtitle / #footerShop while that class is present. This
   * is what stops the hard-coded defaults ("Pomelo Shop", "泰国金柚 …") from
   * flashing on every load before /api/config resolves.
   *
   * Called from applyConfig() — which always runs, because config.js falls back
   * to a default object when the fetch fails — so the text can never stay
   * hidden.
   */
  function markConfigReady() {
    if (!document.body) return;
    document.body.classList.remove("config-pending");
    document.body.classList.add("config-ready");
  }

  // Apply owner-editable page text. Keys are seeded by the RBAC migration
  // (hero_title / hero_subtitle) and edited in /admin.html.
  function applyContent(content) {
    if (content.hero_title && el.shopName) {
      el.shopName.textContent = content.hero_title;
      el.footerShop.textContent = content.hero_title;
      document.title = content.hero_title + " · 柚子下单";
    }
    if (content.hero_subtitle && el.shopSubtitle) {
      el.shopSubtitle.textContent = content.hero_subtitle;
    }
  }

  function applyConfig(cfg) {
    state.config = cfg;

    if (cfg.shopName) {
      el.shopName.textContent = cfg.shopName;
      el.footerShop.textContent = cfg.shopName;
      document.title = cfg.shopName + " · 柚子下单";
    }

    // The confirmed QR payload is the only payment source; never show a stale
    // identifier that differs from the account the QR actually pays.
    el.ppId.textContent = cfg.promptPayQrPayload ? "PromptPay · 已确认收款账户" : "";

    // Swap in the live catalogue. An empty array is meaningful: it means every
    // product is currently down-listed, so we must NOT fall back to the
    // built-in DEFAULT_CATALOGUE (that would keep selling hidden products).
    if (Array.isArray(cfg.catalogue)) {
      CATALOGUE = cfg.catalogue.map(function (it) {
        return {
          sku: it.sku,
          label: it.label,
          unitPrice: Number(it.unitPrice) || 0
        };
      });
      resetQty();
    }
    // Always render: boot() no longer paints the defaults, so this is the
    // first (and normally only) catalogue render.
    renderCatalogue();
    refreshTotals();

    // Swap in the live delivery methods when the server returned any.
    if (Array.isArray(cfg.deliveryMethods) && cfg.deliveryMethods.length) {
      DELIVERY_METHODS = cfg.deliveryMethods.map(function (m) {
        return {
          code: m.code,
          label: m.label,
          description: m.description || "",
          mapUrl: m.mapUrl || "",
          timeWindow: m.timeWindow || ""
        };
      });
    }
    // Same reasoning as the catalogue: render once, from the live list.
    renderDeliveryMethods();

    // Apply owner-editable page text (hero title / subtitle).
    if (cfg.content && typeof cfg.content === "object") {
      applyContent(cfg.content);
    }

    // Config has been written to the DOM: reveal the gated text.
    markConfigReady();

    // Start the simulated social-proof toast (uses cfg.content for ranges).
    initSocialProof(cfg.content || {});

    var missing = cfg.missing || [];
    if (missing.length) {
      showAlert(
        el.configAlert,
        "error",
        "⚠️ 系统尚未配置完成，缺少环境变量：" +
          missing.map(function (m) { return "<code>" + escapeHtml(m) + "</code>"; }).join("、") +
          "。请在 Vercel 中添加后重新部署。"
      );
      return;
    }

    // Build the Supabase client only when config is complete.
    if (window.supabase && window.supabase.createClient) {
      state.supabase = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
    } else {
      showAlert(el.configAlert, "error", "Supabase 客户端加载失败，请刷新页面重试。");
    }
  }

  /**
   * Refresh the confirmed payment QR straight from Supabase.
   *
   * /api/config is a serverless function that may be cached by the CDN or a
   * service worker. The owner can change the receiving account at any time, so
   * we re-read `promptpay_qr_payload` directly from `pomelo_settings` (anon RLS
   * allows exactly this key) and override the config. This guarantees the buyer
   * always sees the account the owner most recently confirmed.
   */
  function refreshPaymentSettings() {
    if (!state.supabase) return Promise.resolve();
    return state.supabase
      .from("pomelo_settings")
      .select("key, value")
      .eq("key", "promptpay_qr_payload")
      .then(function (res) {
        if (res.error || !Array.isArray(res.data)) return;
        var next = Object.assign({}, state.config || {});
        // An absent row means the owner cleared the QR: drop any stale value.
        next.promptPayQrPayload = res.data.length ? (res.data[0].value || "") : "";
        state.config = next;
        // Force a re-render even if the payload string is unchanged.
        state.lastQrPayload = null;
        refreshTotals();
      })
      .catch(function (err) {
        // Non-fatal: keep the config we already have.
        console.warn("[pomelo] payment settings refresh failed:", err);
      });
  }

  function boot() {
    loadBuyer();
    // Render the catalogue and delivery methods only once the live config is
    // in. Rendering them here would paint DEFAULT_CATALOGUE /
    // DEFAULT_DELIVERY_METHODS first, which is the same flash-of-defaults bug
    // as the hero text. applyConfig() renders both when the server returns
    // them; if it does not, the fallbacks below keep the page usable.
    wireEvents();
    refreshTotals();

    // Safety net: if /api/config hangs (no response, no error), the promise
    // never settles and the gated text would stay hidden forever. Reveal it
    // after a few seconds so the page degrades to the built-in defaults
    // instead of looking broken.
    setTimeout(function () {
      if (!document.body.classList.contains("config-ready")) {
        console.warn("[pomelo] config did not resolve in time; showing defaults.");
        renderCatalogue();
        renderDeliveryMethods();
        markConfigReady();
      }
    }, CONFIG_TIMEOUT_MS);

    var ready = window.__pomeloConfigReady || Promise.resolve(window.POMELO_CONFIG || {});
    ready.then(function (cfg) {
      applyConfig(cfg || {});
      refreshTotals(); // re-render QR now that the payment payload is known
      // Override with the freshest payment QR from Supabase.
      return refreshPaymentSettings();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
