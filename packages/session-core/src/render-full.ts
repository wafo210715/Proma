/**
 * 完整会话导出渲染 —— 包含思考过程、工具调用详情和工具返回结果。
 *
 * 与 render-markdown.ts 的区别：
 * - render-markdown.ts 丢弃 thinking 块，工具只保留摘要行 → 面向「快速阅读」
 * - 本文件保留 thinking 全文、工具完整输入/输出 → 面向「评测」和「审计」
 *
 * 输出为干净 Markdown，既适合人工审读，也可直接喂给 LLM-as-judge 做评测。
 */
import type {
  SDKMessage,
  SDKAssistantMessage,
  SDKUserMessage,
  SDKContentBlock,
  SDKToolUseBlock,
  SDKToolResultBlock,
} from '@proma/shared'
import type { MessageGroup, AssistantTurn } from './group'
import { extractUserText, stripScheduledRunMarker } from './group'
import { normalizeThinkTagsInContentBlocks } from './thinking-tags'

export interface RenderFullMarkdownOptions {
  /** 文档标题用的会话 ID。 */
  sessionId?: string
  /** 会话标题（人类可读）。 */
  sessionTitle?: string
  /** 工具输出最大字符数，超出截断（默认 3000）。 */
  maxToolResultLength?: number
}

/** 默认工具输出截断长度 */
const DEFAULT_MAX_TOOL_RESULT = 3000

/**
 * 按 message.id 取每个逻辑消息的最后一条快照（去重流式碎片）。
 * 与 transcript.ts 的 dedupSnapshotsByMessageId 逻辑一致。
 */
function dedupSnapshotsById(messages: SDKAssistantMessage[]): SDKAssistantMessage[] {
  const lastById = new Map<string, SDKAssistantMessage>()
  const order: string[] = []
  let anon = 0
  for (const m of messages) {
    const id = (m.message as unknown as { id?: string } | undefined)?.id ?? `__anon_${anon++}`
    if (!lastById.has(id)) order.push(id)
    lastById.set(id, m)
  }
  return order.map((id) => lastById.get(id)!)
}

/** 截断超长文本 */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max) + `\n…[已截断，完整长度 ${text.length} 字符]`
}

/** 渲染工具输出内容为可读文本 */
function renderToolResultContent(content: unknown, maxLen: number): string {
  if (content === null || content === undefined) return '(空)'
  if (typeof content === 'string') return truncate(content, maxLen)

  // SDK 格式：tool_result.content 是 ContentBlock 数组
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const block of content) {
      if (block && typeof block === 'object') {
        const b = block as Record<string, unknown>
        if (b.type === 'text' && typeof b.text === 'string') {
          parts.push(b.text)
        } else if (b.type === 'image') {
          parts.push('[图片]')
        } else {
          parts.push(JSON.stringify(b))
        }
      }
    }
    return parts.length > 0
      ? truncate(parts.join('\n'), maxLen)
      : JSON.stringify(content, null, 2).slice(0, maxLen)
  }

  // 其他对象 → JSON
  try {
    return truncate(JSON.stringify(content, null, 2), maxLen)
  } catch {
    return String(content).slice(0, maxLen)
  }
}

/** 从 turnMessages 中构建 tool_use_id → tool_result 的查找表 */
function buildToolResultMap(turnMessages: SDKMessage[]): Map<string, SDKToolResultBlock> {
  const map = new Map<string, SDKToolResultBlock>()
  for (const msg of turnMessages) {
    if (msg.type !== 'user') continue
    const userMsg = msg as SDKUserMessage
    const content = userMsg.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block && typeof block === 'object' && (block as Record<string, unknown>).type === 'tool_result') {
        const tr = block as SDKToolResultBlock
        if (tr.tool_use_id) {
          map.set(tr.tool_use_id, tr)
        }
      }
    }
  }
  return map
}

/** 从 user 消息中提取清洗后的纯文本（去掉 XML 标记） */
function extractCleanUserText(message: SDKUserMessage): string {
  const raw = extractUserText(message) ?? ''
  return stripScheduledRunMarker(raw)
    .replace(/<attached_files>[\s\S]*?<\/attached_files>\n*/g, '')
    .replace(/<quoted_file[^>]*>[\s\S]*?<\/quoted_file>\n*/g, '')
    .replace(/<quoted_context[^>]*>[\s\S]*?<\/quoted_context>\n*/g, '')
    .trim()
}

/** 渲染单个 assistant turn（含思考、工具调用、回答） */
function renderAssistantTurn(
  turn: AssistantTurn,
  lines: string[],
  maxToolResult: number,
): void {
  const deduped = dedupSnapshotsById(turn.assistantMessages)
  if (deduped.length === 0) return

  const modelLabel = turn.model ? ` (${turn.model})` : ''
  lines.push(`### 🤖 助手${modelLabel}`, '')

  const toolResults = buildToolResultMap(turn.turnMessages)

  for (const msg of deduped) {
    const rawBlocks = msg.message?.content
    if (!Array.isArray(rawBlocks)) continue

    const blocks = normalizeThinkTagsInContentBlocks(rawBlocks as SDKContentBlock[])

    for (const block of blocks) {
      if (block.type === 'thinking') {
        const thinking = (block as { thinking?: string }).thinking?.trim()
        if (thinking) {
          lines.push('#### 💭 思考', '')
          lines.push(thinking, '')
        }
      } else if (block.type === 'tool_use') {
        const tu = block as SDKToolUseBlock
        lines.push(`#### 🔧 工具: \`${tu.name ?? 'unknown'}\``, '')

        // 输入参数
        lines.push('**输入:**', '')
        lines.push('```json')
        try {
          lines.push(JSON.stringify(tu.input ?? {}, null, 2))
        } catch {
          lines.push(String(tu.input))
        }
        lines.push('```', '')

        // 输出结果
        const result = toolResults.get(tu.id)
        if (result) {
          const isError = result.is_error
          lines.push(`**输出${isError ? ' (错误)' : ''}:**`, '')
          lines.push('```text')
          lines.push(renderToolResultContent(result.content, maxToolResult))
          lines.push('```', '')
        } else {
          lines.push('*（未找到对应工具输出）*', '')
        }
      } else if (block.type === 'text') {
        const text = (block as { text?: string }).text?.trim()
        if (text) {
          lines.push('#### 📝 回答', '')
          lines.push(text, '')
        }
      }
      // 其他块类型（如 redacted_thinking）暂不处理
    }
  }

  // 错误信息（只检查最后一条去重后的消息）
  const lastMsg = deduped[deduped.length - 1]
  const turnError = (lastMsg as unknown as { error?: { message?: string } }).error
  if (turnError?.message) {
    lines.push('#### ⚠️ 错误', '')
    lines.push(turnError.message, '')
  }

  lines.push('---', '')
}

/**
 * 把 MessageGroup[] 渲染为**完整**的 Markdown 对话记录。
 *
 * 包含：用户消息全文、助手思考过程、工具调用（完整输入参数 + 输出结果）、助手回答。
 * 适用于评测（LLM-as-judge）和审计场景。
 */
export function renderFullTranscriptMarkdown(
  groups: MessageGroup[],
  opts: RenderFullMarkdownOptions = {},
): string {
  const { sessionId, sessionTitle, maxToolResultLength = DEFAULT_MAX_TOOL_RESULT } = opts
  const lines: string[] = []

  // 文件头
  if (sessionId || sessionTitle) {
    lines.push(`# 会话导出${sessionTitle ? `: ${sessionTitle}` : ''}`, '')
    if (sessionId) lines.push(`> **会话 ID**: \`${sessionId}\``)
    lines.push(`> **导出时间**: ${new Date().toISOString()}`)
    lines.push('', '---', '')
  }

  for (const group of groups) {
    if (group.type === 'user') {
      const text = extractCleanUserText(group.message)
      if (text) {
        lines.push('### 👤 用户', '')
        lines.push(text, '')
        lines.push('---', '')
      }
    } else if (group.type === 'system') {
      // 系统消息（压缩状态、权限等）不纳入导出
      continue
    } else {
      // assistant-turn
      renderAssistantTurn(group, lines, maxToolResultLength)
    }
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}
