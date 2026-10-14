---
description: 管理 WorkBuddy 接入、登录、余额、倍率和模型同步
---

先调用 `workbuddy_status` 查看国内版和国际版的账号、余额、模型与倍率。

- 用户要首次接入或修复模型列表时，调用 `workbuddy_setup`。
- 用户要登录时，先调用 `workbuddy_login` 的 `start`；把返回的授权链接交给用户，用户确认完成后用同一个 `login_id` 调用 `finish`。
- 用户要求刷新目录时，调用 `workbuddy_refresh`。
- 只有用户明确同意真实消耗积分时，才用 `workbuddy_test` 的 `model` 模式；端点模式不消耗模型积分。

不要展示任何 access token、refresh token、桥接 bearer 或天枢 sidecar token。
