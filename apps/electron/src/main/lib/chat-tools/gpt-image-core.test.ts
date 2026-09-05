/**
 * gpt-image-core BDD 测试
 *
 * 覆盖：URL 拼接规则、渠道目标解析错误链、生图模型识别、
 * Images API 响应解析（b64_json / url / 错误透传）。
 */

import { describe, expect, mock, test, beforeEach, afterEach } from 'bun:test'
import { join } from 'node:path'

// ===== 模块 mock（必须在被测模块 import 前声明，用绝对路径确保拦截） =====

const libDir = join(import.meta.dir, '..')

/** 渠道存储（可变，供各用例注入） */
let mockChannels: {
  id: string
  name: string
  provider: string
  baseUrl: string
  enabled: boolean
  models: { id: string; name: string; enabled: boolean }[]
}[] = []
let mockDecryptedKey = 'sk-test-key'

mock.module(join(libDir, 'channel-manager'), () => ({
  getChannelById: (id: string) => mockChannels.find((c) => c.id === id),
  decryptApiKey: () => mockDecryptedKey,
}))

let mockCredentials: Record<string, string> = {}
mock.module(join(libDir, 'chat-tool-config'), () => ({
  getToolCredentials: () => mockCredentials,
}))

// 被测模块（在 mock 声明后动态导入，确保 mock 先于依赖链加载）
const {
  buildImagesUrl,
  normalizeBaseUrl,
  isLikelyImageModel,
  resolveGptImageTarget,
  generateImages,
} = await import('./gpt-image-core')

type GptImageTarget = Awaited<ReturnType<typeof resolveGptImageTarget>>

// ===== 测试环境 =====

const originalFetch = globalThis.fetch

/** 标准可用渠道 */
function seedChannel(overrides: Record<string, unknown> = {}): void {
  mockChannels = [{
    id: 'ch-1',
    name: '测试渠道',
    provider: 'openai-responses',
    baseUrl: 'https://gw.example.com/v1',
    enabled: true,
    models: [
      { id: 'gpt-image-1', name: 'GPT Image', enabled: true },
      { id: 'gpt-4o', name: 'GPT 4o', enabled: true },
    ],
    ...overrides,
  }]
  mockCredentials = { channelId: 'ch-1', modelId: 'gpt-image-1' }
  mockDecryptedKey = 'sk-test-key'
}

const TARGET: GptImageTarget = {
  baseUrl: 'https://gw.example.com/v1',
  apiKey: 'sk-test-key',
  modelId: 'gpt-image-1',
  channelName: '测试渠道',
}

describe('GPT Image URL 拼接', () => {
  test('Given 已带 /v1 的 baseUrl When 拼接 generations Then 直接追加相对路径', () => {
    expect(buildImagesUrl('https://api.openai.com/v1', 'images/generations'))
      .toBe('https://api.openai.com/v1/images/generations')
  })

  test('Given 裸 host 的 baseUrl When 拼接 Then 自动补 /v1 前缀', () => {
    expect(buildImagesUrl('http://localhost:8080', 'images/edits'))
      .toBe('http://localhost:8080/v1/images/edits')
  })

  test('Given 尾斜杠的 /v1 baseUrl When 拼接 Then 先去尾斜杠', () => {
    expect(buildImagesUrl('http://localhost:8080/v1/', 'images/generations'))
      .toBe('http://localhost:8080/v1/images/generations')
  })

  test('Given 多重尾斜杠 When 归一化 Then 全部移除', () => {
    expect(normalizeBaseUrl('https://gw.example.com/v1///')).toBe('https://gw.example.com/v1')
    expect(normalizeBaseUrl('  https://gw.example.com  ')).toBe('https://gw.example.com')
  })
})

describe('GPT Image 生图模型识别', () => {
  test('Given 常见生图模型 id When 识别 Then 命中', () => {
    expect(isLikelyImageModel('gpt-image-1')).toBe(true)
    expect(isLikelyImageModel('GPT-Image-1-Mini')).toBe(true)
    expect(isLikelyImageModel('dall-e-3')).toBe(true)
    expect(isLikelyImageModel('qwen-image-plus')).toBe(true)
    expect(isLikelyImageModel('flux.1-schnell')).toBe(true)
  })

  test('Given 聊天/理解模型 id When 识别 Then 不误命中', () => {
    expect(isLikelyImageModel('gpt-4o')).toBe(false)
    expect(isLikelyImageModel('claude-sonnet-4-5')).toBe(false)
    expect(isLikelyImageModel('gemini-3.1-flash-image-preview')).toBe(true) // Gemini 生图模型同样命中
    expect(isLikelyImageModel('qwen3-vl-plus')).toBe(false)
  })
})

describe('GPT Image 渠道目标解析', () => {
  beforeEach(() => { seedChannel() })

  test('Given 已选模型的有效渠道 When 解析 Then 返回 baseUrl/apiKey/modelId', () => {
    const target = resolveGptImageTarget()
    expect(target.baseUrl).toBe('https://gw.example.com/v1')
    expect(target.apiKey).toBe('sk-test-key')
    expect(target.modelId).toBe('gpt-image-1')
  })

  test('Given 未配置 channelId/modelId When 解析 Then 提示前往设置选择', () => {
    mockCredentials = {}
    expect(() => resolveGptImageTarget()).toThrow('未选择生图模型')
  })

  test('Given 渠道已被删除 When 解析 Then 提示重新选择', () => {
    mockCredentials = { channelId: 'gone', modelId: 'gpt-image-1' }
    expect(() => resolveGptImageTarget()).toThrow('渠道已不存在')
  })

  test('Given 渠道已停用 When 解析 Then 提示启用渠道', () => {
    seedChannel({ enabled: false })
    expect(() => resolveGptImageTarget()).toThrow('已停用')
  })

  test('Given 模型不在渠道列表 When 解析 Then 提示重新选择', () => {
    mockCredentials = { channelId: 'ch-1', modelId: 'not-exist' }
    expect(() => resolveGptImageTarget()).toThrow('不在渠道')
  })

  test('Given API Key 解密为空 When 解析 Then 提示检查渠道配置', () => {
    mockDecryptedKey = ''
    expect(() => resolveGptImageTarget()).toThrow('API Key 解密失败')
  })

  test('Given 渠道未配置 baseUrl When 解析 Then 提示补充地址', () => {
    seedChannel({ baseUrl: '' })
    expect(() => resolveGptImageTarget()).toThrow('未配置 API 地址')
  })
})

describe('GPT Image Images API 调用', () => {
  beforeEach(() => {
    seedChannel()
    globalThis.fetch = mock((_url: unknown, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
      return Promise.resolve(new Response(JSON.stringify({
        data: Array.from({ length: body.n ?? 1 }, () => ({ b64_json: 'aGVsbG8=' })),
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    }) as unknown as typeof fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('Given 正常 b64_json 响应 When 文生图 Then 返回图片列表且请求体正确', async () => {
    const artifacts = await generateImages(TARGET, { prompt: 'a cat', numberOfImages: 2 })
    expect(artifacts).toHaveLength(2)
    expect(artifacts[0]!.base64).toBe('aGVsbG8=')
    expect(artifacts[0]!.mimeType).toBe('image/png')
  })

  test('Given url 形态响应 When 解析 Then 下载并转 base64', async () => {
    globalThis.fetch = mock((url: unknown) => {
      const urlStr = String(url)
      if (urlStr.includes('images/generations')) {
        return Promise.resolve(new Response(JSON.stringify({
          data: [{ url: 'https://cdn.example.com/img.png' }],
        }), { status: 200, headers: { 'content-type': 'application/json' } }))
      }
      return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }))
    }) as unknown as typeof fetch

    const artifacts = await generateImages(TARGET, { prompt: 'a dog' })
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]!.base64).toBe(Buffer.from([1, 2, 3]).toString('base64'))
  })

  test('Given 空 prompt When 调用 Then 抛出参数缺失错误', async () => {
    expect(generateImages(TARGET, { prompt: '  ' })).rejects.toThrow('参数缺失')
  })

  test('Given 网关 4xx 错误 When 调用 Then 透传状态与错误信息', async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      error: { message: 'model not found' },
    }), { status: 404, headers: { 'content-type': 'application/json' } }))) as unknown as typeof fetch

    await expect(generateImages(TARGET, { prompt: 'x' })).rejects.toThrow('404')
  })

  test('Given 响应 data 为空 When 解析 Then 报未返回图片', async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({ data: [] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }))) as unknown as typeof fetch

    await expect(generateImages(TARGET, { prompt: 'x' })).rejects.toThrow('未返回任何图片')
  })

  test('Given 参考图 When 调用 Then 走 edits 端点 multipart', async () => {
    let capturedUrl = ''
    let capturedInit: RequestInit | undefined
    globalThis.fetch = mock((url: unknown, init?: RequestInit) => {
      capturedUrl = String(url)
      capturedInit = init
      return Promise.resolve(new Response(JSON.stringify({
        data: [{ b64_json: 'aGVsbG8=' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    }) as unknown as typeof fetch

    await generateImages(TARGET, {
      prompt: 'make it watercolor',
      referenceImages: [{ mimeType: 'image/png', base64: 'aGVsbG8=' }],
    })

    expect(capturedUrl).toBe('https://gw.example.com/v1/images/edits')
    expect(capturedInit!.body).toBeInstanceOf(FormData)
  })

  test('Given numberOfImages 超界 When 调用 Then 收敛到 1-4', async () => {
    let capturedBody = ''
    globalThis.fetch = mock((_url: unknown, init?: RequestInit) => {
      capturedBody = String(init?.body ?? '')
      return Promise.resolve(new Response(JSON.stringify({
        data: [{ b64_json: 'aGVsbG8=' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    }) as unknown as typeof fetch

    await generateImages(TARGET, { prompt: 'x', numberOfImages: 99 })
    expect(JSON.parse(capturedBody).n).toBe(4)
  })
})
