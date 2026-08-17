import { describe, expect, test } from 'bun:test'
import {
  resolveReasoningProfile,
  resolveReasoningCapability,
  normalizeReasoningCapabilityLevel,
  normalizeReasoningLevel,
} from './reasoning-profile'

describe('GLM-5.3 reasoning profile（官方 low/high/max 语义）', () => {
  test('openai-completions 解析为 effort 编码而非思考开关', () => {
    const profile = resolveReasoningProfile({ modelId: 'glm-5.3', transport: 'openai-completions' })
    expect(profile?.id).toBe('glm-5.3')
    expect(profile?.encodings['openai-completions']?.kind).toBe('zai-thinking-effort')
    expect(profile?.levels).toEqual(['low', 'high', 'max'])
    expect(profile?.defaultLevel).toBe('max')
  })

  test('anthropic-messages 解析为 adaptive effort 编码', () => {
    const profile = resolveReasoningProfile({ modelId: 'glm-5.3', transport: 'anthropic-messages' })
    expect(profile?.encodings['anthropic-messages']?.kind).toBe('adaptive-effort')
  })

  test('effortMap 将全部扩展档位映射为官方接受的 low/high/max', () => {
    const profile = resolveReasoningProfile({ modelId: 'glm-5.3', transport: 'openai-completions' })
    const map = profile?.encodings['openai-completions']?.effortMap ?? {}
    // null 表示「不支持」，GLM-5.3 三档全覆盖，不允许出现 null
    expect(Object.values(map).every((value) => typeof value === 'string')).toBe(true)
    expect(map.max).toBe('max')
    expect(map.xhigh).toBe('max')
  })

  test('normalize：off/minimal 归一到 low（官方不允许关闭思考）', () => {
    const profile = resolveReasoningProfile({ modelId: 'glm-5.3', transport: 'openai-completions' })
    expect(profile && normalizeReasoningLevel(profile, 'off')).toBe('low')
    expect(profile && normalizeReasoningLevel(profile, 'minimal')).toBe('low')
    expect(profile && normalizeReasoningLevel(profile, undefined)).toBe('low')
    expect(profile && normalizeReasoningLevel(profile, 'xhigh')).toBe('max')
    expect(profile && normalizeReasoningLevel(profile, 'high')).toBe('high')
  })

  test('capability 不暴露 off，旧会话 off 被 clamp 到 low', () => {
    const profile = resolveReasoningProfile({ modelId: 'glm-5.3', transport: 'openai-completions' })
    const capability = resolveReasoningCapability({ profile })
    expect(capability?.source).toBe('profile')
    expect(capability?.levels).not.toContain('off')
    expect(capability?.defaultLevel).toBe('max')
    expect(normalizeReasoningCapabilityLevel(capability, 'off')).toBe('low')
  })
})
