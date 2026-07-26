/**
 * BrowserView — 内嵌浏览器面板
 *
 * 使用 Electron <webview> 标签嵌入第三方网页或本地 HTML。
 * 支持地址栏导航、前进/后退/刷新、截图、DevTools、拖出分屏。
 *
 * 两种形态：
 * - BrowserView（variant='page'）：作为独立 Tab
 * - BrowserPane（variant='pane'）：作为 Agent 右侧分屏
 *
 * 截图走 webview 自身的 capturePage()——webview 是独立的 guest webContents，
 * 主窗口的 capturePage 截不到它的内容（会得到空白块）。
 *
 * 最后访问的 URL 持久化到 ~/.proma/browser-last-url.txt。
 */

import * as React from 'react'
import { useAtom, useAtomValue, useStore } from 'jotai'
import {
  ArrowLeft,
  ArrowRight,
  RotateCw,
  Globe,
  Camera,
  ExternalLink,
  Loader2,
  Home,
  PanelRight,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { browserUrlAtom, browserLoadedAtom } from '@/atoms/tab-atoms'
import { tearOffBrowserToSplit } from './browser-opener'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

// 默认主页
const HOME_URL = 'https://www.google.com'

interface BrowserCoreProps {
  variant: 'page' | 'pane'
  onClose?: () => void
}

function BrowserCore({ variant, onClose }: BrowserCoreProps): React.ReactElement {
  const [url, setUrl] = useAtom(browserUrlAtom)
  const loaded = useAtomValue(browserLoadedAtom)
  const store = useStore()

  const [inputUrl, setInputUrl] = React.useState('')
  const [canGoBack, setCanGoBack] = React.useState(false)
  const [canGoForward, setCanGoForward] = React.useState(false)
  const [isLoading, setIsLoading] = React.useState(false)
  const [pageTitle, setPageTitle] = React.useState('')

  // 用 state 而非 ref 持有 webview 节点：节点挂载后能正确触发 effect 重新绑定事件，
  // 避免 ref + 固定依赖数组导致的时序竞争和闭包陈旧
  const [webviewEl, setWebviewEl] = React.useState<Electron.WebviewTag | null>(null)

  // ref callback 必须用 useCallback 固定身份：否则每次 render 都是新函数，
  // React 会先以 null 再以 node 重复调用，造成 setState → render → setState 循环
  const handleWebviewRef = React.useCallback((node: HTMLElement | null): void => {
    setWebviewEl((node as Electron.WebviewTag | null) ?? null)
  }, [])

  const lastUrlRef = React.useRef<string>('')
  const isPane = variant === 'pane'

  // webview 的 src 只用挂载时的初始值——后续导航一律走 loadURL()，
  // 否则 React 重渲染时 src 变化会触发整页重载，丢失浏览历史
  const initialSrcRef = React.useRef<string | null>(null)
  if (initialSrcRef.current === null && loaded) {
    initialSrcRef.current = url || HOME_URL
    lastUrlRef.current = url || ''
  }

  // ===== webview 事件绑定（节点就绪后） =====
  React.useEffect(() => {
    if (!webviewEl) return

    const syncNavState = (): void => {
      try {
        setCanGoBack(webviewEl.canGoBack())
        setCanGoForward(webviewEl.canGoForward())
        const currentUrl = webviewEl.getURL()
        if (currentUrl && currentUrl !== lastUrlRef.current) {
          lastUrlRef.current = currentUrl
          setInputUrl(currentUrl)
          setUrl(currentUrl)
        }
      } catch {
        // webview 尚未 attach 时调用这些方法会抛，忽略即可
      }
    }

    const handleLoadStart = (): void => setIsLoading(true)
    const handleLoadStop = (): void => {
      setIsLoading(false)
      syncNavState()
      try {
        setPageTitle(webviewEl.getTitle() || '')
      } catch { /* noop */ }
    }
    // did-navigate-in-page 覆盖 SPA 的 pushState 路由跳转——
    // 这类跳转不触发 did-stop-loading，只监听后者会导致地址栏停留在旧 URL
    const handleNavigate = (): void => syncNavState()
    const handleTitleSet = (e: Electron.PageTitleUpdatedEvent): void => setPageTitle(e.title)
    const handleDomReady = (): void => syncNavState()

    webviewEl.addEventListener('dom-ready', handleDomReady)
    webviewEl.addEventListener('did-start-loading', handleLoadStart)
    webviewEl.addEventListener('did-stop-loading', handleLoadStop)
    webviewEl.addEventListener('did-navigate', handleNavigate)
    webviewEl.addEventListener('did-navigate-in-page', handleNavigate)
    webviewEl.addEventListener('page-title-updated', handleTitleSet)

    return () => {
      webviewEl.removeEventListener('dom-ready', handleDomReady)
      webviewEl.removeEventListener('did-start-loading', handleLoadStart)
      webviewEl.removeEventListener('did-stop-loading', handleLoadStop)
      webviewEl.removeEventListener('did-navigate', handleNavigate)
      webviewEl.removeEventListener('did-navigate-in-page', handleNavigate)
      webviewEl.removeEventListener('page-title-updated', handleTitleSet)
    }
  }, [webviewEl, setUrl])

  // ===== 外部改动 url atom（非本组件导航产生）时同步到 webview =====
  React.useEffect(() => {
    if (!webviewEl || !url) return
    if (url === lastUrlRef.current) return
    lastUrlRef.current = url
    setInputUrl(url)
    try {
      if (webviewEl.getURL() !== url) webviewEl.loadURL(url)
    } catch { /* webview 未就绪，src 已带初始值，无需处理 */ }
  }, [url, webviewEl])

  // ===== 导航操作 =====
  const navigate = React.useCallback((target: string): void => {
    let normalized = target.trim()
    if (!normalized) return

    if (!/^[a-z]+:\/\//i.test(normalized)) {
      // 像域名（含点、无空格）就补 https，否则当搜索词
      if (/^[\w-]+(\.[\w-]+)+/.test(normalized) && !normalized.includes(' ')) {
        normalized = 'https://' + normalized
      } else {
        normalized = 'https://www.google.com/search?q=' + encodeURIComponent(normalized)
      }
    }

    if (webviewEl) {
      webviewEl.loadURL(normalized)
    } else {
      setUrl(normalized)
    }
  }, [webviewEl, setUrl])

  const handleGoBack = React.useCallback((): void => { webviewEl?.goBack() }, [webviewEl])
  const handleGoForward = React.useCallback((): void => { webviewEl?.goForward() }, [webviewEl])
  const handleReload = React.useCallback((): void => { webviewEl?.reload() }, [webviewEl])
  const handleGoHome = React.useCallback((): void => { navigate(HOME_URL) }, [navigate])

  const handleOpenExternal = React.useCallback((): void => {
    const current = (() => {
      try { return webviewEl?.getURL() || url } catch { return url }
    })()
    if (current) window.open(current, '_blank')
  }, [webviewEl, url])

  const handleUrlKeyDown = React.useCallback((e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      navigate(inputUrl)
      ;(e.target as HTMLInputElement).blur()
    }
    if (e.key === 'Escape') {
      try { setInputUrl(webviewEl?.getURL() || url) } catch { setInputUrl(url) }
      ;(e.target as HTMLInputElement).blur()
    }
  }, [inputUrl, navigate, url, webviewEl])

  // ===== 截图 =====
  // 必须用 webview 自己的 capturePage：webview 是独立 guest webContents，
  // 主窗口 webContents.capturePage() 在 webview 区域只会得到空白
  // 父容器引用：截图时需要读取实际渲染尺寸
  const viewportRef = React.useRef<HTMLDivElement>(null)

  const handleScreenshot = React.useCallback(async (): Promise<void> => {
    if (!webviewEl) return
    try {
      // capturePage(rect) 截取 guest webContents 的指定区域（CSS 像素）。
      // 不带 rect 时截的是整个页面内容（对 Google 首页只有 ~300px），
      // 带 rect 才能截到 webview 可视区域的完整高度。
      const vp = viewportRef.current
      const rect = vp
        ? { x: 0, y: 0, width: vp.clientWidth, height: vp.clientHeight }
        : undefined
      const image = await webviewEl.capturePage(rect)
      const dataUrl = image.toDataURL()
      if (!dataUrl || dataUrl.length < 100) {
        toast.error('截图为空，页面可能尚未渲染完成')
        return
      }
      const savedPath = await window.electronAPI.saveBrowserScreenshot(dataUrl)
      if (savedPath) {
        toast.success('截图已复制到剪贴板', {
          description: `已保存：${savedPath}`,
          action: {
            label: '复制路径',
            onClick: () => navigator.clipboard.writeText(savedPath),
          },
        })
      } else {
        toast.error('截图失败')
      }
    } catch (err) {
      console.error('[Browser] 截图失败:', err)
      toast.error('截图失败')
    }
  }, [webviewEl])

  const handleTearOff = React.useCallback((): void => {
    const ok = tearOffBrowserToSplit(store)
    if (ok === false) toast.error('需要先打开一个 Agent 会话')
  }, [store])

  // ===== 右键：DevTools =====
  const handleContextMenu = React.useCallback((e: React.MouseEvent): void => {
    e.preventDefault()
    if (!webviewEl) return
    try {
      if (webviewEl.isDevToolsOpened()) webviewEl.closeDevTools()
      else webviewEl.openDevTools()
    } catch { /* noop */ }
  }, [webviewEl])

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-content-area titlebar-no-drag">
      {/* 工具栏 */}
      <div className="flex h-[38px] flex-shrink-0 items-center gap-0.5 border-b border-border/30 px-2">
        <ToolbarButton label="后退" onClick={handleGoBack} disabled={!canGoBack} icon={<ArrowLeft className="size-3.5" />} />
        <ToolbarButton label="前进" onClick={handleGoForward} disabled={!canGoForward} icon={<ArrowRight className="size-3.5" />} />
        <ToolbarButton label="刷新" onClick={handleReload} icon={<RotateCw className={cn('size-3.5', isLoading && 'animate-spin')} />} />
        {!isPane && <ToolbarButton label="主页" onClick={handleGoHome} icon={<Home className="size-3.5" />} />}

        {/* 地址栏 */}
        <div className="mx-1.5 flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-border/40 bg-muted/30 px-2.5 py-1">
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

        <ToolbarButton label="截图（复制到剪贴板并存盘）" onClick={handleScreenshot} icon={<Camera className="size-3.5" />} />
        {!isPane && (
          <ToolbarButton label="拖到 Agent 右侧分屏" onClick={handleTearOff} icon={<PanelRight className="size-3.5" />} />
        )}
        <ToolbarButton label="在外部浏览器打开" onClick={handleOpenExternal} icon={<ExternalLink className="size-3.5" />} />
        {isPane && onClose && (
          <ToolbarButton label="关闭分屏" onClick={onClose} icon={<X className="size-3.5" />} />
        )}
      </div>

      {/* webview 容器 */}
      {/* 用 absolute inset-0 而非 h-full：Electron webview 在 flexbox + height:100% 下有
          高度感知 bug，guest 内容只渲染头部一截 */}
      <div ref={viewportRef} className="relative min-h-0 flex-1 overflow-hidden" onContextMenu={handleContextMenu}>
        {!loaded || initialSrcRef.current === null ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground/40">
            <Loader2 className="mr-2 size-4 animate-spin" />
            加载中…
          </div>
        ) : (
          <webview
            ref={handleWebviewRef}
            src={initialSrcRef.current}
            className="absolute inset-0 h-full w-full border-none"
            allowpopups={true}
            webpreferences="contextIsolation=yes, nodeIntegration=no"
          />
        )}
      </div>

      {/* 状态栏 */}
      {pageTitle && !isPane && (
        <div className="flex h-[22px] flex-shrink-0 items-center border-t border-border/20 px-3 text-[11px] text-muted-foreground/60">
          <span className="truncate">{pageTitle}</span>
        </div>
      )}
    </div>
  )
}

export function BrowserView(): React.ReactElement {
  return <BrowserCore variant="page" />
}

interface BrowserPaneProps {
  onClose: () => void
}

export function BrowserPane({ onClose }: BrowserPaneProps): React.ReactElement {
  return <BrowserCore variant="pane" onClose={onClose} />
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
            'flex size-7 flex-shrink-0 items-center justify-center rounded text-muted-foreground transition-colors',
            disabled ? 'cursor-not-allowed opacity-30' : 'hover:bg-muted/50 hover:text-foreground',
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
