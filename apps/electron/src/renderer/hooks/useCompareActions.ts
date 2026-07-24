/**
 * useCompareActions — 双开对比的会话创建动作
 *
 * 统一封装「新建空白对比」「新建并继承上下文」两类操作，供 AgentHeader（发起）
 * 与 MainArea（待办 watcher 在源会话跑完后补执行）复用，避免逻辑重复。
 *
 * 继承上下文的两条路径：
 * - 目标模型与源会话同渠道 → 用原生 forkAgentSession（SDK 级上下文继承，干净、不花重新注入 token）
 * - 目标模型跨渠道 → 文本注入：读源会话历史，拼成 <context> 块通过 agentPendingPromptAtom 自动发给新会话
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { toast } from 'sonner'
import { isAgentCompatibleProvider } from '@proma/shared'
import type { AgentRuntime, AgentSessionMeta, Channel, SDKMessage } from '@proma/shared'
import { agentSessionsAtom, agentPendingPromptAtom } from '@/atoms/agent-atoms'
import { channelsAtom } from '@/atoms/chat-atoms'
import { comparePairsAtom, compareLinkedAtom, addPair, pendingInheritAtom } from '@/atoms/compare-atoms'

/**
 * 从源会话的 SDKMessage 历史提取纯文本，构建可注入新 session 的 <context> 块。
 * 仅取 user / assistant 的文本内容，跳过工具调用等中间过程。
 */
export function buildInheritedContextBlock(messages: SDKMessage[]): string {
  const lines: string[] = []
  for (const raw of messages) {
    const msg = raw as unknown as { type?: string; message?: { content?: unknown } }
    if (msg.type !== 'user' && msg.type !== 'assistant') continue
    const content = msg.message?.content
    let text = ''
    if (typeof content === 'string') {
      text = content
    } else if (Array.isArray(content)) {
      text = content
        .map((part) => {
          const p = part as { type?: string; text?: string }
          return p.type === 'text' && typeof p.text === 'string' ? p.text : ''
        })
        .filter(Boolean)
        .join('\n')
    }
    text = text.trim()
    if (!text) continue
    lines.push(`${msg.type === 'user' ? 'User' : 'Assistant'}: ${text}`)
  }
  const history = lines.join('\n\n')
  return (
    '<context source="从另一个会话继承的上下文">\n' +
    '以下是另一个会话的完整对话历史。请阅读并在此背景下继续，无需复述历史内容。\n\n' +
    history +
    '\n</context>\n\n' +
    '我已把另一个会话的上下文同步给你。请简要确认你已理解，我们将在此背景下并行继续。'
  )
}

/** 同渠道 Claude 会话只有存在 SDK session 时才能走原生 fork。 */
export function shouldForkInheritedSession(
  source: AgentSessionMeta,
  targetChannelId: string,
): boolean {
  return source.agentRuntime !== 'pi'
    && !!source.sdkSessionId
    && !!source.channelId
    && targetChannelId === source.channelId
}

/**
 * 目标 runtime 优先沿用 Pi；Claude 源会话选择非 Claude 兼容渠道时自动切到 Pi。
 * 这样跨 provider 继承不会创建出无法运行目标模型的 Claude 会话。
 */
export function resolveCompareTargetRuntime(
  source: AgentSessionMeta,
  targetChannelId: string,
  channels: Channel[],
): AgentRuntime {
  if (source.agentRuntime === 'pi') return 'pi'
  const targetChannel = channels.find((channel) => channel.id === targetChannelId)
  if (targetChannel && !isAgentCompatibleProvider(targetChannel.provider)) return 'pi'
  return 'claude'
}

export function useCompareActions(): {
  createBlankCompare: (source: AgentSessionMeta) => Promise<void>
  requestInherit: (source: AgentSessionMeta, targetChannelId: string, targetModelId: string, sourceRunning: boolean) => Promise<void>
  executeInherit: (source: AgentSessionMeta, targetChannelId: string, targetModelId: string) => Promise<boolean>
} {
  const channels = useAtomValue(channelsAtom)
  const setAgentSessions = useSetAtom(agentSessionsAtom)
  const setComparePairs = useSetAtom(comparePairsAtom)
  const setCompareLinked = useSetAtom(compareLinkedAtom)
  const setPendingPrompt = useSetAtom(agentPendingPromptAtom)
  const setPendingInherit = useSetAtom(pendingInheritAtom)

  /** 把 source 与 newId 配对分屏并开启联动 */
  const pairWith = React.useCallback((sourceId: string, newId: string): void => {
    setComparePairs((prev) => addPair(prev, sourceId, newId))
    setCompareLinked(true)
  }, [setComparePairs, setCompareLinked])

  /** 新建空白对比会话：pin 到源会话 channel/model（独立、不浮在全局 default），配对 */
  const createBlankCompare = React.useCallback(async (source: AgentSessionMeta): Promise<void> => {
    try {
      const meta = await window.electronAPI.createAgentSession(
        undefined,
        source.channelId ?? undefined,
        source.workspaceId ?? undefined,
        source.modelId ?? undefined,
        source.agentRuntime ?? 'claude',
      )
      setAgentSessions((prev) => [meta, ...prev])
      pairWith(source.id, meta.id)
    } catch (error) {
      console.error('[useCompareActions] 新建空白对比会话失败:', error)
      toast.error('新建对比会话失败', { description: String(error) })
    }
  }, [setAgentSessions, pairWith])

  /** 立即执行继承：可 fork 时走 SDK fork，其余情况用文本注入 */
  const executeInherit = React.useCallback(async (
    source: AgentSessionMeta,
    targetChannelId: string,
    targetModelId: string,
  ): Promise<boolean> => {
    // 仅有 SDK session 的 Claude runtime + 同渠道才走原生 fork
    //（省略 uuid = 复制全部历史，SDK 级继承，干净省 token）。
    // Pi runtime 的 fork 强制要求一条「已完成的 assistant 消息」uuid，不指定会报错；
    // 没有 SDK session 或跨渠道时统一走文本注入。
    const useFork = shouldForkInheritedSession(source, targetChannelId)
    try {
      if (useFork) {
        const meta = await window.electronAPI.forkAgentSession({
          sessionId: source.id,
          modelId: targetModelId,
        })
        setAgentSessions((prev) => [meta, ...prev])
        pairWith(source.id, meta.id)
        toast.success('已 fork 并继承上下文', { description: meta.title })
        return true
      }

      const targetRuntime = resolveCompareTargetRuntime(source, targetChannelId, channels)
      const meta = await window.electronAPI.createAgentSession(
        undefined,
        targetChannelId,
        source.workspaceId ?? undefined,
        targetModelId,
        targetRuntime,
      )
      setAgentSessions((prev) => [meta, ...prev])
      try {
        const srcMessages = await window.electronAPI.getAgentSessionSDKMessages(source.id)
        const block = buildInheritedContextBlock(srcMessages)
        if (block) setPendingPrompt({ sessionId: meta.id, message: block })
      } catch (error) {
        console.error('[useCompareActions] 读取源会话历史失败:', error)
        toast.error('继承上下文失败，已创建空白对比会话', { description: String(error) })
      }
      pairWith(source.id, meta.id)
      return true
    } catch (error) {
      console.error('[useCompareActions] 继承上下文失败:', error)
      toast.error('新建对比会话失败', { description: String(error) })
      return false
    }
  }, [channels, setAgentSessions, setPendingPrompt, pairWith])

  /** 发起继承：源会话在跑则记为待办（等它这轮结束再执行），否则立即执行 */
  const requestInherit = React.useCallback(async (
    source: AgentSessionMeta,
    targetChannelId: string,
    targetModelId: string,
    sourceRunning: boolean,
  ): Promise<void> => {
    if (sourceRunning) {
      setPendingInherit({ sourceSessionId: source.id, targetChannelId, targetModelId })
      toast.info('已安排：左侧完成后自动继承并分屏', { description: '你可以离开，回来即得到两个共享上下文的会话。' })
      return
    }
    await executeInherit(source, targetChannelId, targetModelId)
  }, [executeInherit, setPendingInherit])

  return { createBlankCompare, requestInherit, executeInherit }
}
