/**
 * GPT Image 生图工具模块（Chat 模式）
 *
 * 基于 OpenAI Images API（凭据复用「模型配置」渠道，见 gpt-image-core.ts）。
 * 支持文生图、参考图编辑。生成的图片保存为附件并以图片卡片渲染。
 */

import type { ToolCall, ToolResult, ToolDefinition } from '@proma/core'
import type { ChatToolMeta, FileAttachment } from '@proma/shared'
import { randomUUID } from 'node:crypto'
import { saveAttachment, readAttachmentAsBase64, isImageAttachment } from '../attachment-service'
import {
  GptImageConfigError,
  generateImages,
  resolveGptImageTarget,
} from './gpt-image-core'

// ===== 工具元数据 =====

export const GPT_IMAGE_TOOL_META: ChatToolMeta = {
  id: 'gpt-image',
  name: 'GPT Image',
  description: 'AI 图片生成与编辑（基于 OpenAI Images 协议，凭据复用模型配置渠道）',
  params: [
    { name: 'prompt', type: 'string', description: '图片生成/编辑描述', required: true },
  ],
  icon: 'ImagePlus',
  category: 'builtin',
  executorType: 'builtin',
  systemPromptAppend: `
<gpt_image_instructions>
你拥有 AI 图片生成和编辑能力（GPT Image）。

**generate_image — 生成/编辑图片：**
当用户需要创建或修改图片时调用：
- 用户要求画画、生成图片、创作插图
- 用户上传了图片并要求修改、编辑、调整

**参数说明：**
- prompt: 详细描述想要生成的图片内容或要做的修改
- size: 可选尺寸 "auto"(默认) / "1024x1024" / "1536x1024" / "1024x1536"
- quality: 可选质量 "auto"(默认) / "low" / "medium" / "high"
- numberOfImages: 可选生成数量 1-4（默认 1）
- useReferenceImages: 当用户上传了参考图或要求修改图片时设为 "true"

**使用技巧：**
- 生成新图片时给出详细描述
- 编辑图片时设置 useReferenceImages: true，并在 prompt 中描述要做的修改
- 多次编辑同一张图时，把要继续修改的图留在对话附件中
</gpt_image_instructions>`,
}

// ===== 工具定义（传给 Provider） =====

export const GPT_IMAGE_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'gpt_image',
    description:
      'Generate or edit images using OpenAI Images API (GPT Image). Supports text-to-image generation and reference image editing.',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Detailed description of the image to generate or the edits to make.',
        },
        size: {
          type: 'string',
          description: 'Image size',
          enum: ['auto', '1024x1024', '1536x1024', '1024x1536'],
        },
        quality: {
          type: 'string',
          description: 'Image quality',
          enum: ['auto', 'low', 'medium', 'high'],
        },
        useReferenceImages: {
          type: 'string',
          description: 'Set to "true" to edit uploaded reference images',
          enum: ['true', 'false'],
        },
        numberOfImages: {
          type: 'number',
          description: 'Number of images to generate (1-4, default 1)',
        },
      },
      required: ['prompt'],
    },
  },
]

// ===== 可用性检查 =====

/**
 * 检查 GPT Image 工具是否可用（已选择渠道生图模型且凭据可解密）。
 * 配置错误不在开关列表期阻塞，仅在执行时给出明确指引。
 */
export function isGptImageAvailable(): boolean {
  try {
    resolveGptImageTarget()
    return true
  } catch {
    return false
  }
}

// ===== 工具执行 =====

/** 工具名称集合 */
const GPT_IMAGE_TOOL_NAMES = new Set(['gpt_image'])

/** 判断是否为 GPT Image 工具调用 */
export function isGptImageToolCall(toolName: string): boolean {
  return GPT_IMAGE_TOOL_NAMES.has(toolName)
}

/** Chat 模式工具执行上下文（与 NanoBananaContext 对齐） */
export interface GptImageContext {
  /** 对话 ID（用于保存附件） */
  conversationId: string
  /** 当前用户消息的附件列表 */
  currentAttachments?: FileAttachment[]
  /** 前一轮用户消息的附件 */
  previousUserAttachments?: FileAttachment[]
  /** 前一轮助手消息的附件（含生成的图片） */
  previousAssistantAttachments?: FileAttachment[]
}

/**
 * 收集参考图，按时间从早到晚排列：
 * 前一轮用户附件 → 前一轮助手附件（生成的图）→ 当前用户附件。
 * 支持连续编辑上一轮生成结果（把要改的图留在附件里即可）。
 */
function collectReferenceImages(context: GptImageContext): { mimeType: string; base64: string }[] {
  const references: { mimeType: string; base64: string }[] = []
  const all: FileAttachment[] = [
    ...(context.previousUserAttachments ?? []),
    ...(context.previousAssistantAttachments ?? []),
    ...(context.currentAttachments ?? []),
  ]
  for (const attachment of all) {
    if (!isImageAttachment(attachment.mediaType)) continue
    try {
      references.push({
        mimeType: attachment.mediaType,
        base64: readAttachmentAsBase64(attachment.localPath),
      })
    } catch (error) {
      console.warn(`[GPT Image] 读取参考图失败: ${attachment.localPath}`, error)
    }
  }
  return references
}

/**
 * 执行 GPT Image 工具调用。
 */
export async function executeGptImageTool(
  toolCall: ToolCall,
  context: GptImageContext,
): Promise<ToolResult> {
  try {
    const target = resolveGptImageTarget()

    const prompt = toolCall.arguments.prompt as string
    if (!prompt) {
      return { toolCallId: toolCall.id, content: '参数缺失: prompt', isError: true }
    }

    const size = toolCall.arguments.size as string | undefined
    const quality = toolCall.arguments.quality as string | undefined
    const useReferenceImages = toolCall.arguments.useReferenceImages === 'true'
    const numberOfImages = typeof toolCall.arguments.numberOfImages === 'number'
      ? toolCall.arguments.numberOfImages
      : undefined

    const referenceImages = useReferenceImages ? collectReferenceImages(context) : []
    if (useReferenceImages && referenceImages.length === 0) {
      return {
        toolCallId: toolCall.id,
        content: 'useReferenceImages 为 true，但当前消息没有可用的图片附件。请让用户先上传图片，或改为纯文生图。',
        isError: true,
      }
    }

    const artifacts = await generateImages(target, {
      prompt,
      size,
      quality,
      numberOfImages,
      referenceImages,
    })

    // 保存为附件并渲染图片卡片
    const generatedAttachments: FileAttachment[] = artifacts.map((artifact) => {
      const ext = artifact.mimeType === 'image/jpeg' ? '.jpg' : '.png'
      const result = saveAttachment({
        conversationId: context.conversationId,
        filename: `gpt-image-${randomUUID().slice(0, 8)}${ext}`,
        mediaType: artifact.mimeType,
        data: artifact.base64,
      })
      return result.attachment
    })

    return {
      toolCallId: toolCall.id,
      content: `图片已成功生成（${generatedAttachments.length} 张），可在对话中查看。`,
      generatedAttachments: generatedAttachments.length > 0 ? generatedAttachments : undefined,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const isConfigError = error instanceof GptImageConfigError
    console.error('[GPT Image] 执行失败:', error)
    return {
      toolCallId: toolCall.id,
      content: isConfigError ? message : `图片生成失败: ${message}`,
      isError: true,
    }
  }
}
