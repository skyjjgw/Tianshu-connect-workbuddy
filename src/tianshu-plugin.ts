import { getRuntime, REGIONS, type WorkBuddyTianshuRuntime } from './tianshu-runtime.ts'
import type { WorkBuddyRegion } from './tianshu-core.ts'

export { getRuntime } from './tianshu-runtime.ts'

interface ToolResult { content: string, isError?: boolean }

function result(value: unknown, isError = false): ToolResult {
  return { content: JSON.stringify(value, null, 2), ...(isError ? { isError: true } : {}) }
}

function regionOf(value: unknown): WorkBuddyRegion | undefined {
  return typeof value === 'string' && (REGIONS as readonly string[]).includes(value)
    ? value as WorkBuddyRegion
    : undefined
}

async function withRuntime(operation: (runtime: WorkBuddyTianshuRuntime) => Promise<unknown>): Promise<ToolResult> {
  try {
    return result(await operation(await getRuntime()))
  } catch (error) {
    return result({ ok: false, error: error instanceof Error ? error.message : String(error) }, true)
  }
}

export const tools = [
  {
    definition: {
      name: 'workbuddy_setup',
      description: '把本机已登录的 WorkBuddy 国内版/国际版注册到天枢模型选择器。首次接入或修复 Provider 时使用。',
      input_schema: {
        type: 'object',
        properties: {
          region: { type: 'string', enum: [...REGIONS], description: '可选；只同步一个区域。留空同步两个区域。' },
        },
        additionalProperties: false,
      },
    },
    execute: async (params: { region?: string }) => withRuntime(runtime => runtime.setup(regionOf(params.region))),
    requiresApproval: () => true,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
  },
  {
    definition: {
      name: 'workbuddy_status',
      description: '查看 WorkBuddy 两个区域的登录账号、积分余额、模型、上下文规格和积分倍率。不会返回任何令牌。',
      input_schema: { type: 'object', properties: {}, additionalProperties: false },
    },
    execute: async () => withRuntime(runtime => runtime.snapshot()),
    requiresApproval: () => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  },
  {
    definition: {
      name: 'workbuddy_login',
      description: '启动或完成 WorkBuddy 网页登录。start 返回授权链接与 loginId；用户完成网页授权后，用 finish 和同一 loginId 收取登录结果并自动同步 Provider。',
      input_schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['start', 'finish'] },
          region: { type: 'string', enum: [...REGIONS] },
          login_id: { type: 'string', description: 'finish 时填写 start 返回的 loginId。' },
          open_browser: { type: 'boolean', description: 'start 时是否自动打开系统浏览器，默认 true。' },
        },
        required: ['action', 'region'],
        additionalProperties: false,
      },
    },
    execute: async (params: { action?: string, region?: string, login_id?: string, open_browser?: boolean }) => {
      const region = regionOf(params.region)
      if (region === undefined) return result({ ok: false, error: 'region 必须是 cn 或 global' }, true)
      if (params.action === 'start') {
        return withRuntime(runtime => runtime.startLogin(region, params.open_browser !== false))
      }
      if (params.action === 'finish' && typeof params.login_id === 'string' && params.login_id) {
        return withRuntime(runtime => runtime.finishLogin(region, params.login_id!))
      }
      return result({ ok: false, error: 'finish 需要 login_id' }, true)
    },
    requiresApproval: () => true,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
  },
  {
    definition: {
      name: 'workbuddy_refresh',
      description: '从 WorkBuddy 刷新模型目录、倍率和账号状态，然后同步到天枢 Provider。',
      input_schema: {
        type: 'object',
        properties: {
          region: { type: 'string', enum: [...REGIONS], description: '可选；只刷新一个区域。' },
        },
        additionalProperties: false,
      },
    },
    execute: async (params: { region?: string }) => withRuntime(async runtime => {
      const region = regionOf(params.region)
      const refreshed = await runtime.refresh(region)
      const registered = await runtime.setup(region)
      return { ok: registered.ok, refreshed, registered }
    }),
    requiresApproval: () => true,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
  },
  {
    definition: {
      name: 'workbuddy_test',
      description: '测试插件端点，或发一次真实 WorkBuddy 模型请求。mode=model 会真实消耗积分，只能在用户明确同意后调用。',
      input_schema: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['endpoint', 'model'], description: 'endpoint 只测试 /models；model 发真实对话。' },
          region: { type: 'string', enum: [...REGIONS] },
          model: { type: 'string', description: 'mode=model 时必填。' },
        },
        required: ['mode'],
        additionalProperties: false,
      },
    },
    execute: async (params: { mode?: string, region?: string, model?: string }) => {
      const region = regionOf(params.region)
      if (params.mode === 'endpoint') return withRuntime(runtime => runtime.endpointTest(region))
      if (params.mode === 'model' && region !== undefined && typeof params.model === 'string' && params.model) {
        return withRuntime(runtime => runtime.modelTest(region, params.model!))
      }
      return result({ ok: false, error: 'mode=model 需要 region 和 model' }, true)
    },
    requiresApproval: () => true,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
  },
]

// Provider calls begin only after session bootstrap, but starting here ensures
// the loopback endpoint is normally ready before the first model request.
//
// 启动即注册：这一步让「装上就能用」成立。少了它，新用户装完插件后模型不会
// 出现在天枢的模型选择器里，必须手动跑一次 `/workbuddy` 或 workbuddy_setup——
// 而在此之前天枢里什么都看不到，很容易被当成插件没生效。
//
// 同时它也是刷新入口：切换 WorkBuddy 账号、官方上新模型后，重启天枢即同步。
//
// 失败只记日志、不上抛：`getRuntime()` 本身已经拉起了 shim 端口，注册失败
// （例如 core 还没就绪、两个区域都未登录）不该影响插件继续服务。注册成功与否
// 都不阻塞插件加载——这是 fire-and-forget，调用方不等它。
if (process.env['TIANSHU_WORKBUDDY_DISABLE_AUTOSTART'] !== '1') {
  void getRuntime()
    .then(runtime => runtime.setup())
    .then(sync => {
      // 未登录区域会以 skipped 返回，不是错误；只有真的注册失败才值得告警。
      const summary = Object.entries(sync.regions)
        .map(([region, item]) => `${region}=${item.ok ? `ok(${item.models ?? 0} 模型)` : item.skipped ? '未登录跳过' : `失败:${item.error ?? '未知'}`}`)
        .join(' ')
      if (sync.ok) {
        console.info(`[tianshu-connect-workbuddy] 启动同步完成：${summary}`)
      } else {
        console.warn(`[tianshu-connect-workbuddy] 启动同步未完成：${summary}`)
      }
    })
    .catch(error => {
      console.error(`[tianshu-connect-workbuddy] 启动失败：${error instanceof Error ? error.message : String(error)}`)
    })
}
