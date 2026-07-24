/**
 * Compare Atoms — Agent 模式「跨 Provider 双开对比」状态
 *
 * Phase 2：多对分屏并存（内存态数组）。
 * 把两个独立 Agent session 在 UI 上配成一对并排分屏；
 * 联动开启时，一个 prompt 同时注入两个 session（各自用自己的 channel/model/runtime 独立跑）。
 *
 * 设计要点：不改消息存储、不改后端。两个 session 仍是完全独立的实体，
 这里只维护「配对关系 + 联动开关 + 分屏比例 + 广播信号」四类纯 UI 状态。
 *
 * v2 变更（2026-07-24）：comparePairAtom 从单值改为数组 comparePairsAtom，
 * 支持多对分屏并存。点任一 session 都恢复其所属分屏。
 */

import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import type { AgentQueuedAttachment } from '@/lib/agent-message-queue'

/**
 * 一组分屏配对。
 * left = 主 session（左栏，通常是发起配对的当前 session），
 * right = 对比 session（右栏）。
 * colorIndex = 创建时分配的颜色索引（单调递增，不随数组位置变化）。
 * 内存态，切换/重启不保留。
 */
export interface ComparePair {
  left: string
  right: string
  colorIndex: number
}

export const comparePairsAtom = atom<ComparePair[]>([])

/**
 * 从配对数组中找出包含某个 session 的配对。
 * 返回 { pair, role } 方便调用方知道当前 session 是 left 还是 right。
 */
export function findPairContaining(
  pairs: ComparePair[],
  sessionId: string,
): { pair: ComparePair; role: 'left' | 'right' } | null {
  for (const pair of pairs) {
    if (pair.left === sessionId) return { pair, role: 'left' }
    if (pair.right === sessionId) return { pair, role: 'right' }
  }
  return null
}

/**
 * 向配对数组添加一对。如果任一 session 已在其它配对中，先移除旧配对（一个 session 只能属于一对）。
 * 颜色索引单调递增：取现有最大 colorIndex + 1，确保新配对不会复用被移除配对的颜色。
 */
export function addPair(
  pairs: ComparePair[],
  left: string,
  right: string,
): ComparePair[] {
  const filtered = pairs.filter(
    (p) => p.left !== left && p.left !== right && p.right !== left && p.right !== right,
  )
  const maxColorIndex = filtered.reduce((max, p) => Math.max(max, p.colorIndex), -1)
  return [...filtered, { left, right, colorIndex: maxColorIndex + 1 }]
}

/**
 * 从配对数组移除包含某个 session 的配对。
 */
export function removePairContaining(
  pairs: ComparePair[],
  sessionId: string,
): ComparePair[] {
  return pairs.filter((p) => p.left !== sessionId && p.right !== sessionId)
}

/** 当前获得交互焦点的对比 pane；文件侧栏据此决定"添加到聊天"的目标 session。 */
export const compareFocusedSessionIdAtom = atom<string | null>(null)

/**
 * 联动开关：开启时任一侧发送都会把同一 prompt 与已准备附件路径广播到另一侧；
 * 关闭时两侧各聊各的（支撑「二选一」「第三模型收敛」等灵活玩法）。
 * 全局单值：同一时刻只有一组联动（当前活跃分屏的联动状态）。
 */
export const compareLinkedAtom = atom<boolean>(true)

/**
 * 分屏比例（左栏占比）。独立于 preview 分屏比例，避免互相干扰。
 * 持久化到 localStorage，范围在 MainArea 拖拽时 clamp 到 [0.3, 0.7]。
 */
export const compareSplitRatioAtom = atomWithStorage<number>('proma-compare-split-ratio', 0.5)

/**
 * 联动广播信号：primary 发送时写入目标 session、文本、nonce 与可选附件 payload，
 * partner 的 AgentView 监听到（targetSessionId === 自身 sessionId 且 nonce 未消费）
 * 后走自己的 handleSend 独立发送。
 * nonce 用于去重与触发；单槽位即可（人工发送不会并发）。
 */
export interface CompareAttachmentPayload {
  fileReferenceBlock: string
  attachments: AgentQueuedAttachment[]
  additionalDirectories: string[]
  /** 目标 session 中由本次同步创建、发送后应消费掉的附件草稿 ID。 */
  pendingFileIdsToConsume: string[]
}

export interface CompareBroadcast {
  targetSessionId: string
  text: string
  nonce: string
  attachmentPayload?: CompareAttachmentPayload
}

export const compareBroadcastAtom = atom<CompareBroadcast | null>(null)

/** 联动开启时成对创建的附件草稿 ID 映射；关闭联动时清空，之后两侧独立演化。 */
export interface ComparePendingFileLink {
  partnerSessionId: string
  partnerFileId: string
}

export const comparePendingFileLinksAtom = atom<Map<string, ComparePendingFileLink>>(new Map())

export function getComparePendingFileLinkKey(sessionId: string, fileId: string): string {
  return `${sessionId}:${fileId}`
}

/**
 * 待办·继承上下文：源会话正在跑时点「新建并继承」，先记下意图，
 * 等源会话这一轮结束后由源会话的 AgentView watcher 执行（fork / 注入）。
 * 单槽位即可（一次只安排一个）。
 */
export interface PendingInherit {
  sourceSessionId: string
  targetChannelId: string
  targetModelId: string
}

export const pendingInheritAtom = atom<PendingInherit | null>(null)

/**
 * 派生：某个 session 在配对数组中的 partner sessionId（不在任何配对中则为 null）。
 * 用工厂函数而非 atomFamily，避免为每个 sessionId 缓存 atom 实例。
 */
export function getComparePartner(
  pairs: ComparePair[],
  sessionId: string,
): string | null {
  const found = findPairContaining(pairs, sessionId)
  if (!found) return null
  return found.role === 'left' ? found.pair.right : found.pair.left
}

/**
 * 分屏配对颜色板。每对配对按数组顺序分配一种颜色，
 * 同一对的两个 session 颜色一致，不同对颜色不同。
 * 返回 tailwind 颜色名（不含 bg-/text- 前缀）。
 */
const COMPARE_COLOR_PALETTE = [
  'violet-500',
  'sky-500',
  'amber-500',
  'emerald-500',
  'rose-500',
  'indigo-500',
] as const

/**
 * 获取某个 session 所属配对的颜色索引和 tailwind 颜色名。
 * 颜色由 pair.colorIndex 决定（创建时分配，不会因数组重排而变化）。
 * 不在任何配对中返回 null。
 */
export function getCompareColor(
  pairs: ComparePair[],
  sessionId: string,
): { index: number; tw: string } | null {
  const found = findPairContaining(pairs, sessionId)
  if (!found) return null
  const colorIndex = found.pair.colorIndex
  return { index: colorIndex, tw: COMPARE_COLOR_PALETTE[colorIndex % COMPARE_COLOR_PALETTE.length]! }
}
