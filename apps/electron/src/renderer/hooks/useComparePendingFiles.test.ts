import { describe, expect, test } from 'bun:test'
import type { AgentPendingFile } from '@proma/shared'
import { getComparePendingFileLinkKey } from '@/atoms/compare-atoms'
import {
  clonePendingFileForPartner,
  linkComparePendingFilePair,
  releaseComparePendingFilePairs,
} from './useComparePendingFiles'

const sourceFile: AgentPendingFile = {
  id: 'source-file',
  filename: 'proposal.pdf',
  mediaType: 'application/pdf',
  size: 1024,
  sourcePath: '/workspace/source/proposal.pdf',
}

describe('双开对比附件草稿同步', () => {
  test('given a path-backed attachment when cloning then preserves the exact source path with an independent id', () => {
    const clone = clonePendingFileForPartner(sourceFile, 'partner-file')

    expect(clone.id).toBe('partner-file')
    expect(clone.sourcePath).toBe('/workspace/source/proposal.pdf')
    expect(clone.filename).toBe('proposal.pdf')
  })

  test('given an in-memory image when cloning then creates an independent data preview', () => {
    const clone = clonePendingFileForPartner({
      ...sourceFile,
      mediaType: 'image/png',
      previewUrl: 'blob:source-preview',
      sourcePath: undefined,
    }, 'partner-image', 'aW1hZ2U=')

    expect(clone.previewUrl).toBe('data:image/png;base64,aW1hZ2U=')
    expect(clone.sourcePath).toBeUndefined()
  })

  test('given two synced drafts when linking then stores a symmetric relationship', () => {
    const links = linkComparePendingFilePair(
      new Map(),
      'left-session',
      'left-file',
      'right-session',
      'right-file',
    )

    expect(links.get(getComparePendingFileLinkKey('left-session', 'left-file'))).toEqual({
      partnerSessionId: 'right-session',
      partnerFileId: 'right-file',
    })
    expect(links.get(getComparePendingFileLinkKey('right-session', 'right-file'))).toEqual({
      partnerSessionId: 'left-session',
      partnerFileId: 'left-file',
    })
  })

  test('given linked drafts when the source sends then returns the partner draft to consume and releases both links', () => {
    const links = linkComparePendingFilePair(
      new Map(),
      'left-session',
      'left-file',
      'right-session',
      'right-file',
    )

    const released = releaseComparePendingFilePairs(
      links,
      'left-session',
      ['left-file'],
      'right-session',
    )

    expect(released.partnerFileIds).toEqual(['right-file'])
    expect(released.links.size).toBe(0)
  })

  test('given drafts diverged after unlinking when one side sends then releases mapping without consuming the partner draft', () => {
    const links = linkComparePendingFilePair(
      new Map(),
      'left-session',
      'left-file',
      'right-session',
      'right-file',
    )

    const released = releaseComparePendingFilePairs(
      links,
      'left-session',
      ['left-file'],
      null,
    )

    expect(released.partnerFileIds).toEqual([])
    expect(released.links.size).toBe(0)
  })
})
