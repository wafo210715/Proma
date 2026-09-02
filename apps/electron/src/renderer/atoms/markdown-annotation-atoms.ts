/**
 * Markdown 批注 Atoms
 *
 * 每个文件（file:<绝对路径> / vault:<相对路径>）一份批注列表，
 * 面板、行内 Tag 与持久化都读同一个 atom；null 表示尚未从 sidecar 读取。
 */

import { atom } from 'jotai'
import { atomFamily } from 'jotai/utils'
import type { MarkdownAnnotation } from '@proma/shared'

export const markdownAnnotationsAtomFamily = atomFamily((_fileKey: string) => atom<MarkdownAnnotation[] | null>(null))
