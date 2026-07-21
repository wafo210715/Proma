import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, type Dirent } from 'node:fs'
import { createReadStream } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { MAX_ATTACHMENT_SIZE, type AgentSessionMeta, type AgentWorkspace } from '@proma/shared'
import {
  attachWorkspaceFile,
  detachWorkspaceFile,
  listAgentWorkspaces,
} from './agent-workspace-manager'
import { listAgentSessions, updateAgentSessionMeta } from './agent-session-manager'
import {
  getConfigDir,
  resolveAgentSessionWorkspacePath,
  resolveWorkspaceFilesDir,
} from './config-paths'
import { rmSyncWithRetry } from './fs-retry'
import { MIGRATION_BLOCKED_DIRS, isPathWithin } from './workspace-file-policy'

export type LargeFileAttachmentScope = 'workspace' | 'session'

export interface LargeFileAttachmentCandidate {
  path: string
  relativePath: string
  size: number
  scope: LargeFileAttachmentScope
  workspaceId: string
  workspaceSlug: string
  sessionId?: string
}

export interface LargeFileAttachmentPreview {
  candidates: LargeFileAttachmentCandidate[]
  totalBytes: number
}

export interface ExternalizedLargeFile {
  originalPath: string
  attachmentPath: string
  size: number
  scope: LargeFileAttachmentScope
  workspaceSlug: string
  sessionId?: string
}

export interface LargeFileExternalizationFailure {
  path: string
  error: string
}

export interface LargeFileExternalizationResult {
  externalized: ExternalizedLargeFile[]
  failures: LargeFileExternalizationFailure[]
  freedBytes: number
}

export interface ExternalizeLargeFilesOptions {
  attachmentRoot?: string
  candidates?: LargeFileAttachmentCandidate[]
}

interface CandidateScanTarget {
  rootPath: string
  scope: LargeFileAttachmentScope
  workspace: AgentWorkspace
  sessionId?: string
}

/** 大附件的默认外部存储目录。 */
export function getDefaultLargeFileAttachmentDir(): string {
  return join(homedir(), 'Documents', 'Proma-attachments')
}

/** 解析并校验外部附件根目录，禁止其仍位于 Proma 配置目录中。 */
export function resolveLargeFileAttachmentDir(configuredDir?: string): string {
  const attachmentRoot = resolve(configuredDir ?? getDefaultLargeFileAttachmentDir())
  if (isPathWithin(getConfigDir(), attachmentRoot)) {
    throw new Error('大文件附件目录不能位于 ~/.proma 内，请选择外部目录')
  }
  return attachmentRoot
}

/** 扫描所有已登记工作区及其已登记会话中超过附件阈值的历史文件。 */
export function previewLargeWorkspaceFiles(): LargeFileAttachmentPreview {
  const workspaces = listAgentWorkspaces()
  const sessions = listAgentSessions()
  const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace]))
  const candidates: LargeFileAttachmentCandidate[] = []

  for (const workspace of workspaces) {
    scanTarget({
      rootPath: resolveWorkspaceFilesDir(workspace.slug),
      scope: 'workspace',
      workspace,
    }, candidates)
  }

  for (const session of sessions) {
    if (!session.workspaceId) continue
    const workspace = workspaceById.get(session.workspaceId)
    if (!workspace) continue
    scanTarget({
      rootPath: resolveAgentSessionWorkspacePath(workspace.slug, session.id),
      scope: 'session',
      workspace,
      sessionId: session.id,
    }, candidates)
  }

  candidates.sort((left, right) => right.size - left.size)
  return {
    candidates,
    totalBytes: candidates.reduce((total, candidate) => total + candidate.size, 0),
  }
}

/**
 * 将扫描到的大文件迁到外部附件根目录，并在成功删除原文件后保留附件登记。
 * 每个文件独立处理，单个失败不会中断其他迁移。
 */
export async function externalizeLargeWorkspaceFiles(
  options: ExternalizeLargeFilesOptions = {},
): Promise<LargeFileExternalizationResult> {
  const attachmentRoot = resolveLargeFileAttachmentDir(options.attachmentRoot)
  const candidates = options.candidates ?? previewLargeWorkspaceFiles().candidates
  const result: LargeFileExternalizationResult = {
    externalized: [],
    failures: [],
    freedBytes: 0,
  }

  for (const candidate of candidates) {
    try {
      const externalized = await externalizeCandidate(candidate, attachmentRoot)
      result.externalized.push(externalized)
      result.freedBytes += externalized.size
    } catch (error) {
      result.failures.push({
        path: candidate.path,
        error: formatError(error),
      })
    }
  }

  return result
}

function scanTarget(target: CandidateScanTarget, candidates: LargeFileAttachmentCandidate[]): void {
  if (!existsSync(target.rootPath)) return
  scanDirectory(target.rootPath, target.rootPath, target, candidates)
}

function scanDirectory(
  rootPath: string,
  currentPath: string,
  target: CandidateScanTarget,
  candidates: LargeFileAttachmentCandidate[],
): void {
  let entries: Dirent[]
  try {
    entries = readdirSync(currentPath, { withFileTypes: true })
  } catch (error) {
    console.warn(`[大文件附件] 无法读取目录，已跳过: ${currentPath}`, error)
    return
  }

  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const fullPath = join(currentPath, entry.name)

    if (entry.isDirectory()) {
      if (MIGRATION_BLOCKED_DIRS.has(entry.name)) continue
      scanDirectory(rootPath, fullPath, target, candidates)
      continue
    }

    if (!entry.isFile()) continue
    try {
      const stats = statSync(fullPath)
      if (stats.size <= MAX_ATTACHMENT_SIZE) continue
      candidates.push({
        path: fullPath,
        relativePath: relative(rootPath, fullPath),
        size: stats.size,
        scope: target.scope,
        workspaceId: target.workspace.id,
        workspaceSlug: target.workspace.slug,
        sessionId: target.sessionId,
      })
    } catch (error) {
      console.warn(`[大文件附件] 无法读取文件，已跳过: ${fullPath}`, error)
    }
  }
}

async function externalizeCandidate(
  candidate: LargeFileAttachmentCandidate,
  attachmentRoot: string,
): Promise<ExternalizedLargeFile> {
  const sourcePath = resolve(candidate.path)
  const sourceStats = statSync(sourcePath)
  if (!sourceStats.isFile()) throw new Error('源路径不是普通文件')
  if (sourceStats.size <= MAX_ATTACHMENT_SIZE) throw new Error('文件已不再超过附件阈值')

  const destinationPath = getUniqueDestinationPath(candidate, attachmentRoot)
  const temporaryPath = `${destinationPath}.proma-partial-${randomUUID()}`
  mkdirSync(dirname(destinationPath), { recursive: true })

  let registered = false
  let originalSessionFiles: string[] | undefined
  try {
    copyFileSync(sourcePath, temporaryPath)
    const temporaryStats = statSync(temporaryPath)
    if (temporaryStats.size !== sourceStats.size) {
      throw new Error('复制后文件大小不一致')
    }

    const [sourceHash, targetHash] = await Promise.all([
      hashFile(sourcePath),
      hashFile(temporaryPath),
    ])
    if (sourceHash !== targetHash) throw new Error('复制后 SHA-256 校验失败')

    renameSync(temporaryPath, destinationPath)
    if (candidate.scope === 'workspace') {
      attachWorkspaceFile(candidate.workspaceSlug, destinationPath)
    } else {
      if (!candidate.sessionId) throw new Error('会话附件缺少 sessionId')
      const session = findSession(candidate.sessionId)
      originalSessionFiles = session.attachedFiles ? [...session.attachedFiles] : undefined
      updateAgentSessionMeta(candidate.sessionId, {
        attachedFiles: [...(session.attachedFiles ?? []), destinationPath],
        archived: session.archived,
      })
    }
    registered = true

    try {
      rmSyncWithRetry(sourcePath, { force: true })
    } catch (deleteError) {
      rollbackRegistration(candidate, destinationPath, originalSessionFiles)
      registered = false
      throw new Error(`删除原文件失败，已回滚附件登记: ${formatError(deleteError)}`)
    }

    return {
      originalPath: sourcePath,
      attachmentPath: destinationPath,
      size: sourceStats.size,
      scope: candidate.scope,
      workspaceSlug: candidate.workspaceSlug,
      sessionId: candidate.sessionId,
    }
  } catch (error) {
    if (registered) {
      try {
        rollbackRegistration(candidate, destinationPath, originalSessionFiles)
      } catch (rollbackError) {
        console.error('[大文件附件] 回滚附件登记失败:', rollbackError)
      }
    }
    cleanupTemporaryFile(temporaryPath)
    cleanupTemporaryFile(destinationPath)
    throw error
  }
}

function getUniqueDestinationPath(candidate: LargeFileAttachmentCandidate, attachmentRoot: string): string {
  const scopeDir = candidate.scope === 'workspace'
    ? join(attachmentRoot, 'workspaces', candidate.workspaceSlug)
    : join(attachmentRoot, 'sessions', candidate.workspaceSlug, candidate.sessionId ?? 'unknown-session')
  const desiredPath = join(scopeDir, candidate.relativePath)
  if (!existsSync(desiredPath)) return desiredPath

  const parent = dirname(desiredPath)
  const extension = extname(desiredPath)
  const stem = basename(desiredPath, extension)
  for (let index = 1; ; index++) {
    const candidatePath = join(parent, `${stem} (${index})${extension}`)
    if (!existsSync(candidatePath)) return candidatePath
  }
}

function findSession(sessionId: string): AgentSessionMeta {
  const session = listAgentSessions().find((item) => item.id === sessionId)
  if (!session) throw new Error(`会话不存在: ${sessionId}`)
  return session
}

function rollbackRegistration(
  candidate: LargeFileAttachmentCandidate,
  destinationPath: string,
  originalSessionFiles: string[] | undefined,
): void {
  if (candidate.scope === 'workspace') {
    detachWorkspaceFile(candidate.workspaceSlug, destinationPath)
    return
  }
  if (!candidate.sessionId) return
  const session = findSession(candidate.sessionId)
  updateAgentSessionMeta(candidate.sessionId, {
    attachedFiles: originalSessionFiles,
    archived: session.archived,
  })
}

function cleanupTemporaryFile(filePath: string): void {
  try {
    if (existsSync(filePath)) rmSync(filePath, { force: true })
  } catch (error) {
    console.warn(`[大文件附件] 清理临时文件失败: ${filePath}`, error)
  }
}

function hashFile(filePath: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', (chunk: string | Buffer) => { hash.update(chunk) })
    stream.on('error', reject)
    stream.on('end', () => resolveHash(hash.digest('hex')))
  })
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
