/**
 * Markdown 批注 sidecar 存储
 *
 * 每个文件对应 ~/.proma/annotations/<sha256(绝对路径)>.json，
 * 主进程独占写入（多窗口安全），原子写 + .bak 容错沿用 safe-file。
 * 批注不写入 .md 正文，避免污染 Obsidian 等第三方工具的视图。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type {
  MarkdownAnnotation,
  MarkdownAnnotationAnchor,
  MarkdownAnnotationDocument,
  MarkdownAnnotationStatus,
} from '@proma/shared'
import { getConfigDir } from './config-paths'
import { readJsonFileSafe, writeJsonFileAtomic } from './safe-file'

const ANNOTATIONS_DIR_NAME = 'annotations'
const MAX_ANNOTATIONS_PER_FILE = 500
const MAX_COMMENT_CHARS = 4000
const MAX_EXACT_CHARS = 20_000

function getAnnotationsDir(baseDir: string): string {
  const dir = join(baseDir, ANNOTATIONS_DIR_NAME)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/** sidecar 文件名只取路径摘要，不泄漏用户目录结构。 */
export function getMarkdownAnnotationSidecarPath(absoluteFilePath: string, baseDir = getConfigDir()): string {
  const digest = createHash('sha256').update(absoluteFilePath, 'utf-8').digest('hex')
  return join(getAnnotationsDir(baseDir), `${digest}.json`)
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isStatus(value: unknown): value is MarkdownAnnotationStatus {
  return value === 'open' || value === 'sent' || value === 'outdated'
}

function normalizeAnchor(value: unknown): MarkdownAnnotationAnchor | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (!isFiniteNonNegative(record.from) || !isFiniteNonNegative(record.to) || record.to < record.from) return null
  if (typeof record.exact !== 'string' || record.exact.length === 0 || record.exact.length > MAX_EXACT_CHARS) return null
  const startLine = isFiniteNonNegative(record.startLine) && record.startLine >= 1 ? Math.floor(record.startLine) : 1
  const endLine = isFiniteNonNegative(record.endLine) && record.endLine >= startLine ? Math.floor(record.endLine) : startLine
  return {
    from: Math.floor(record.from),
    to: Math.floor(record.to),
    exact: record.exact,
    prefix: typeof record.prefix === 'string' ? record.prefix : '',
    suffix: typeof record.suffix === 'string' ? record.suffix : '',
    startLine,
    endLine,
  }
}

/** 渲染进程与磁盘内容都不可信：逐字段校验，丢弃无法恢复的记录而不是整体失败。 */
export function normalizeMarkdownAnnotations(value: unknown): MarkdownAnnotation[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const result: MarkdownAnnotation[] = []
  for (const item of value) {
    if (result.length >= MAX_ANNOTATIONS_PER_FILE) break
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (typeof record.id !== 'string' || !record.id.trim() || seen.has(record.id)) continue
    const anchor = normalizeAnchor(record.anchor)
    if (!anchor) continue
    const comment = typeof record.comment === 'string' ? record.comment.slice(0, MAX_COMMENT_CHARS) : ''
    const createdAt = isFiniteNonNegative(record.createdAt) ? record.createdAt : Date.now()
    const updatedAt = isFiniteNonNegative(record.updatedAt) ? record.updatedAt : createdAt
    seen.add(record.id)
    result.push({
      id: record.id,
      anchor,
      comment,
      status: isStatus(record.status) ? record.status : 'open',
      createdAt,
      updatedAt,
    })
  }
  return result
}

export function loadMarkdownAnnotations(absoluteFilePath: string, baseDir = getConfigDir()): MarkdownAnnotation[] {
  const sidecarPath = getMarkdownAnnotationSidecarPath(absoluteFilePath, baseDir)
  if (!existsSync(sidecarPath)) return []
  const document = readJsonFileSafe<Partial<MarkdownAnnotationDocument>>(sidecarPath)
  if (!document || typeof document !== 'object') return []
  return normalizeMarkdownAnnotations(document.annotations)
}

/** 空列表直接删除 sidecar，避免用户清空批注后仍残留文件。 */
export function saveMarkdownAnnotations(
  absoluteFilePath: string,
  annotations: unknown,
  baseDir = getConfigDir(),
): MarkdownAnnotation[] {
  const normalized = normalizeMarkdownAnnotations(annotations)
  const sidecarPath = getMarkdownAnnotationSidecarPath(absoluteFilePath, baseDir)
  if (normalized.length === 0) {
    for (const path of [sidecarPath, `${sidecarPath}.bak`, `${sidecarPath}.tmp`]) {
      try { if (existsSync(path)) unlinkSync(path) } catch { /* 清理失败不影响结果 */ }
    }
    return normalized
  }
  const document: MarkdownAnnotationDocument = {
    version: 1,
    filePath: absoluteFilePath,
    annotations: normalized,
    updatedAt: Date.now(),
  }
  writeJsonFileAtomic(sidecarPath, document)
  return normalized
}

/**
 * 把渲染进程传来的批注目标解析为绝对路径。
 * 普通文件必须是绝对路径；Vault 只接受已授权根目录内的相对路径。
 */
export function resolveMarkdownAnnotationFilePath(target: unknown, vaultRootPath: string | null): string {
  if (!target || typeof target !== 'object') throw new Error('批注目标非法')
  const value = target as Record<string, unknown>
  if (value.kind === 'file') {
    if (typeof value.filePath !== 'string' || !value.filePath.trim() || !isAbsolute(value.filePath)) {
      throw new Error('批注文件路径必须为绝对路径')
    }
    return resolve(value.filePath)
  }
  if (value.kind === 'vault') {
    if (typeof value.relativePath !== 'string' || !value.relativePath.trim()) throw new Error('Vault 批注路径非法')
    if (!vaultRootPath) throw new Error('尚未授权 Vault，无法保存批注')
    const root = resolve(vaultRootPath)
    const absolutePath = resolve(root, value.relativePath)
    const fromRoot = relative(root, absolutePath)
    if (!fromRoot || fromRoot.startsWith('..') || isAbsolute(fromRoot)) throw new Error('Vault 批注路径越界')
    return absolutePath
  }
  throw new Error('批注目标类型非法')
}
