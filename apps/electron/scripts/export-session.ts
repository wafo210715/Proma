#!/usr/bin/env bun
/**
 * export-session.ts — 把 Agent 会话 JSONL 导出为 judge 可读的结构化 Markdown
 *
 * 用法：
 *   bun run export-session.ts <session-id> [--full]
 *   bun run export-session.ts 2484fa25  # 只导摘要（thinking 截断 + tool 只记名字）
 *   bun run export-session.ts 2484fa25 --full  # 导完整内容
 *
 * 输出到 stdout，可以 pipe 到文件或直接喂给 judge。
 */

import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

// ===== 参数 =====
const sessionId = process.argv[2]
const fullMode = process.argv.includes('--full')

if (!sessionId) {
  console.error('用法: bun run export-session.ts <session-id> [--full]')
  console.error('session-id 可以是完整 UUID 或前缀')
  process.exit(1)
}

// ===== 查找文件 =====
const searchPaths = [
  join(homedir(), '.proma-dev', 'agent-sessions'),
  join(homedir(), '.proma-dev-fork', 'agent-sessions'),
  join(homedir(), '.proma', 'agent-sessions'),
]

let filePath: string | null = null
for (const dir of searchPaths) {
  // 精确匹配
  const exact = join(dir, `${sessionId}.jsonl`)
  if (existsSync(exact)) { filePath = exact; break }
  // 前缀匹配
  if (existsSync(dir)) {
    const { readdirSync } = await import('fs')
    const files = readdirSync(dir).filter(f => f.startsWith(sessionId) && f.endsWith('.jsonl'))
    if (files.length > 0) { filePath = join(dir, files[0]!); break }
  }
}

if (!filePath) {
  console.error(`未找到 session: ${sessionId}`)
  process.exit(1)
}

// ===== 解析 JSONL =====
interface ParsedTurn {
  type: string
  role: string
  ts: number
  thinking?: string
  text?: string
  toolUses: Array<{ name: string; input: Record<string, unknown> }>
  toolResults: Array<{ toolUseId: string; content: string }>
}

const turns: ParsedTurn[] = []

for (const line of readFileSync(filePath, 'utf-8').split('\n')) {
  const trimmed = line.trim()
  if (!trimmed) continue
  let obj: Record<string, unknown>
  try { obj = JSON.parse(trimmed) } catch { continue }

  const type = obj.type as string
  const msg = obj.message as Record<string, unknown> | undefined
  if (!msg) continue
  const role = (msg.role as string) || type
  const content = msg.content
  const ts = (obj._createdAt as number) || (obj.createdAt as number) || 0

  const turn: ParsedTurn = { type, role, ts, toolUses: [], toolResults: [] }

  if (typeof content === 'string') {
    turn.text = content
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block !== 'object' || !block) continue
      const b = block as Record<string, unknown>
      const blockType = b.type as string

      if (blockType === 'thinking') {
        turn.thinking = b.thinking as string
      } else if (blockType === 'text') {
        turn.text = b.text as string
      } else if (blockType === 'tool_use') {
        turn.toolUses.push({
          name: b.name as string,
          input: (b.input as Record<string, unknown>) || {},
        })
      } else if (blockType === 'tool_result') {
        const resultContent = b.content
        let resultText = ''
        if (typeof resultContent === 'string') {
          resultText = resultContent
        } else if (Array.isArray(resultContent)) {
          resultText = resultContent
            .filter((r: unknown) => typeof r === 'object' && r && (r as Record<string, unknown>).type === 'text')
            .map((r: unknown) => ((r as Record<string, unknown>).text as string) || '')
            .join('\n')
        }
        turn.toolResults.push({
          toolUseId: b.tool_use_id as string,
          content: resultText,
        })
      }
    }
  }

  if (turn.text || turn.thinking || turn.toolUses.length > 0 || turn.toolResults.length > 0) {
    turns.push(turn)
  }
}

// ===== 输出结构化 Markdown =====
const truncate = (text: string, limit: number): string => {
  if (fullMode) return text
  if (text.length <= limit) return text
  return text.slice(0, limit) + '…[截断]'
}

console.log(`# Agent 会话导出`)
console.log(`Session: ${sessionId}`)
console.log(`模式: ${fullMode ? '完整' : '摘要（截断）'}`)
console.log(`总轮次: ${turns.length}`)
console.log(`---`)

let turnNum = 0
for (const turn of turns) {
  turnNum++
  const timeStr = turn.ts > 0
    ? new Date(turn.ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    : '??'

  // user 消息（含 tool_result）
  if (turn.role === 'user') {
    if (turn.text) {
      // 分离注入块和用户原话
      const raw = turn.text
      const injections: string[] = []
      let userText = raw

      // 提取 <跨会话历史召回> 块
      const recallMatch = raw.match(/<跨会话历史召回[\s\S]*?<\/跨会话历史召回>/)
      if (recallMatch) {
        injections.push(`### 注入：跨会话历史召回\n${recallMatch[0]}`)
        userText = userText.replace(recallMatch[0], '').trim()
      }

      // 提取 <mentioned_tools> 块
      const toolsMatch = raw.match(/<mentioned_tools>[\s\S]*?<\/mentioned_tools>/)
      if (toolsMatch) {
        injections.push(`### 注入：mentioned_tools\n${toolsMatch[0]}`)
        userText = userText.replace(toolsMatch[0], '').trim()
      }

      // 提取 referenced_sessions 块（如果有）
      const refMatch = raw.match(/<referenced_sessions>[\s\S]*?<\/referenced_sessions>/)
      if (refMatch) {
        injections.push(`### 注入：referenced_sessions\n${refMatch[0]}`)
        userText = userText.replace(refMatch[0], '').trim()
      }

      // 去掉 dynamicCtx 的残留（通常是开头的几行路径信息）
      // dynamicCtx 没有明确标签，但通常在开头且包含路径信息

      console.log(`\n## [Turn ${turnNum}] 用户 · ${timeStr}`)

      // 先输出注入块（如果有）
      if (injections.length > 0) {
        console.log(`\n> **⚠️ 以下内容不是用户输入，是系统自动注入的上下文。**评估时请注意区分。**`)
        for (const inj of injections) {
          console.log(inj)
        }
        console.log(`\n---\n`)
      }

      // 输出用户原话
      if (userText) {
        if (injections.length > 0) {
          console.log(`### 用户实际输入`)
        }
        console.log(truncate(userText, 2000))
      }
    }
    if (turn.toolResults.length > 0) {
      for (const tr of turn.toolResults) {
        console.log(`\n### 工具返回 (tool_use_id: ${tr.toolUseId?.slice(0, 8)}…)`)
        console.log(truncate(tr.content, fullMode ? 5000 : 500))
      }
    }
  }

  // assistant 消息
  if (turn.role === 'assistant') {
    console.log(`\n## [Turn ${turnNum}] Agent · ${timeStr}`)

    if (turn.thinking) {
      console.log(`### 思考过程`)
      console.log(truncate(turn.thinking, fullMode ? 10000 : 1500))
    }

    if (turn.toolUses.length > 0) {
      console.log(`### 工具调用 (${turn.toolUses.length} 次)`)
      for (const tu of turn.toolUses) {
        const inputStr = fullMode
          ? JSON.stringify(tu.input, null, 2)
          : JSON.stringify(tu.input).slice(0, 200)
        console.log(`- **${tu.name}**: ${inputStr}`)
      }
    }

    if (turn.text) {
      console.log(`### 回复`)
      console.log(truncate(turn.text, fullMode ? 20000 : 3000))
    }
  }
}

console.log(`\n---\n导出结束。共 ${turns.length} 轮。`)
