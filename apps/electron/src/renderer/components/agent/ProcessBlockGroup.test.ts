import { describe, expect, test } from 'bun:test'
import { isProcessViewportActive } from './ProcessBlockGroup'

describe('流式过程视口激活判定', () => {
  test('given 流式期间且设置未开启无限展开 when 判定视口 then 启用固定高度内部滚动', () => {
    expect(isProcessViewportActive({ keepProgressViewport: true, processViewExpanded: false })).toBe(true)
  })

  test('given 流式期间设置已开启无限展开 when 判定视口 then 不限制过程区高度', () => {
    expect(isProcessViewportActive({ keepProgressViewport: true, processViewExpanded: true })).toBe(false)
  })

  test('given 流式结束（含历史态） when 判定视口 then 无论设置与否均不启用', () => {
    expect(isProcessViewportActive({ keepProgressViewport: false, processViewExpanded: false })).toBe(false)
    expect(isProcessViewportActive({ keepProgressViewport: false, processViewExpanded: true })).toBe(false)
  })
})
