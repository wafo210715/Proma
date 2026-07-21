import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'

type WorkspaceManager = typeof import('./agent-workspace-manager')
type MigrationService = typeof import('./migration-service')
type ConfigPaths = typeof import('./config-paths')

let tempHome: string
let workspaceManager: WorkspaceManager
let migrationService: MigrationService
let configPaths: ConfigPaths
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
  tempHome = mkdtempSync(join(os.tmpdir(), 'proma-migration-'))
  process.env.HOME = tempHome
  process.env.PROMA_DEV = '0'
  configPaths = await import('./config-paths')
  workspaceManager = await import('./agent-workspace-manager')
  migrationService = await import('./migration-service')
})

afterEach(() => {
  rmSync(join(tempHome, '.proma'), { recursive: true, force: true })
  rmSync(join(tempHome, 'backup.proma-share'), { force: true })
})

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalPromaDev === undefined) delete process.env.PROMA_DEV
  else process.env.PROMA_DEV = originalPromaDev
  rmSync(tempHome, { recursive: true, force: true })
})

describe('迁移导入的会话附件路径', () => {
  test('Given session metadata has an external file When previewing and importing v2 Then it is shown and mapped', async () => {
    const workspace = workspaceManager.createAgentWorkspace('Migration attachment test')
    const sourceAttachment = join(tempHome, 'Documents', 'Proma-attachments', 'sessions', workspace.slug, 'session-a', 'video.mp4')
    const targetAttachment = join(tempHome, 'Restored', 'video.mp4')
    mkdirSync(join(tempHome, 'Documents', 'Proma-attachments', 'sessions', workspace.slug, 'session-a'), { recursive: true })
    writeFileSync(sourceAttachment, 'source')
    mkdirSync(join(tempHome, 'Restored'), { recursive: true })
    writeFileSync(targetAttachment, 'target')

    writeFileSync(configPaths.getAgentSessionsIndexPath(), JSON.stringify({
      version: 1,
      sessions: [{
        id: 'session-a',
        title: 'Session attachment',
        workspaceId: workspace.id,
        createdAt: 1,
        updatedAt: 1,
        attachedFiles: [sourceAttachment],
      }],
    }), 'utf-8')
    writeFileSync(configPaths.getAgentSessionMessagesPath('session-a'), '', 'utf-8')

    const outputPath = join(tempHome, 'backup.proma-share')
    await migrationService.exportDataV2({
      mode: 'share',
      components: ['sessions'],
      outputPath,
    })
    expect(existsSync(outputPath)).toBe(true)

    const preview = await migrationService.parseImportFile(outputPath)
    expect(preview.pathCheckResults.map((result) => result.path)).toContain(sourceAttachment)

    writeFileSync(configPaths.getAgentSessionsIndexPath(), JSON.stringify({ version: 1, sessions: [] }), 'utf-8')
    await migrationService.confirmImport({
      tempDir: preview.tempDir,
      manifest: preview.manifest,
      pathMappings: { [sourceAttachment]: targetAttachment },
      workspaceMappings: [{ sourceSlug: workspace.slug, action: 'merge', targetWorkspaceId: workspace.id }],
    })

    const imported = JSON.parse(readFileSync(configPaths.getAgentSessionsIndexPath(), 'utf-8')) as {
      sessions: Array<{ id: string; attachedFiles?: string[] }>
    }
    expect(imported.sessions).toHaveLength(1)
    expect(imported.sessions[0]?.attachedFiles).toEqual([targetAttachment])
  })
})
