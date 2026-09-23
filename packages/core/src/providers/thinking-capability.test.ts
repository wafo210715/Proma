import { describe, expect, test } from 'bun:test'
import { detectThinkingCapability } from './thinking-capability'
import { AnthropicAdapter } from './anthropic-adapter'

/**
 * Claude Opus 5.5 官方语义（platform.claude.com，2026-09-22 发布）：
 * adaptive 思考常开，`thinking:{type:'disabled'}` 与旧版 `{type:'enabled',budget_tokens}`
 * 均返回 400 invalid_request_error；深度由 output_config.effort 控制。
 * Fable 5 家族同规则（官方 what's-new：Opus 5.5 前三条破坏性变更同样适用于 Fable 5.1）。
 */
describe('Claude Opus 5.5 / Fable 5 思考能力检测', () => {
  test('opus-5-5 解析为 adaptive-only 且禁用策略为省略字段', () => {
    const capability = detectThinkingCapability('anthropic', 'claude-opus-5-5')
    expect(capability.mode).toBe('adaptive-only')
    expect(capability.disableStrategy).toBe('omit-field')
    expect(capability.titleEffort).toBe('low')
  })

  test('opus-5-5 快照别名同样命中，claude-opus-5 保持既有行为', () => {
    const snapshot = detectThinkingCapability('anthropic', 'claude-opus-5-5-20260922')
    expect(snapshot.mode).toBe('adaptive-only')
    expect(snapshot.disableStrategy).toBe('omit-field')
    // opus-5 官方接受 disabled（xhigh/max effort 除外），维持显式 disabled 的既有分支
    expect(detectThinkingCapability('anthropic', 'claude-opus-5').mode).toBe('manual-only')
  })

  test('fable-5 家族解析为 adaptive-only', () => {
    for (const modelId of ['claude-fable-5', 'claude-fable-5-1']) {
      const capability = detectThinkingCapability('anthropic', modelId)
      expect(capability.mode).toBe('adaptive-only')
      expect(capability.disableStrategy).toBe('omit-field')
      expect(capability.titleEffort).toBe('low')
    }
  })

  test('供应商兼容分支优先于家族分支：兼容渠道上的 claude ID 仍省略 thinking', () => {
    for (const provider of ['kimi-api', 'zhipu-coding', 'minimax', 'qwen-token-plan'] as const) {
      const capability = detectThinkingCapability(provider, 'claude-opus-5-5')
      expect(capability.mode).toBe('none')
      expect(capability.disableStrategy).toBe('omit-field')
    }
  })

  test('既有 Claude 分支不回归：4-7 adaptive-only、4-6/sonnet-5 adaptive-preferred、4-5 manual', () => {
    expect(detectThinkingCapability('anthropic', 'claude-opus-4-7').mode).toBe('adaptive-only')
    expect(detectThinkingCapability('anthropic', 'claude-opus-4-6').mode).toBe('adaptive-preferred')
    expect(detectThinkingCapability('anthropic', 'claude-sonnet-5').mode).toBe('adaptive-preferred')
    expect(detectThinkingCapability('anthropic', 'claude-sonnet-4-5').mode).toBe('manual-only')
    expect(detectThinkingCapability('anthropic', 'claude-opus-4-5').mode).toBe('manual-only')
  })
})

describe('AnthropicAdapter opus-5-5 请求体', () => {
  const adapter = new AnthropicAdapter('anthropic')

  function buildStreamRequest(thinkingEnabled: boolean) {
    return adapter.buildStreamRequest({
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'test-key',
      modelId: 'claude-opus-5-5',
      history: [],
      userMessage: '你好',
      thinkingEnabled,
      readImageAttachments: () => [],
    })
  }

  test('开启思考：发送 adaptive + summarized，不携带 budget_tokens', () => {
    const body = JSON.parse(buildStreamRequest(true).body) as Record<string, unknown>
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect((body.thinking as { budget_tokens?: number }).budget_tokens).toBeUndefined()
  })

  test('关闭思考：省略 thinking 字段（服务端常开，disabled 会 400），上限不缩减', () => {
    const body = JSON.parse(buildStreamRequest(false).body) as Record<string, unknown>
    expect(body.thinking).toBeUndefined()
    expect(body.max_tokens).toBe(32000)
  })

  test('标题请求：省略 thinking 并叠加 effort low，避免思考吃满小预算', () => {
    const request = adapter.buildTitleRequest({
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'test-key',
      modelId: 'claude-opus-5-5',
      prompt: '生成标题',
    })
    const body = JSON.parse(request.body) as Record<string, unknown>
    expect(body.thinking).toBeUndefined()
    expect(body.output_config).toEqual({ effort: 'low' })
  })

  test('标题请求回归：opus-4-5 仍显式 disabled，不带 output_config', () => {
    const request = adapter.buildTitleRequest({
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'test-key',
      modelId: 'claude-opus-4-5',
      prompt: '生成标题',
    })
    const body = JSON.parse(request.body) as Record<string, unknown>
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body.output_config).toBeUndefined()
  })
})
