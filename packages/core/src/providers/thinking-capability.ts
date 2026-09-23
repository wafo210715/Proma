/**
 * Claude 思考模式能力检测
 *
 * Anthropic 在 Claude 4.6+ 引入了 adaptive thinking，协议与旧版 extended thinking 不兼容：
 * - Opus 5.5 / Fable 5 家族：adaptive 常开且不可关闭，disabled 与旧版 budget 均会 400
 * - Opus 4.7 / Mythos Preview：只支持 adaptive，发送旧版 `{type: 'enabled', budget_tokens}` 会 400
 * - Opus 4.6 / Sonnet 5：两种都支持，adaptive 为推荐
 * - 更老的 Claude 系列（Sonnet 4.5 / Opus 4.5 / 3.x 等）：只支持 manual
 *
 * DeepSeek v4 系列走 Anthropic 兼容端点，但思考强度通过 `output_config.effort` 控制
 * （`high` / `max`），且默认就开启思考。本项目策略：开启思考 → max；关闭思考 → 显式 disabled。
 *
 * 本模块根据模型 ID 推断思考协议，供适配器构造请求体时分支使用。
 */
import { resolveReasoningProfile, type ProviderType } from '@proma/shared'

/** 思考协议能力 */
export type ThinkingMode =
  /** 仅支持 adaptive（Opus 4.7 / Mythos Preview） */
  | 'adaptive-only'
  /** 同时支持 adaptive 和 manual，推荐用 adaptive（Opus 4.6 / Sonnet 5） */
  | 'adaptive-preferred'
  /** 仅支持 manual（旧 Claude 4.5 及以下，以及 DeepSeek v3/reasoner 等） */
  | 'manual-only'
  /** DeepSeek v4 系列：`{type: enabled}` + `output_config.effort = 'max'`，关闭需显式 disabled */
  | 'effort-based-max'
  /** 不支持思考（非 Claude/Anthropic 兼容模型） */
  | 'none'

/** 禁用思考的方式（用于标题生成等） */
export type ThinkingDisableStrategy =
  /** 显式发送 `thinking: {type: 'disabled'}` */
  | 'explicit-disabled'
  /** 省略 thinking 字段（Mythos Preview 不接受 disabled） */
  | 'omit-field'

export interface ThinkingCapability {
  mode: ThinkingMode
  disableStrategy: ThinkingDisableStrategy
  /** adaptive effort 模型的默认强度；仅在支持 output_config.effort 时设置。 */
  effort?: string
  /**
   * 思考常开模型生成标题等轻量请求时使用的最低 effort 档。
   * 仅在官方已确认支持 low 档的模型上设置，避免思考吃满小 max_tokens 预算。
   */
  titleEffort?: 'low'
}

/**
 * 匹配模型 ID（不区分大小写，允许 -latest、-20250101 等后缀）
 */
function startsWith(modelId: string, prefix: string): boolean {
  const id = modelId.toLowerCase()
  return id === prefix || id.startsWith(`${prefix}-`)
}

/**
 * 根据模型 ID 推断思考协议能力
 *
 * 匹配策略：
 * - 优先按**模型 ID** 识别 DeepSeek v4（历史遗留：用户早期配的 DeepSeek 渠道 providerType 是
 *   'anthropic'，不是 'deepseek'；只靠 providerType 匹配会落到 manual-only，导致
 *   思考关闭时不发 `thinking` 字段、而 DeepSeek v4 默认开思考 → 报「thinking must be passed back」）
 * - 再按 providerType 兜底
 *
 * @param providerType 供应商类型
 * @param modelId 模型 ID
 */
export function detectThinkingCapability(
  providerType: ProviderType,
  modelId: string,
): ThinkingCapability {
  // Claude Opus 5.5（2026-09-22 发布）与 Fable 5 家族：adaptive 思考常开，
  // `thinking:{type:'disabled'}` 与旧版 `{type:'enabled',budget_tokens}` 均返回 400；
  // 深度由 output_config.effort 控制（两族官方均确认五档全支持）。
  // 先在这里排除，避免下方通用 reasoning profile 分支把它们错判为
  // explicit-disabled（对思考常开模型是 400）；真正的协议分支在供应商兼容分支之后。
  const isAlwaysOnAdaptiveClaude = startsWith(modelId, 'claude-opus-5-5')
    || startsWith(modelId, 'claude-fable-5')

  const profile = isAlwaysOnAdaptiveClaude
    ? undefined
    : resolveReasoningProfile({
      modelId,
      transport: 'anthropic-messages',
    })
  const encoding = profile?.encodings['anthropic-messages']
  if (encoding?.kind === 'adaptive-effort') {
    const effort = profile && encoding.effortMap[profile.defaultLevel]
    return {
      mode: 'adaptive-preferred',
      disableStrategy: 'explicit-disabled',
      ...(typeof effort === 'string' ? { effort } : {}),
    }
  }

  // DeepSeek v4 系列（按模型 ID 识别，不依赖 providerType）：
  // effort-based-max 模式会在思考关闭时显式发 `{type:'disabled'}`，这是 DeepSeek v4 的硬要求
  if (startsWith(modelId, 'deepseek-v4')) {
    return { mode: 'effort-based-max', disableStrategy: 'explicit-disabled' }
  }

  // DeepSeek 其它模型（v3 / reasoner 等）：旧 manual 协议
  if (providerType === 'deepseek') {
    return { mode: 'manual-only', disableStrategy: 'explicit-disabled' }
  }

  // Kimi / 智谱 / MiniMax / Token Plan 的 Anthropic 协议渠道：
  // 这些供应商的 thinking 请求参数存在兼容差异，这里直接省略以保持连接稳定。
  // Token Plan（qwen-token-plan / xiaomi-token-plan）端点不接受 thinking 字段，
  // 发送 `thinking: {type:'disabled'}` 会导致请求失败（标题生成等场景）。
  if (
    providerType === 'kimi-api'
    || providerType === 'kimi-coding'
    || providerType === 'zhipu-coding'
    || providerType === 'zhipu-coding-team'
    || providerType === 'ark-coding-plan'
    || providerType === 'minimax'
    || providerType === 'qwen-token-plan'
    || providerType === 'xiaomi-token-plan'
  ) {
    return { mode: 'none', disableStrategy: 'omit-field' }
  }

  // 其它非 Anthropic 供应商：不发 thinking
  if (providerType !== 'anthropic' && providerType !== 'anthropic-compatible') {
    return { mode: 'manual-only', disableStrategy: 'explicit-disabled' }
  }

  // Claude Opus 5.5 / Fable 5 家族：adaptive 常开且不可关闭（disabled 与旧版 budget 均 400）。
  // 官方迁移指引：以前关思考的地方改用低 effort，因此标题等轻量请求发 effort low。
  if (isAlwaysOnAdaptiveClaude) {
    return { mode: 'adaptive-only', disableStrategy: 'omit-field', titleEffort: 'low' }
  }

  // Claude Mythos Preview：adaptive 是默认且唯一，不接受 disabled
  if (startsWith(modelId, 'claude-mythos-preview')) {
    return { mode: 'adaptive-only', disableStrategy: 'omit-field' }
  }

  // Claude Opus 4.7:adaptive 唯一模式
  if (startsWith(modelId, 'claude-opus-4-7')) {
    return { mode: 'adaptive-only', disableStrategy: 'explicit-disabled' }
  }

  // Claude Opus 4.6 / Sonnet 5：两者都支持，优先 adaptive
  if (
    startsWith(modelId, 'claude-opus-4-6') ||
    startsWith(modelId, 'claude-sonnet-5')
  ) {
    return { mode: 'adaptive-preferred', disableStrategy: 'explicit-disabled' }
  }

  // 其它 Claude（4.5 及以下、3.x 等）：仅 manual
  return { mode: 'manual-only', disableStrategy: 'explicit-disabled' }
}
