/**
 * 屏幕区域截图服务（微信式十字框选）。
 *
 * macOS：直接调用系统原生 `screencapture -i`，得到与微信/系统截图一致的十字框选体验，
 * 天然支持多显示器与 Retina 缩放，无需自建全屏 overlay 窗口。
 * 用户按 Esc 取消时不会生成文件 → 返回 { cancelled: true }。
 *
 * 其它平台暂返回 error（Windows/Linux 后续可用 desktopCapturer + 自建 overlay 实现）。
 */

import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFile, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'

export interface ScreenCaptureResult {
  /** 成功：裸 base64 PNG（不含 data: 前缀） */
  base64?: string
  /** 用户取消（Esc） */
  cancelled?: boolean
  /** 出错或不支持 */
  error?: string
}

/**
 * 交互式框选一块屏幕区域并返回其 PNG 的裸 base64。
 */
export async function captureScreenRegion(): Promise<ScreenCaptureResult> {
  if (process.platform !== 'darwin') {
    return { error: '屏幕区域截图目前仅支持 macOS' }
  }

  const tmpFile = join(tmpdir(), `proma-shot-${Date.now()}-${Math.random().toString(36).slice(2)}.png`)

  // -i 交互式框选；-x 不播放快门声；-t png 指定输出格式
  const exitCode = await new Promise<number>((resolve) => {
    try {
      const child = spawn('screencapture', ['-i', '-x', '-t', 'png', tmpFile])
      child.on('close', (code) => resolve(code ?? 0))
      child.on('error', () => resolve(-1))
    } catch {
      resolve(-1)
    }
  })

  if (exitCode === -1) {
    return { error: '无法调用系统截图工具 screencapture' }
  }

  // 用户 Esc 取消时 screencapture 仍以 0 退出，但不会生成文件
  if (!existsSync(tmpFile)) {
    return { cancelled: true }
  }

  try {
    const buf = await readFile(tmpFile)
    await unlink(tmpFile).catch(() => {})
    if (buf.length === 0) return { cancelled: true }
    return { base64: buf.toString('base64') }
  } catch (err) {
    await unlink(tmpFile).catch(() => {})
    return { error: err instanceof Error ? err.message : String(err) }
  }
}
