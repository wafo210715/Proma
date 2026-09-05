import { describe, expect, test } from 'bun:test'
import type { BrowserTabSummary, BrowserTraceItem, BrowserViewState } from '@proma/shared'
import { buildEmbeddedBrowserTabIndex, type EmbeddedBrowserTabOwner } from './embedded-browser-tabs'

function makeTab(tabId: string, title: string, favicon?: string): BrowserTabSummary {
  return {
    tabId,
    url: `https://example.test/${tabId}`,
    title,
    ...(favicon ? { favicon } : {}),
    loading: false,
    openedByAgent: false,
    openedByPopup: false,
  }
}

function makeActivity(tabId: string, id = 'activity-1'): BrowserTraceItem {
  return {
    id,
    action: 'navigate',
    summary: '已打开 example.test',
    at: 1,
    success: true,
    status: 'verified',
    tabId,
    domain: 'example.test',
    executionSource: 'delegation',
  }
}

function makeState(
  sessionId: string,
  overrides: Partial<BrowserViewState> = {},
): BrowserViewState {
  return {
    sessionId,
    executionSource: 'user',
    activeTabId: 'main-t1',
    agentTabId: 'main-t1',
    tabs: [makeTab('main-t1', '主会话页面'), makeTab('main-t2', '')],
    url: 'https://example.test/main-t1',
    title: '主会话页面',
    loading: false,
    visible: true,
    canGoBack: false,
    canGoForward: false,
    trace: [],
    activity: null,
    ...overrides,
  }
}

describe('buildEmbeddedBrowserTabIndex', () => {
  test('主会话与嵌入会话标签并列展开，空标题回退「新建标签页」', () => {
    const index = buildEmbeddedBrowserTabIndex([
      { ownerSessionId: 'session-a', ownerLabel: '', state: makeState('session-a') },
      {
        ownerSessionId: 'session-b',
        ownerLabel: '并排会话 B',
        state: makeState('session-b', { tabs: [makeTab('side-t1', 'B 的页面')] }),
      },
    ], null)

    expect(index.tabs.map((tab) => tab.tabId)).toEqual(['main-t1', 'main-t2', 'side-t1'])
    expect(index.tabs.map((tab) => tab.title)).toEqual(['主会话页面', '新建标签页', 'B 的页面'])
    expect(index.tabs[2]?.ownerSessionId).toBe('session-b')
    expect(index.tabs[2]?.ownerLabel).toBe('并排会话 B')
  })

  test('resolveOwner 命中标签属主并携带完整状态；未知 tabId 返回 null', () => {
    const sideState = makeState('session-b', { tabs: [makeTab('side-t1', 'B 的页面', 'https://example.test/icon.png')] })
    const primaryOwner: EmbeddedBrowserTabOwner = { ownerSessionId: 'session-a', ownerLabel: '', state: makeState('session-a') }
    const sideOwner: EmbeddedBrowserTabOwner = { ownerSessionId: 'session-b', ownerLabel: '并排会话 B', state: sideState }

    const index = buildEmbeddedBrowserTabIndex([primaryOwner, sideOwner], null)

    expect(index.resolveOwner('main-t1')).toBe(primaryOwner)
    expect(index.resolveOwner('side-t1')).toBe(sideOwner)
    expect(index.resolveOwner('side-t1')?.state).toBe(sideState)
    expect(index.resolveOwner('not-exist')).toBeNull()
  })

  test('activity 仅标记 Agent 活动属主的当前活动标签，且不标记当前选中标签', () => {
    const activeOwner: EmbeddedBrowserTabOwner = {
      ownerSessionId: 'session-b',
      ownerLabel: '并排会话 B',
      state: makeState('session-b', {
        executionSource: 'delegation',
        activeTabId: 'side-t1',
        agentTabId: 'side-t1',
        activity: makeActivity('side-t1'),
        tabs: [makeTab('side-t1', '活动页'), makeTab('side-t2', '后台页')],
      }),
    }

    // 当前选中的就是活动标签：不标记（避免自我高亮）。
    const selected = buildEmbeddedBrowserTabIndex([activeOwner], 'side-t1')
    expect(selected.tabs.find((tab) => tab.tabId === 'side-t1')?.activity).toBe(false)
    expect(selected.tabs.find((tab) => tab.tabId === 'side-t2')?.activity).toBe(false)

    // 当前选中其他标签：活动标签标记为活动。
    const elsewhere = buildEmbeddedBrowserTabIndex([activeOwner], 'main-t1')
    expect(elsewhere.tabs.find((tab) => tab.tabId === 'side-t1')?.activity).toBe(true)
    expect(elsewhere.tabs.find((tab) => tab.tabId === 'side-t2')?.activity).toBe(false)

    // 用户手动打开的浏览器（executionSource=user）不标记活动。
    const userDriven = buildEmbeddedBrowserTabIndex([{
      ownerSessionId: 'session-b',
      ownerLabel: 'B',
      state: makeState('session-b', {
        activeTabId: 'side-t1',
        agentTabId: 'side-t1',
        activity: makeActivity('side-t1'),
        tabs: [makeTab('side-t1', '用户页')],
      }),
    }], null)
    expect(userDriven.tabs.find((tab) => tab.tabId === 'side-t1')?.activity).toBe(false)
  })

  test('favicon 缺省时字段整体省略，存在时透传', () => {
    const index = buildEmbeddedBrowserTabIndex([{
      ownerSessionId: 'session-a',
      ownerLabel: '',
      state: makeState('session-a', {
        tabs: [makeTab('t-plain', '无图标'), makeTab('t-icon', '有图标', 'https://example.test/icon.png')],
      }),
    }], null)

    expect(index.tabs.find((tab) => tab.tabId === 't-plain')?.favicon).toBeUndefined()
    expect(index.tabs.find((tab) => tab.tabId === 't-icon')?.favicon).toBe('https://example.test/icon.png')
  })
})
