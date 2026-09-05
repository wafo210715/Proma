import { describe, expect, test } from 'bun:test'
import type { WebContents } from 'electron'
import { AgentQueueCoordinator } from './agent-queue-coordinator'
import type { AgentDeferredQueueMessageInput, AgentQueuedMessageStatus } from '@proma/shared'

function makeMessage(sessionId: string, messageId: string): AgentDeferredQueueMessageInput {
  return {
    sessionId,
    userMessage: `消息 ${messageId}`,
    rawUserMessage: `消息 ${messageId}`,
    channelId: 'channel-1',
    queueMessageId: messageId,
  }
}

function createWebContents(): WebContents {
  return { isDestroyed: () => false } as unknown as WebContents
}

interface CapturedRun {
  sessionId: string
  queueMessageId: string
  runGeneration: number
  startedAt?: number
  userMessageUuid?: string
}

interface QueueHarness {
  coordinator: AgentQueueCoordinator
  startedStatuses: AgentQueuedMessageStatus[]
  runs: CapturedRun[]
  setActive: (active: boolean) => void
  setWebContents: (webContents: WebContents | null) => void
  setSendStartedError: (error: Error | null) => void
  resolveCurrentRun: () => void
}

function createHarness(): QueueHarness {
  const startedStatuses: AgentQueuedMessageStatus[] = []
  const runs: CapturedRun[] = []
  const state = {
    active: false,
    webContents: createWebContents() as WebContents | null,
    sendStartedError: null as Error | null,
  }
  let resolveRun: (() => void) | null = null
  let nextRunGeneration = 0
  const coordinator = new AgentQueueCoordinator({
    isActive: () => state.active,
    getWebContents: () => state.webContents,
    startRun: (input) => {
      state.active = true
      runs.push({
        sessionId: input.sessionId,
        queueMessageId: input.queueMessageId,
        runGeneration: input.runGeneration,
        ...(input.startedAt != null ? { startedAt: input.startedAt } : {}),
        ...(input.userMessageUuid != null ? { userMessageUuid: input.userMessageUuid } : {}),
      })
      return new Promise<void>((resolve) => {
        resolveRun = () => {
          // 真实系统中 run 收束时 orchestrator 已在 STREAM_COMPLETE 前释放活跃槽位。
          state.active = false
          resolve()
        }
      })
    },
    sendStarted: (_webContents, status) => {
      if (state.sendStartedError) throw state.sendStartedError
      startedStatuses.push(status)
    },
    reserveRunGeneration: () => ++nextRunGeneration,
  })
  return {
    coordinator,
    startedStatuses,
    runs,
    setActive: (active) => { state.active = active },
    setWebContents: (webContents) => { state.webContents = webContents },
    setSendStartedError: (error) => { state.sendStartedError = error },
    resolveCurrentRun: () => {
      const resolve = resolveRun
      resolveRun = null
      resolve?.()
    },
  }
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('AgentQueueCoordinator 运行代际生命周期', () => {
  test('空闲会话入队立即派发：started 投影与 startRun 携带同一 runGeneration', async () => {
    const h = createHarness()

    const disposition = h.coordinator.enqueue(makeMessage('s1', 'm1'))
    await flushAsync()

    expect(disposition).toBe('started')
    expect(h.startedStatuses).toHaveLength(1)
    expect(h.startedStatuses[0]).toMatchObject({ sessionId: 's1', messageId: 'm1', status: 'started' })
    expect(h.startedStatuses[0]?.runGeneration).toBe(1)
    expect(h.runs).toHaveLength(1)
    expect(h.runs[0]?.queueMessageId).toBe('m1')
    expect(h.runs[0]?.runGeneration).toBe(1)
    expect(h.runs[0]?.userMessageUuid).toBe('m1')
    expect(h.coordinator.hasPending('s1')).toBe(true)
  })

  test('startRun 完成后自动派发下一条排队消息（代际递增）', async () => {
    const h = createHarness()

    expect(h.coordinator.enqueue(makeMessage('s1', 'm1'))).toBe('started')
    expect(h.coordinator.enqueue(makeMessage('s1', 'm2'))).toBe('queued')
    await flushAsync()
    expect(h.startedStatuses).toHaveLength(1)

    h.resolveCurrentRun()
    await flushAsync()

    expect(h.startedStatuses).toHaveLength(2)
    expect(h.startedStatuses[1]?.messageId).toBe('m2')
    expect(h.startedStatuses[1]?.runGeneration).toBe(2)
    expect(h.runs[1]?.runGeneration).toBe(2)
  })

  test('活跃会话入队仅排队；空闲后的 onRunComplete 触发派发', async () => {
    const h = createHarness()
    h.setActive(true)

    expect(h.coordinator.enqueue(makeMessage('s1', 'm1'))).toBe('queued')
    expect(h.startedStatuses).toHaveLength(0)
    const snapshot = h.coordinator.snapshot('s1')
    expect(snapshot).toHaveLength(1)
    expect(snapshot[0]?.input.queueMessageId).toBe('m1')
    expect(typeof snapshot[0]?.queuedAt).toBe('number')

    h.setActive(false)
    h.coordinator.onRunComplete('s1', undefined, false, false)
    await flushAsync()

    expect(h.startedStatuses[0]?.messageId).toBe('m1')
  })

  test('sendStarted 抛错时保留消息，等待下一次唤醒重试', async () => {
    const h = createHarness()
    h.setSendStartedError(new Error('webContents destroyed'))

    expect(h.coordinator.enqueue(makeMessage('s1', 'm1'))).toBe('queued')
    await flushAsync()
    expect(h.startedStatuses).toHaveLength(0)
    expect(h.coordinator.snapshot('s1')).toHaveLength(1)

    h.setSendStartedError(null)
    h.coordinator.onTargetAvailable('s1')
    await flushAsync()

    expect(h.startedStatuses[0]?.messageId).toBe('m1')
  })

  test('webContents 不可用时保留消息，恢复后由 onTargetAvailable 派发', async () => {
    const h = createHarness()
    h.setWebContents(null)

    expect(h.coordinator.enqueue(makeMessage('s1', 'm1'))).toBe('queued')
    await flushAsync()
    expect(h.startedStatuses).toHaveLength(0)
    expect(h.coordinator.snapshot('s1')).toHaveLength(1)

    h.setWebContents(createWebContents())
    h.coordinator.onTargetAvailable('s1')
    await flushAsync()

    expect(h.startedStatuses[0]?.messageId).toBe('m1')
  })

  test('cancel 移除指定排队消息；重复取消返回 false', () => {
    const h = createHarness()
    h.setActive(true)

    h.coordinator.enqueue(makeMessage('s1', 'm1'))
    h.coordinator.enqueue(makeMessage('s1', 'm2'))

    expect(h.coordinator.cancel({ sessionId: 's1', messageId: 'm1' })).toBe(true)
    expect(h.coordinator.snapshot('s1').map((entry) => entry.input.queueMessageId)).toEqual(['m2'])
    expect(h.coordinator.cancel({ sessionId: 's1', messageId: 'm1' })).toBe(false)
  })

  test('move 调整排队顺序，空闲后按新顺序派发', async () => {
    const h = createHarness()
    h.setActive(true)

    h.coordinator.enqueue(makeMessage('s1', 'm1'))
    h.coordinator.enqueue(makeMessage('s1', 'm2'))

    expect(h.coordinator.move({ sessionId: 's1', sourceId: 'm2', targetId: 'm1', placement: 'before' })).toBe(true)
    expect(h.coordinator.snapshot('s1').map((entry) => entry.input.queueMessageId)).toEqual(['m2', 'm1'])

    h.setActive(false)
    h.coordinator.onRunComplete('s1', undefined, false, false)
    await flushAsync()

    expect(h.startedStatuses[0]?.messageId).toBe('m2')
  })

  test('后台任务待续或用户停止时 onRunComplete 不派发下一条', async () => {
    const h = createHarness()

    expect(h.coordinator.enqueue(makeMessage('s1', 'm1'))).toBe('started')
    expect(h.coordinator.enqueue(makeMessage('s1', 'm2'))).toBe('queued')
    await flushAsync()

    h.setActive(false)
    h.coordinator.onRunComplete('s1', 'm1', true, false)
    await flushAsync()
    expect(h.startedStatuses).toHaveLength(1)

    h.coordinator.onBackgroundTaskComplete('s1')
    await flushAsync()
    expect(h.startedStatuses[1]?.messageId).toBe('m2')
  })
})
