import { randomBytes, timingSafeEqual } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync, closeSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  createWorkBuddyShim,
  oauthPoll,
  oauthStart,
  regionOfOAuthAccount,
  WorkBuddyCatalog,
  WorkBuddyCredentialStore,
  WorkBuddyUpstreamClient,
  type WorkBuddyRegion,
  type WorkBuddyUpstreamModel,
} from './tianshu-core.ts'
import { locateTianshu } from './tianshu-discovery.ts'

export const PLUGIN_VERSION = '1.0.0'
export const REGIONS = ['cn', 'global'] as const satisfies readonly WorkBuddyRegion[]
const DEFAULT_PORTS: Record<WorkBuddyRegion, number> = { cn: 28791, global: 28792 }
const REFRESH_MS = 30 * 60_000
const PROXY_BODY_LIMIT = 128 * 1024 * 1024

interface RuntimeConfig {
  host: '127.0.0.1'
  ports: Record<WorkBuddyRegion, number>
  token: string
}

interface RegionStack {
  store: WorkBuddyCredentialStore
  catalog: WorkBuddyCatalog
  shim: ReturnType<typeof createWorkBuddyShim>
  account?: { domain?: string, id?: string | null, error?: string }
  listenError?: string
  server?: Server
  ownsPort: boolean
}

export interface SetupRegionResult {
  ok: boolean
  provider: string
  models?: number
  skipped?: boolean
  error?: string
}

function rivetHome(): string {
  const configured = process.env['RIVET_HOME']?.trim()
  return configured || join(homedir(), '.rivet')
}

export function pluginStateDir(): string {
  return join(rivetHome(), 'workbuddy-connect')
}

function configPath(): string {
  return join(pluginStateDir(), 'config.json')
}

function parsePort(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 1024 && parsed <= 65535 ? parsed : fallback
}

/** Create/read the local bearer without ever returning it through a tool. */
function loadRuntimeConfig(): RuntimeConfig {
  const file = configPath()
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    const fresh: RuntimeConfig = {
      host: '127.0.0.1',
      ports: { ...DEFAULT_PORTS },
      token: randomBytes(32).toString('base64url'),
    }
    try {
      const fd = openSync(file, 'wx', 0o600)
      try { writeFileSync(fd, `${JSON.stringify(fresh, null, 2)}\n`, 'utf8') } finally { closeSync(fd) }
      return fresh
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      // A concurrent Tianshu process won creation; read its complete file.
    }
  }

  const parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as Partial<RuntimeConfig>
  if (typeof parsed.token !== 'string' || parsed.token.length < 24) {
    throw new Error(`WorkBuddy 插件配置无效：${file} 缺少安全 token`)
  }
  try { chmodSync(file, 0o600) } catch { /* Windows ACL is managed by the parent Tianshu data directory. */ }
  return {
    host: '127.0.0.1',
    ports: {
      cn: parsePort(parsed.ports?.cn, DEFAULT_PORTS.cn),
      global: parsePort(parsed.ports?.global, DEFAULT_PORTS.global),
    },
    token: parsed.token,
  }
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function providerName(region: WorkBuddyRegion): string {
  return region === 'cn' ? 'workbuddy' : 'workbuddy-global'
}

function presentedBearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization?.trim()
  const match = header?.match(/^Bearer\s+(.+)$/i)
  return match?.[1]
}

function tokenMatches(actual: string, presented: string | undefined): boolean {
  if (presented === undefined) return false
  const left = Buffer.from(actual)
  const right = Buffer.from(presented)
  return left.length === right.length && timingSafeEqual(left, right)
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function readProxyBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > PROXY_BODY_LIMIT) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function modelDescription(model: WorkBuddyUpstreamModel): string {
  const multiplier = typeof model.creditMultiplier === 'number'
    ? `积分倍率 x${model.creditMultiplier.toFixed(2)}`
    : '积分倍率未提供'
  return `WorkBuddy · ${multiplier}`
}

function tianshuModel(model: WorkBuddyUpstreamModel): Record<string, unknown> {
  return {
    id: model.id,
    description: modelDescription(model),
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...(model.multimodal === true ? { supportsVision: true } : {}),
    ...(typeof model.creditMultiplier === 'number' && model.creditMultiplier === 0
      ? { pricing: { free: true } }
      : {}),
    capabilities: {
      effortFormat: 'reasoning_effort',
      supportsThinking: true,
    },
  }
}

function modelsPayload(catalog: WorkBuddyCatalog): Record<string, unknown> {
  return {
    object: 'list',
    data: catalog.current().map(model => ({
      id: model.id,
      object: 'model',
      created: 0,
      owned_by: 'workbuddy',
      name: typeof model.creditMultiplier === 'number'
        ? `${model.name} · x${model.creditMultiplier.toFixed(2)}`
        : model.name,
      description: modelDescription(model),
      context_window: model.contextWindow,
      max_output_tokens: model.maxTokens,
      ...(model.multimodal === true ? { supports_vision: true } : {}),
    })),
  }
}

async function callTianshu(path: string, init: RequestInit = {}): Promise<{ ok: boolean, status: number, body: any }> {
  // heal: true —— 顺手修正陈旧的 server-info.json，让其他按该文件发现 core 的
  // 插件/工具也能连上（core 自身那次写入在 Windows 上会静默失败）。
  const tianshu = await locateTianshu({ heal: true })
  if (tianshu === undefined) throw new Error('未找到正在运行的天枢 sidecar；请先启动天枢桌面端')
  const response = await fetch(`${tianshu.protocol ?? 'http'}://127.0.0.1:${tianshu.port}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${tianshu.token}`,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...init.headers,
    },
    signal: AbortSignal.timeout(20_000),
  })
  const text = await response.text()
  let body: any
  try { body = JSON.parse(text) } catch { body = { error: text.slice(0, 500) } }
  return { ok: response.ok, status: response.status, body }
}

async function openExternal(url: string): Promise<boolean> {
  const parsed = new URL(url)
  if (!['http:', 'https:'].includes(parsed.protocol)) return false
  const command = process.platform === 'win32'
    ? { file: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', parsed.href] }
    : process.platform === 'darwin'
      ? { file: 'open', args: [parsed.href] }
      : { file: 'xdg-open', args: [parsed.href] }
  try {
    const child = spawn(command.file, command.args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
    return true
  } catch {
    return false
  }
}

export class WorkBuddyTianshuRuntime {
  readonly config = loadRuntimeConfig()
  private readonly client: WorkBuddyUpstreamClient
  private readonly stacks: Record<WorkBuddyRegion, RegionStack>
  private refreshTimer?: NodeJS.Timeout

  private constructor(client: WorkBuddyUpstreamClient, stacks: Record<WorkBuddyRegion, RegionStack>) {
    this.client = client
    this.stacks = stacks
  }

  static async create(): Promise<WorkBuddyTianshuRuntime> {
    const state = pluginStateDir()
    mkdirSync(state, { recursive: true, mode: 0o700 })
    const client = new WorkBuddyUpstreamClient(() => {})
    const stacks = {} as Record<WorkBuddyRegion, RegionStack>

    for (const region of REGIONS) {
      const authDir = join(state, 'auth')
      const store = new WorkBuddyCredentialStore({
        region,
        ownPath: join(authDir, `${region}.json`),
        legacyOwnPath: join(authDir, 'legacy.json'),
        vaultDir: join(state, 'vault', region),
        refresh: credential => client.refreshToken(credential),
      })
      const catalog = new WorkBuddyCatalog(region)
      const shim = createWorkBuddyShim({
        store,
        client,
        catalog,
        logger: { warn: () => {}, error: () => {} },
      })
      stacks[region] = { store, catalog, shim, ownsPort: false }
    }

    const runtime = new WorkBuddyTianshuRuntime(client, stacks)
    await Promise.all(REGIONS.map(region => stacks[region].shim.ready))
    await Promise.all(REGIONS.map(region => runtime.ensurePublicServer(region)))
    await runtime.refresh()
    runtime.refreshTimer = setInterval(() => void runtime.refresh(), REFRESH_MS)
    runtime.refreshTimer.unref()
    return runtime
  }

  private async proxy(region: WorkBuddyRegion, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const stack = this.stacks[region]
    const target = `${stack.shim.baseUrl()}${req.url ?? '/'}`
    const headers = new Headers()
    for (const [name, value] of Object.entries(req.headers)) {
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value)
    }
    const connectionHeaders = (headers.get('connection') ?? '').split(',').map(value => value.trim().toLowerCase())
    for (const name of [
      'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
      'te', 'trailer', 'transfer-encoding', 'upgrade', ...connectionHeaders,
    ]) headers.delete(name)
    headers.set('authorization', `Bearer ${stack.shim.token()}`)
    headers.set('host', new URL(stack.shim.baseUrl()).host)
    headers.delete('origin')
    try {
      const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readProxyBody(req)
      const response = await fetch(target, {
        method: req.method ?? 'GET',
        headers,
        ...(body === undefined ? {} : { body }),
      })
      res.writeHead(response.status, Object.fromEntries(response.headers))
      if (response.body === null) return void res.end()
      for await (const chunk of response.body) {
        if (!res.write(chunk)) await new Promise(resolve => res.once('drain', resolve))
      }
      res.end()
    } catch (error) {
      if (!res.headersSent) json(res, 502, { error: { message: `WorkBuddy 上游失败：${safeMessage(error)}`, type: 'server_error' } })
      else res.end()
    }
  }

  private requestHandler(region: WorkBuddyRegion): (req: IncomingMessage, res: ServerResponse) => void {
    return (req, res) => {
      if (!tokenMatches(this.config.token, presentedBearer(req))) {
        json(res, 401, { error: { message: 'invalid bridge token', type: 'unauthorized' } })
        return
      }
      const url = req.url ?? '/'
      if (req.method === 'GET' && url === '/health') {
        json(res, 200, { ok: true, plugin: 'tianshu-connect-workbuddy', version: PLUGIN_VERSION, region })
        return
      }
      if (req.method === 'GET' && (url === '/v1/models' || url === '/v1/models/')) {
        json(res, 200, modelsPayload(this.stacks[region].catalog))
        return
      }
      void this.proxy(region, req, res)
    }
  }

  private async existingPluginOwnsPort(region: WorkBuddyRegion): Promise<boolean> {
    try {
      const response = await fetch(`http://${this.config.host}:${this.config.ports[region]}/health`, {
        headers: { authorization: `Bearer ${this.config.token}` },
        signal: AbortSignal.timeout(2_000),
      })
      const body = await response.json() as { plugin?: string, region?: string }
      return response.ok && body.plugin === 'tianshu-connect-workbuddy' && body.region === region
    } catch {
      return false
    }
  }

  private async ensurePublicServer(region: WorkBuddyRegion): Promise<void> {
    const stack = this.stacks[region]
    if (stack.server?.listening) return
    const server = createServer(this.requestHandler(region))
    stack.server = server
    await new Promise<void>((resolve) => {
      server.once('error', async error => {
        if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE' && await this.existingPluginOwnsPort(region)) {
          stack.ownsPort = false
          delete stack.listenError
        } else {
          stack.listenError = safeMessage(error)
        }
        resolve()
      })
      server.listen(this.config.ports[region], this.config.host, () => {
        stack.ownsPort = true
        delete stack.listenError
        resolve()
      })
    })
  }

  async refresh(region?: WorkBuddyRegion): Promise<Record<string, unknown>> {
    const targets = region === undefined ? REGIONS : [region]
    const results: Record<string, unknown> = {}
    for (const current of targets) {
      const stack = this.stacks[current]
      try {
        const accounts = await stack.store.accounts()
        if (accounts.length === 0) {
          stack.catalog.setRegionUsable(false)
          stack.account = { error: '未登录' }
          results[current] = { ok: false, signedIn: false, error: '未登录' }
          continue
        }
        stack.catalog.setRegionUsable(true)
        const credential = await stack.store.resolve()
        const models = await this.client.fetchModels(credential)
        stack.catalog.set(models)
        stack.account = { domain: credential.domain }
        results[current] = { ok: true, signedIn: true, models: models.length }
      } catch (error) {
        const message = safeMessage(error)
        stack.account = { error: message }
        results[current] = { ok: false, error: message }
      }
    }
    return results
  }

  private providerPayload(region: WorkBuddyRegion): Record<string, unknown> {
    return {
      providerName: providerName(region),
      baseUrl: `http://${this.config.host}:${this.config.ports[region]}/v1`,
      apiKey: this.config.token,
      protocol: 'openai',
      force: true,
      slowThinking: true,
      capabilities: {
        supportsThinking: true,
        thinkingBlockType: 'none',
        effortFormat: 'reasoning_effort',
        supportsResponseFormat: false,
        prefixCacheStrategy: 'none',
      },
      models: this.stacks[region].catalog.current().map(tianshuModel),
    }
  }

  async setup(region?: WorkBuddyRegion): Promise<{ ok: boolean, regions: Record<string, SetupRegionResult> }> {
    await this.refresh(region)
    const targets = region === undefined ? REGIONS : [region]
    const regions: Record<string, SetupRegionResult> = {}
    for (const current of targets) {
      const provider = providerName(current)
      const models = this.stacks[current].catalog.current()
      if (models.length === 0) {
        regions[current] = { ok: false, provider, skipped: true, error: '该区域尚未登录，未注册空 Provider' }
        continue
      }
      try {
        const response = await callTianshu('/config/providers/custom', {
          method: 'POST',
          body: JSON.stringify(this.providerPayload(current)),
        })
        regions[current] = response.ok && response.body?.ok === true
          ? { ok: true, provider, models: models.length }
          : { ok: false, provider, error: response.body?.error ?? `HTTP ${response.status}` }
      } catch (error) {
        regions[current] = { ok: false, provider, error: safeMessage(error) }
      }
    }
    return { ok: Object.values(regions).some(item => item.ok), regions }
  }

  async snapshot(): Promise<Record<string, unknown>> {
    const regions: Record<string, unknown> = {}
    for (const region of REGIONS) {
      const stack = this.stacks[region]
      const accounts = await stack.store.accounts().catch(() => [])
      const accountRows = []
      for (const account of accounts) {
        let credits: number | undefined
        let creditsError: string | undefined
        try {
          const credential = await stack.store.credentialFor(account.id)
          if (credential !== undefined) credits = (await this.client.fetchCredits(credential)).total
        } catch (error) { creditsError = safeMessage(error) }
        accountRows.push({
          id: account.id,
          name: account.accountName || '未命名账号',
          domain: account.domain,
          selected: account.selected,
          tokenExpiresAtMs: account.tokenExpiresAtMs,
          ...(credits === undefined ? {} : { credits }),
          ...(creditsError === undefined ? {} : { creditsError }),
        })
      }
      regions[region] = {
        provider: providerName(region),
        baseUrl: `http://${this.config.host}:${this.config.ports[region]}/v1`,
        listening: stack.listenError === undefined,
        ownsPort: stack.ownsPort,
        ...(stack.listenError === undefined ? {} : { listenError: stack.listenError }),
        accounts: accountRows,
        models: stack.catalog.current().map(model => ({
          id: model.id,
          name: model.name,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
          supportsVision: model.multimodal === true,
          ...(typeof model.creditMultiplier === 'number' ? { creditMultiplier: model.creditMultiplier } : {}),
        })),
      }
    }
    return { ok: true, version: PLUGIN_VERSION, regions }
  }

  async startLogin(region: WorkBuddyRegion, openBrowser = true): Promise<Record<string, unknown>> {
    const result = await oauthStart(region)
    if ('error' in result) return { ok: false, error: result.error }
    const browserOpened = openBrowser ? await openExternal(result.verificationUri) : false
    return { ok: true, region, loginId: result.loginId, verificationUri: result.verificationUri, expiresIn: result.expiresIn, browserOpened }
  }

  async finishLogin(region: WorkBuddyRegion, loginId: string): Promise<Record<string, unknown>> {
    const result = await oauthPoll(loginId, region)
    if (!result.done) return { ok: false, pending: true }
    if ('error' in result) return { ok: false, error: result.error }
    const actual = regionOfOAuthAccount(result.account)
    if (actual !== region) return { ok: false, error: `登录结果属于 ${actual}，不是 ${region}` }
    const accountId = await this.stacks[region].store.addOAuthAccount({
      accessToken: result.account.accessToken,
      refreshToken: result.account.refreshToken,
      expiresAtMs: result.account.expiresAtMs,
      ...(result.account.refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs: result.account.refreshExpiresAtMs }),
      domain: result.account.domain,
      uid: result.account.uid,
      ...(result.account.nickname === undefined ? {} : { nickname: result.account.nickname }),
      ...(result.account.uin === undefined ? {} : { uin: result.account.uin }),
      ...(result.account.enterpriseId === undefined ? {} : { enterpriseId: result.account.enterpriseId }),
    })
    this.stacks[region].store.selectAccount(accountId)
    await this.refresh(region)
    const registered = await this.setup(region)
    return { ok: registered.ok, pending: false, accountId, registered }
  }

  async endpointTest(region?: WorkBuddyRegion): Promise<Record<string, unknown>> {
    const targets = region === undefined ? REGIONS : [region]
    const regions: Record<string, unknown> = {}
    for (const current of targets) {
      try {
        const response = await fetch(`http://${this.config.host}:${this.config.ports[current]}/v1/models`, {
          headers: { authorization: `Bearer ${this.config.token}` },
          signal: AbortSignal.timeout(10_000),
        })
        const body = await response.json() as { data?: unknown[] }
        regions[current] = response.ok
          ? { ok: true, models: Array.isArray(body.data) ? body.data.length : 0 }
          : { ok: false, error: `HTTP ${response.status}` }
      } catch (error) { regions[current] = { ok: false, error: safeMessage(error) } }
    }
    return { ok: Object.values(regions).every((item: any) => item.ok), regions }
  }

  async modelTest(region: WorkBuddyRegion, modelId: string): Promise<Record<string, unknown>> {
    const response = await fetch(`http://${this.config.host}:${this.config.ports[region]}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.config.token}` },
      body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: '只回复 OK' }], stream: true, max_tokens: 64 }),
      signal: AbortSignal.timeout(90_000),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`)
    let output = ''
    let carry = ''
    const decoder = new TextDecoder()
    for await (const chunk of response.body ?? []) {
      carry += decoder.decode(chunk, { stream: true })
      let newline = carry.indexOf('\n')
      while (newline >= 0) {
        const line = carry.slice(0, newline).trim()
        carry = carry.slice(newline + 1)
        if (line.startsWith('data:')) {
          const payload = line.slice(5).trim()
          if (payload && payload !== '[DONE]') {
            try {
              const frame = JSON.parse(payload)
              if (typeof frame.choices?.[0]?.delta?.content === 'string') output += frame.choices[0].delta.content
            } catch { /* Ignore non-JSON keepalive frames. */ }
          }
        }
        newline = carry.indexOf('\n')
      }
    }
    return { ok: output.trim().length > 0, region, model: modelId, reply: output.trim().slice(0, 120) }
  }

  async close(): Promise<void> {
    if (this.refreshTimer !== undefined) clearInterval(this.refreshTimer)
    await Promise.all([
      ...REGIONS.map(region => new Promise<void>(resolve => {
        const server = this.stacks[region].server
        if (server === undefined || !server.listening) return resolve()
        server.close(() => resolve())
      })),
      ...REGIONS.map(region => this.stacks[region].shim.close().catch(() => undefined)),
    ])
  }
}

const RUNTIME_KEY = Symbol.for('tianshu-connect-workbuddy.runtime')
type RuntimeGlobal = typeof globalThis & { [RUNTIME_KEY]?: Promise<WorkBuddyTianshuRuntime> }

export function getRuntime(): Promise<WorkBuddyTianshuRuntime> {
  const shared = globalThis as RuntimeGlobal
  shared[RUNTIME_KEY] ??= WorkBuddyTianshuRuntime.create()
  return shared[RUNTIME_KEY]
}
