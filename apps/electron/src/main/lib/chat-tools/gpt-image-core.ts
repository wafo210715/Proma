/**
 * GPT Image 生图核心模块（Chat 模式与 Agent 模式共用）
 *
 * 基于 OpenAI Images API（/v1/images/generations 与 /v1/images/edits）提供
 * 文生图与参考图编辑能力。凭据不独立存储，而是引用「模型配置」中的渠道：
 * toolCredentials['gpt-image'] = { channelId, modelId }，运行时通过
 * channel-manager 解密渠道 API Key。渠道改 Key / 换地址 / 改模型名后自动跟随。
 */

import type { Channel } from '@proma/shared'
import { isLikelyImageModel } from '@proma/shared'
import { getChannelById, decryptApiKey } from '../channel-manager'
import { getToolCredentials } from '../chat-tool-config'

// ===== 常量 =====

/** 生图请求超时（高质量大图可能较慢） */
export const GPT_IMAGE_TIMEOUT_MS = 120_000

/** Images API 路径 */
const GENERATIONS_PATH = 'images/generations'
const EDITS_PATH = 'images/edits'

// ===== 渠道目标解析 =====

/** 解析后的生图调用目标 */
export interface GptImageTarget {
  /** 渠道根地址（已归一化，无尾斜杠） */
  baseUrl: string
  /** 解密后的 API Key */
  apiKey: string
  /** 生图模型 ID */
  modelId: string
  /** 来源渠道（供日志与错误信息使用） */
  channelName: string
}

/** 渠道解析失败的结构化错误 */
export class GptImageConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GptImageConfigError'
  }
}

/**
 * 读取并校验 gpt-image 工具的渠道配置。
 *
 * 校验链：channelId 已配置 → 渠道存在 → 渠道启用 → modelId 在渠道模型列表中 →
 * API Key 可解密。任何一环失败抛出 GptImageConfigError，错误文案面向用户。
 */
export function resolveGptImageTarget(): GptImageTarget {
  const credentials = getToolCredentials('gpt-image')
  const channelId = credentials.channelId?.trim()
  const modelId = credentials.modelId?.trim()

  if (!channelId || !modelId) {
    throw new GptImageConfigError('GPT Image 未选择生图模型，请在 设置 → Chat 工具 中选择')
  }

  const channel: Channel | undefined = getChannelById(channelId)
  if (!channel) {
    throw new GptImageConfigError('GPT Image 关联的渠道已不存在，请重新选择生图模型')
  }
  if (!channel.enabled) {
    throw new GptImageConfigError(`渠道「${channel.name}」已停用，请启用后重试或重新选择`)
  }

  const modelExists = channel.models.some((m) => m.id === modelId && m.enabled)
  if (!modelExists) {
    throw new GptImageConfigError(
      `模型 ${modelId} 不在渠道「${channel.name}」的可用模型列表中，请重新选择`,
    )
  }

  let apiKey = ''
  try {
    apiKey = decryptApiKey(channelId)
  } catch (error) {
    console.error('[GPT Image] 渠道 API Key 解密失败:', error)
  }
  if (!apiKey) {
    throw new GptImageConfigError(`渠道「${channel.name}」的 API Key 解密失败，请检查渠道配置`)
  }

  const baseUrl = normalizeBaseUrl(channel.baseUrl || '')
  if (!baseUrl) {
    throw new GptImageConfigError(`渠道「${channel.name}」未配置 API 地址，请补充后重试`)
  }

  return { baseUrl, apiKey, modelId, channelName: channel.name }
}

// ===== URL 拼接 =====

/**
 * 归一化渠道根地址：去尾斜杠。
 * 空地址返回空字符串（由调用方给出明确错误）。
 */
export function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '')
}

/**
 * 将渠道根地址与 Images API 路径拼接为完整端点。
 *
 * 兼容三种用户填法：
 * - `https://api.openai.com/v1`（官方 / 标准 OpenAI 兼容网关）→ `.../v1/images/generations`
 * - `http://localhost:8080/`（new-api 类网关，带尾斜杠）→ `http://localhost:8080/v1/images/generations`
 * - `http://localhost:8080/v1/` → `http://localhost:8080/v1/images/generations`
 *
 * 规则：已以 `/v1` 结尾则直接拼接相对路径，否则补 `/v1` 前缀。
 */
export function buildImagesUrl(baseUrl: string, apiPath: string): string {
  const base = normalizeBaseUrl(baseUrl)
  const suffix = base.endsWith('/v1') ? `/${apiPath}` : `/v1/${apiPath}`
  return `${base}${suffix}`
}

// ===== 生图模型识别 =====

// isLikelyImageModel 由 @proma/shared 提供（与设置 UI 共用同一份规则），此处再导出供工具层直接使用。
export { isLikelyImageModel }

// ===== Images API 调用 =====

/** 生图请求参数 */
export interface GptImageRequest {
  prompt: string
  /** 图片尺寸：auto / 1024x1024 / 1536x1024 / 1024x1536 */
  size?: string
  /** 质量：auto / low / medium / high */
  quality?: string
  /** 生成数量（1-4） */
  numberOfImages?: number
  /** 参考图（提供时走 /images/edits multipart 端点） */
  referenceImages?: { mimeType: string; base64: string }[]
}

/** 生成的单张图片 */
export interface GptImageArtifact {
  mimeType: string
  base64: string
}

/** OpenAI Images API 响应结构（b64_json 与 url 两种形态） */
interface ImagesApiResponse {
  data?: { b64_json?: string; url?: string }[]
  error?: { message?: string } | string
}

/** 参数校验与归一化 */
function normalizeRequest(request: GptImageRequest): { prompt: string; n: number } {
  const prompt = request.prompt?.trim()
  if (!prompt) {
    throw new GptImageConfigError('参数缺失: prompt')
  }
  const n = typeof request.numberOfImages === 'number'
    ? Math.min(Math.max(Math.round(request.numberOfImages), 1), 4)
    : 1
  return { prompt, n }
}

/** 提取并归一化错误信息 */
function extractErrorMessage(body: unknown, status: number): string {
  if (body && typeof body === 'object') {
    const parsed = body as ImagesApiResponse
    if (parsed.error) {
      const message = typeof parsed.error === 'string' ? parsed.error : parsed.error.message
      if (message) return message
    }
  }
  return `HTTP ${status}`
}

/** 从响应解析图片（b64_json 优先，兼容 url 下载） */
async function parseImageArtifacts(data: ImagesApiResponse): Promise<GptImageArtifact[]> {
  const items = data.data ?? []
  const artifacts: GptImageArtifact[] = []

  for (const item of items) {
    if (item.b64_json) {
      artifacts.push({ mimeType: 'image/png', base64: item.b64_json })
    } else if (item.url) {
      try {
        const downloaded = await fetch(item.url, { signal: AbortSignal.timeout(GPT_IMAGE_TIMEOUT_MS) })
        if (!downloaded.ok) {
          console.warn(`[GPT Image] 图片 URL 下载失败 (${downloaded.status}): ${item.url}`)
          continue
        }
        const buffer = Buffer.from(await downloaded.arrayBuffer())
        artifacts.push({
          mimeType: downloaded.headers.get('content-type')?.split(';')[0] || 'image/png',
          base64: buffer.toString('base64'),
        })
      } catch (error) {
        console.warn('[GPT Image] 图片 URL 下载失败:', error)
      }
    }
  }

  return artifacts
}

/**
 * 调用 OpenAI Images API 生成图片。
 *
 * 无参考图走 generations（JSON），有参考图走 edits（multipart，参考图作为输入图）。
 * 返回 base64 图片列表；由上层负责保存附件与组装展示。
 */
export async function generateImages(
  target: GptImageTarget,
  request: GptImageRequest,
): Promise<GptImageArtifact[]> {
  const { prompt, n } = normalizeRequest(request)

  const references = request.referenceImages?.filter((img) => img.base64) ?? []
  const headers: Record<string, string> = { Authorization: `Bearer ${target.apiKey}` }
  let url: string
  let body: BodyInit

  if (references.length > 0) {
    // 编辑模式：multipart/form-data，参考图 + 编辑指令
    url = buildImagesUrl(target.baseUrl, EDITS_PATH)
    const form = new FormData()
    form.append('model', target.modelId)
    form.append('prompt', prompt)
    form.append('n', String(n))
    if (request.size && request.size !== 'auto') form.append('size', request.size)
    if (request.quality && request.quality !== 'auto') form.append('quality', request.quality)
    references.forEach((img, index) => {
      const bytes = Buffer.from(img.base64, 'base64')
      const ext = img.mimeType === 'image/jpeg' ? 'jpg' : 'png'
      form.append('image[]', new Blob([new Uint8Array(bytes)], { type: img.mimeType }), `reference-${index}.${ext}`)
    })
    body = form
  } else {
    // 文生图：JSON
    url = buildImagesUrl(target.baseUrl, GENERATIONS_PATH)
    headers['Content-Type'] = 'application/json'
    const payload: Record<string, unknown> = { model: target.modelId, prompt, n }
    if (request.size && request.size !== 'auto') payload.size = request.size
    if (request.quality && request.quality !== 'auto') payload.quality = request.quality
    body = JSON.stringify(payload)
  }

  console.log(
    `[GPT Image] 调用 Images API: model=${target.modelId}, mode=${references.length > 0 ? 'edit' : 'generate'}, ` +
    `prompt="${prompt.slice(0, 50)}...", n=${n}`,
  )

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(GPT_IMAGE_TIMEOUT_MS),
  })

  if (!response.ok) {
    const errorText = await response.text()
    let message = errorText
    try {
      message = extractErrorMessage(JSON.parse(errorText), response.status)
    } catch {
      // 保留原始文本
    }
    console.error(`[GPT Image] API 请求失败 (${response.status}):`, errorText.slice(0, 300))
    throw new Error(`生图 API 请求失败 (${response.status}): ${message.slice(0, 200)}`)
  }

  const data = (await response.json()) as ImagesApiResponse

  if (data.error) {
    const message = typeof data.error === 'string' ? data.error : data.error.message
    throw new Error(`生图 API 错误: ${message ?? '未知错误'}`)
  }

  const artifacts = await parseImageArtifacts(data)
  if (artifacts.length === 0) {
    throw new Error('生图 API 未返回任何图片')
  }
  return artifacts
}

/**
 * 测试渠道连通性（设置页「测试连接」用）。
 *
 * 使用 GET {baseUrl}/models 标准端点；网关不支持列表时给出可继续试用的提示
 * 而非硬失败（部分中转只实现生成端点）。
 */
export async function testGptImageConnection(): Promise<{ success: boolean; message: string }> {
  let target: GptImageTarget
  try {
    target = resolveGptImageTarget()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { success: false, message }
  }

  try {
    const response = await fetch(buildImagesUrl(target.baseUrl, 'models'), {
      method: 'GET',
      headers: { Authorization: `Bearer ${target.apiKey}` },
      signal: AbortSignal.timeout(15_000),
    })

    if (response.ok) {
      return { success: true, message: `连接成功，模型 ${target.modelId} 所在渠道「${target.channelName}」可用` }
    }
    if (response.status === 404 || response.status === 405) {
      return {
        success: true,
        message: `渠道「${target.channelName}」可达，但不支持模型列表端点；生图端点是否可用请在对话中实际试用`,
      }
    }
    const errorText = await response.text()
    return { success: false, message: `API 请求失败 (${response.status}): ${errorText.slice(0, 200)}` }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { success: false, message: `连接失败: ${message}` }
  }
}
