import { describe, expect, test } from 'bun:test'
import {
  resolveReasoningProfile,
  resolveReasoningCapability,
  normalizeReasoningLevel,
} from './reasoning-profile'

/**
 * Claude Opus 5.5 官方语义（platform.claude.com，2026-09-22 发布）：
 * - adaptive 思考常开，`thinking:{type:'disabled'}` 与旧版 budget 均返回 400；
 * - `output_config.effort` 五档全支持（low/medium/high/xhigh/max），官方默认 medium。
 */
describe('Claude Opus 5.5 reasoning profile（adaptive 常开 + 五档 effort）', () => {
  test('anthropic-messages 解析为 adaptive effort 编码', () => {
    const profile = resolveReasoningProfile({ modelId: 'claude-opus-5-5', transport: 'anthropic-messages' })
    expect(profile?.id).toBe('claude-opus-5-5')
    expect(profile?.encodings['anthropic-messages']?.kind).toBe('adaptive-effort')
    expect(profile?.levels).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(profile?.defaultLevel).toBe('medium')
  })

  test('快照与 -latest 别名同样命中，claude-opus-5 不误命中', () => {
    expect(resolveReasoningProfile({ modelId: 'claude-opus-5-5-20260922', transport: 'anthropic-messages' })?.id)
      .toBe('claude-opus-5-5')
    expect(resolveReasoningProfile({ modelId: 'claude-opus-5-5-latest', transport: 'anthropic-messages' })?.id)
      .toBe('claude-opus-5-5')
    expect(resolveReasoningProfile({ modelId: 'claude-opus-5', transport: 'anthropic-messages' })).toBeUndefined()
    expect(resolveReasoningProfile({ modelId: 'claude-opus-5-55', transport: 'anthropic-messages' })).toBeUndefined()
  })

  test('openai 协议渠道不携带 anthropic 编码', () => {
    expect(resolveReasoningProfile({ modelId: 'claude-opus-5-5', transport: 'openai-completions' })).toBeUndefined()
    expect(resolveReasoningProfile({ modelId: 'claude-opus-5-5', transport: 'openai-responses' })).toBeUndefined()
  })

  test('effortMap 将扩展档位映射为官方五档，不允许出现 null', () => {
    const profile = resolveReasoningProfile({ modelId: 'claude-opus-5-5', transport: 'anthropic-messages' })
    const map = profile?.encodings['anthropic-messages']?.effortMap ?? {}
    expect(Object.values(map).every((value) => typeof value === 'string')).toBe(true)
    expect(map.minimal).toBe('low')
    expect(map.low).toBe('low')
    expect(map.medium).toBe('medium')
    expect(map.high).toBe('high')
    expect(map.xhigh).toBe('xhigh')
    expect(map.max).toBe('max')
  })

  test('normalize：off/minimal 归一到 low（思考不可关闭），undefined 对齐官方默认 medium', () => {
    const profile = resolveReasoningProfile({ modelId: 'claude-opus-5-5', transport: 'anthropic-messages' })
    expect(profile && normalizeReasoningLevel(profile, 'off')).toBe('low')
    expect(profile && normalizeReasoningLevel(profile, 'minimal')).toBe('low')
    expect(profile && normalizeReasoningLevel(profile, undefined)).toBe('medium')
    expect(profile && normalizeReasoningLevel(profile, 'xhigh')).toBe('xhigh')
    expect(profile && normalizeReasoningLevel(profile, 'max')).toBe('max')
  })

  test('capability 不暴露 off（思考常开），默认档为官方 medium', () => {
    const profile = resolveReasoningProfile({ modelId: 'claude-opus-5-5', transport: 'anthropic-messages' })
    const capability = resolveReasoningCapability({ profile })
    expect(capability?.source).toBe('profile')
    expect(capability?.levels).not.toContain('off')
    expect(capability?.levels).not.toContain('minimal')
    expect(capability?.defaultLevel).toBe('medium')
  })
})
