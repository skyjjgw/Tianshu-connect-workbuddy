# Gitee 镜像配置步骤（人工操作）

> 由助手核实并整理。`/settings` 页面需登录才能访问（实测 HTTP 401），
> 助手无法代配，需仓库所有者本人操作。

## 目标

让 Gitee 仓库自动从 GitHub 拉取更新，这样只推 GitHub 一处即可，Gitee 自动跟上。

## 步骤

### 1. 打开镜像管理页

浏览器登录 Gitee 后访问：

```
https://gitee.com/skyjjgw/tianshu-connect-workbuddy/settings
```

在左侧或页面中找到 **「仓库镜像管理」**（不同版本位置可能不同，
通常在「设置」页的功能区）。

### 2. 新建镜像

- **镜像方向**：选「**Pull**」（从 GitHub 拉到 Gitee）
- **镜像仓库地址**：

  ```
  https://github.com/skyjjgw/tianshu-connect-workbuddy.git
  ```

- **认证方式**：
  - 公开仓库通常**不需要**填凭据
  - 若要求，用 GitHub 的 Personal Access Token（只读权限即可）
    - 生成地址：https://github.com/settings/tokens
    - 勾选 `public_repo`（或 `repo`）

### 3. 触发同步

- **手动**：点「同步」按钮，立即拉一次
- **自动**：若界面提供「定时同步」选项，开启（通常每几小时一次）

### 4. 验证

同步后访问 Gitee 仓库主页，对比最新提交的短哈希是否与 GitHub 一致：

```
https://gitee.com/skyjjgw/tianshu-connect-workbuddy
https://github.com/skyjjgw/tianshu-connect-workbuddy
```

两边 HEAD 相同即为成功。

## 备选方案（不依赖平台功能）

如果镜像功能不可用或受限，直接用两条命令手动同步：

```bash
cd E:\zzz\tianshu-connect-workbuddy

# 推 GitHub
git push origin main

# 推 Gitee
git push gitee main
```

两个 remote 已在本地配置好（`origin` → GitHub，`gitee` → Gitee），
且 Gitee 的凭据已缓存，无需每次登录。

## 当前状态（2026-10-14 核实）

| 项 | 值 |
| --- | --- |
| 本地 HEAD | `13dc690` |
| GitHub HEAD | `13dc690` |
| Gitee HEAD | `13dc690` |
| 三处是否一致 | ✅ 是 |
| 本地 remotes | `origin`（GitHub）、`gitee`（Gitee） |
