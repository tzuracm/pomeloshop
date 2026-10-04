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
    { key: "hero_subtitle", label: "副标题" }
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
    content: {},
    settings: {},
    users: []
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

  function api(path, options) {
    options = options || {};
    var headers = { "Content-Type": "application/json" };
    if (state.session && state.session.access_token) {
      headers.Authorization = "Bearer " + state.session.access_token;
    }

    return fetch(path, {
      method: options.method || "GET",
      headers: headers,
      body: options.body ? JSON.stringify(options.body) : undefined
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

    api("/api/admin/orders" + qs)
      .then(function (data) {
        state.orders = data.orders || [];
        renderOrders();
      })
      .catch(function (err) {
        el.ordersBody.innerHTML = '<div class="empty">加载失败</div>';
        fail(err);
      });
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

      var slip = o.slip_url
        ? '<a class="slip-link" href="' + escapeHtml(o.slip_url) + '" target="_blank" rel="noopener">查看</a>'
        : '<span class="muted">—</span>';

      var statusOptions = ORDER_STATUSES.map(function (s) {
        return '<option value="' + s + '"' + (o.status === s ? " selected" : "") + ">" + s + "</option>";
      }).join("");

      return (
        '<tr data-id="' + escapeHtml(o.id) + '">' +
          '<td class="mono">' + escapeHtml(String(o.id).slice(0, 8)) + "</td>" +
          "<td>" + escapeHtml(o.wechat_name || "—") + "<br><span class=\"muted\">" + escapeHtml(o.phone || "") + "</span></td>" +
          "<td>" + (itemsText || '<span class="muted">—</span>') + "</td>" +
          "<td>" + escapeHtml(o.fulfilment || "—") + "</td>" +
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
        "<th>ID</th><th>客户</th><th>商品</th><th>方式</th><th>金额</th><th>水单</th><th>下单时间</th><th>操作</th>" +
      "</tr></thead><tbody>" + rows + "</tbody></table>";

    // Wire per-row save buttons.
    var buttons = el.ordersBody.querySelectorAll(".order-save");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].addEventListener("click", onOrderSave);
    }
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
      return (
        '<tr data-sku="' + escapeHtml(it.sku) + '">' +
          '<td class="mono">' + escapeHtml(it.sku) + "</td>" +
          "<td>" + escapeHtml(it.label) + "</td>" +
          '<td class="mono">฿' + escapeHtml(it.unit_price) + "</td>" +
          "<td>" + escapeHtml(it.sort_order) + "</td>" +
          "<td>" + (it.active ? "是" : "否") + "</td>" +
          '<td><div class="row-actions">' +
            '<button class="btn secondary cat-edit">编辑</button>' +
            '<button class="btn danger cat-del">删除</button>' +
          "</div></td>" +
        "</tr>"
      );
    }).join("");

    el.catalogueBody.innerHTML =
      "<table><thead><tr>" +
        "<th>SKU</th><th>名称</th><th>单价</th><th>排序</th><th>上架</th><th>操作</th>" +
      "</tr></thead><tbody>" + rows + "</tbody></table>";

    var edits = el.catalogueBody.querySelectorAll(".cat-edit");
    for (var i = 0; i < edits.length; i++) edits[i].addEventListener("click", onCatalogueEdit);

    var dels = el.catalogueBody.querySelectorAll(".cat-del");
    for (var j = 0; j < dels.length; j++) dels[j].addEventListener("click", onCatalogueDelete);
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
    var sku = el.catSku.value.trim();
    var label = el.catLabel.value.trim();
    var price = parseInt(el.catPrice.value, 10);
    var sort = parseInt(el.catSort.value, 10);

    if (!sku || !label) { showAlert("error", "请填写 SKU 和名称。"); return; }
    if (!Number.isInteger(price) || price < 0) { showAlert("error", "单价必须是非负整数 (THB)。"); return; }

    var mode = el.catSave.getAttribute("data-mode") === "update" ? "PATCH" : "POST";
    var body = { sku: sku, label: label, unit_price: price };
    if (Number.isInteger(sort)) body.sort_order = sort;

    el.catSave.disabled = true;
    hideAlert();

    api("/api/admin/catalogue", { method: mode, body: body })
      .then(function () {
        el.catSave.disabled = false;
        resetCatalogueForm();
        showAlert("ok", mode === "POST" ? "商品已创建。" : "商品已更新。");
        loadCatalogue();
      })
      .catch(function (err) {
        el.catSave.disabled = false;
        fail(err);
      });
  }

  function resetCatalogueForm() {
    el.catSku.value = "";
    el.catSku.readOnly = false;
    el.catLabel.value = "";
    el.catPrice.value = "";
    el.catSort.value = "";
    el.catSave.textContent = "保存商品";
    el.catSave.removeAttribute("data-mode");
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

  function renderUsers() {
    if (!state.users.length) {
      el.usersBody.innerHTML = '<div class="empty">暂无员工</div>';
      return;
    }

    var rows = state.users.map(function (u) {
      var isSelf = state.session && u.id === state.session.user.id;
      var options = ["user", "admin", "owner"].map(function (r) {
        return '<option value="' + r + '"' + (u.role === r ? " selected" : "") + ">" +
          escapeHtml(ROLE_LABEL[r] || r) + " (" + r + ")</option>";
      }).join("");

      return (
        '<tr data-id="' + escapeHtml(u.id) + '">' +
          "<td>" + escapeHtml(u.email || "—") + (isSelf ? ' <span class="muted">(你)</span>' : "") + "</td>" +
          "<td>" + escapeHtml(u.full_name || "—") + "</td>" +
          "<td>" + fmtDate(u.created_at) + "</td>" +
          "<td>" +
            (isSelf
              ? '<span class="pill ' + escapeHtml(u.role) + '">' + escapeHtml(ROLE_LABEL[u.role] || u.role) + "</span>"
              : '<select class="user-role">' + options + "</select>" +
                '<div class="row-actions" style="margin-top:6px;">' +
                  '<button class="btn user-save">保存</button>' +
                "</div>") +
          "</td>" +
        "</tr>"
      );
    }).join("");

    el.usersBody.innerHTML =
      "<table><thead><tr>" +
        "<th>邮箱</th><th>姓名</th><th>加入时间</th><th>角色</th>" +
      "</tr></thead><tbody>" + rows + "</tbody></table>";

    var buttons = el.usersBody.querySelectorAll(".user-save");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].addEventListener("click", onUserSave);
    }
  }

  function onUserSave(ev) {
    var btn = ev.currentTarget;
    var tr = btn.closest("tr");
    var userId = tr.getAttribute("data-id");
    var role = tr.querySelector(".user-role").value;

    btn.disabled = true;
    hideAlert();

    api("/api/admin/users", { method: "PATCH", body: { userId: userId, role: role } })
      .then(function () {
        btn.disabled = false;
        showAlert("ok", "角色已更新。");
        loadUsers();
      })
      .catch(function (err) {
        btn.disabled = false;
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
    el.ordersBody = $("ordersBody");

    el.catSku = $("catSku");
    el.catLabel = $("catLabel");
    el.catPrice = $("catPrice");
    el.catSort = $("catSort");
    el.catSave = $("catSave");
    el.catalogueBody = $("catalogueBody");

    el.contentBody = $("contentBody");
    el.contentSave = $("contentSave");

    el.settingsNote = $("settingsNote");
    el.settingsBody = $("settingsBody");
    el.settingsSave = $("settingsSave");

    el.usersBody = $("usersBody");
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

    el.catSave.addEventListener("click", onCatalogueSave);
    el.contentSave.addEventListener("click", onContentSave);
    el.settingsSave.addEventListener("click", onSettingsSave);
  }

  /**
   * Discover the caller's role from the server. /api/admin/me verifies the
   * bearer token and returns the role stored in `profiles` — the client never
   * asserts its own role.
   */
  function resolveRole() {
    return api("/api/admin/me").then(function (data) {
      return (data && data.role) || "user";
    });
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

        // Refresh the token if it is close to expiry, then resolve the role.
        state.client.auth.getUser().then(function () {
          return resolveRole();
        }).then(function (role) {
          state.role = role;
          el.whoRole.textContent = ROLE_LABEL[role] || role;
          applyRoleGating();
          wireEvents();
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
