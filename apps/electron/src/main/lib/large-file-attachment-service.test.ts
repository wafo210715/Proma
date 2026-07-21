import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import { dirname, join } from 'node:path'
import { MAX_ATTACHMENT_SIZE } from '@proma/shared'

type WorkspaceManager = typeof import('./agent-workspace-manager')
type SessionManager = typeof import('./agent-session-manager')
type ConfigPaths = typeof import('./config-paths')
type LargeFileService = typeof import('./large-file-attachment-service')

let tempHome: string
let workspaceManager: WorkspaceManager
let sessionManager: SessionManager
let configPaths: ConfigPaths
let service: LargeFileService
const originalHome = process.env.HOME
const originalPromaDev = process.env.PROMA_DEV

mock.module('electron', () => ({
  app: { isPackaged: true, getPath: () => join(process.env.HOME ?? tempHome, 'Library', 'Application Support') },
  BrowserWindow: class {},
  clipboard: {},
  dialog: {},
  nativeImage: { createFromPath: () => ({}) },
  nativeTheme: {},
  powerMonitor: {},
  powerSaveBlocker: {},
  screen: {},
  shell: {},
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf-8'),
  },
}))

mock.module('node:os', () => ({
  ...os,
  homedir: () => tempHome,
}))

beforeAll(async () => {
  tempHome = mkdtempSync(join(os.tmpdir(), 'proma-large-file-'))
  process.env.HOME = tempHome
  process.env.PROMA_DEV = '0'
  configPaths = await import('./config-paths')
  workspaceManager = await import('./agent-workspace-manager')
  sessionManager = await import('./agent-session-manager')
  service = await import('./large-file-attachment-service')
})

afterEach(() => {
  rmSync(join(tempHome, '.proma'), { recursive: true, force: true })
  rmSync(join(tempHome, 'Documents'), { recursive: true, force: true })
})

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalPromaDev === undefined) delete process.env.PROMA_DEV
  else process.env.PROMA_DEV = originalPromaDev
  rmSync(tempHome, { recursive: true, force: true })
})

function createSparseFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, '')
  truncateSync(path, MAX_ATTACHMENT_SIZE + 1)
}

describe('大文件外部附件迁移', () => {
  test('Given 会话和工作区包含超阈值文件 When 预览 Then 跳过 blocked 目录与 symlink 并标记作用域', () => {
    const workspace = workspaceManager.createAgentWorkspace('Large file test')
    const session = sessionManager.createAgentSession('Session', undefined, workspace.id)
    const workspaceFile = join(configPaths.resolveWorkspaceFilesDir(workspace.slug), 'video.mp4')
    const sessionFile = join(configPaths.resolveAgentSessionWorkspacePath(workspace.slug, session.id), 'recording.mov')
    const blockedFile = join(configPaths.resolveWorkspaceFilesDir(workspace.slug), 'node_modules', 'package', 'large.bin')

    createSparseFile(workspaceFile)
    createSparseFile(sessionFile)
    createSparseFile(blockedFile)
    symlinkSync(workspaceFile, join(configPaths.resolveWorkspaceFilesDir(workspace.slug), 'linked-video.mp4'))

    const preview = service.previewLargeWorkspaceFiles()

    expect(preview.candidates).toHaveLength(2)
    expect(preview.candidates.map((candidate) => candidate.scope).sort()).toEqual(['session', 'workspace'])
    expect(preview.candidates.every((candidate) => candidate.size === MAX_ATTACHMENT_SIZE + 1)).toBe(true)
  })

  test('Given a historical session file When externalized Then destination is registered on that session', async () => {
    const workspace = workspaceManager.createAgentWorkspace('Externalize session file')
    const session = sessionManager.createAgentSession('Session', undefined, workspace.id)
    sessionManager.updateAgentSessionMeta(session.id, { archived: true })
    const sourcePath = join(configPaths.resolveAgentSessionWorkspacePath(workspace.slug, session.id), 'recording.mov')
    createSparseFile(sourcePath)

    const candidate = service.previewLargeWorkspaceFiles().candidates.find((item) => item.path === sourcePath)
    expect(candidate).toBeDefined()

    const result = await service.externalizeLargeWorkspaceFiles({ candidates: [candidate!] })
    const attachmentPath = join(tempHome, 'Documents', 'Proma-attachments', 'sessions', workspace.slug, session.id, 'recording.mov')

    expect(result.failures).toEqual([])
    expect(existsSync(sourcePath)).toBe(false)
    expect(existsSync(attachmentPath)).toBe(true)
    expect(sessionManager.getAgentSessionMeta(session.id)?.attachedFiles).toContain(attachmentPath)
    expect(sessionManager.getAgentSessionMeta(session.id)?.archived).toBe(true)
  })

  test('Given a historical workspace file When externalized Then destination is attached and source space is released', async () => {
    const workspace = workspaceManager.createAgentWorkspace('Externalize workspace file')
    const sourcePath = join(configPaths.resolveWorkspaceFilesDir(workspace.slug), 'archive', 'video.mp4')
    createSparseFile(sourcePath)

    const candidate = service.previewLargeWorkspaceFiles().candidates.find((item) => item.path === sourcePath)
    expect(candidate).toBeDefined()

    const result = await service.externalizeLargeWorkspaceFiles({ candidates: [candidate!] })
    const attachmentPath = join(tempHome, 'Documents', 'Proma-attachments', 'workspaces', workspace.slug, 'archive', 'video.mp4')

    expect(result.failures).toEqual([])
    expect(result.freedBytes).toBe(MAX_ATTACHMENT_SIZE + 1)
    expect(existsSync(sourcePath)).toBe(false)
    expect(existsSync(attachmentPath)).toBe(true)
    expect(workspaceManager.getWorkspaceAttachedFiles(workspace.slug)).toContain(attachmentPath)
  })
})
