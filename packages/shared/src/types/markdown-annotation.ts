/**
 * Markdown 预览批注（行内 Tag + 待办 + 批量发送）
 *
 * 批注不写入 .md 正文，而是以 sidecar JSON 存放在 ~/.proma/annotations/ 下，
 * 普通文件预览与 Obsidian Vault 预览共用同一份实现与存储。
 */

/** 批注锚点：源码偏移是内存态快路径，引文三元组用于跨会话重定位。 */
export interface MarkdownAnnotationAnchor {
  /** 源码起始偏移（创建或最近一次映射时） */
  from: number
  /** 源码结束偏移（exclusive） */
  to: number
  /** 被批注文本快照 */
  exact: string
  /** 锚点前若干字符，用于多处命中时消歧 */
  prefix: string
  /** 锚点后若干字符 */
  suffix: string
  /** 起始行号（1-based） */
  startLine: number
  /** 结束行号（1-based） */
  endLine: number
}

/**
 * open = 待办（尚未发送）；sent = 已发送到输入框；
 * outdated = 原文已变更、无法重新定位（保留在面板，仍可发送快照）。
 */
export type MarkdownAnnotationStatus = 'open' | 'sent' | 'outdated'

export interface MarkdownAnnotation {
  id: string
  anchor: MarkdownAnnotationAnchor
  /** 用户评论 */
  comment: string
  status: MarkdownAnnotationStatus
  createdAt: number
  updatedAt: number
}

/** 批注归属的文件；Vault 只暴露相对路径，由主进程解析为已授权根内的绝对路径。 */
export type MarkdownAnnotationTarget =
  | { kind: 'file'; filePath: string }
  | { kind: 'vault'; relativePath: string }

export interface MarkdownAnnotationDocument {
  version: 1
  /** 解析后的绝对路径，仅用于人工排查 sidecar 文件 */
  filePath: string
  annotations: MarkdownAnnotation[]
  updatedAt: number
}

export interface SaveMarkdownAnnotationsInput {
  target: MarkdownAnnotationTarget
  annotations: MarkdownAnnotation[]
}

export const MARKDOWN_ANNOTATION_IPC_CHANNELS = {
  LOAD: 'markdown-annotations:load',
  SAVE: 'markdown-annotations:save',
} as const
