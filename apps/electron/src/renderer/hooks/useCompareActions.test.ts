import { describe, expect, test } from 'bun:test'
import type { AgentSessionMeta, Channel, SDKMessage } from '@proma/shared'
import {
  buildInheritedContextBlock,
  resolveCompareTargetRuntime,
  shouldForkInheritedSession,
} from './useCompareActions'

function session(overrides: Partial<AgentSessionMeta> = {}): AgentSessionMeta {
  return {
    id: 'source-session',
    title: 'Source',
    channelId: 'anthropic-channel',
    modelId: 'claude-model',
    agentRuntime: 'claude',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

const channels = [
  { id: 'anthropic-channel', provider: 'anthropic', enabled: true, models: [] },
  { id: 'openai-channel', provider: 'custom', enabled: true, models: [] },
] as unknown as Channel[]

describe('跨 Provider 对比会话继承', () => {
  test('given a Claude SDK session on the same channel when inheriting then uses native fork', () => {
    expect(shouldForkInheritedSession(
      session({ sdkSessionId: 'sdk-session' }),
      'anthropic-channel',
    )).toBe(true)
  })

  test('given no SDK session, Pi runtime, or a different channel when inheriting then uses text injection', () => {
    expect(shouldForkInheritedSession(session(), 'anthropic-channel')).toBe(false)
    expect(shouldForkInheritedSession(
      session({ agentRuntime: 'pi', sdkSessionId: 'pi-session' }),
      'anthropic-channel',
    )).toBe(false)
    expect(shouldForkInheritedSession(
      session({ sdkSessionId: 'sdk-session' }),
      'openai-channel',
    )).toBe(false)
  })

  test('given a Pi source when creating an injected target then preserves Pi runtime', () => {
    expect(resolveCompareTargetRuntime(
      session({ agentRuntime: 'pi' }),
      'anthropic-channel',
      channels,
    )).toBe('pi')
  })

  test('given a Claude source and a non-Claude-compatible target then routes the target to Pi', () => {
    expect(resolveCompareTargetRuntime(
      session(),
      'openai-channel',
      channels,
    )).toBe('pi')
  })

  test('given a Claude source and a compatible target then keeps Claude runtime', () => {
    expect(resolveCompareTargetRuntime(
      session(),
      'anthropic-channel',
      channels,
    )).toBe('claude')
  })

  test('given user and assistant text blocks when building inherited context then keeps dialogue and skips tools', () => {
    const messages = [
      {
        type: 'user',
        message: { content: [{ type: 'text', text: '研究问题' }] },
      },
      {
        type: 'assistant',
        message: { content: '已有结论' },
      },
      {
        type: 'tool',
        message: { content: '不应出现' },
      },
    ] as unknown as SDKMessage[]

    const block = buildInheritedContextBlock(messages)

    expect(block).toContain('User: 研究问题')
    expect(block).toContain('Assistant: 已有结论')
    expect(block).not.toContain('不应出现')
  })
})
