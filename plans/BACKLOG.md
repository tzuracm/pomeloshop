# Pomelo Shop — Backlog / 待办事项

> **This file is the single source of truth for all outstanding work.**
> 本文件是**所有未完成事项的唯一记录处**。任何待办、遗留问题、未完成的功能或已知缺陷都必须记录在此。
>
> - 新增事项：在对应分类下追加一行，分配一个稳定的 ID（如 `SEC-07`、`FEAT-03`）。
> - 完成事项：把 `[ ]` 改为 `[x]`，并在「完成记录」中补一行日期与说明。**不要删除条目**，保留历史。
> - 状态取值：`未开始` / `进行中` / `待验证` / `已完成` / `已搁置`。
> - 优先级：`P0` 阻断上线 · `P1` 高 · `P2` 中 · `P3` 低/优化。

Last updated: 2026-10-17

---

## 0. 当前状态概览

| 分类 | 未完成 | 已完成 |
| --- | --- | --- |
| 安全 / 权限（SEC） | 8 | 9 |
| 功能（FEAT） | 5 | 1 |
| 运维 / 部署（OPS） | 6 | 0 |
| 文档（DOC） | 3 | 0 |
| 测试（TEST） | 4 | 0 |

**上线前必须完成：** `OPS-01`、`OPS-02`、`OPS-06`（迁移 0006）、`OPS-03`。

---

## 1. 安全 / 权限（SEC）

来源：[`plans/user-tier-permissions-audit.md`](user-tier-permissions-audit.md)

### 已完成（P0 / P1）

- [x] **SEC-01** `P0-1` 移除 `profiles_update_own` 策略，新增 `guard_profile_privileges()` 触发器，禁止非 owner 修改 `role`/`status`。
      → [`0005_pomelo_security_hardening.sql`](../supabase/migrations/0005_pomelo_security_hardening.sql:191)
- [x] **SEC-02** `P0-2` 新增 `profiles.status`（`pending`/`active`/`suspended`），角色辅助函数要求 `status = 'active'`，新账号默认 `pending`。
      → [`0005_pomelo_security_hardening.sql`](../supabase/migrations/0005_pomelo_security_hardening.sql:40)
- [x] **SEC-03** `P0-2` `requireRole()` 改为 fail-closed：无 profile / 未知角色 / 非 active 一律 403。
      → [`api/admin/_auth.js`](../api/admin/_auth.js:72)
- [x] **SEC-04** `P0-3` 匿名只可读 `promptpay_id`、`promptpay_qr_payload`，银行信息不再对 anon 暴露。
      → [`0005_pomelo_security_hardening.sql`](../supabase/migrations/0005_pomelo_security_hardening.sql:244)
- [x] **SEC-05** `P1-1` 删除 `orders_staff_update`，撤销 `authenticated`/`anon` 对 `pomelo_orders` 的 `UPDATE`。
      → [`0005_pomelo_security_hardening.sql`](../supabase/migrations/0005_pomelo_security_hardening.sql:277)
- [x] **SEC-06** `P1-2` 账号生命周期：owner 可创建 / 启用 / 停用员工账号，含"最后一个 owner"保护。
      → [`api/admin/users.js`](../api/admin/users.js:49)
- [x] **SEC-07** `P1-3` `slip_url` 双重防护：DB 触发器拒绝非 `https://`，前端 `safeHttpUrl()` 只渲染 http/https。
      → [`0005_pomelo_security_hardening.sql`](../supabase/migrations/0005_pomelo_security_hardening.sql:284)、[`admin.js`](../admin.js:93)
- [x] **SEC-08** `P1-4` 删除 slip bucket 的匿名列举策略，改为仅 active staff 可列举。
      → [`0005_pomelo_security_hardening.sql`](../supabase/migrations/0005_pomelo_security_hardening.sql:314)
- [x] **SEC-09** `P2-1` 设置页与 `GET /api/admin/settings` 提升为 `admin+`。
      → [`admin.html`](../admin.html:258)、[`api/admin/settings.js`](../api/admin/settings.js:43)

### 未完成

- [ ] **SEC-10** `P2-2` 目录 / 配送 / 页面内容仍保留 RLS 直写策略，绕过 API 校验（SKU 生成、价格整数、URL scheme、长度限制）。
      现状：`catalogue_staff_write`、`delivery_methods_staff_write`、`content_owner_write` 仍允许直接写表。
      建议：统一为"staff 只读 + 仅 `/api/admin/*` 写入"，或为关键不变量补 DB 约束。
      优先级：`P2` · 状态：`未开始`
      涉及：[`0002_pomelo_rbac.sql`](../supabase/migrations/0002_pomelo_rbac.sql:228)、[`0004_pomelo_delivery_methods.sql`](../supabase/migrations/0004_pomelo_delivery_methods.sql:67)、[`0002_pomelo_rbac.sql`](../supabase/migrations/0002_pomelo_rbac.sql:262)

- [ ] **SEC-11** `P2-5` 订单 `items` 结构与总额一致性未校验。
      现状：[`api/admin/orders.js`](../api/admin/orders.js:84) 只校验 `total_satang` 为非负整数，`items` 未做结构校验，也未与 `total_satang` 交叉核对。
      建议：校验 `items` 为数组、每项含 `sku`/`qty`/`unit_price`，并用 `pomelo_catalogue` 重算总额。
      优先级：`P2` · 状态：`未开始`

- [ ] **SEC-12** `P2-5` 订单总额完全由客户端提供，服务端不重算。
      现状：买家直接 INSERT `total_satang` 与 `items`，篡改客户端可记录低总额。
      建议：新增服务端下单端点，从 `pomelo_catalogue` 重算权威金额后再展示 QR。
      优先级：`P2` · 状态：`未开始`
      涉及：[`app.js`](../app.js:553)、[`0001_pomelo_orders.sql`](../supabase/migrations/0001_pomelo_orders.sql:73)

- [ ] **SEC-13** 转账凭证仍存放在 **public** bucket，持有对象 URL 即可访问（含 PII）。
      现状：`pomelo-slips` bucket `public = true`，仅列举被限制。
      建议：改为私有 bucket + 服务端签发短期 signed URL。
      优先级：`P2` · 状态：`未开始`
      涉及：[`0001_pomelo_orders.sql`](../supabase/migrations/0001_pomelo_orders.sql:92)

- [ ] **SEC-14** 无审计日志：角色变更、状态变更、设置写入、订单修改均无留痕。
      建议：新增 `pomelo_audit` 表（`actor_id`、`action`、`target_table`、`target_id`、`before`、`after`、`created_at`），在 `/api/admin/*` 写操作后记录。
      优先级：`P3` · 状态：`未开始`

- [ ] **SEC-15** 缺少安全响应头：无 CSP、HSTS、`frame-ancestors`。
      建议：在 [`vercel.json`](../vercel.json:5) 增加 `Content-Security-Policy`、`Strict-Transport-Security`、`X-Frame-Options`。
      优先级：`P3` · 状态：`未开始`

- [ ] **SEC-16** CDN 脚本未使用 SRI（Subresource Integrity）。
      涉及：[`login.html`](../login.html:101)、[`admin.html`](../admin.html:316)、[`index.html`](../index.html:1) 中的 supabase-js / qrcode-generator。
      优先级：`P3` · 状态：`未开始`

- [ ] **SEC-17** 未验证 `promptpay_qr_payload` 是否只能经 `/api/admin/payment-qr` 写入。
      现状：已从 `WRITABLE_KEYS` 移除，但需确认 owner 无法通过其他路径（如直接 SQL / 未来新增端点）写入未校验 payload。
      优先级：`P3` · 状态：`待验证`
      涉及：[`api/admin/settings.js`](../api/admin/settings.js:17)

---

## 2. 功能（FEAT）

- [x] **FEAT-01** 员工账号自助改密码 + owner 重置密码。
      实现：owner 创建账号时以邮箱为登录名，初始密码统一为 `123456`，并置 `must_change_password = true`；
      员工首次登录后 [`admin.js`](../admin.js:1390) 弹出阻塞式改密弹窗，调用 [`api/admin/change-password.js`](../api/admin/change-password.js:1) 校验当前密码后更新；
      owner 可在员工列表点「重置密码」把账号恢复为 `123456` 并重新置位标记。
      > 注：初始密码原定为 `1234`，但 Supabase Auth 强制最短 6 位，创建账号会报
      > `Password should be at least 6 characters`，故改为 `123456`。
      > 注：新建账号一律为 `pending`（待激活），创建表单不再提供状态选择；owner 需在员工列表
      > 把状态改为「已启用」后，该账号才能登录后台（`requireRole` 只放行 `active`）。
      → [`0006_pomelo_forced_password_change.sql`](../supabase/migrations/0006_pomelo_forced_password_change.sql:1)、[`api/admin/me.js`](../api/admin/me.js:23)、[`api/admin/users.js`](../api/admin/users.js:49)

- [ ] **FEAT-02** 员工账号删除（当前只能 `suspended`，无法彻底移除 auth 用户）。
      建议：`DELETE /api/admin/users`，调用 `admin.auth.admin.deleteUser`，并保留 profile 审计记录。
      优先级：`P3` · 状态：`未开始`

- [ ] **FEAT-03** 订单列表分页 / 无限滚动。
      现状：[`api/admin/orders.js`](../api/admin/orders.js:34) 仅支持 `limit`（上限 500），无游标分页。
      优先级：`P3` · 状态：`未开始`

- [ ] **FEAT-04** 订单状态变更历史（谁在何时把订单从 A 改到 B）。
      依赖：`SEC-14` 审计表。
      优先级：`P3` · 状态：`未开始`

- [ ] **FEAT-05** 初始密码 `123456` 强度过低（且为全员共用的固定值）。
      现状：Supabase Auth 最短 6 位，故取 `123456`；依赖 `must_change_password` 强制首登修改，
      但若员工从不登录，该密码长期有效，且所有新账号共用同一初始密码。
      建议：改为 8 位以上随机初始密码并由 owner 当面/私信告知，或为"未改密账号"设置自动停用时限。
      优先级：`P2` · 状态：`未开始`
      涉及：[`api/admin/users.js`](../api/admin/users.js:34)

---

## 3. 运维 / 部署（OPS）

- [ ] **OPS-01** 确认目标 Supabase 项目是**专用项目**，而非共享的 open-play 项目。
      原因：迁移 `0005` 会修改 `profiles` 与 `storage.objects` 策略。
      优先级：`P0` · 状态：`未开始`

- [ ] **OPS-02** 在 Supabase SQL Editor 按顺序执行 `0005_pomelo_security_hardening.sql`，并确认末尾校验查询全部返回 `0` / `false`。
      优先级：`P0` · 状态：`未开始`

- [ ] **OPS-03** 在 Supabase Auth 设置中**关闭公开注册**（`Disable signup`），员工账号只能由 owner 在后台创建。
      优先级：`P0` · 状态：`未开始`

- [ ] **OPS-04** 执行迁移后核对现有员工账号状态：确认应保留的账号为 `active`，应停用的改为 `suspended`。
      优先级：`P1` · 状态：`未开始`

- [ ] **OPS-05** 若怀疑 anon / service_role key 曾泄露，轮换密钥并同步更新 Vercel 环境变量。
      优先级：`P1` · 状态：`未开始`

- [ ] **OPS-06** 执行 `0006_pomelo_forced_password_change.sql`（新增 `profiles.must_change_password` 并扩展权限守卫触发器）。
      注意：该迁移会把**已存在**的 profile 的 `must_change_password` 置为 `false`，避免老账号被锁在改密弹窗；
      新建账号才会被强制改密。执行后确认末尾校验查询返回列存在。
      优先级：`P0` · 状态：`未开始`
      涉及：[`0006_pomelo_forced_password_change.sql`](../supabase/migrations/0006_pomelo_forced_password_change.sql:1)

---

## 4. 文档（DOC）

- [ ] **DOC-01** 更新 [`README.md`](../README.md:86)：删除"通过 `/login.html` 注册"的描述，改为"owner 在后台创建员工账号"；补充 `status` 生命周期说明。
      优先级：`P2` · 状态：`未开始`

- [ ] **DOC-02** 更新 [`plans/rbac-design.md`](rbac-design.md)：补充 `profiles.status`、fail-closed 鉴权、owner-only 账号创建、订单只读 RLS。
      优先级：`P2` · 状态：`未开始`

- [ ] **DOC-03** 修正 [`api/config.js`](../api/config.js:25) 注释：原文称"service_role key 绝不能加入环境变量"，但 admin API 实际需要它。应改为"service_role 仅限服务端环境变量，绝不可下发到浏览器"。
      优先级：`P3` · 状态：`未开始`

---

## 5. 测试（TEST）

- [ ] **TEST-01** 角色矩阵回归清单：分别以 `anon` / `pending` / `user` / `admin` / `owner` / `suspended` 身份访问每个 `/api/admin/*` 端点，核对预期状态码。
      优先级：`P1` · 状态：`未开始`

- [ ] **TEST-02** 直接 PostgREST 越权负向测试：
      - 普通用户 PATCH 自己的 `profiles.role` → 应失败
      - `user` PATCH `pomelo_orders.total_satang` → 应失败
      - anon SELECT `pomelo_settings` 的 `bank_account` → 应返回空
      - anon SELECT `storage.objects` 列举 slips → 应返回空
      - anon INSERT `slip_url = 'javascript:alert(1)'` → 应被拒绝
      优先级：`P1` · 状态：`未开始`

- [ ] **TEST-03** 最后一个 owner 保护测试：尝试降级 / 停用唯一 active owner → 应返回 400/42501。
      优先级：`P1` · 状态：`未开始`

- [ ] **TEST-04** 强制改密流程测试：
      - owner 新建 admin（邮箱为登录名）→ 用 `123456` 登录 → 应弹出改密弹窗且无法进入后台
      - 输入错误当前密码 → 应返回 400
      - 新密码少于 8 位 / 两次不一致 → 前端应拦截
      - 改密成功后刷新页面 → 弹窗不再出现
      - owner 点「重置密码」→ 该账号下次登录应再次被要求改密
      - 直接 PATCH `profiles.must_change_password = false` → 应被触发器拒绝（42501）
      优先级：`P1` · 状态：`未开始`

---

## 6. 完成记录

| 日期 | ID | 说明 |
| --- | --- | --- |
| 2026-10-17 | SEC-01 ~ SEC-09 | 完成审计中的全部 P0 / P1 修复，并顺带完成 P2-1（设置页 admin+）。新增迁移 `0005_pomelo_security_hardening.sql`，改写 `_auth.js` / `settings.js` / `users.js`，更新 `admin.html` / `admin.js`。所有 JS 通过 `node --check`。 |
| 2026-10-17 | FEAT-01 | owner 创建 admin/员工：邮箱即登录名，初始密码 `123456`，`must_change_password` 强制首登改密。新增迁移 `0006_pomelo_forced_password_change.sql`、端点 `api/admin/change-password.js`；`me.js` 返回标记；`users.js` 支持默认密码与 owner 重置；`admin.html`/`admin.js` 增加阻塞式改密弹窗与「重置密码」按钮。所有 JS 通过 `node --check`。 |
| 2026-10-17 | FEAT-01 修复 | 创建账号报 `Password should be at least 6 characters`：Supabase Auth 最短 6 位，初始密码由 `1234` 改为 `123456`，同步更新 `admin.html` 提示与 `admin.js` 文案。 |
| 2026-10-17 | FEAT-01 修复 | 创建表单移除「状态」下拉（新建账号必然是待激活，无需选择）。`createUser` 服务端固定写入 `status = 'pending'` 并忽略请求体中的 status，避免绕过激活流程；`admin.html` 提示补充「需改为已启用后才能登录」，`admin.js` 创建成功文案同步。 |

---

## 7. 新增事项模板

复制以下模板追加到对应分类：

```markdown
- [ ] **SEC-XX** 一句话标题。
      现状：……
      建议：……
      优先级：`P2` · 状态：`未开始`
      涉及：[`file.js`](../file.js:12)
```
