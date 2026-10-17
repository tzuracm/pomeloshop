/**
 * ============================================================================
 * Pomelo Shop — staff admin console (client)
 * ============================================================================
 * Pairs with admin.html. Responsibilities:
 *   • require a Supabase session (else redirect to /login.html)
 *   • discover the caller's role and show/hide tabs by `data-min`
 *   • call /api/admin/* with `Authorization: Bearer <access_token>`
 *   • render + mutate orders, catalogue, page text, settings and staff roles
 *
 * SECURITY: hiding a tab is UX only. Every endpoint re-checks the role
 * server-side (see api/admin/_auth.js). The client never asserts its own role.
 * ============================================================================
 */
(function () {
  "use strict";

  var ROLE_RANK = { user: 1, admin: 2, owner: 3 };
  var ROLE_LABEL = { user: "员工", admin: "管理员", owner: "所有者" };
  var ORDER_STATUSES = ["pending", "paid", "delivered", "cancelled"];

  /** Content keys the owner may edit on the storefront. */
  var CONTENT_KEYS = [
    { key: "hero_title", label: "主标题" },
    { key: "hero_subtitle", label: "副标题" },
    { key: "social_proof_orders_base", label: "跑马灯 · 今日已售基数（数字）" },
    { key: "social_proof_orders_daily_max", label: "跑马灯 · 今日已售上限（数字，0 = 不限制）" },
    { key: "social_proof_viewers_min", label: "跑马灯 · 浏览人数下限（数字）" },
    { key: "social_proof_viewers_max", label: "跑马灯 · 浏览人数上限（数字）" }
  ];

  /** Settings keys shown in the settings panel. */
  var SETTING_KEYS = [
    { key: "promptpay_id", label: "PromptPay ID" },
    { key: "bank_name", label: "银行名称" },
    { key: "bank_account", label: "银行账号" },
    { key: "bank_holder", label: "账户名" }
  ];

  var state = {
    client: null,
    session: null,
    role: "user",
    email: "",
    activeTab: "orders",
    orders: [],
    catalogue: [],
    deliveryMethods: [],
    content: {},
    settings: {},
    users: [],
    // Payment QR upload flow
    qrFile: null,
    qrDecoded: null
  };

  var el = {};

  // --------------------------------------------------------------------------
  // Small helpers
  // --------------------------------------------------------------------------

  function $(id) { return document.getElementById(id); }

  var AMP = String.fromCharCode(38) + "amp;";
  var LT = String.fromCharCode(38) + "lt;";
  var GT = String.fromCharCode(38) + "gt;";
  var QUOT = String.fromCharCode(38) + "quot;";
  var APOS = String.fromCharCode(38) + "#39;";

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, AMP)
      .replace(/</g, LT)
      .replace(/>/g, GT)
      .replace(/"/g, QUOT)
      .replace(/'/g, APOS);
  }

  function thb(satang) {
    var baht = (Number(satang) || 0) / 100;
    return baht.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }

  /**
   * Return `url` only when it is a safe http(s) URL, else "".
   *
   * `slip_url` is buyer-controlled (anon INSERT). escapeHtml() stops attribute
   * breakout but NOT a `javascript:` scheme, which would run in the admin
   * origin where the Supabase session lives. The DB trigger rejects non-https
   * inserts; this is the matching client-side guard for legacy rows.
   */
  function safeHttpUrl(url) {
    var s = String(url == null ? "" : url).trim();
    if (!s) return "";
    try {
      var parsed = new URL(s, window.location.origin);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.href;
    } catch (e) {
      return "";
    }
    return "";
  }

  function fmtDate(iso) {
    if (!iso) return "—";
    try {
      return new Date(iso).toLocaleString("zh-CN", { hour12: false });
    } catch (e) {
      return String(iso);
    }
  }

  function showAlert(kind, html) {
    el.alert.className = "alert " + kind + " show";
    el.alert.innerHTML = html;
  }

  function hideAlert() {
    el.alert.className = "alert";
    el.alert.innerHTML = "";
  }

  function fail(err) {
    var msg = err && err.message ? err.message : String(err);
    showAlert("error", escapeHtml(msg));
  }

  // --------------------------------------------------------------------------
  // API wrapper — always attaches the bearer token
  // --------------------------------------------------------------------------

  /**
   * Resolve the freshest session before each call. The token captured at boot
   * expires after ~1h; without this the console would keep sending a stale
   * token and bounce the user to login mid-session.
   */
  function currentSession() {
    if (!state.client) return Promise.resolve(state.session);
    return state.client.auth.getSession().then(function (res) {
      var session = res && res.data ? res.data.session : null;
      if (session) state.session = session;
      return state.session;
    }).catch(function () {
      return state.session;
    });
  }

  function api(path, options) {
    options = options || {};

    return currentSession().then(function (session) {
      var headers = { "Content-Type": "application/json" };
      if (session && session.access_token) {
        headers.Authorization = "Bearer " + session.access_token;
      }

      return fetch(path, {
        method: options.method || "GET",
        headers: headers,
        body: options.body ? JSON.stringify(options.body) : undefined
      });
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (res.status === 401) {
          // Session expired / invalid — bounce to login.
          window.location.replace("/login.html");
          throw new Error("登录已过期，请重新登录。");
        }
        if (!res.ok) {
          throw new Error(data && data.error ? data.error : ("请求失败 (" + res.status + ")"));
        }
        return data;
      });
    });
  }

  // --------------------------------------------------------------------------
  // Role gating
  // --------------------------------------------------------------------------

  function applyRoleGating() {
    var have = ROLE_RANK[state.role] || 0;

    // Tabs
    var tabs = el.tabs.querySelectorAll(".tab");
    for (var i = 0; i < tabs.length; i++) {
      var need = ROLE_RANK[tabs[i].getAttribute("data-min")] || 1;
      tabs[i].style.display = have >= need ? "" : "none";
    }

    // If the currently active tab is now hidden, fall back to orders.
    var activeBtn = el.tabs.querySelector('.tab[data-tab="' + state.activeTab + '"]');
    if (activeBtn && activeBtn.style.display === "none") {
      activateTab("orders");
    }

    // Settings: read-only for non-owners.
    var isOwner = state.role === "owner";
    el.settingsSave.style.display = isOwner ? "" : "none";
    el.settingsNote.textContent = isOwner
      ? "这些设置对所有人可见，但只有所有者可以修改。"
      : "这些设置对所有人可见，只有所有者可以修改（你当前为只读）。";

    // Payment QR: everyone admin+ may decode, but only the owner may confirm
    // or clear the active payload. The server enforces this too.
    if (el.qrConfirmBtn) el.qrConfirmBtn.style.display = isOwner ? "" : "none";
    if (el.qrClearBtn) el.qrClearBtn.style.display = isOwner ? "" : "none";

    // Catalogue form: admin+ only (tab is hidden otherwise, but guard anyway).
    var catForm = el.panelCatalogue.querySelector(".form-grid");
    if (catForm) catForm.style.display = have >= ROLE_RANK.admin ? "" : "none";
  }

  function activateTab(name) {
    state.activeTab = name;

    var tabs = el.tabs.querySelectorAll(".tab");
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle("active", tabs[i].getAttribute("data-tab") === name);
    }

    var panels = document.querySelectorAll(".panel");
    for (var j = 0; j < panels.length; j++) {
      panels[j].classList.toggle("active", panels[j].id === "panel-" + name);
    }

    // Lazy-load the panel's data on first view.
    if (name === "orders") loadOrders();
    else if (name === "catalogue") loadCatalogue();
    else if (name === "delivery") loadDeliveryMethods();
    else if (name === "payment") loadPaymentQr();
    else if (name === "content") loadContent();
    else if (name === "settings") loadSettings();
    else if (name === "users") loadUsers();
  }

  // --------------------------------------------------------------------------
  // Orders
  // --------------------------------------------------------------------------

  function loadOrders() {
    el.ordersBody.innerHTML = '<div class="empty">加载中…</div>';
    var status = el.orderStatusFilter.value;
    var qs = status ? ("?status=" + encodeURIComponent(status)) : "";

    // Load the delivery-method labels alongside the orders so the table shows
    // "自提" rather than the raw code. A failure here must not block orders.
    var labelsReady = api("/api/admin/delivery-methods")
      .then(function (data) {
        state.deliveryMethods = data.methods || [];
      })
      .catch(function () {
        state.deliveryMethods = [];
      });

    Promise.all([api("/api/admin/orders" + qs), labelsReady])
      .then(function (results) {
        state.orders = results[0].orders || [];
        renderOrders();
      })
      .catch(function (err) {
        el.ordersBody.innerHTML = '<div class="empty">加载失败</div>';
        fail(err);
      });
  }

  /** Human-readable label for a delivery-method code, with a safe fallback. */
  function fulfilmentLabel(code) {
    if (!code) return "—";
    var m = findDeliveryMethod(code);
    if (m && m.label) return m.label;
    if (code === "self_pickup") return "自提";
    if (code === "grab_cod") return "Grab 到付";
    return code;
  }

  function renderOrders() {
    if (!state.orders.length) {
      el.ordersBody.innerHTML = '<div class="empty">暂无订单</div>';
      return;
    }

    var canEditMore = (ROLE_RANK[state.role] || 0) >= ROLE_RANK.admin;

    var rows = state.orders.map(function (o) {
      var items = Array.isArray(o.items) ? o.items : [];
      var itemsText = items.map(function (it) {
        return escapeHtml(it.label || it.sku || "?") + " × " + escapeHtml(it.qty || 1);
      }).join("<br>");

      var slipUrl = safeHttpUrl(o.slip_url);
      var slip = slipUrl
        ? '<a class="slip-thumb" href="' + escapeHtml(slipUrl) + '" target="_blank" rel="noopener" title="查看转账凭证">' +
            '<img src="' + escapeHtml(slipUrl) + '" alt="转账凭证" loading="lazy" />' +
          "</a>"
        : '<span class="muted">—</span>';

      var statusOptions = ORDER_STATUSES.map(function (s) {
        return '<option value="' + s + '"' + (o.status === s ? " selected" : "") + ">" + s + "</option>";
      }).join("");

      return (
        '<tr data-id="' + escapeHtml(o.id) + '">' +
          '<td class="mono">' + escapeHtml(String(o.id).slice(0, 8)) + "</td>" +
          "<td>" + escapeHtml(o.wechat_name || "—") + "<br><span class=\"muted\">" + escapeHtml(o.phone || "") + "</span></td>" +
          "<td>" + (itemsText || '<span class="muted">—</span>') + "</td>" +
          "<td>" + escapeHtml(fulfilmentLabel(o.fulfilment)) + "</td>" +
          '<td class="mono">฿' + thb(o.total_satang) + "</td>" +
          "<td>" + slip + "</td>" +
          "<td>" + fmtDate(o.created_at) + "</td>" +
          "<td>" +
            '<select class="order-status">' + statusOptions + "</select>" +
            '<textarea class="order-note" placeholder="备注">' + escapeHtml(o.note || "") + "</textarea>" +
            '<div class="row-actions" style="margin-top:6px;">' +
              '<button class="btn order-save">保存</button>' +
            "</div>" +
          "</td>" +
        "</tr>"
      );
    }).join("");

    var hint = canEditMore
      ? ""
      : '<p class="readonly-note">你当前只能修改订单状态和备注。</p>';

    el.ordersBody.innerHTML =
      hint +
      "<table><thead><tr>" +
        "<th>ID</th><th>客户</th><th>商品</th><th>交货方式</th><th>金额</th><th>水单</th><th>下单时间</th><th>操作</th>" +
      "</tr></thead><tbody>" + rows + "</tbody></table>";

    // Wire per-row save buttons.
    var buttons = el.ordersBody.querySelectorAll(".order-save");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].addEventListener("click", onOrderSave);
    }
  }

  /**
   * Export the currently-filtered orders as a real .xlsx workbook.
   *
   * The endpoint is auth-protected, so we cannot simply navigate to it (the
   * browser would not send the bearer token). Instead we fetch it as a blob
   * and then either open it in a new tab ("inline") or save it ("download").
   */
  function exportOrders(mode) {
    var status = el.orderStatusFilter.value;
    var qs = "?mode=" + encodeURIComponent(mode);
    if (status) qs += "&status=" + encodeURIComponent(status);

    var btn = mode === "download" ? el.exportDownload : el.exportOpen;
    var original = btn.textContent;
    btn.disabled = true;
    btn.textContent = "生成中…";
    hideAlert();

    currentSession()
      .then(function (session) {
        var headers = {};
        if (session && session.access_token) {
          headers.Authorization = "Bearer " + session.access_token;
        }
        return fetch("/api/admin/orders-export" + qs, { headers: headers });
      })
      .then(function (res) {
        if (res.status === 401) {
          window.location.replace("/login.html");
          throw new Error("登录已过期，请重新登录。");
        }
        if (!res.ok) {
          return res.json().catch(function () { return {}; }).then(function (data) {
            throw new Error(data && data.error ? data.error : ("导出失败 (" + res.status + ")"));
          });
        }
        return res.blob();
      })
      .then(function (blob) {
        var stamp = new Date().toISOString().slice(0, 10);
        var filename = "pomelo-orders" + (status ? "-" + status : "") + "-" + stamp + ".xlsx";
        var url = URL.createObjectURL(blob);

        if (mode === "download") {
          var a = document.createElement("a");
          a.href = url;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
          showAlert("ok", "Excel 已开始下载。");
        } else {
          // Open in a new tab. Browsers render .xlsx via their built-in viewer
          // (or hand it to Excel / Numbers / Google Sheets).
          var win = window.open(url, "_blank");
          if (!win) {
            // Popup blocked — fall back to a download.
            var a2 = document.createElement("a");
            a2.href = url;
            a2.download = filename;
            document.body.appendChild(a2);
            a2.click();
            document.body.removeChild(a2);
            showAlert("ok", "弹窗被拦截，已改为下载 Excel。");
          } else {
            showAlert("ok", "已在新标签页打开 Excel。");
          }
          setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
        }
      })
      .catch(fail)
      .then(function () {
        btn.disabled = false;
        btn.textContent = original;
      });
  }

  function onOrderSave(ev) {
    var btn = ev.currentTarget;
    var tr = btn.closest("tr");
    var id = tr.getAttribute("data-id");
    var status = tr.querySelector(".order-status").value;
    var note = tr.querySelector(".order-note").value;

    btn.disabled = true;
    hideAlert();

    api("/api/admin/orders", { method: "PATCH", body: { id: id, status: status, note: note } })
      .then(function () {
        btn.disabled = false;
        showAlert("ok", "订单已更新。");
      })
      .catch(function (err) {
        btn.disabled = false;
        fail(err);
      });
  }

  // --------------------------------------------------------------------------
  // Catalogue
  // --------------------------------------------------------------------------

  function loadCatalogue() {
    el.catalogueBody.innerHTML = '<div class="empty">加载中…</div>';
    api("/api/admin/catalogue")
      .then(function (data) {
        state.catalogue = data.items || [];
        renderCatalogue();
      })
      .catch(function (err) {
        el.catalogueBody.innerHTML = '<div class="empty">加载失败</div>';
        fail(err);
      });
  }

  function renderCatalogue() {
    if (!state.catalogue.length) {
      el.catalogueBody.innerHTML = '<div class="empty">暂无商品</div>';
      return;
    }

    var rows = state.catalogue.map(function (it) {
      var status = it.active
        ? '<span class="pill paid">在售</span>'
        : '<span class="pill cancelled">已下架</span>';
      return (
        '<tr data-sku="' + escapeHtml(it.sku) + '">' +
          '<td class="mono">' + escapeHtml(it.sku) + "</td>" +
          "<td>" + escapeHtml(it.label) + "</td>" +
          '<td class="mono">฿' + escapeHtml(it.unit_price) + "</td>" +
          "<td>" + escapeHtml(it.sort_order) + "</td>" +
          "<td>" + status + "</td>" +
          '<td><div class="row-actions">' +
            '<button class="btn secondary cat-edit">编辑</button>' +
            '<button class="btn ' + (it.active ? "secondary" : "") + ' cat-toggle">' +
              (it.active ? "下架" : "上架") +
            "</button>" +
            '<button class="btn danger cat-del">删除</button>' +
          "</div></td>" +
        "</tr>"
      );
    }).join("");

    el.catalogueBody.innerHTML =
      "<table><thead><tr>" +
        "<th>SKU</th><th>名称</th><th>单价</th><th>排序</th><th>状态</th><th>操作</th>" +
      "</tr></thead><tbody>" + rows + "</tbody></table>";

    var edits = el.catalogueBody.querySelectorAll(".cat-edit");
    for (var i = 0; i < edits.length; i++) edits[i].addEventListener("click", onCatalogueEdit);

    var toggles = el.catalogueBody.querySelectorAll(".cat-toggle");
    for (var j = 0; j < toggles.length; j++) toggles[j].addEventListener("click", onCatalogueToggle);

    var dels = el.catalogueBody.querySelectorAll(".cat-del");
    for (var k = 0; k < dels.length; k++) dels[k].addEventListener("click", onCatalogueDelete);
  }

  function findCatalogueItem(sku) {
    for (var i = 0; i < state.catalogue.length; i++) {
      if (state.catalogue[i].sku === sku) return state.catalogue[i];
    }
    return null;
  }

  /**
   * Flip a product between on-sale and off-sale. The storefront only receives
   * `active` items from /api/config, so a down-listed product disappears from
   * the buyer page on their next load.
   */
  function onCatalogueToggle(ev) {
    var btn = ev.currentTarget;
    var sku = btn.closest("tr").getAttribute("data-sku");
    var item = findCatalogueItem(sku);
    if (!item) return;

    var next = !item.active;
    btn.disabled = true;
    hideAlert();

    api("/api/admin/catalogue", { method: "PATCH", body: { sku: sku, active: next } })
      .then(function () {
        btn.disabled = false;
        showAlert("ok", next ? "商品已上架，买家端可见。" : "商品已下架，买家端不再显示。");
        loadCatalogue();
      })
      .catch(function (err) {
        btn.disabled = false;
        fail(err);
      });
  }

  function onCatalogueEdit(ev) {
    var sku = ev.currentTarget.closest("tr").getAttribute("data-sku");
    var item = null;
    for (var i = 0; i < state.catalogue.length; i++) {
      if (state.catalogue[i].sku === sku) { item = state.catalogue[i]; break; }
    }
    if (!item) return;

    el.catSku.value = item.sku;
    el.catSku.readOnly = true;
    el.catSku.placeholder = "保存后自动生成";
    el.catLabel.value = item.label;
    el.catPrice.value = item.unit_price;
    el.catSort.value = item.sort_order;
    el.catSave.textContent = "更新商品";
    el.catSave.setAttribute("data-mode", "update");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function onCatalogueDelete(ev) {
    var sku = ev.currentTarget.closest("tr").getAttribute("data-sku");
    if (!window.confirm("确定删除商品 " + sku + " 吗？")) return;

    hideAlert();
    api("/api/admin/catalogue", { method: "DELETE", body: { sku: sku } })
      .then(function () {
        showAlert("ok", "商品已删除。");
        loadCatalogue();
      })
      .catch(fail);
  }

  function onCatalogueSave() {
    var mode = el.catSave.getAttribute("data-mode") === "update" ? "PATCH" : "POST";
    var sku = el.catSku.value.trim();
    var label = el.catLabel.value.trim();
    var price = parseInt(el.catPrice.value, 10);
    var sort = parseInt(el.catSort.value, 10);

    if (!label) { showAlert("error", "请填写商品名称。"); return; }
    if (!Number.isInteger(price) || price < 0) { showAlert("error", "单价必须是非负整数 (THB)。"); return; }

    // On create the server allocates the SKU code; on update it is the key.
    var body = { label: label, unit_price: price };
    if (mode === "PATCH") body.sku = sku;
    if (Number.isInteger(sort)) body.sort_order = sort;

    el.catSave.disabled = true;
    hideAlert();

    api("/api/admin/catalogue", { method: mode, body: body })
      .then(function (data) {
        el.catSave.disabled = false;
        resetCatalogueForm();
        var created = data && data.item && data.item.sku ? "（SKU: " + data.item.sku + "）" : "";
        showAlert("ok", mode === "POST" ? "商品已创建" + created + "。" : "商品已更新。");
        loadCatalogue();
      })
      .catch(function (err) {
        el.catSave.disabled = false;
        fail(err);
      });
  }

  function resetCatalogueForm() {
    el.catSku.value = "";
    el.catSku.readOnly = true;
    el.catSku.placeholder = "保存后自动生成";
    el.catLabel.value = "";
    el.catPrice.value = "";
    el.catSort.value = "";
    el.catSave.textContent = "保存商品";
    el.catSave.removeAttribute("data-mode");
  }

  // --------------------------------------------------------------------------
  // Delivery methods (交货方式)
  // --------------------------------------------------------------------------

  function loadDeliveryMethods() {
    el.deliveryBody.innerHTML = '<div class="empty">加载中…</div>';
    api("/api/admin/delivery-methods")
      .then(function (data) {
        state.deliveryMethods = data.methods || [];
        renderDeliveryMethods();
      })
      .catch(function (err) {
        el.deliveryBody.innerHTML = '<div class="empty">加载失败</div>';
        fail(err);
      });
  }

  function renderDeliveryMethods() {
    if (!state.deliveryMethods.length) {
      el.deliveryBody.innerHTML = '<div class="empty">暂无交货方式</div>';
      return;
    }

    var rows = state.deliveryMethods.map(function (m) {
      var map = m.map_url
        ? '<a class="slip-link" href="' + escapeHtml(m.map_url) + '" target="_blank" rel="noopener">打开地图</a>'
        : '<span class="muted">—</span>';
      return (
        '<tr data-code="' + escapeHtml(m.code) + '">' +
          '<td class="mono">' + escapeHtml(m.code) + "</td>" +
          "<td>" + escapeHtml(m.label) +
            (m.description ? '<br><span class="muted">' + escapeHtml(m.description) + "</span>" : "") +
          "</td>" +
          "<td>" + (m.time_window ? escapeHtml(m.time_window) : '<span class="muted">—</span>') + "</td>" +
          "<td>" + map + "</td>" +
          "<td>" + escapeHtml(m.sort_order) + "</td>" +
          "<td>" + (m.active ? "是" : "否") + "</td>" +
          '<td><div class="row-actions">' +
            '<button class="btn secondary dm-edit">编辑</button>' +
            '<button class="btn secondary dm-toggle">' + (m.active ? "停用" : "启用") + "</button>" +
            '<button class="btn danger dm-del">删除</button>' +
          "</div></td>" +
        "</tr>"
      );
    }).join("");

    el.deliveryBody.innerHTML =
      "<table><thead><tr>" +
        "<th>代码</th><th>名称</th><th>取货时间</th><th>地图</th><th>排序</th><th>启用</th><th>操作</th>" +
      "</tr></thead><tbody>" + rows + "</tbody></table>";

    var edits = el.deliveryBody.querySelectorAll(".dm-edit");
    for (var i = 0; i < edits.length; i++) edits[i].addEventListener("click", onDeliveryEdit);

    var toggles = el.deliveryBody.querySelectorAll(".dm-toggle");
    for (var j = 0; j < toggles.length; j++) toggles[j].addEventListener("click", onDeliveryToggle);

    var dels = el.deliveryBody.querySelectorAll(".dm-del");
    for (var k = 0; k < dels.length; k++) dels[k].addEventListener("click", onDeliveryDelete);
  }

  function findDeliveryMethod(code) {
    for (var i = 0; i < state.deliveryMethods.length; i++) {
      if (state.deliveryMethods[i].code === code) return state.deliveryMethods[i];
    }
    return null;
  }

  function onDeliveryEdit(ev) {
    var code = ev.currentTarget.closest("tr").getAttribute("data-code");
    var m = findDeliveryMethod(code);
    if (!m) return;

    el.dmCode.value = m.code;
    el.dmLabel.value = m.label || "";
    el.dmDescription.value = m.description || "";
    el.dmTimeWindow.value = m.time_window || "";
    el.dmMapUrl.value = m.map_url || "";
    el.dmSort.value = m.sort_order;
    el.dmSave.textContent = "更新方式";
    el.dmSave.setAttribute("data-mode", "update");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function onDeliveryToggle(ev) {
    var code = ev.currentTarget.closest("tr").getAttribute("data-code");
    var m = findDeliveryMethod(code);
    if (!m) return;

    hideAlert();
    api("/api/admin/delivery-methods", {
      method: "PATCH",
      body: { code: code, active: !m.active }
    })
      .then(function () {
        showAlert("ok", m.active ? "已停用该交货方式。" : "已启用该交货方式。");
        loadDeliveryMethods();
      })
      .catch(fail);
  }

  function onDeliveryDelete(ev) {
    var code = ev.currentTarget.closest("tr").getAttribute("data-code");
    if (!window.confirm("确定删除交货方式 " + code + " 吗？历史订单不受影响。")) return;

    hideAlert();
    api("/api/admin/delivery-methods", { method: "DELETE", body: { code: code } })
      .then(function () {
        showAlert("ok", "交货方式已删除。");
        loadDeliveryMethods();
      })
      .catch(fail);
  }

  function onDeliverySave() {
    var mode = el.dmSave.getAttribute("data-mode") === "update" ? "PATCH" : "POST";
    var code = el.dmCode.value.trim();
    var label = el.dmLabel.value.trim();
    var sort = parseInt(el.dmSort.value, 10);

    if (!label) { showAlert("error", "请填写交货方式名称。"); return; }

    var body = {
      label: label,
      description: el.dmDescription.value.trim(),
      time_window: el.dmTimeWindow.value.trim(),
      map_url: el.dmMapUrl.value.trim()
    };
    if (mode === "PATCH") body.code = code;
    if (Number.isInteger(sort)) body.sort_order = sort;

    el.dmSave.disabled = true;
    hideAlert();

    api("/api/admin/delivery-methods", { method: mode, body: body })
      .then(function (data) {
        el.dmSave.disabled = false;
        resetDeliveryForm();
        var created = data && data.method && data.method.code ? "（代码: " + data.method.code + "）" : "";
        showAlert("ok", mode === "POST" ? "交货方式已创建" + created + "。" : "交货方式已更新。");
        loadDeliveryMethods();
      })
      .catch(function (err) {
        el.dmSave.disabled = false;
        fail(err);
      });
  }

  function resetDeliveryForm() {
    el.dmCode.value = "";
    el.dmLabel.value = "";
    el.dmDescription.value = "";
    el.dmTimeWindow.value = "";
    el.dmMapUrl.value = "";
    el.dmSort.value = "";
    el.dmSave.textContent = "保存方式";
    el.dmSave.removeAttribute("data-mode");
  }

  // --------------------------------------------------------------------------
  // Page content (owner)
  // --------------------------------------------------------------------------

  function loadContent() {
    el.contentBody.innerHTML = '<div class="empty">加载中…</div>';
    api("/api/admin/content")
      .then(function (data) {
        state.content = {};
        (data.content || []).forEach(function (row) { state.content[row.key] = row.value; });
        renderContent();
      })
      .catch(function (err) {
        el.contentBody.innerHTML = '<div class="empty">加载失败</div>';
        fail(err);
      });
  }

  function renderContent() {
    var fields = CONTENT_KEYS.map(function (c) {
      var val = state.content[c.key] != null ? state.content[c.key] : "";
      return (
        '<div style="margin-bottom:12px;">' +
          '<label for="content-' + escapeHtml(c.key) + '">' + escapeHtml(c.label) +
            ' <span class="muted mono">(' + escapeHtml(c.key) + ")</span></label>" +
          '<textarea id="content-' + escapeHtml(c.key) + '" data-key="' + escapeHtml(c.key) + '">' +
            escapeHtml(val) +
          "</textarea>" +
        "</div>"
      );
    }).join("");

    el.contentBody.innerHTML = fields;
  }

  function onContentSave() {
    var areas = el.contentBody.querySelectorAll("textarea[data-key]");
    var entries = {};
    for (var i = 0; i < areas.length; i++) {
      entries[areas[i].getAttribute("data-key")] = areas[i].value;
    }

    el.contentSave.disabled = true;
    hideAlert();

    api("/api/admin/content", { method: "PUT", body: { entries: entries } })
      .then(function () {
        el.contentSave.disabled = false;
        showAlert("ok", "页面文字已保存。");
      })
      .catch(function (err) {
        el.contentSave.disabled = false;
        fail(err);
      });
  }

  // --------------------------------------------------------------------------
  // Settings (read: all, write: owner)
  // --------------------------------------------------------------------------

  function loadSettings() {
    el.settingsBody.innerHTML = '<div class="empty">加载中…</div>';
    api("/api/admin/settings")
      .then(function (data) {
        state.settings = {};
        (data.settings || []).forEach(function (row) { state.settings[row.key] = row.value; });
        renderSettings();
      })
      .catch(function (err) {
        el.settingsBody.innerHTML = '<div class="empty">加载失败</div>';
        fail(err);
      });
  }

  function renderSettings() {
    var isOwner = state.role === "owner";

    var fields = SETTING_KEYS.map(function (s) {
      var val = state.settings[s.key] != null ? state.settings[s.key] : "";
      return (
        '<div style="margin-bottom:12px;">' +
          '<label for="setting-' + escapeHtml(s.key) + '">' + escapeHtml(s.label) +
            ' <span class="muted mono">(' + escapeHtml(s.key) + ")</span></label>" +
          '<input type="text" id="setting-' + escapeHtml(s.key) + '" data-key="' + escapeHtml(s.key) + '"' +
            ' value="' + escapeHtml(val) + '"' + (isOwner ? "" : " readonly") + " />" +
        "</div>"
      );
    }).join("");

    el.settingsBody.innerHTML = fields;
  }

  function onSettingsSave() {
    var inputs = el.settingsBody.querySelectorAll("input[data-key]");
    var entries = {};
    for (var i = 0; i < inputs.length; i++) {
      entries[inputs[i].getAttribute("data-key")] = inputs[i].value;
    }

    el.settingsSave.disabled = true;
    hideAlert();

    api("/api/admin/settings", { method: "PUT", body: { entries: entries } })
      .then(function () {
        el.settingsSave.disabled = false;
        showAlert("ok", "设置已保存。");
      })
      .catch(function (err) {
        el.settingsSave.disabled = false;
        fail(err);
      });
  }

  // --------------------------------------------------------------------------
  // Payment QR (decode: admin+, confirm/clear: owner)
  // --------------------------------------------------------------------------
  //
  // Flow:
  //   1. admin picks a screenshot of the bank's receive-money QR
  //   2. we read the QR pixels in the browser (BarcodeDetector) and POST the
  //      raw payload to /api/admin/payment-qr for authoritative decoding
  //   3. the decoded receiving info is shown for the admin to verify
  //   4. the owner confirms -> PUT stores it as `promptpay_qr_payload`
  //   5. the storefront rebuilds its QR from that payload (see app.js)

  function loadPaymentQr() {
    el.qrCurrent.innerHTML = '<div class="empty">加载中…</div>';
    api("/api/admin/settings")
      .then(function (data) {
        state.settings = {};
        (data.settings || []).forEach(function (row) { state.settings[row.key] = row.value; });
        renderCurrentPaymentQr();
      })
      .catch(function (err) {
        el.qrCurrent.innerHTML = '<div class="empty">加载失败</div>';
        fail(err);
      });
  }

  /** Render the currently confirmed payload (or a "not set" notice). */
  function renderCurrentPaymentQr() {
    var payload = state.settings.promptpay_qr_payload || "";
    var isOwner = state.role === "owner";

    el.qrClearBtn.style.display = isOwner && payload ? "" : "none";

    if (!payload) {
      el.qrCurrent.innerHTML =
        '<h3>当前收款二维码</h3>' +
        '<p class="muted" style="margin:0;">尚未上传并确认收款二维码。' +
          '买家目前使用「敏感设置」中的 PromptPay ID 生成二维码。</p>';
      return;
    }

    // Decode locally for display — the server already validated it on save.
    var info;
    try {
      info = decodeEmvLocally(payload);
    } catch (e) {
      info = null;
    }

    var rows = info
      ? '<dl>' +
          "<dt>PromptPay ID</dt><dd>" + escapeHtml(info.promptPayId) + "</dd>" +
          "<dt>类型</dt><dd>" + escapeHtml(targetTypeLabel(info.targetType)) + "</dd>" +
          "<dt>金额</dt><dd>" + (info.amount != null ? "฿" + escapeHtml(String(info.amount)) : "任意金额（静态码）") + "</dd>" +
        "</dl>"
      : '<p class="muted" style="margin:0;">已保存收款二维码（无法在本地解析）。</p>';

    el.qrCurrent.innerHTML =
      "<h3>当前收款二维码 <span class=\"pill paid\">已确认</span></h3>" +
      rows +
      '<div class="qr-mini" id="qrCurrentMini"></div>';

    // Draw a preview of the confirmed payload.
    var mini = $("qrCurrentMini");
    if (mini && window.qrcode) {
      try {
        var qr = window.qrcode(0, "M");
        qr.addData(payload);
        qr.make();
        var img = document.createElement("img");
        img.alt = "当前收款二维码";
        img.src = qr.createDataURL(4, 4);
        mini.appendChild(img);
      } catch (e) {
        mini.textContent = "预览生成失败";
      }
    }
  }

  /** Human label for a PromptPay target type. */
  function targetTypeLabel(type) {
    if (type === "mobile") return "手机号";
    if (type === "national-id") return "身份证 / 税号";
    if (type === "e-wallet") return "电子钱包";
    return type || "—";
  }

  /**
   * Minimal local EMVCo decoder for display purposes only. The server is the
   * authority; this just lets us show the confirmed payload without a round
   * trip. Returns { promptPayId, targetType, amount }.
   */
  function decodeEmvLocally(payload) {
    function parseTlv(str) {
      var out = [];
      var i = 0;
      while (i < str.length) {
        var id = str.slice(i, i + 2);
        var len = parseInt(str.slice(i + 2, i + 4), 10);
        out.push({ id: id, value: str.slice(i + 4, i + 4 + len) });
        i += 4 + len;
      }
      return out;
    }
    function field(fields, id) {
      for (var i = 0; i < fields.length; i++) if (fields[i].id === id) return fields[i].value;
      return "";
    }
    var fields = parseTlv(payload);
    var merchant = parseTlv(field(fields, "29"));
    var raw = field(merchant, "01") || field(merchant, "02") || field(merchant, "03");
    var digits = String(raw).replace(/[^0-9]/g, "");
    var id = digits;
    if (digits.length === 13 && digits.indexOf("0066") === 0) id = "0" + digits.slice(4);
    else if (digits.length === 13 && digits.indexOf("66") === 0) id = "0" + digits.slice(2);
    var amountRaw = field(fields, "54");
    var type;
    if (digits.length >= 15) type = "e-wallet";
    else if (digits.length === 13 && (digits.indexOf("0066") === 0 || digits.indexOf("66") === 0)) type = "mobile";
    else if (digits.length >= 13) type = "national-id";
    else type = "mobile";
    return {
      promptPayId: id,
      targetType: type,
      amount: amountRaw ? Number(amountRaw) : null
    };
  }

  /** Read the QR payload from an image file using the BarcodeDetector API. */
  function detectQrPayload(file) {
    if (!("BarcodeDetector" in window)) {
      return Promise.reject(new Error(
        "当前浏览器不支持二维码识别（BarcodeDetector）。请使用最新版 Chrome / Edge / Safari。"
      ));
    }
    var detector;
    try {
      detector = new window.BarcodeDetector({ formats: ["qr_code"] });
    } catch (e) {
      return Promise.reject(new Error("无法初始化二维码识别器。"));
    }

    return createImageBitmap(file).then(function (bitmap) {
      return detector.detect(bitmap).then(function (codes) {
        if (!codes || !codes.length) {
          throw new Error("图片中未识别到二维码，请上传更清晰的截图。");
        }
        return codes[0].rawValue;
      });
    });
  }

  function onQrFileChange() {
    var file = el.qrFile.files && el.qrFile.files[0];
    state.qrFile = file || null;
    state.qrDecoded = null;
    el.qrDecodeBtn.disabled = !file;
    el.qrConfirmBar.hidden = true;
    el.qrDecoded.hidden = true;
    el.qrDecoded.innerHTML = "";

    if (!file) {
      el.qrUploadPreview.hidden = true;
      return;
    }

    var url = URL.createObjectURL(file);
    el.qrUploadImg.src = url;
    el.qrUploadPreview.hidden = false;
  }

  function onQrDecode() {
    if (!state.qrFile) return;
    el.qrDecodeBtn.disabled = true;
    hideAlert();

    detectQrPayload(state.qrFile)
      .then(function (payload) {
        // Ask the server to authoritatively parse + validate the payload.
        return api("/api/admin/payment-qr", { method: "POST", body: { payload: payload } });
      })
      .then(function (data) {
        state.qrDecoded = data.decoded;
        renderDecodedQr(data.decoded);
        el.qrDecodeBtn.disabled = false;
      })
      .catch(function (err) {
        el.qrDecodeBtn.disabled = false;
        fail(err);
      });
  }

  /** Show the decoded receiving info and the confirm bar. */
  function renderDecodedQr(decoded) {
    var crc = decoded.crcOk
      ? '<span class="ok">✓ 校验通过</span>'
      : '<span class="warn">✗ 校验失败</span>';

    el.qrDecoded.innerHTML =
      "<h3>解码结果（请核对）</h3>" +
      "<dl>" +
        "<dt>PromptPay ID</dt><dd>" + escapeHtml(decoded.promptPayId) + "</dd>" +
        "<dt>类型</dt><dd>" + escapeHtml(targetTypeLabel(decoded.targetType)) + "</dd>" +
        "<dt>金额</dt><dd>" +
          (decoded.amount != null ? "฿" + escapeHtml(String(decoded.amount)) : "任意金额（静态码）") +
        "</dd>" +
        "<dt>国家 / 币种</dt><dd>" + escapeHtml(decoded.country || "—") + " / " +
          escapeHtml(decoded.currency || "—") + "</dd>" +
        "<dt>校验</dt><dd>" + crc + "</dd>" +
      "</dl>";

    el.qrDecoded.hidden = false;

    var isOwner = state.role === "owner";
    el.qrConfirmBar.hidden = false;
    el.qrConfirmBtn.style.display = isOwner ? "" : "none";
    if (!isOwner) {
      showAlert("error", "解码成功。只有所有者可以确认并启用收款二维码。");
    }
  }

  function onQrConfirm() {
    if (!state.qrDecoded || !state.qrDecoded.payload) return;
    el.qrConfirmBtn.disabled = true;
    hideAlert();

    api("/api/admin/payment-qr", { method: "PUT", body: { payload: state.qrDecoded.payload } })
      .then(function (data) {
        el.qrConfirmBtn.disabled = false;
        state.settings.promptpay_qr_payload = data.decoded.payload;
        el.qrConfirmBar.hidden = true;
        el.qrDecoded.hidden = true;
        el.qrUploadPreview.hidden = true;
        el.qrFile.value = "";
        el.qrDecodeBtn.disabled = true;
        state.qrFile = null;
        state.qrDecoded = null;
        renderCurrentPaymentQr();
        showAlert("ok", "收款二维码已确认并启用。买家下单时将使用此账户生成支付二维码。");
      })
      .catch(function (err) {
        el.qrConfirmBtn.disabled = false;
        fail(err);
      });
  }

  function onQrCancel() {
    state.qrDecoded = null;
    el.qrConfirmBar.hidden = true;
    el.qrDecoded.hidden = true;
    el.qrDecoded.innerHTML = "";
  }

  function onQrClear() {
    if (!window.confirm("确定要清除已确认的收款二维码吗？清除后将回退到 PromptPay ID。")) return;
    el.qrClearBtn.disabled = true;
    hideAlert();

    api("/api/admin/payment-qr", { method: "DELETE" })
      .then(function () {
        el.qrClearBtn.disabled = false;
        delete state.settings.promptpay_qr_payload;
        renderCurrentPaymentQr();
        showAlert("ok", "已清除收款二维码，买家将使用 PromptPay ID 生成二维码。");
      })
      .catch(function (err) {
        el.qrClearBtn.disabled = false;
        fail(err);
      });
  }

  // --------------------------------------------------------------------------
  // Users & roles (owner)
  // --------------------------------------------------------------------------

  function loadUsers() {
    el.usersBody.innerHTML = '<div class="empty">加载中…</div>';
    api("/api/admin/users")
      .then(function (data) {
        state.users = data.users || [];
        renderUsers();
      })
      .catch(function (err) {
        el.usersBody.innerHTML = '<div class="empty">加载失败</div>';
        fail(err);
      });
  }

  var STATUS_LABEL = { pending: "待激活", active: "已启用", suspended: "已停用" };

  function renderUsers() {
    if (!state.users.length) {
      el.usersBody.innerHTML = '<div class="empty">暂无员工</div>';
      return;
    }

    var rows = state.users.map(function (u) {
      var isSelf = state.session && u.id === state.session.user.id;
      var roleOptions = ["user", "admin", "owner"].map(function (r) {
        return '<option value="' + r + '"' + (u.role === r ? " selected" : "") + ">" +
          escapeHtml(ROLE_LABEL[r] || r) + " (" + r + ")</option>";
      }).join("");
      var statusOptions = ["active", "suspended", "pending"].map(function (s) {
        return '<option value="' + s + '"' + (u.status === s ? " selected" : "") + ">" +
          escapeHtml(STATUS_LABEL[s] || s) + "</option>";
      }).join("");
      var pwBadge = u.must_change_password
        ? ' <span class="pill pending" title="仍在使用初始密码">待改密</span>'
        : "";

      return (
        '<tr data-id="' + escapeHtml(u.id) + '">' +
          "<td>" + escapeHtml(u.email || "—") + (isSelf ? ' <span class="muted">(你)</span>' : "") + "</td>" +
          "<td>" + escapeHtml(u.full_name || "—") + "</td>" +
          "<td>" + fmtDate(u.created_at) + "</td>" +
          "<td>" +
            (isSelf
              ? '<span class="pill ' + escapeHtml(u.role) + '">' + escapeHtml(ROLE_LABEL[u.role] || u.role) + "</span>" +
                ' <span class="muted">' + escapeHtml(STATUS_LABEL[u.status] || u.status || "") + "</span>" +
                pwBadge
              : '<select class="user-role">' + roleOptions + "</select>" +
                '<select class="user-status" style="margin-left:6px;">' + statusOptions + "</select>" +
                pwBadge +
                '<div class="row-actions" style="margin-top:6px;">' +
                  '<button class="btn user-save">保存</button>' +
                  '<button class="btn secondary user-reset">重置密码</button>' +
                "</div>") +
          "</td>" +
        "</tr>"
      );
    }).join("");

    el.usersBody.innerHTML =
      "<table><thead><tr>" +
        "<th>邮箱</th><th>姓名</th><th>加入时间</th><th>角色 / 状态</th>" +
      "</tr></thead><tbody>" + rows + "</tbody></table>";

    var buttons = el.usersBody.querySelectorAll(".user-save");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].addEventListener("click", onUserSave);
    }

    var resets = el.usersBody.querySelectorAll(".user-reset");
    for (var j = 0; j < resets.length; j++) {
      resets[j].addEventListener("click", onUserResetPassword);
    }
  }

  function onUserSave(ev) {
    var btn = ev.currentTarget;
    var tr = btn.closest("tr");
    var userId = tr.getAttribute("data-id");
    var role = tr.querySelector(".user-role").value;
    var status = tr.querySelector(".user-status").value;

    btn.disabled = true;
    hideAlert();

    api("/api/admin/users", { method: "PATCH", body: { userId: userId, role: role, status: status } })
      .then(function () {
        btn.disabled = false;
        showAlert("ok", "角色与状态已更新。");
        loadUsers();
      })
      .catch(function (err) {
        btn.disabled = false;
        fail(err);
      });
  }

  /** Owner-only: put the account back on the bootstrap password (123456). */
  function onUserResetPassword(ev) {
    var btn = ev.currentTarget;
    var tr = btn.closest("tr");
    var userId = tr.getAttribute("data-id");

    if (!window.confirm("将该账号密码重置为 123456，并要求其下次登录时修改？")) return;

    btn.disabled = true;
    hideAlert();

    api("/api/admin/users", { method: "PATCH", body: { userId: userId, resetPassword: true } })
      .then(function () {
        btn.disabled = false;
        showAlert("ok", "密码已重置为 123456，该账号下次登录必须修改密码。");
        loadUsers();
      })
      .catch(function (err) {
        btn.disabled = false;
        fail(err);
      });
  }

  /**
   * Owner-only: provision a new staff account (public sign-up is disabled).
   * The email is the login identity; the server assigns the bootstrap password
   * (123456) and flags the account so the holder must change it on first login.
   */
  function onCreateUser() {
    var email = el.newUserEmail.value.trim();
    var fullName = el.newUserName.value.trim();
    var role = el.newUserRole.value;
    var status = el.newUserStatus.value;

    if (!email) { showAlert("error", "请填写邮箱。"); return; }

    el.createUserBtn.disabled = true;
    hideAlert();

    api("/api/admin/users", {
      method: "POST",
      body: { email: email, fullName: fullName, role: role, status: status }
    })
      .then(function () {
        el.createUserBtn.disabled = false;
        el.newUserEmail.value = "";
        el.newUserName.value = "";
        showAlert("ok", "员工账号已创建，初始密码为 123456，首次登录后必须修改。");
        loadUsers();
      })
      .catch(function (err) {
        el.createUserBtn.disabled = false;
        fail(err);
      });
  }

  // --------------------------------------------------------------------------
  // Boot
  // --------------------------------------------------------------------------

  function cacheElements() {
    el.alert = $("adminAlert");
    el.tabs = $("tabs");
    el.whoEmail = $("whoEmail");
    el.whoRole = $("whoRole");
    el.signOutBtn = $("signOutBtn");

    el.panelCatalogue = $("panel-catalogue");

    el.orderStatusFilter = $("orderStatusFilter");
    el.refreshOrders = $("refreshOrders");
    el.exportOpen = $("exportOpen");
    el.exportDownload = $("exportDownload");
    el.ordersBody = $("ordersBody");

    el.catSku = $("catSku");
    el.catLabel = $("catLabel");
    el.catPrice = $("catPrice");
    el.catSort = $("catSort");
    el.catSave = $("catSave");
    el.catalogueBody = $("catalogueBody");

    el.dmCode = $("dmCode");
    el.dmLabel = $("dmLabel");
    el.dmDescription = $("dmDescription");
    el.dmTimeWindow = $("dmTimeWindow");
    el.dmMapUrl = $("dmMapUrl");
    el.dmSort = $("dmSort");
    el.dmSave = $("dmSave");
    el.deliveryBody = $("deliveryBody");

    el.qrFile = $("qrFile");
    el.qrDecodeBtn = $("qrDecodeBtn");
    el.qrClearBtn = $("qrClearBtn");
    el.qrUploadPreview = $("qrUploadPreview");
    el.qrUploadImg = $("qrUploadImg");
    el.qrDecoded = $("qrDecoded");
    el.qrConfirmBar = $("qrConfirmBar");
    el.qrConfirmBtn = $("qrConfirmBtn");
    el.qrCancelBtn = $("qrCancelBtn");
    el.qrCurrent = $("qrCurrent");

    el.contentBody = $("contentBody");
    el.contentSave = $("contentSave");

    el.settingsNote = $("settingsNote");
    el.settingsBody = $("settingsBody");
    el.settingsSave = $("settingsSave");

    el.usersBody = $("usersBody");
    el.newUserEmail = $("newUserEmail");
    el.newUserName = $("newUserName");
    el.newUserRole = $("newUserRole");
    el.newUserStatus = $("newUserStatus");
    el.createUserBtn = $("createUserBtn");

    // Forced password change modal
    el.pwModal = $("pwModal");
    el.pwAlert = $("pwAlert");
    el.pwCurrent = $("pwCurrent");
    el.pwNew = $("pwNew");
    el.pwConfirm = $("pwConfirm");
    el.pwSubmit = $("pwSubmit");
    el.pwSignOut = $("pwSignOut");
  }

  function wireEvents() {
    // Tab clicks
    el.tabs.addEventListener("click", function (ev) {
      var btn = ev.target.closest(".tab");
      if (!btn) return;
      activateTab(btn.getAttribute("data-tab"));
    });

    el.signOutBtn.addEventListener("click", function () {
      state.client.auth.signOut().then(function () {
        window.location.replace("/login.html");
      });
    });

    el.refreshOrders.addEventListener("click", loadOrders);
    el.orderStatusFilter.addEventListener("change", loadOrders);
    el.exportOpen.addEventListener("click", function () { exportOrders("inline"); });
    el.exportDownload.addEventListener("click", function () { exportOrders("download"); });

    el.catSave.addEventListener("click", onCatalogueSave);
    el.dmSave.addEventListener("click", onDeliverySave);
    el.contentSave.addEventListener("click", onContentSave);
    el.settingsSave.addEventListener("click", onSettingsSave);

    el.qrFile.addEventListener("change", onQrFileChange);
    el.qrDecodeBtn.addEventListener("click", onQrDecode);
    el.qrConfirmBtn.addEventListener("click", onQrConfirm);
    el.qrCancelBtn.addEventListener("click", onQrCancel);
    el.qrClearBtn.addEventListener("click", onQrClear);

    if (el.createUserBtn) el.createUserBtn.addEventListener("click", onCreateUser);

    // Forced password change modal
    if (el.pwSubmit) el.pwSubmit.addEventListener("click", onChangePassword);
    if (el.pwSignOut) {
      el.pwSignOut.addEventListener("click", function () {
        state.client.auth.signOut().then(function () {
          window.location.replace("/login.html");
        });
      });
    }
  }

  // --------------------------------------------------------------------------
  // Forced password change (first login)
  // --------------------------------------------------------------------------

  function pwAlert(kind, html) {
    el.pwAlert.className = "alert " + kind + " show";
    el.pwAlert.innerHTML = html;
  }

  function pwClearAlert() {
    el.pwAlert.className = "alert";
    el.pwAlert.innerHTML = "";
  }

  /** Show the blocking modal. The console is unusable until it is dismissed. */
  function showPasswordModal() {
    el.pwModal.hidden = false;
    el.pwCurrent.value = "";
    el.pwNew.value = "";
    el.pwConfirm.value = "";
    pwClearAlert();
    el.pwCurrent.focus();
  }

  function hidePasswordModal() {
    el.pwModal.hidden = true;
  }

  function onChangePassword() {
    var current = el.pwCurrent.value;
    var next = el.pwNew.value;
    var confirm = el.pwConfirm.value;

    pwClearAlert();

    if (!current) { pwAlert("error", "请输入当前密码。"); return; }
    if (next.length < 8) { pwAlert("error", "新密码至少 8 位。"); return; }
    if (next !== confirm) { pwAlert("error", "两次输入的新密码不一致。"); return; }
    if (next === current) { pwAlert("error", "新密码不能与当前密码相同。"); return; }

    el.pwSubmit.disabled = true;

    api("/api/admin/change-password", {
      method: "POST",
      body: { currentPassword: current, newPassword: next }
    })
      .then(function () {
        el.pwSubmit.disabled = false;
        hidePasswordModal();
        showAlert("ok", "密码已更新。");
        // Re-resolve the role so the console loads with the new state.
        return resolveRole().then(function (role) {
          state.role = role;
          el.whoRole.textContent = ROLE_LABEL[role] || role;
          applyRoleGating();
          activateTab("orders");
        });
      })
      .catch(function (err) {
        el.pwSubmit.disabled = false;
        pwAlert("error", escapeHtml(err && err.message ? err.message : String(err)));
      });
  }

  /**
   * Discover the caller's identity and role from the server. /api/admin/me
   * verifies the bearer token and returns the role stored in `profiles` — the
   * client never asserts its own role. It also reports whether the account is
   * still on its initial password.
   */
  function resolveMe() {
    return api("/api/admin/me").then(function (data) {
      return {
        role: (data && data.role) || "user",
        mustChangePassword: !!(data && data.mustChangePassword)
      };
    });
  }

  function resolveRole() {
    return resolveMe().then(function (me) { return me.role; });
  }

  function boot() {
    cacheElements();

    var ready = window.__pomeloConfigReady || Promise.resolve(window.POMELO_CONFIG || {});
    ready.then(function (cfg) {
      if (!cfg || !cfg.supabaseUrl || !cfg.supabaseAnonKey) {
        showAlert("error", "系统尚未配置完成，请联系管理员。");
        return;
      }

      state.client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);

      state.client.auth.getSession().then(function (res) {
        var session = res && res.data ? res.data.session : null;
        if (!session) {
          window.location.replace("/login.html");
          return;
        }

        state.session = session;
        state.email = session.user && session.user.email ? session.user.email : "";

        el.whoEmail.textContent = state.email || "—";

        // Refresh the token if it is close to expiry, then resolve identity.
        state.client.auth.getUser().then(function () {
          return resolveMe();
        }).then(function (me) {
          state.role = me.role;
          el.whoRole.textContent = ROLE_LABEL[me.role] || me.role;
          applyRoleGating();
          wireEvents();

          // First login on the shared bootstrap password: block the console
          // until the account holder sets their own password.
          if (me.mustChangePassword) {
            showPasswordModal();
            return;
          }

          activateTab("orders");
        }).catch(function (err) {
          fail(err);
        });
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
