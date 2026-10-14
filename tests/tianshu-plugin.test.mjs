import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

test('package exposes a valid Tianshu plugin manifest', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.name, 'tianshu-connect-workbuddy')
  assert.equal(pkg.tianshu.name, pkg.name)
  assert.equal(pkg.tianshu.entry, 'lib/index.js')
  assert.ok(pkg.tianshu.tools.length >= 4)
  assert.deepEqual(
    pkg.tianshu.tools.map(tool => tool.name),
    ['workbuddy_setup', 'workbuddy_status', 'workbuddy_login', 'workbuddy_refresh', 'workbuddy_test'],
  )
})

test('built entry exports exactly the declared tools without starting network listeners', async () => {
  process.env.TIANSHU_WORKBUDDY_DISABLE_AUTOSTART = '1'
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const mod = await import(new URL(`../${pkg.tianshu.entry}?test=${Date.now()}`, import.meta.url))
  assert.ok(Array.isArray(mod.tools))
  assert.deepEqual(mod.tools.map(tool => tool.definition.name), pkg.tianshu.tools.map(tool => tool.name))
  for (const tool of mod.tools) {
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.requiresApproval, 'function')
    assert.equal(typeof tool.isConcurrencySafe, 'function')
    assert.equal(typeof tool.isEnabled, 'function')
  }
})

test('built plugin does not statically depend on DSH host packages', () => {
  const built = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.doesNotMatch(built, /^import\s.+from\s+["']@deepseek-ai\/dsh-/m)
  assert.doesNotMatch(built, /^import\s.+from\s+["']@deepseek-ai\/cordis/m)
  assert.match(built, /workbuddy_setup/)
})

test('slash command is packaged', () => {
  const command = readFileSync(join(root, 'commands', 'workbuddy.md'), 'utf8')
  assert.match(command, /workbuddy_status/)
  assert.match(command, /真实消耗积分/)
})

// ── 启动即注册（autostart → setup）────────────────────────────
//
// 为什么锁这条：这是「装上就能用」的保证。少了它，新用户装完插件后模型不会
// 出现在模型选择器里，必须手动跑一次 /workbuddy 才看得到——在此之前天枢里
// 什么都没有，很容易被当成插件没生效。这是真实发生过的用户困惑（见本仓库
// 的 fetch failed 修复记录），所以用测试钉住。

test('built entry wires autostart to setup (装上即注册)', () => {
  const built = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  // 启动块必须同时含 getRuntime 与 setup 调用，否则就是「只起服务不注册」
  assert.match(built, /DISABLE_AUTOSTART/, '应保留禁用开关')
  const autostartBlock = built.slice(built.indexOf('DISABLE_AUTOSTART'))
  assert.match(autostartBlock, /getRuntime\(\)/, '应启动 runtime')
  assert.match(autostartBlock, /\.setup\(\)/, '必须调用 setup 注册 Provider')
  assert.match(autostartBlock, /启动同步完成|启动同步未完成/, '应有可观测的同步结果日志')
})

test('autostart failure is swallowed (不阻塞插件加载)', () => {
  const built = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const autostartBlock = built.slice(built.indexOf('DISABLE_AUTOSTART'))
  // 必须有 catch，且不能被 await —— fire-and-forget
  assert.match(autostartBlock, /\.catch\(/, '注册失败必须被捕获')
  assert.doesNotMatch(autostartBlock, /await\s+getRuntime/, '不得阻塞模块加载')
})

// ── 启用耗时契约：create() 不得等待网络刷新 ─────────────────────
//
// 为什么锁这条：天枢启用插件时会等待 create() 完成，超时则报
// `sidecar request timed out` 并禁用插件（真实故障，见 issue 记录）。
// 而 refresh() 会向 WorkBuddy 服务器拉模型列表，超时上限 30s × 2 区域
// = 最坏 60s+——网络不通的机器必然撞上天枢的加载超时。
//
// 因此 create() 必须只做本地的事（起端口、初始化），网络刷新放后台。

test('create() 不阻塞在网络刷新上（启用耗时不随网络变化）', async () => {
  const src = readFileSync(new URL('../src/tianshu-runtime.ts', import.meta.url), 'utf8')
  const createBody = src.slice(
    src.indexOf('static async create()'),
    src.indexOf('private async proxy('),
  )
  // create() 里不得出现裸的 await refresh——它必须被 fire-and-forget 掉
  assert.doesNotMatch(
    createBody,
    /await\s+runtime\.refresh\(\)/,
    'create() 不得 await refresh()：网络慢会撞上天枢的插件加载超时',
  )
})

test('refresh 并行处理区域，且支持自定义超时（setup 不得串行等 30s×N）', () => {
  const src = readFileSync(new URL('../src/tianshu-runtime.ts', import.meta.url), 'utf8')
  const refreshBody = src.slice(
    src.indexOf('async refresh(region?: WorkBuddyRegion, timeoutMs?: number)'),
    src.indexOf('private providerPayload('),
  )
  // 不得用 for-of 串行 await——两个区域会叠加超时
  assert.doesNotMatch(
    refreshBody,
    /for\s*\(const\s+\w+\s+of\s+targets\)/,
    'refresh 不得串行遍历区域：cn 30s + global 30s = 最坏 60s',
  )
  assert.match(refreshBody, /Promise\.all/, 'refresh 应并行处理区域')
})
