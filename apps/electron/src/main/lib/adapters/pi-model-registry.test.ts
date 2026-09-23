import { describe, expect, test } from 'bun:test'
import { resolvePiReasoningCapability } from './pi-model-registry'

/**
 * Claude Opus 5.5（2026-09-22 发布）尚未进入 Pi catalog：
 * 思考能力必须由 shared reasoning profile 兜底（adaptive 常开 + 五档 effort），
 * 而不能因 catalog 缺失退化为「无思考档位」。
 */
describe('Pi reasoning capability：Claude Opus 5.5', () => {
  test('anthropic 渠道解析出 profile 来源的五档能力，默认档为官方 medium', async () => {
    const capability = await resolvePiReasoningCapability('anthropic', 'claude-opus-5-5')
    expect(capability?.source).toBe('profile')
    expect(capability?.levels).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(capability?.defaultLevel).toBe('medium')
  })

  test('快照别名同样命中', async () => {
    const capability = await resolvePiReasoningCapability('anthropic', 'claude-opus-5-5-20260922')
    expect(capability?.source).toBe('profile')
    expect(capability?.defaultLevel).toBe('medium')
  })

  test('anthropic-compatible 渠道同样命中（第三方 Anthropic 兼容端点）', async () => {
    const capability = await resolvePiReasoningCapability('anthropic-compatible', 'claude-opus-5-5')
    expect(capability?.source).toBe('profile')
  })

  test('catalog 已收录的 claude-opus-5 不受影响，仍走 pi-catalog 能力', async () => {
    const capability = await resolvePiReasoningCapability('anthropic', 'claude-opus-5')
    expect(capability?.source).toBe('pi-catalog')
  })
})
