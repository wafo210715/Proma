import * as React from 'react'
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import type { AgentPendingFile } from '@proma/shared'
import {
  agentPendingFilesAtomFamily,
} from '@/atoms/agent-atoms'
import {
  compareLinkedAtom,
  comparePairAtom,
  comparePendingFileLinksAtom,
  getComparePartner,
  getComparePendingFileLinkKey,
} from '@/atoms/compare-atoms'
import type { ComparePendingFileLink } from '@/atoms/compare-atoms'

function cleanupPendingFileData(file: AgentPendingFile): void {
  if (file.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(file.previewUrl)
  window.__pendingAgentFileData?.delete(file.id)
}

export function clonePendingFileForPartner(
  file: AgentPendingFile,
  id: string,
  data?: string,
): AgentPendingFile {
  return {
    ...file,
    id,
    // blob URL 被任一侧 revoke 后会失效；有内存数据时改用独立 data URL，否则不复制预览。
    previewUrl: data && file.mediaType.startsWith('image/')
      ? `data:${file.mediaType};base64,${data}`
      : file.previewUrl?.startsWith('data:') ? file.previewUrl : undefined,
  }
}

export function linkComparePendingFilePair(
  links: Map<string, ComparePendingFileLink>,
  sourceSessionId: string,
  sourceFileId: string,
  partnerSessionId: string,
  partnerFileId: string,
): Map<string, ComparePendingFileLink> {
  const next = new Map(links)
  next.set(getComparePendingFileLinkKey(sourceSessionId, sourceFileId), {
    partnerSessionId,
    partnerFileId,
  })
  next.set(getComparePendingFileLinkKey(partnerSessionId, partnerFileId), {
    partnerSessionId: sourceSessionId,
    partnerFileId: sourceFileId,
  })
  return next
}

export function releaseComparePendingFilePairs(
  links: Map<string, ComparePendingFileLink>,
  sourceSessionId: string,
  sourceFileIds: string[],
  activePartnerSessionId: string | null,
): { links: Map<string, ComparePendingFileLink>; partnerFileIds: string[] } {
  const next = new Map(links)
  const partnerFileIds: string[] = []

  for (const fileId of sourceFileIds) {
    const key = getComparePendingFileLinkKey(sourceSessionId, fileId)
    const link = links.get(key)
    if (!link) continue
    if (activePartnerSessionId && link.partnerSessionId === activePartnerSessionId) {
      partnerFileIds.push(link.partnerFileId)
    }
    next.delete(key)
    next.delete(getComparePendingFileLinkKey(link.partnerSessionId, link.partnerFileId))
  }

  return { links: next, partnerFileIds }
}

function createPartnerPendingFile(file: AgentPendingFile): AgentPendingFile {
  const id = `pending-${crypto.randomUUID()}`
  const data = window.__pendingAgentFileData?.get(file.id)
  if (data) {
    if (!window.__pendingAgentFileData) window.__pendingAgentFileData = new Map()
    window.__pendingAgentFileData.set(id, data)
  }
  return clonePendingFileForPartner(file, id, data)
}

/**
 * 管理单个 session 的附件草稿，并在「已配对 + 联动开启」时镜像新增/移除事件。
 * 联动关闭后映射由 MainArea 清空，现有草稿从此独立演化；重新开启不会自动合并。
 */
export function useComparePendingFiles(sessionId: string) {
  const store = useStore()
  const pendingFiles = useAtomValue(agentPendingFilesAtomFamily(sessionId))
  const setPendingFiles = useSetAtom(agentPendingFilesAtomFamily(sessionId))
  const comparePair = useAtomValue(comparePairAtom)
  const compareLinked = useAtomValue(compareLinkedAtom)
  const partnerSessionId = compareLinked ? getComparePartner(comparePair, sessionId) : null

  const addPendingFile = React.useCallback((file: AgentPendingFile): void => {
    setPendingFiles((prev) => prev.some((item) => item.id === file.id) ? prev : [...prev, file])
    if (!partnerSessionId) return

    const partnerAtom = agentPendingFilesAtomFamily(partnerSessionId)
    const partnerFiles = store.get(partnerAtom)
    // 联动开启后再次 attach 同一路径，视为用户主动把两侧草稿重新同步。
    const existingPartnerFile = file.sourcePath
      ? partnerFiles.find((item) => item.sourcePath === file.sourcePath)
      : undefined
    const partnerFile = existingPartnerFile ?? createPartnerPendingFile(file)
    if (!existingPartnerFile) store.set(partnerAtom, (prev) => [...prev, partnerFile])

    store.set(comparePendingFileLinksAtom, (prev) => linkComparePendingFilePair(
      prev,
      sessionId,
      file.id,
      partnerSessionId,
      partnerFile.id,
    ))
  }, [partnerSessionId, sessionId, setPendingFiles, store])

  const removePendingFile = React.useCallback((fileId: string): void => {
    const currentAtom = agentPendingFilesAtomFamily(sessionId)
    const current = store.get(currentAtom)
    const file = current.find((item) => item.id === fileId)
    if (file) cleanupPendingFileData(file)
    store.set(currentAtom, current.filter((item) => item.id !== fileId))

    const key = getComparePendingFileLinkKey(sessionId, fileId)
    const links = store.get(comparePendingFileLinksAtom)
    const link = links.get(key)
    const shouldMirrorRemoval = !!partnerSessionId && link?.partnerSessionId === partnerSessionId
    if (shouldMirrorRemoval && link) {
      const partnerAtom = agentPendingFilesAtomFamily(link.partnerSessionId)
      const partnerFiles = store.get(partnerAtom)
      const partnerFile = partnerFiles.find((item) => item.id === link.partnerFileId)
      if (partnerFile) cleanupPendingFileData(partnerFile)
      store.set(partnerAtom, partnerFiles.filter((item) => item.id !== link.partnerFileId))
    }

    store.set(comparePendingFileLinksAtom, (prev) => {
      const next = new Map(prev)
      next.delete(key)
      if (link) {
        next.delete(getComparePendingFileLinkKey(link.partnerSessionId, link.partnerFileId))
      }
      return next
    })
  }, [partnerSessionId, sessionId, store])

  /**
   * 源侧成功准备附件后释放同步关系，并返回目标侧应随广播消费的镜像草稿 ID。
   * 联动已关闭时只释放关系，不影响 partner 草稿。
   */
  const releasePendingFileLinks = React.useCallback((files: AgentPendingFile[]): string[] => {
    const currentLinks = store.get(comparePendingFileLinksAtom)
    const released = releaseComparePendingFilePairs(
      currentLinks,
      sessionId,
      files.map((file) => file.id),
      partnerSessionId,
    )
    if (released.links.size !== currentLinks.size) {
      store.set(comparePendingFileLinksAtom, released.links)
    }
    return released.partnerFileIds
  }, [partnerSessionId, sessionId, store])

  const removePendingFilesById = React.useCallback((fileIds: string[]): void => {
    if (fileIds.length === 0) return
    const ids = new Set(fileIds)
    const atom = agentPendingFilesAtomFamily(sessionId)
    const current = store.get(atom)
    for (const file of current) {
      if (ids.has(file.id)) cleanupPendingFileData(file)
    }
    store.set(atom, current.filter((file) => !ids.has(file.id)))
  }, [sessionId, store])

  return {
    pendingFiles,
    setPendingFiles,
    addPendingFile,
    removePendingFile,
    releasePendingFileLinks,
    removePendingFilesById,
  }
}
