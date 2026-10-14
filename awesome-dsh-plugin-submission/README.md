# 市场收录目录（Awesome DSH Plugin Submission）

本目录存放本项目提交到 [Awesome DSH Plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 注册表的**草稿**。正式提交以 PR 形式存在于该仓库，本目录是本地镜像与操作说明。

## 当前状态

- **本仓库**：`skyjjgw/tianshu-connect-workbuddy`，尚未提交注册表 PR
- **草稿**：[`skyjjgw__tianshu-connect-workbuddy.yml`](./skyjjgw__tianshu-connect-workbuddy.yml)
- **前置条件**：需仓库打 `dsh-plugin` topic，且满足注册表的收录门槛（见下）

> 上游 `dingminhua/dsh-connect-workbuddy` 曾以 PR #3812 提交过同一插件的早期版本。
> 本仓库是其派生，独立维护——若提交注册表，应作为**新条目**而非修改上游那条。

## 收录目录规范（依据 contributing.md）

- 每个插件一个 YAML：`data/plugins/<owner>__<repo>.yml`
- 字段：
  - `url`：与仓库地址**完全一致**
  - `name`：`owner/repo`
  - `category`：有效值之一（本项目为 `model`）
  - `description.en`：必填，一行，以句号结尾；含 `: ` 必须加引号
  - `description.zh`：可选，维护者会补
- 前置要求：
  - 仓库 `package.json` 声明对应 manifest
  - 仓库打 `dsh-plugin` topic
  - 仓库满 1 天、提交数 ≥ 10（CI 自动检查）
- README（`README.md` / `README.zh.md`）由脚本生成，**不要手工编辑**；改 YAML 后执行：
  ```sh
  npm ci
  node scripts/generate-readme.mjs
  ```
- 一个 PR 最多收录 3 条；只改自己的条目。

## 更新步骤（提交或改条目时）

1. 修改本目录的 `skyjjgw__tianshu-connect-workbuddy.yml` 草稿
2. 在 fork 分支上同步新增 `data/plugins/skyjjgw__tianshu-connect-workbuddy.yml`
3. 重新生成 README（见上）
4. 推送，PR 自动重跑 CI
