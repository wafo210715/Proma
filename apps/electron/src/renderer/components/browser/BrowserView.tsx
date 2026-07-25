/**
 * BrowserView — 内嵌浏览器面板
 *
 * 使用 Electron <webview> 标签嵌入第三方网页或本地 HTML。
 * 支持地址栏导航、前进/后退/刷新、截图到剪贴板、DevTools、打开外部浏览器。
 *
 * 最后访问的 URL 持久化到 ~/.proma/browser-last-url.txt。
 */

import * as React from 'react'
import { useAtom, useAtomValue } from 'jotai'
import {
  ArrowLeft,
  ArrowRight,
  RotateCw,
  Globe,
  Camera,
  ExternalLink,
  Loader2,
  Home,
} from 'lucide-react'
import { toast } from 'sonner'
import { browserUrlAtom, browserLoadedAtom } from '@/atoms/tab-atoms'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

// 默认主页
const HOME_URL = 'https://www.google.com'

export function BrowserView(): React.ReactElement {
  const [url, setUrl] = useAtom(browserUrlAtom)
  const loaded = useAtomValue(browserLoadedAtom)

  const [inputUrl, setInputUrl] = React.useState('')
  const [canGoBack, setCanGoBack] = React.useState(false)
  const [canGoForward, setCanGoForward] = React.useState(false)
  const [isLoading, setIsLoading] = React.useState(false)
  const [pageTitle, setPageTitle] = React.useState('')

  const webviewRef = React.useRef<Electron.WebviewTag | null>(null)
  const containerRef = React.useRef<HTMLDivElement>(null)
  const lastSavedUrlRef = React.useRef<string>('')
  const saveTimerRef = React.useRef<ReturnType<typeof setTimeout>>()

  // ===== 同步 inputUrl ← url（仅外部变化时） =====
  React.useEffect(() => {
    if (!loaded) return
    if (url !== lastSavedUrlRef.current) {
      setInputUrl(url)
      lastSavedUrlRef.current = url
      // 如果 webview 存在且 URL 不同，导航到新 URL
      const wv = webviewRef.current
      if (wv && url && wv.getURL() !== url) {
        wv.loadURL(url)
      }
    }
  }, [url, loaded])

  // ===== webview 事件绑定 =====
  React.useEffect(() => {
    if (!loaded) return
    const wv = webviewRef.current
    if (!wv) return

    const handleNavStateChange = (): void => {
      setCanGoBack(wv.canGoBack())
      setCanGoForward(wv.canGoForward())
      const currentUrl = wv.getURL()
      setInputUrl(currentUrl)
      // 更新持久化的 URL（防抖保存）
      if (currentUrl && currentUrl !== lastSavedUrlRef.current) {
        lastSavedUrlRef.current = currentUrl
        setUrl(currentUrl)
      }
    }

    const handleLoadStart = (): void => setIsLoading(true)
    const handleLoadStop = (): void => {
      setIsLoading(false)
      handleNavStateChange()
      setPageTitle(wv.getTitle() || '')
    }
    const handleTitleSet = (e: Electron.PageTitleUpdatedEvent): void => {
      setPageTitle(e.title)
    }

    wv.addEventListener('did-start-loading', handleLoadStart)
    wv.addEventListener('did-stop-loading', handleLoadStop)
    wv.addEventListener('page-title-updated', handleTitleSet)

    return () => {
      wv.removeEventListener('did-start-loading', handleLoadStart)
      wv.removeEventListener('did-stop-loading', handleLoadStop)
      wv.removeEventListener('page-title-updated', handleTitleSet)
    }
  }, [loaded, setUrl])

  // ===== 防抖保存 URL =====
  React.useEffect(() => {
    if (!loaded) return
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      if (window.electronAPI.saveBrowserUrl) {
        window.electronAPI.saveBrowserUrl(url).catch(console.error)
      }
    }, 500)
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [url, loaded])

  // ===== beforeunload 同步保存 =====
  React.useEffect(() => {
    const handleBeforeUnload = (): void => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      if (window.electronAPI.saveBrowserUrlSync) {
        window.electronAPI.saveBrowserUrlSync(lastSavedUrlRef.current)
      }
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [])

  // ===== 导航操作 =====
  const navigate = React.useCallback((target: string): void => {
    let normalized = target.trim()
    if (!normalized) return

    // 如果不是协议开头，尝试作为搜索或补全
    if (!/^[a-z]+:\/\//i.test(normalized) && !normalized.startsWith('file://')) {
      // 判断是否像 URL（包含 . 且没有空格）
      if (/^[\w-]+(\.[\w-]+)+/.test(normalized) && !normalized.includes(' ')) {
        normalized = 'https://' + normalized
      } else {
        // 当作搜索词
        normalized = 'https://www.google.com/search?q=' + encodeURIComponent(normalized)
      }
    }

    const wv = webviewRef.current
    if (wv) {
      wv.loadURL(normalized)
    } else {
      // webview 尚未挂载，更新 url atom 触发加载
      setUrl(normalized)
    }
  }, [setUrl])

  const handleGoBack = React.useCallback((): void => {
    webviewRef.current?.goBack()
  }, [])

  const handleGoForward = React.useCallback((): void => {
    webviewRef.current?.goForward()
  }, [])

  const handleReload = React.useCallback((): void => {
    webviewRef.current?.reload()
  }, [])

  const handleGoHome = React.useCallback((): void => {
    navigate(HOME_URL)
  }, [navigate])

  const handleOpenExternal = React.useCallback((): void => {
    const current = webviewRef.current?.getURL() || url
    if (current) {
      window.open(current, '_blank')
    }
  }, [url])

  const handleUrlKeyDown = React.useCallback((e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      navigate(inputUrl)
      ;(e.target as HTMLInputElement).blur()
    }
    if (e.key === 'Escape') {
      setInputUrl(webviewRef.current?.getURL() || url)
      ;(e.target as HTMLInputElement).blur()
    }
  }, [inputUrl, navigate, url])

  // ===== 截图 =====
  const handleScreenshot = React.useCallback(async (): Promise<void> => {
    if (!containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    // 截取 webview 区域（减去工具栏高度 38px）
    const webviewRect = {
      x: rect.left,
      y: rect.top + 38,
      width: rect.width,
      height: rect.height - 38,
    }
    try {
      const dataUrl = window.electronAPI.captureBrowserRegion
        ? await window.electronAPI.captureBrowserRegion(webviewRect)
        : null
      if (dataUrl) {
        toast.success('截图已复制到剪贴板')
      } else {
        toast.error('截图失败')
      }
    } catch (err) {
      console.error('[Browser] 截图失败:', err)
      toast.error('截图失败')
    }
  }, [])

  // ===== 右键菜单：DevTools =====
  const handleContextMenu = React.useCallback((e: React.MouseEvent): void => {
    e.preventDefault()
    const wv = webviewRef.current
    if (!wv) return
    // 简单实现：直接切换 DevTools
    // TODO: 未来可以用 Electron Menu API 做更完整的右键菜单
    const isDevOpen = wv.isDevToolsOpened?.() ?? false
    if (isDevOpen) {
      wv.closeDevTools()
    } else {
      wv.openDevTools()
    }
  }, [])

  // ===== webview ref callback =====
  const setWebviewRef = React.useCallback((node: Electron.WebviewTag | null): void => {
    if (node) {
      webviewRef.current = node
      // 如果已有保存的 URL，加载它
      const currentUrl = url || lastSavedUrlRef.current
      if (currentUrl && node.getURL() !== currentUrl) {
        // 给 webview 一点时间挂载
        setTimeout(() => {
          if (webviewRef.current && webviewRef.current.getURL() !== currentUrl) {
            webviewRef.current.loadURL(currentUrl)
          }
        }, 100)
      }
    } else {
      webviewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded])

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-content-area">
      {/* 工具栏 */}
      <div className="flex h-[38px] flex-shrink-0 items-center gap-0.5 border-b border-border/30 px-2">
        <ToolbarButton label="后退" onClick={handleGoBack} disabled={!canGoBack} icon={<ArrowLeft className="size-3.5" />} />
        <ToolbarButton label="前进" onClick={handleGoForward} disabled={!canGoForward} icon={<ArrowRight className="size-3.5" />} />
        <ToolbarButton label="刷新" onClick={handleReload} icon={<RotateCw className={cn('size-3.5', isLoading && 'animate-spin')} />} />
        <ToolbarButton label="主页" onClick={handleGoHome} icon={<Home className="size-3.5" />} />

        {/* 地址栏 */}
        <div className="mx-1.5 flex flex-1 items-center gap-1.5 rounded-md border border-border/40 bg-muted/30 px-2.5 py-1">
          <Globe className="size-3 flex-shrink-0 text-muted-foreground/60" />
          <input
            type="text"
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            onKeyDown={handleUrlKeyDown}
            onFocus={(e) => e.target.select()}
            placeholder="输入网址或搜索…"
            className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground/50"
            spellCheck={false}
          />
          {isLoading && <Loader2 className="size-3 flex-shrink-0 animate-spin text-muted-foreground/60" />}
        </div>

        <ToolbarButton label="截图到剪贴板" onClick={handleScreenshot} icon={<Camera className="size-3.5" />} />
        <ToolbarButton label="在外部浏览器打开" onClick={handleOpenExternal} icon={<ExternalLink className="size-3.5" />} />
      </div>

      {/* webview 容器 */}
      <div
        ref={containerRef}
        className="relative min-h-0 flex-1 overflow-hidden"
        onContextMenu={handleContextMenu}
      >
        {!loaded ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground/40">
            <Loader2 className="mr-2 size-4 animate-spin" />
            加载中…
          </div>
        ) : (
          <webview
            ref={setWebviewRef}
            src={url || HOME_URL}
            className="h-full w-full"
            allowpopups={true}
            webpreferences="contextIsolation=yes, nodeIntegration=no"
          />
        )}
      </div>

      {/* 状态栏：页面标题 */}
      {pageTitle && (
        <div className="flex h-[22px] flex-shrink-0 items-center border-t border-border/20 px-3 text-[11px] text-muted-foreground/60">
          <span className="truncate">{pageTitle}</span>
        </div>
      )}
    </div>
  )
}

interface ToolbarButtonProps {
  label: string
  onClick: () => void
  icon: React.ReactNode
  disabled?: boolean
}

function ToolbarButton({ label, onClick, icon, disabled }: ToolbarButtonProps): React.ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          disabled={disabled}
          className={cn(
            'flex size-7 items-center justify-center rounded text-muted-foreground transition-colors',
            disabled
              ? 'cursor-not-allowed opacity-30'
              : 'hover:bg-muted/50 hover:text-foreground',
          )}
          aria-label={label}
        >
          {icon}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <p>{label}</p>
      </TooltipContent>
    </Tooltip>
  )
}
