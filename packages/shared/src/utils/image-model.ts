/**
 * 生图模型识别工具
 *
 * 供「设置 → Chat 工具 → GPT Image」默认过滤渠道模型列表使用，
 * 主进程（gpt-image-core）与渲染进程（ToolSettings）共用同一份规则。
 * 命中规则只是候选过滤，未命中时用户仍可切换「显示全部模型」手动选择。
 */

/** 已知生图模型 id 关键词（大小写不敏感，子串匹配） */
const IMAGE_MODEL_KEYWORDS = [
  // "image" 子串覆盖 gpt-image / image-generation / gemini-*-image-preview 等 OpenAI 与
  // Gemini 生图命名；主流理解模型（qwen*-vl、gpt-4o、claude、gemini-*-vision）不含该子串。
  'image',
  'dall-e',
  'dalle',
  'flux',
  'seedream',
  'janus',
  'stable-diffusion',
  'sdxl',
  'cogview',
  'irag',
]

/** 判断模型 id 是否疑似生图模型。 */
export function isLikelyImageModel(modelId: string): boolean {
  const id = modelId.toLowerCase()
  return IMAGE_MODEL_KEYWORDS.some((keyword) => id.includes(keyword))
}
