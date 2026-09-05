/**
 * GPT Image Pi 工具注入（Agent 模式）
 *
 * 基于 OpenAI Images API 的生图能力（凭据复用「模型配置」渠道，见 gpt-image-core.ts）。
 * 通过 Pi custom tool 注入启用 GPT Image 的 Agent 会话。
 * 支持文生图、参考图编辑（referenceImagePaths 显式传图，无会话历史）。
 */

import { randomUUID } from 'node:crypto'
import { readFileSync, existsSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs'
import { extname, resolve, isAbsolute, join, relative } from 'node:path'
import { saveAttachment, isImageAttachment } from '../attachment-service'
import { getToolState } from '../chat-tool-config'
import {
  GptImageConfigError,
  generateImages,
  resolveGptImageTarget,
} from './gpt-image-core'
import { Type } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'

// ===== 参考图读取（授权目录校验，与 nano-banana-mcp 一致） =====

/** 已知图片扩展名 → MIME 类型映射 */
const EXT_TO_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
}

/**
 * 从文件路径列表读取参考图。
 *
 * 支持绝对路径和相对路径（相对于 agentCwd 解析）。
 * 跳过不存在、非图片、授权目录外的文件——参考图只从用户已授权的目录读取。
 */
function readReferenceImages(
  paths: string[],
  cwd?: string,
  allowedRoots: string[] = [],
): { mimeType: string; base64: string }[] {
  const roots = [cwd, ...allowedRoots]
    .filter((root): root is string => typeof root === 'string' && root.length > 0)
    .map((root) => {
      const resolved = resolve(root)
      try { return realpathSync(resolved) } catch { return resolved }
    })
  const references: { mimeType: string; base64: string }[] = []
  for (const rawPath of paths) {
    try {
      const requestedPath = isAbsolute(rawPath) ? rawPath : resolve(cwd ?? process.cwd(), rawPath)
      if (!existsSync(requestedPath)) {
        console.warn(`[GPT Image MCP] 参考图不存在: ${requestedPath}`)
        continue
      }
      // Resolve symlinks before checking containment; an attached symlink must not escape
      // the directories explicitly authorized for this Agent run.
      const filePath = realpathSync(requestedPath)
      const authorized = roots.some((root) => {
        const rel = relative(root, filePath)
        return rel === '' || (!rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && rel !== '..' && !isAbsolute(rel))
      })
      if (!authorized) {
        console.warn(`[GPT Image MCP] 拒绝读取授权目录外的参考图: ${filePath}`)
        continue
      }
      const ext = extname(filePath).toLowerCase()
      const mimeType = EXT_TO_MIME[ext]
      if (!mimeType || !isImageAttachment(mimeType)) {
        console.warn(`[GPT Image MCP] 非图片文件，跳过: ${filePath}`)
        continue
      }
      references.push({ mimeType, base64: readFileSync(filePath).toString('base64') })
    } catch (error) {
      console.warn(`[GPT Image MCP] 读取参考图失败: ${rawPath}`, error)
    }
  }
  return references
}

// ===== Pi 工具注入 =====

type PiSdk = typeof import('@earendil-works/pi-coding-agent')

export interface PiGptImageToolsContext {
  sessionId: string
  agentCwd?: string
  allowedRoots?: string[]
}

/**
 * 执行生图并构建文本结果。
 *
 * 图片三通道交付：
 * 1. saveAttachment → 前端附件卡片渲染；
 * 2. 写入 {agentCwd}/generated-images/ → Agent 后续引用与再编辑；
 * 3. 文本摘要列出落盘路径。
 * 与 nano-banana-mcp 相同，Pi tool result 保持纯文本，避免 base64 写入 transcript。
 */
async function executeAndBuildText(
  sessionId: string,
  args: {
    prompt: string
    size?: string
    quality?: string
    numberOfImages?: number
    referenceImagePaths?: string[]
    cwd?: string
    allowedRoots?: string[]
  },
): Promise<string> {
  const target = resolveGptImageTarget()

  const references = args.referenceImagePaths?.length
    ? readReferenceImages(args.referenceImagePaths, args.cwd, args.allowedRoots)
    : []
  if (references.length > 0) {
    console.log(`[GPT Image MCP] 加载了 ${references.length} 张参考图`)
  }
  if (args.referenceImagePaths?.length && references.length === 0) {
    throw new Error('参考图读取失败：路径不存在、不在授权目录内或不是图片文件')
  }

  const artifacts = await generateImages(target, {
    prompt: args.prompt,
    size: args.size,
    quality: args.quality,
    numberOfImages: args.numberOfImages,
    referenceImages: references,
  })

  const savedWorkspacePaths: string[] = []
  for (const artifact of artifacts) {
    const ext = artifact.mimeType === 'image/jpeg' ? '.jpg' : '.png'
    const filename = `gpt-image-${randomUUID().slice(0, 8)}${ext}`

    // 1. 附件（UI 图片卡片）
    saveAttachment({
      conversationId: sessionId,
      filename,
      mediaType: artifact.mimeType,
      data: artifact.base64,
    })

    // 2. Agent 工作目录（供后续引用与再编辑）
    if (args.cwd) {
      try {
        const imgDir = join(args.cwd, 'generated-images')
        mkdirSync(imgDir, { recursive: true })
        const workspacePath = join(imgDir, filename)
        writeFileSync(workspacePath, Buffer.from(artifact.base64, 'base64'))
        savedWorkspacePaths.push(workspacePath)
      } catch (err) {
        console.warn('[GPT Image MCP] 保存图片到工作目录失败:', err)
      }
    }
  }

  // 3. 文本摘要
  const pathInfo = savedWorkspacePaths.length > 0
    ? `\n图片已保存到工作目录:\n${savedWorkspacePaths.map((p) => `- ${p}`).join('\n')}`
    : ''
  return `图片已生成（${artifacts.length} 张）${pathInfo}`
}

/**
 * 构建 Pi custom tool。开关与渠道配置任一缺失时返回空数组（不注入）。
 */
export function buildPiGptImageTools(
  sdk: PiSdk,
  ctx: PiGptImageToolsContext,
): ToolDefinition[] {
  const toolState = getToolState('gpt-image')
  if (!toolState.enabled) return []
  try {
    resolveGptImageTarget()
  } catch {
    // 已开启但渠道未就绪：不注入，避免 Agent 侧出现必然失败的工具
    return []
  }

  return [sdk.defineTool({
    name: 'mcp__gpt_image__generate_image',
    label: '生成或编辑图片（GPT Image）',
    description:
      'Generate or edit images using OpenAI Images API (GPT Image). Supports text-to-image and reference image editing. When the user uploads images (listed in <attached_files>) or mentions image files via @file:{path}, pass their paths through referenceImagePaths to edit them.',
    promptSnippet:
      'GPT Image: generate or edit images via OpenAI Images API. Pass user-authorized reference image paths when editing an existing image.',
    parameters: Type.Object({
      prompt: Type.String({ description: 'Detailed description of the image to generate or the edits to make.' }),
      referenceImagePaths: Type.Optional(Type.Array(Type.String({ description: 'Absolute or cwd-relative reference image path.' }))),
      size: Type.Optional(Type.Union([Type.Literal('auto'), Type.Literal('1024x1024'), Type.Literal('1536x1024'), Type.Literal('1024x1536')])),
      quality: Type.Optional(Type.Union([Type.Literal('auto'), Type.Literal('low'), Type.Literal('medium'), Type.Literal('high')])),
      numberOfImages: Type.Optional(Type.Integer({ minimum: 1, maximum: 4 })),
    }),
    async execute(_toolCallId, args) {
      try {
        const text = await executeAndBuildText(ctx.sessionId, {
          prompt: String(args.prompt),
          size: typeof args.size === 'string' ? args.size : undefined,
          quality: typeof args.quality === 'string' ? args.quality : undefined,
          numberOfImages: typeof args.numberOfImages === 'number' ? args.numberOfImages : undefined,
          referenceImagePaths: Array.isArray(args.referenceImagePaths)
            ? args.referenceImagePaths.filter((path): path is string => typeof path === 'string')
            : undefined,
          cwd: ctx.agentCwd,
          allowedRoots: ctx.allowedRoots,
        })
        return {
          content: [{ type: 'text', text }],
          details: { generated: true },
        } as AgentToolResult<unknown>
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const isConfigError = error instanceof GptImageConfigError
        console.error('[GPT Image Pi 工具] 执行失败:', error)
        return {
          content: [{ type: 'text', text: isConfigError ? message : `图片生成失败: ${message}` }],
          details: { generated: false },
        } as AgentToolResult<unknown>
      }
    },
  })]
}
