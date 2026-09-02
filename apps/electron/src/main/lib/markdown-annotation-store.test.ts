import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MarkdownAnnotation } from '@proma/shared'
import {
  getMarkdownAnnotationSidecarPath,
  loadMarkdownAnnotations,
  normalizeMarkdownAnnotations,
  resolveMarkdownAnnotationFilePath,
  saveMarkdownAnnotations,
} from './markdown-annotation-store'

const FILE = '/Users/me/notes/review.md'

function makeAnnotation(id: string, overrides: Partial<MarkdownAnnotation> = {}): MarkdownAnnotation {
  return {
    id,
    anchor: { from: 10, to: 20, exact: '被批注文本', prefix: '前文', suffix: '后文', startLine: 2, endLine: 2 },
    comment: '需要补充引用',
    status: 'open',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe('Markdown 批注 sidecar 存储', () => {
  let baseDir: string
  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'proma-annotations-'))
  })
  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true })
  })

  test('given 批注列表 when 保存后读取 then 原样往返且 sidecar 位于 annotations 目录', () => {
    const saved = saveMarkdownAnnotations(FILE, [makeAnnotation('a'), makeAnnotation('b', { status: 'sent' })], baseDir)
    expect(saved).toHaveLength(2)
    const sidecar = getMarkdownAnnotationSidecarPath(FILE, baseDir)
    expect(sidecar.startsWith(join(baseDir, 'annotations'))).toBe(true)
    expect(existsSync(sidecar)).toBe(true)
    const document = JSON.parse(readFileSync(sidecar, 'utf-8')) as { version: number; filePath: string }
    expect(document.version).toBe(1)
    expect(document.filePath).toBe(FILE)
    expect(loadMarkdownAnnotations(FILE, baseDir)).toEqual(saved)
  })

  test('given 不同文件 when 保存 then 互不覆盖', () => {
    saveMarkdownAnnotations(FILE, [makeAnnotation('a')], baseDir)
    saveMarkdownAnnotations('/Users/me/notes/other.md', [makeAnnotation('z')], baseDir)
    expect(loadMarkdownAnnotations(FILE, baseDir).map((item) => item.id)).toEqual(['a'])
  })

  test('given 空列表 when 保存 then 删除既有 sidecar', () => {
    saveMarkdownAnnotations(FILE, [makeAnnotation('a')], baseDir)
    const sidecar = getMarkdownAnnotationSidecarPath(FILE, baseDir)
    saveMarkdownAnnotations(FILE, [], baseDir)
    expect(existsSync(sidecar)).toBe(false)
    expect(existsSync(`${sidecar}.bak`)).toBe(false)
    expect(loadMarkdownAnnotations(FILE, baseDir)).toEqual([])
  })

  test('given 未保存过的文件 when 读取 then 返回空列表', () => {
    expect(loadMarkdownAnnotations('/nowhere.md', baseDir)).toEqual([])
  })

  test('given 损坏的 sidecar when 读取 then 回退为空而不是抛错', () => {
    const sidecar = getMarkdownAnnotationSidecarPath(FILE, baseDir)
    writeFileSync(sidecar, '{ not json', 'utf-8')
    expect(loadMarkdownAnnotations(FILE, baseDir)).toEqual([])
  })

  test('given 非法字段 when 归一化 then 丢弃坏记录、修正缺省值、去重 id', () => {
    const normalized = normalizeMarkdownAnnotations([
      makeAnnotation('ok'),
      { ...makeAnnotation('dup') },
      { ...makeAnnotation('dup'), comment: '重复 id 应被忽略' },
      { ...makeAnnotation('bad-anchor'), anchor: { from: 5, to: 2, exact: 'x' } },
      { ...makeAnnotation('no-exact'), anchor: { from: 0, to: 1, exact: '' } },
      { ...makeAnnotation('loose'), status: 'weird', comment: 42, createdAt: 'x' },
      'garbage',
      null,
    ])
    expect(normalized.map((item) => item.id)).toEqual(['ok', 'dup', 'loose'])
    const loose = normalized[2]!
    expect(loose.status).toBe('open')
    expect(loose.comment).toBe('')
    expect(typeof loose.createdAt).toBe('number')
  })
})

describe('批注目标解析', () => {
  test('given 绝对文件路径 when 解析 then 原样归一', () => {
    expect(resolveMarkdownAnnotationFilePath({ kind: 'file', filePath: '/Users/me/a.md' }, null)).toBe('/Users/me/a.md')
  })

  test('given 相对文件路径 when 解析 then 拒绝', () => {
    expect(() => resolveMarkdownAnnotationFilePath({ kind: 'file', filePath: 'notes/a.md' }, null)).toThrow()
  })

  test('given Vault 相对路径 when 解析 then 落在已授权根目录内', () => {
    expect(resolveMarkdownAnnotationFilePath({ kind: 'vault', relativePath: 'inbox/a.md' }, '/vault')).toBe('/vault/inbox/a.md')
  })

  test('given Vault 路径越界或未授权 when 解析 then 拒绝', () => {
    expect(() => resolveMarkdownAnnotationFilePath({ kind: 'vault', relativePath: '../a.md' }, '/vault')).toThrow()
    expect(() => resolveMarkdownAnnotationFilePath({ kind: 'vault', relativePath: 'a.md' }, null)).toThrow()
    expect(() => resolveMarkdownAnnotationFilePath({ kind: 'other' }, null)).toThrow()
  })
})
