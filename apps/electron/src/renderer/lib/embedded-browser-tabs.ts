import type { BrowserViewState } from '@proma/shared'

/** 右侧工作区中某个浏览器标签的属主会话。 */
export interface EmbeddedBrowserTabOwner {
  ownerSessionId: string
  /** 嵌入会话的工作区标签前缀；主会话传空字符串表示不加前缀。 */
  ownerLabel: string
  state: BrowserViewState
}

/** 扁平化后的工作区浏览器标签；tabId 为全局唯一 UUID，可直接编码进 AgentSidePanelTab。 */
export interface EmbeddedBrowserTabInfo {
  tabId: string
  ownerSessionId: string
  ownerLabel: string
  title: string
  favicon?: string
  /** 属主会话存在 Agent 浏览器活动，且该标签是其当前活动标签、又不是当前选中的工作区标签。 */
  activity: boolean
}

export interface EmbeddedBrowserTabIndex {
  tabs: EmbeddedBrowserTabInfo[]
  /** 按 tabId 找到标签属主（含其完整浏览器状态）；未知 tabId 返回 null。 */
  resolveOwner: (tabId: string) => EmbeddedBrowserTabOwner | null
}

function hasAgentBrowserActivity(state: BrowserViewState): boolean {
  return Boolean(state.activity && state.executionSource !== 'user')
}

/**
 * 汇总主会话与嵌入会话（并排 / 探索分支 / 委派子会话）的浏览器标签。
 *
 * 这些会话共享同一个右侧工作区，但浏览器状态各自独立；不聚合时，嵌入会话的
 * 浏览器操作会成功执行却没有任何可见入口（状态只存在于自己的 sessionId 下）。
 * 浏览器 tabId 由主进程以 UUID 生成，跨会话唯一，因此可与主会话标签共用
 * `getBrowserSidePanelTab` 编码而不冲突。
 */
export function buildEmbeddedBrowserTabIndex(
  owners: EmbeddedBrowserTabOwner[],
  activeTabId: string | null,
): EmbeddedBrowserTabIndex {
  const tabs: EmbeddedBrowserTabInfo[] = []
  for (const owner of owners) {
    const ownerActive = hasAgentBrowserActivity(owner.state)
    for (const tab of owner.state.tabs) {
      tabs.push({
        tabId: tab.tabId,
        ownerSessionId: owner.ownerSessionId,
        ownerLabel: owner.ownerLabel,
        title: tab.title || '新建标签页',
        ...(tab.favicon ? { favicon: tab.favicon } : {}),
        activity: ownerActive && activeTabId !== tab.tabId && owner.state.activeTabId === tab.tabId,
      })
    }
  }
  return {
    tabs,
    resolveOwner(tabId: string): EmbeddedBrowserTabOwner | null {
      for (const owner of owners) {
        if (owner.state.tabs.some((tab) => tab.tabId === tabId)) return owner
      }
      return null
    },
  }
}
