import { describe, expect, test } from 'bun:test'
import { isProcessViewportActive } from './ProcessBlockGroup'

describe('流式过程视口激活判定', () => {
  test('given 流式期间且未放大 when 判定视口 then 启用固定高度内部滚动', () => {
    expect(isProcessViewportActive({ keepProgressViewport: true, viewportExpanded: false })).toBe(true)
  })

  test('given 流式期间用户点开放大 when 判定视口 then 临时解除高度限制', () => {
    expect(isProcessViewportActive({ keepProgressViewport: true, viewportExpanded: true })).toBe(false)
  })

  test('given 流式结束（含历史态） when 判定视口 then 无论放大与否均不启用', () => {
    expect(isProcessViewportActive({ keepProgressViewport: false, viewportExpanded: false })).toBe(false)
    expect(isProcessViewportActive({ keepProgressViewport: false, viewportExpanded: true })).toBe(false)
  })
})
