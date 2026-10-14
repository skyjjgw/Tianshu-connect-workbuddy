# Tianshu Connect WorkBuddy

天枢原生插件：把本机 WorkBuddy 国内版与国际版账号接入天枢模型选择器，并提供网页登录、账号状态、积分余额、模型目录和倍率查看。

它不是独立桌面软件。安装后由天枢的插件系统加载，插件进程内启动仅绑定 `127.0.0.1` 的 OpenAI 兼容端点，再把 `workbuddy` / `workbuddy-global` 两个 Provider 注册给天枢。

## 功能

- 国内版与国际版并行接入；未登录的区域不会注册空 Provider。
- 自动读取 WorkBuddy 桌面端已有登录，也可直接从插件发起浏览器登录。
- 模型直接进入天枢模型选择器，保留上下文窗口、最大输出和视觉能力。
- 模型说明显示 WorkBuddy 积分倍率（例如 `积分倍率 x0.79`）。
- `workbuddy_status` 查看账号、精确余额、模型和倍率，不返回任何令牌。
- `workbuddy_refresh` 刷新上游目录并同步天枢。
- `workbuddy_test` 支持无积分消耗的端点检查，以及需明确授权的真实模型调用。
- 本地端点使用随机 Bearer、固定回环地址和常量时间比较；WorkBuddy 凭据不写入天枢配置。

## 要求

- 天枢 `3.31.0` 或更高版本。
- Node.js 24（天枢桌面端已内置）。
- 已安装 WorkBuddy 桌面端，或使用插件的网页登录功能。

## 安装

在天枢会话中执行：

```text
/plugin install https://github.com/skyjjgw/tianshu-connect-workbuddy
```

### 国内网络（推荐用 Gitee 镜像）

GitHub 直连不稳定的话，直接装 Gitee 镜像——国内直连，不需要任何代理：

```text
/plugin install https://gitee.com/skyjjgw/tianshu-connect-workbuddy
```

两个仓库内容一致，GitHub 是主仓库、Gitee 是镜像。

### 用代理前缀

也可以给 GitHub 地址套一层代理（把原地址接在代理域名后面）：

```text
/plugin install https://ghfast.top/https://github.com/skyjjgw/tianshu-connect-workbuddy
```

以下代理实测可克隆本仓库（2026-10-14 验证，均含 `lib/`、HEAD 与 GitHub 一致）：

| 代理 | 地址格式 |
| --- | --- |
| ghfast | `https://ghfast.top/https://github.com/<owner>/<repo>` |
| ghproxy.net | `https://ghproxy.net/https://github.com/<owner>/<repo>` |
| gh.llkk.cc | `https://gh.llkk.cc/https://github.com/<owner>/<repo>` |

这些是公共代理，可用性会变——同一个地址可能今天通、明天 403。**换一个再试**
通常就好了。已知不可用/有坑的：`gh-proxy.com`（服务端 403）、
`hub.fastgit.xyz`（返回空仓库，会伪装成克隆成功）。

### 完全离线安装

网络实在不通时，用本地目录安装——先把仓库下载或拷贝到本机，再把路径换成你自己的：

```text
/plugin install D:\path\to\tianshu-connect-workbuddy
```

构建产物 `lib/` 已随仓库提供，本地安装无需联网、也无需自行构建。

插件工具在新会话生效。重开会话后执行：

```text
/workbuddy
```

或直接让天枢“接入 WorkBuddy”，它会调用 `workbuddy_setup`。

## 首次接入

1. 已在 WorkBuddy 桌面端登录：调用 `workbuddy_setup`，插件会检测账号、刷新模型并注册 Provider。
2. 尚未登录：调用 `workbuddy_login`，选择 `cn` 或 `global`。插件会打开浏览器；授权完成后再执行完成动作，账号和 Provider 会自动保存与同步。
3. 新开一个天枢会话，在模型选择器中选择 `workbuddy:<model-id>` 或 `workbuddy-global:<model-id>`。

命令行也可以完成相同操作：

```powershell
tianshu-connect-workbuddy setup
tianshu-connect-workbuddy status
tianshu-connect-workbuddy login cn
tianshu-connect-workbuddy login global
tianshu-connect-workbuddy test
```

`smoke` 会真实调用模型并消耗 WorkBuddy 积分：

```powershell
tianshu-connect-workbuddy smoke cn glm-5.3
```

## 插件工具

| 工具 | 作用 | 是否修改状态 |
| --- | --- | --- |
| `workbuddy_setup` | 注册/更新天枢 Provider | 是，需要审批 |
| `workbuddy_status` | 查看账号、余额、模型、倍率 | 否 |
| `workbuddy_login` | 浏览器登录并保存到插件凭据库 | 是，需要审批 |
| `workbuddy_refresh` | 刷新目录并同步 Provider | 是，需要审批 |
| `workbuddy_test` | 端点或真实模型测试 | 真实模型测试会消耗积分 |

## 本地数据与安全

插件状态默认保存在 `$RIVET_HOME/workbuddy-connect/`；未设置 `RIVET_HOME` 时为 `~/.rivet/workbuddy-connect/`。

- `config.json`：回环端口与随机本地 Bearer。
- `vault/<region>/`：插件通过网页登录保存的 WorkBuddy 凭据。
- WorkBuddy 桌面端原始认证文件始终只读。
- 工具输出不会包含 WorkBuddy token、本地 Bearer 或天枢 sidecar token。

默认监听：

- 国内版：`127.0.0.1:28791`
- 国际版：`127.0.0.1:28792`

端口仅绑定回环且所有请求必须携带随机 Bearer。多个天枢会话使用同一 `$RIVET_HOME` 时会复用同一个端点。

## 与 DSH 插件的差异

核心的 WorkBuddy 认证、刷新、模型目录、倍率、余额和流式协议沿用 `dsh-connect-workbuddy` 的成熟实现；宿主接入层改成天枢插件 ABI。

天枢当前插件 ABI 支持工具、Skill、Hook 与 slash command，但没有设置页/Composer UI 插槽，所以余额通过 `workbuddy_status` 和 `/workbuddy` 查看，暂时不能常驻显示在输入框旁。模型倍率会进入天枢模型说明，不影响实际积分计费。

## 开发

```powershell
pnpm install
pnpm run check
```

构建产物为 `lib/index.js`（天枢插件入口）与 `lib/cli.js`（可选 CLI），两者均自包含，不依赖 DSH 宿主包。

## 来源与许可

WorkBuddy 接入核心源自 MIT 许可的 `dingminhua/dsh-connect-workbuddy`。详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。本项目采用 MIT License。
