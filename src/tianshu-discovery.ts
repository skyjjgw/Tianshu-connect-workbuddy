/**
 * 天枢 core 的发现逻辑。
 *
 * 独立成模块有两个原因：
 * 1. 它是纯逻辑（读 env / argv / 文件 + 探活），不依赖 WorkBuddy 那一堆
 *    运行时（shim / upstream / 凭据库），因此能被 `node --test` 直接驱动，
 *    不必先构建、也不受类型剥离限制影响。
 * 2. 它是「插件能否接上天枢」的唯一入口——接不上，后面所有功能都是空的。
 *    把它单列出来，回归测试才有明确的靶子。
 */
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface TianshuServerInfo {
  port: number
  token: string
  protocol?: 'http' | 'https'
}

/** 天枢数据目录；与 core 的 `rivetHome()` 同规则。 */
export function rivetHome(env: Record<string, string | undefined> = process.env): string {
  const configured = env['RIVET_HOME']?.trim()
  return configured || join(homedir(), '.rivet')
}

/**
 * 已知的 `server-info.json` 候选路径，按可信度排序。
 *
 * 顺序对应 core 的落盘位置与用户可能的自定义：显式指定 → RIVET_HOME →
 * TIANSHU_HOME → Windows 的 LOCALAPPDATA/APPDATA → 便携安装的各盘符。
 */
export function serverInfoCandidates(env: Record<string, string | undefined> = process.env): string[] {
  const portable = process.platform === 'win32'
    ? 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(drive =>
      join(`${drive}:\\`, 'tianshu', 'app', 'Tianshu', 'TianshuData', '.rivet', 'server-info.json'))
    : []
  return [
    env['TIANSHU_SERVER_INFO'],
    join(rivetHome(env), 'server-info.json'),
    ...(env['TIANSHU_HOME']
      ? [join(env['TIANSHU_HOME'], 'TianshuData', '.rivet', 'server-info.json')]
      : []),
    join(env['LOCALAPPDATA'] ?? '', 'Tianshu', 'TianshuData', '.rivet', 'server-info.json'),
    join(env['APPDATA'] ?? '', 'Tianshu', 'TianshuData', '.rivet', 'server-info.json'),
    ...portable,
  ].filter((value): value is string => Boolean(value))
}

/**
 * 从 argv 解析 serve 端口；非法/缺省返回 undefined。
 *
 * 只认「独立成元素」的 flag（`--port N` / `--port=N`），并要求 argv 里确有
 * `serve` 子命令。天枢的 headless 路径会把用户消息正文作为单个 argv 元素
 * 传进来（`main.js -p <消息> --json`），若扫描其它元素的前缀，一条正文形如
 * `--port=27015 …` 的消息就会被误认成本机端口——双重排除避免这个误判。
 */
export function parseServePort(argv: readonly string[] = process.argv): number | undefined {
  if (!Array.isArray(argv) || !argv.includes('serve')) return undefined
  const index = argv.indexOf('--port')
  let raw: string | undefined = index >= 0 ? argv[index + 1] : undefined
  if (raw === undefined) {
    const inline = argv.find((value): value is string => typeof value === 'string' && /^--port=\d+$/.test(value))
    raw = inline?.slice('--port='.length)
  }
  const port = Number.parseInt(String(raw), 10)
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined
}

/**
 * 进程内发现：插件与天枢 serve 运行在同一个进程里，可以直接读 env 注入的
 * token 与 argv 里的端口。这是天枢官方插件的发现机制（见内置
 * `tianshu-imbridge` 的 `probeServerEnv`），不依赖 `server-info.json`。
 *
 * 之所以不能只靠那个文件：core 写它时会先给临时文件做 ACL 加固，而加固脚本
 * 在 Windows 上对「零显式 ACE 的新文件」会抛错（PowerShell 把空数组展平成
 * `$null`，`Compare-Object -ReferenceObject $null` 终止），异常又被空 catch
 * 吞掉——于是文件长期停在旧实例的端口上，插件照着它请求就得到 `fetch failed`。
 * 同进程注入不受这条路径影响，是权威来源。
 */
export function probeServeEnv(
  env: Record<string, string | undefined> = process.env,
  argv: readonly string[] = process.argv,
): TianshuServerInfo | undefined {
  const token = typeof env['RIVET_SERVER_TOKEN'] === 'string' ? env['RIVET_SERVER_TOKEN'].trim() : ''
  const port = parseServePort(argv)
  if (token.length === 0 || port === undefined) return undefined
  return { port, token }
}

/**
 * 探活：`GET /status` 返回 2xx 才算这个地址可用。
 *
 * 用于淘汰陈旧的 `server-info.json`——文件里的端口可能早已随上一个实例退出，
 * 直接采用只会把后续请求引向 `fetch failed`。连接被拒时立即返回，不会等满超时。
 */
export async function probeAlive(info: TianshuServerInfo): Promise<boolean> {
  try {
    const response = await fetch(`${info.protocol ?? 'http'}://127.0.0.1:${info.port}/status`, {
      headers: { authorization: `Bearer ${info.token}` },
      signal: AbortSignal.timeout(2_000),
    })
    return response.ok
  } catch {
    return false
  }
}

/**
 * 自愈：把进程内发现的权威地址写回 `server-info.json`。
 *
 * 为什么需要：天枢 core 写这个文件时会先给临时文件做 ACL 加固，而加固脚本在
 * Windows 上对「零显式 ACE 的新文件」抛终止错误，异常又被空 catch 吞掉——文件
 * 于是长期停在旧实例的端口上。任何**其他**按该文件发现 core 的插件/工具都会
 * 因此连到死地址。插件在进程内拿到了权威地址，顺手把它修正，等于替 core 补上
 * 那次失败的写入。
 *
 * 只在两种情况写：文件不存在，或文件内容与权威地址不一致。写前先探活目标，
 * 避免把一个不可用的地址写进去。整体 fail-safe——任何异常都吞掉，自愈失败
 * 不影响插件自身（它本来就走进程内发现）。
 *
 * @returns 是否真的写入
 */
export function healServerInfo(
  info: TianshuServerInfo,
  options: { candidates?: readonly string[] } = {},
): boolean {
  const target = (options.candidates ?? serverInfoCandidates())[0]
  if (target === undefined) return false
  try {
    // 已经是权威地址就不动，避免无谓写盘。
    if (existsSync(target)) {
      try {
        const current = JSON.parse(readFileSync(target, 'utf8').replace(/^\uFEFF/, '')) as Partial<TianshuServerInfo>
        if (current.port === info.port && current.token === info.token) return false
      } catch { /* 损坏文件：继续覆写 */ }
    }
    const payload = {
      port: info.port,
      host: '127.0.0.1',
      ...(info.protocol === 'https' ? { protocol: 'https' } : {}),
      token: info.token,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    }
    // 临时文件 + rename：与 core 相同的原子替换，但不做 ACL 加固（那正是它失败的原因）。
    const tmp = `${target}.${process.pid}.heal.tmp`
    try {
      writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
      renameSync(tmp, target)
      return true
    } catch {
      try { unlinkSync(tmp) } catch { /* 清理失败无妨 */ }
      return false
    }
  } catch {
    return false
  }
}

/**
 * 解析出可用天枢地址：进程内注入优先，其次逐个探活已知发现文件。
 *
 * `env` / `argv` / `candidates` 可注入：测试必须能脱离本机真实环境断言，
 * 否则一台已装天枢的机器上「读到了什么」会让结果随环境漂移。
 * `heal: true` 时，在返回进程内地址前先把陈旧的路标文件修正。
 */
export async function locateTianshu(options: {
  env?: Record<string, string | undefined>
  argv?: readonly string[]
  candidates?: readonly string[]
  heal?: boolean
} = {}): Promise<TianshuServerInfo | undefined> {
  // 1) 进程内注入优先：同进程即可信，不读盘，也就不受 core 写盘失败影响。
  const inProcess = probeServeEnv(options.env ?? process.env, options.argv ?? process.argv)
  if (inProcess !== undefined) {
    if (options.heal === true) {
      try { healServerInfo(inProcess, { ...(options.candidates === undefined ? {} : { candidates: options.candidates }) }) } catch { /* 自愈失败不影响发现 */ }
    }
    return inProcess
  }
  // 2) 文件发现兜底（插件独立进程运行时）：逐个探活，跳过陈旧端口。
  for (const file of options.candidates ?? serverInfoCandidates()) {
    if (!existsSync(file)) continue
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as Partial<TianshuServerInfo>
      if (Number.isInteger(parsed.port) && parsed.port! > 0 && typeof parsed.token === 'string' && parsed.token) {
        const candidate: TianshuServerInfo = {
          port: parsed.port!,
          token: parsed.token,
          protocol: parsed.protocol ?? 'http',
        }
        if (await probeAlive(candidate)) return candidate
      }
    } catch { /* stale/partial discovery file: continue to the next known location */ }
  }
  return undefined
}
