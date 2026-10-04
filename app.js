/* ==========================================================================
 * Pomelo Shop — application logic
 * ==========================================================================
 * Boot order:
 *   1. wait for window.__pomeloConfigReady (set by /config.js)
 *   2. build the Supabase client
 *   3. wire up the UI
 *
 * Everything is plain ES5-compatible JS (no build step, no modules) so the
 * page works when opened directly from Vercel's static file server.
 * ========================================================================== */
(function () {
  "use strict";

  // ---------------------------------------------------------------------
  // 0. Catalogue — edit this to change products / prices.
  //    unitPrice is in THB. Internally we convert to satang (x100) so no
  //    floating-point rounding creeps into the stored total.
  // ---------------------------------------------------------------------
  var CATALOGUE = [
    { sku: "5kg",  label: "5 kg 装",  unitPrice: 180 },
    { sku: "10kg", label: "10 kg 装", unitPrice: 330 }
  ];

  var STORAGE_KEY = "pomelo_shop_buyer_v1";
  var BUCKET = "pomelo-slips";
  var TABLE = "pomelo_orders";
  var MAX_SLIP_BYTES = 8 * 1024 * 1024; // 8 MB

  // ---------------------------------------------------------------------
  // 1. DOM refs
  // ---------------------------------------------------------------------
  function $(id) { return document.getElementById(id); }

  var el = {
    shopName:    $("shopName"),
    footerShop:  $("footerShop"),
    configAlert: $("configAlert"),
    formAlert:   $("formAlert"),
    wechatName:  $("wechatName"),
    phone:       $("phone"),
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
    orderRef:    $("orderRef")
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
    lastQrPayload: null
  };

  CATALOGUE.forEach(function (item) { state.qty[item.sku] = 0; });

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
      totalSatang() > 0 &&
      el.wechatName.value.trim().length > 0 &&
      el.phone.value.trim().length > 0 &&
      !!state.slipFile &&
      !state.submitting;
    el.submitBtn.disabled = !ok;
  }

  // ---------------------------------------------------------------------
  // 7. PromptPay QR generation
  //    promptpay.js builds the EMVCo payload; qrcode-generator renders it.
  // ---------------------------------------------------------------------
  function renderQr(satang) {
    if (!state.config || !state.config.promptPayId) return;

    if (satang <= 0) {
      el.qrFrame.innerHTML =
        '<div class="placeholder">选择规格后<br />自动生成支付二维码</div>';
      state.lastQrPayload = null;
      return;
    }

    var amountBaht = satang / 100;
    var payload;
    try {
      // promptpay.js exposes `generatePayload(id, { amount })`.
      payload = window.generatePayload(state.config.promptPayId, { amount: amountBaht });
    } catch (e) {
      console.error("[pomelo] promptpay payload error:", e);
      el.qrFrame.innerHTML =
        '<div class="placeholder">PromptPay ID 无效<br />请联系卖家</div>';
      return;
    }

    // Avoid re-rendering the same QR on every keystroke.
    if (payload === state.lastQrPayload) return;
    state.lastQrPayload = payload;

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
      el.qrFrame.innerHTML =
        '<div class="placeholder">二维码生成失败<br />请刷新重试</div>';
      return;
    }

    var dataUrl = qr.createDataURL(6, 8);
    el.qrFrame.innerHTML = "";
    var img = document.createElement("img");
    img.alt = "PromptPay 支付二维码";
    img.src = dataUrl;
    el.qrFrame.appendChild(img);
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

  function fulfilmentValue() {
    var checked = document.querySelector('input[name="fulfilment"]:checked');
    return checked ? checked.value : "self_pickup";
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
        // spurious "提交订单失败" even though the row was written. We already
        // generated `orderId` client-side and used it as the storage folder, so
        // it is a valid reference to show the buyer.
        return state.supabase.from(TABLE).insert({
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
    el.orderFlow.style.display = "none";
    hideAlert(el.formAlert);
    hideAlert(el.configAlert);
    el.orderRef.textContent = "订单号：" + orderId;
    el.success.classList.add("show");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // ---------------------------------------------------------------------
  // 10. Wiring
  // ---------------------------------------------------------------------
  function wireEvents() {
    el.catalogue.addEventListener("click", onCatalogueClick);

    el.wechatName.addEventListener("input", updateSubmitState);
    el.phone.addEventListener("input", updateSubmitState);

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

  function applyConfig(cfg) {
    state.config = cfg;

    if (cfg.shopName) {
      el.shopName.textContent = cfg.shopName;
      el.footerShop.textContent = cfg.shopName;
      document.title = cfg.shopName + " · 柚子下单";
    }

    if (cfg.promptPayId) {
      el.ppId.textContent = "PromptPay: " + cfg.promptPayId;
    }

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

  function boot() {
    loadBuyer();
    renderCatalogue();
    wireEvents();
    refreshTotals();

    var ready = window.__pomeloConfigReady || Promise.resolve(window.POMELO_CONFIG || {});
    ready.then(function (cfg) {
      applyConfig(cfg || {});
      refreshTotals(); // re-render QR now that promptPayId is known
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
