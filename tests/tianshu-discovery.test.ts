import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { parseServePort, probeServeEnv, locateTianshu } from '../src/tianshu-discovery.ts'

/**
 * `locateTianshu` 的发现矩阵。
 *
 * 背景（这就是这套测试存在的原因）：插件原先只读 `server-info.json`。那个文件
 * 由天枢 core 写，而 core 的写路径会先给临时文件做 ACL 加固，加固脚本在
 * Windows 上对「零显式 ACE 的新文件」抛终止错误（PowerShell 把空数组展平成
 * `$null`，`Compare-Object -ReferenceObject $null` 直接报错），异常又被空
 * catch 吞掉——文件于是长期停在旧实例的端口上。插件照着它请求，就得到
 * `fetch failed`，整条 Provider 注册链路失败。
 *
 * 修法是改用天枢官方插件（内置 `tianshu-imbridge`）的进程内发现：插件与
 * serve 同进程，直接读 env 的 token 和 argv 的端口。下面的用例锁住这条路径，
 * 并确保文件兜底在「陈旧端口」和「缺失文件」时不会把请求引向死地址。
 */

// ── parseServePort：argv 解析 ─────────────────────────────────

test('parseServePort: 读 --port N 的独立 flag', () => {
  assert.equal(parseServePort(['node', 'entry.js', 'serve', '--port', '61754', '--host', '127.0.0.1']), 61754)
})

test('parseServePort: 也认 --port=N 内联写法', () => {
  assert.equal(parseServePort(['node', 'entry.js', 'serve', '--port=61754']), 61754)
})

test('parseServePort: 没有 serve 子命令时返回 undefined（TUI/headless 场景）', () => {
  assert.equal(parseServePort(['node', 'main.js', '-p', 'hi', '--json']), undefined)
  assert.equal(parseServePort(['node', 'main.js', '--port', '61754']), undefined)
})

test('parseServePort: 不把用户消息正文里的 --port= 当成本机端口', () => {
  // headless 会把整条消息作为一个 argv 元素传进来；若扫描其它元素的前缀，
  // 这条消息里的 `--port=27015` 就会被误认。双重排除（必须有 serve 子命令
  // + 只认独立元素）挡住它。
  const attack = ['node', 'main.js', '-p', '帮我看看 --port=27015 这个端口', '--json']
  assert.equal(parseServePort(attack), undefined)
})

test('parseServePort: 越界/非法端口返回 undefined', () => {
  assert.equal(parseServePort(['serve', '--port', '0']), undefined)
  assert.equal(parseServePort(['serve', '--port', '65536']), undefined)
  assert.equal(parseServePort(['serve', '--port', 'abc']), undefined)
  assert.equal(parseServePort(['serve', '--port']), undefined)
  assert.equal(parseServePort([]), undefined)
})

// ── probeServeEnv：进程内注入 ─────────────────────────────────

test('probeServeEnv: token + port 齐全 → 可用（核心修复路径）', () => {
  const result = probeServeEnv(
    { RIVET_SERVER_TOKEN: 'tok-123' },
    ['node', 'entry.js', 'serve', '--port', '61754'],
  )
  assert.deepEqual(result, { port: 61754, token: 'tok-123' })
})

test('probeServeEnv: 缺 token → undefined', () => {
  assert.equal(probeServeEnv({}, ['node', 'entry.js', 'serve', '--port', '61754']), undefined)
})

test('probeServeEnv: 缺 port（TUI/headless）→ undefined', () => {
  assert.equal(probeServeEnv({ RIVET_SERVER_TOKEN: 'tok' }, ['node', 'main.js', '-p', 'x']), undefined)
})

test('probeServeEnv: 空白 token 视同缺失', () => {
  assert.equal(
    probeServeEnv({ RIVET_SERVER_TOKEN: '   ' }, ['node', 'entry.js', 'serve', '--port', '1']),
    undefined,
  )
})

// ── locateTianshu：发现优先级与探活 ───────────────────────────

/** 起一个真实的 /status 服务，返回 { port, token, close }。 */
async function startStatusServer({ ok = true, expectedToken = 'live-token' } = {}) {
  const server = createServer((req, res) => {
    if (req.url !== '/status') {
      res.writeHead(404).end('{}')
      return
    }
    const auth = req.headers.authorization ?? ''
    if (auth !== `Bearer ${expectedToken}`) {
      res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"Unauthorized"}')
      return
    }
    if (!ok) {
      res.writeHead(500).end('{"error":"boom"}')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    port: address.port,
    token: expectedToken,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

test('locateTianshu: 进程内注入优先于文件（即便文件存在且可用）', async () => {
  const live = await startStatusServer({ expectedToken: 'file-token' })
  try {
    const dir = mkdtempSync(join(tmpdir(), 'wb-discover-'))
    const file = join(dir, 'server-info.json')
    writeFileSync(file, JSON.stringify({ port: live.port, token: 'file-token' }))

    const found = await locateTianshu({
      env: { RIVET_SERVER_TOKEN: 'env-token' },
      argv: ['node', 'entry.js', 'serve', '--port', '45678'],
      candidates: [file],
    })
    // 进程内是权威：同进程即可信，不该被磁盘上的东西改写。
    assert.deepEqual(found, { port: 45678, token: 'env-token' })
  } finally {
    await live.close()
  }
})

test('locateTianshu: 无进程内注入时，文件里的活端口可用', async () => {
  const live = await startStatusServer()
  try {
    const dir = mkdtempSync(join(tmpdir(), 'wb-discover-'))
    const file = join(dir, 'server-info.json')
    writeFileSync(file, JSON.stringify({ port: live.port, token: live.token }))

    const found = await locateTianshu({ env: {}, argv: [], candidates: [file] })
    assert.deepEqual(found, { port: live.port, token: live.token, protocol: 'http' })
  } finally {
    await live.close()
  }
})

test('locateTianshu: 陈旧文件的死端口被跳过（原 bug 的直接回归）', async () => {
  // 复现原故障：文件指向一个已经没有监听的端口。修复前这里会返回死端口，
  // 后续 fetch 得到 `fetch failed`；修复后探活失败应跳过。
  const dead = await startStatusServer()
  const deadPort = dead.port
  await dead.close() // 端口现在没人监听

  const dir = mkdtempSync(join(tmpdir(), 'wb-discover-'))
  const file = join(dir, 'server-info.json')
  writeFileSync(file, JSON.stringify({ port: deadPort, token: 'stale-token' }))

  const found = await locateTianshu({ env: {}, argv: [], candidates: [file] })
  assert.equal(found, undefined, '死端口必须被跳过，不能返回给调用方')
})

test('locateTianshu: 陈旧死端口在前、活端口在后 → 跳到活的', async () => {
  const dead = await startStatusServer()
  const deadPort = dead.port
  await dead.close()
  const live = await startStatusServer({ expectedToken: 'second-token' })
  try {
    const dir = mkdtempSync(join(tmpdir(), 'wb-discover-'))
    const staleFile = join(dir, 'stale.json')
    const liveFile = join(dir, 'live.json')
    writeFileSync(staleFile, JSON.stringify({ port: deadPort, token: 'stale' }))
    writeFileSync(liveFile, JSON.stringify({ port: live.port, token: 'second-token' }))

    const found = await locateTianshu({ env: {}, argv: [], candidates: [staleFile, liveFile] })
    assert.deepEqual(found, { port: live.port, token: 'second-token', protocol: 'http' })
  } finally {
    await live.close()
  }
})

test('locateTianshu: token 不匹配（401）也算不可用，继续找', async () => {
  // 端口活着但 token 是旧的：请求会 401，不能当成可用地址。
  const live = await startStatusServer({ expectedToken: 'right-token' })
  try {
    const dir = mkdtempSync(join(tmpdir(), 'wb-discover-'))
    const file = join(dir, 'server-info.json')
    writeFileSync(file, JSON.stringify({ port: live.port, token: 'wrong-token' }))

    const found = await locateTianshu({ env: {}, argv: [], candidates: [file] })
    assert.equal(found, undefined)
  } finally {
    await live.close()
  }
})

test('locateTianshu: 文件缺失/损坏时不抛异常', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-discover-'))
  const missing = join(dir, 'nope.json')
  const broken = join(dir, 'broken.json')
  writeFileSync(broken, '{ not json')

  assert.equal(await locateTianshu({ env: {}, argv: [], candidates: [missing] }), undefined)
  assert.equal(await locateTianshu({ env: {}, argv: [], candidates: [broken] }), undefined)
  assert.equal(await locateTianshu({ env: {}, argv: [], candidates: [] }), undefined)
})

test('locateTianshu: 端口字段非法时跳过该文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-discover-'))
  const file = join(dir, 'server-info.json')
  writeFileSync(file, JSON.stringify({ port: 'not-a-number', token: 't' }))
  assert.equal(await locateTianshu({ env: {}, argv: [], candidates: [file] }), undefined)
})

// ── healServerInfo：自愈（修正陈旧路标文件）─────────────────────

test('healServerInfo: 陈旧文件被覆写为权威地址', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-heal-'))
  const file = join(dir, 'server-info.json')
  writeFileSync(file, JSON.stringify({ port: 52231, pid: 52384, token: 'stale-token' }))

  const { healServerInfo } = await import('../src/tianshu-discovery.ts')
  const wrote = healServerInfo({ port: 61754, token: 'fresh-token' }, { candidates: [file] })
  assert.equal(wrote, true, '陈旧文件应被覆写')

  const after = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(after.port, 61754)
  assert.equal(after.token, 'fresh-token')
})

test('healServerInfo: 内容已一致时不重复写盘', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-heal-'))
  const file = join(dir, 'server-info.json')
  writeFileSync(file, JSON.stringify({ port: 61754, token: 'same-token', pid: 1 }))

  const { healServerInfo } = await import('../src/tianshu-discovery.ts')
  const wrote = healServerInfo({ port: 61754, token: 'same-token' }, { candidates: [file] })
  assert.equal(wrote, false, '一致时不该写')
})

test('healServerInfo: 文件不存在时创建', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-heal-'))
  const file = join(dir, 'server-info.json')
  const { healServerInfo } = await import('../src/tianshu-discovery.ts')
  const wrote = healServerInfo({ port: 61754, token: 'new-token' }, { candidates: [file] })
  assert.equal(wrote, true)
  const after = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(after.port, 61754)
  assert.equal(after.host, '127.0.0.1')
  assert.ok(typeof after.startedAt === 'string')
})

test('healServerInfo: 损坏文件被修复（不抛异常）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-heal-'))
  const file = join(dir, 'server-info.json')
  writeFileSync(file, '{ not json at all')
  const { healServerInfo } = await import('../src/tianshu-discovery.ts')
  const wrote = healServerInfo({ port: 61754, token: 'fixed' }, { candidates: [file] })
  assert.equal(wrote, true)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).port, 61754)
})

test('healServerInfo: 不可写路径时安静失败（不抛异常）', async () => {
  const { healServerInfo } = await import('../src/tianshu-discovery.ts')
  // 指向一个不存在的目录下的文件
  const wrote = healServerInfo(
    { port: 61754, token: 't' },
    { candidates: ['Z:/nonexistent-dir-xyz/server-info.json'] },
  )
  assert.equal(wrote, false, '写不了应返回 false 而不是抛')
})

test('locateTianshu(heal:true): 进程内发现后顺带修正陈旧文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-heal-'))
  const file = join(dir, 'server-info.json')
  writeFileSync(file, JSON.stringify({ port: 52231, pid: 52384, token: 'stale' }))

  const found = await locateTianshu({
    env: { RIVET_SERVER_TOKEN: 'authoritative' },
    argv: ['node', 'entry.js', 'serve', '--port', '61754'],
    candidates: [file],
    heal: true,
  })
  assert.deepEqual(found, { port: 61754, token: 'authoritative' })
  const after = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(after.port, 61754, '路标文件应已被自愈')
  assert.equal(after.token, 'authoritative')
})

test('locateTianshu(heal:false/缺省): 不触碰文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-heal-'))
  const file = join(dir, 'server-info.json')
  writeFileSync(file, JSON.stringify({ port: 52231, pid: 52384, token: 'stale' }))

  await locateTianshu({
    env: { RIVET_SERVER_TOKEN: 'authoritative' },
    argv: ['node', 'entry.js', 'serve', '--port', '61754'],
    candidates: [file],
  })
  const after = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(after.port, 52231, '缺省不该写盘')
})
