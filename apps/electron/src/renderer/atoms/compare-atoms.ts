/**
 * Compare Atoms — Agent 模式「跨 Provider 双开对比」状态
 *
 * Phase 1：临时配对（内存态，不持久化）。
 * 把两个独立 Agent session 在 UI 上配成一对并排分屏；
 * 联动开启时，一个 prompt 同时注入两个 session（各自用自己的 channel/model/runtime 独立跑）。
 *
 * 设计要点：不改消息存储、不改后端。两个 session 仍是完全独立的实体，
 * 这里只维护「配对关系 + 联动开关 + 分屏比例 + 广播信号」四类纯 UI 状态。
 */

import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'

/**
 * 当前配对（sessionId 对），null = 未进入分屏对比。
 * left = 主 session（左栏，通常是发起配对的当前 session），
 * right = 对比 session（右栏）。内存态，切换/重启不保留（Phase 2 再持久化）。
 */
export const comparePairAtom = atom<{ left: string; right: string } | null>(null)

/**
 * 联动开关：开启时任一侧发送都会把同一 prompt 广播到另一侧；
 * 关闭时两侧各聊各的（支撑「二选一」「第三模型收敛」等灵活玩法）。
 */
export const compareLinkedAtom = atom<boolean>(true)

/**
 * 分屏比例（左栏占比）。独立于 preview 分屏比例，避免互相干扰。
 * 持久化到 localStorage，范围在 MainArea 拖拽时 clamp 到 [0.3, 0.7]。
 */
export const compareSplitRatioAtom = atomWithStorage<number>('proma-compare-split-ratio', 0.5)

/**
 * 联动广播信号：primary 发送时写入 { targetSessionId: partner, text, nonce }，
 * partner 的 AgentView 监听到（targetSessionId === 自身 sessionId 且 nonce 未消费）
 * 后走自己的 handleSend(text, { fromBroadcast: true }) 独立发送。
 * nonce 用于去重与触发；单槽位即可（人工发送不会并发）。
 */
export interface CompareBroadcast {
  targetSessionId: string
  text: string
  nonce: string
}

export const compareBroadcastAtom = atom<CompareBroadcast | null>(null)

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
 * 派生：某个 session 在当前配对中的 partner sessionId（不在配对中则为 null）。
 * 用工厂函数而非 atomFamily，避免为每个 sessionId 缓存 atom 实例。
 */
export function getComparePartner(
  pair: { left: string; right: string } | null,
  sessionId: string,
): string | null {
  if (!pair) return null
  if (pair.left === sessionId) return pair.right
  if (pair.right === sessionId) return pair.left
  return null
}
