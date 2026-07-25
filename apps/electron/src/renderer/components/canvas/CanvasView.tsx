/**
 * CanvasView — JSON Canvas 自由画布
 *
 * 采用 JSON Canvas 开源格式（github.com/obsidianmd/jsoncanvas），与 Obsidian Canvas 互通。
 * 内容持久化到 ~/.proma/canvas.canvas，自动保存由 CanvasPersistence 统一管理。
 *
 * 设计原则：坐标对 agent 无意义 —— agent 只写逻辑字段（id/text/fromNode/toNode），
 * 坐标由 autoLayout 力导向初始布局后固定，用户可自由拖拽/缩放/改尺寸，不回弹。
 *
 * 支持：自由拖拽、resize、双击编辑节点文本、双击编辑连线标签、平移缩放、
 *      color 预设（"1"-"6"）、text halo 连线标签（无底色）、截图当前视口到剪贴板。
 */

import * as React from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { Camera, LayoutGrid, Crosshair } from 'lucide-react'
import { toast } from 'sonner'
import { canvasContentAtom, canvasLoadedAtom } from '@/atoms/tab-atoms'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

// ===== 类型 =====

interface CanvasNode {
  id: string
  type: string
  x: number
  y: number
  width: number
  height: number
  text: string
  color?: string
}

interface CanvasEdge {
  id: string
  fromNode: string
  toNode: string
  label?: string
  color?: string
  fromSide?: string
  toSide?: string
}

interface ViewState {
  scale: number
  offsetX: number
  offsetY: number
}

/** JSON Canvas color 预设映射（Obsidian 兼容） */
const COLOR_PRESETS: Record<string, { bg: string; border: string; text: string }> = {
  '1': { bg: '#fa5252', border: '#e03131', text: '#fff' },
  '2': { bg: '#fd7e14', border: '#e8590c', text: '#fff' },
  '3': { bg: '#fab005', border: '#f08c00', text: '#1a1a1a' },
  '4': { bg: '#40c057', border: '#2f9e44', text: '#fff' },
  '5': { bg: '#15aabf', border: '#1098ad', text: '#fff' },
  '6': { bg: '#7950f2', border: '#6741d9', text: '#fff' },
}

const DEFAULT_WIDTH = 250
const DEFAULT_HEIGHT = 120

// ===== 解析 / 序列化 =====

function parseCanvas(json: string): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  if (!json.trim()) return { nodes: [], edges: [] }
  const data = JSON.parse(json)
  const nodes: CanvasNode[] = (data.nodes || []).map((n: Record<string, unknown>) => ({
    id: String(n.id),
    type: (n.type as string) || 'text',
    x: typeof n.x === 'number' ? n.x : 0,
    y: typeof n.y === 'number' ? n.y : 0,
    width: typeof n.width === 'number' ? n.width : DEFAULT_WIDTH,
    height: typeof n.height === 'number' ? n.height : DEFAULT_HEIGHT,
    text: (n.text as string) || (n.label as string) || '',
    color: (n.color as string) || undefined,
  }))
  const edges: CanvasEdge[] = (data.edges || []).map((e: Record<string, unknown>) => ({
    id: String(e.id),
    fromNode: String(e.fromNode),
    toNode: String(e.toNode),
    label: (e.label as string) || undefined,
    color: (e.color as string) || undefined,
    fromSide: (e.fromSide as string) || undefined,
    toSide: (e.toSide as string) || undefined,
  }))
  return { nodes, edges }
}

function serializeCanvas(nodes: CanvasNode[], edges: CanvasEdge[]): string {
  const data = {
    nodes: nodes.map((n) => {
      const o: Record<string, unknown> = {
        id: n.id,
        type: n.type || 'text',
        x: Math.round(n.x),
        y: Math.round(n.y),
        width: Math.round(n.width),
        height: Math.round(n.height),
        text: n.text,
      }
      if (n.color) o.color = n.color
      return o
    }),
    edges: edges.map((e) => {
      const o: Record<string, unknown> = { id: e.id, fromNode: e.fromNode, toNode: e.toNode }
      if (e.label) o.label = e.label
      if (e.color) o.color = e.color
      if (e.fromSide) o.fromSide = e.fromSide
      if (e.toSide) o.toSide = e.toSide
      return o
    }),
  }
  return JSON.stringify(data, null, 2)
}

// ===== 力导向初始布局（一次性，之后固定） =====

function runForceLayout(nodes: CanvasNode[], edges: CanvasEdge[]): void {
  if (nodes.length === 0) return
  const k = 280
  nodes.forEach((n, i) => {
    if (n.x === 0 && n.y === 0) {
      const cols = Math.ceil(Math.sqrt(nodes.length))
      n.x = (i % cols) * (DEFAULT_WIDTH + 80) + 50
      n.y = Math.floor(i / cols) * (DEFAULT_HEIGHT + 60) + 50
    }
  })
  const iters = 100
  for (let it = 0; it < iters; it++) {
    const fx = nodes.map(() => 0)
    const fy = nodes.map(() => 0)
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dx = nodes[i]!.x - nodes[j]!.x
        const dy = nodes[i]!.y - nodes[j]!.y
        const d = Math.sqrt(dx * dx + dy * dy) || 1
        const f = (k * k) / d
        fx[i]! += (dx / d) * f
        fy[i]! += (dy / d) * f
        fx[j]! -= (dx / d) * f
        fy[j]! -= (dy / d) * f
      }
    }
    for (const e of edges) {
      const i = nodes.findIndex((n) => n.id === e.fromNode)
      const j = nodes.findIndex((n) => n.id === e.toNode)
      if (i < 0 || j < 0) continue
      const dx = nodes[i]!.x - nodes[j]!.x
      const dy = nodes[i]!.y - nodes[j]!.y
      const d = Math.sqrt(dx * dx + dy * dy) || 1
      const f = (d * d) / k
      fx[i]! -= (dx / d) * f
      fy[i]! -= (dy / d) * f
      fx[j]! += (dx / d) * f
      fy[j]! += (dy / d) * f
    }
    const temp = (1 - it / iters) * 35
    for (let i = 0; i < nodes.length; i++) {
      const mag = Math.sqrt(fx[i]! ** 2 + fy[i]! ** 2) || 1
      const step = Math.min(mag, temp)
      nodes[i]!.x += (fx[i]! / mag) * step
      nodes[i]!.y += (fy[i]! / mag) * step
    }
  }
}

// ===== 连线几何 =====

function getRectEdgePoint(node: CanvasNode, targetCx: number, targetCy: number): { x: number; y: number } {
  const cx = node.x + node.width / 2
  const cy = node.y + node.height / 2
  const dx = targetCx - cx
  const dy = targetCy - cy
  if (dx === 0 && dy === 0) return { x: cx, y: cy }
  const hw = node.width / 2
  const hh = node.height / 2
  const t = Math.min(
    Math.abs(dx) > 0.01 ? hw / Math.abs(dx) : Infinity,
    Math.abs(dy) > 0.01 ? hh / Math.abs(dy) : Infinity,
  )
  return { x: cx + dx * t, y: cy + dy * t }
}

export function CanvasView(): React.ReactElement {
  const [content, setContent] = useAtom(canvasContentAtom)
  const loaded = useAtomValue(canvasLoadedAtom)

  const [nodes, setNodes] = React.useState<CanvasNode[]>([])
  const [edges, setEdges] = React.useState<CanvasEdge[]>([])
  const [view, setView] = React.useState<ViewState>({ scale: 1, offsetX: 0, offsetY: 0 })
  const [editingNodeId, setEditingNodeId] = React.useState<string | null>(null)
  const [editingEdgeId, setEditingEdgeId] = React.useState<string | null>(null)

  const containerRef = React.useRef<HTMLDivElement>(null)
  const lastSerializedRef = React.useRef<string>('')
  const nodesRef = React.useRef(nodes)
  nodesRef.current = nodes
  const viewRef = React.useRef(view)
  viewRef.current = view

  // ===== 从 atom 解析（仅外部变化时） =====
  React.useEffect(() => {
    if (!loaded) return
    if (content === lastSerializedRef.current) return
    try {
      const parsed = parseCanvas(content)
      const needLayout = parsed.nodes.length > 0 && parsed.nodes.every((n) => n.x === 0 && n.y === 0)
      if (needLayout) {
        runForceLayout(parsed.nodes, parsed.edges)
      }
      setNodes(parsed.nodes)
      setEdges(parsed.edges)
      // 记录本次序列化，避免解析结果回写触发死循环
      lastSerializedRef.current = content
      // 布局后居中
      requestAnimationFrame(() => fitView(parsed.nodes))
    } catch (err) {
      console.error('[Canvas] 解析失败:', err)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, loaded])

  // ===== 提交到 atom =====
  const commit = React.useCallback((nextNodes: CanvasNode[], nextEdges: CanvasEdge[]): void => {
    const json = serializeCanvas(nextNodes, nextEdges)
    lastSerializedRef.current = json
    setContent(json)
  }, [setContent])

  // ===== 视图居中 =====
  const fitView = React.useCallback((ns: CanvasNode[]): void => {
    if (ns.length === 0 || !containerRef.current) return
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const n of ns) {
      minX = Math.min(minX, n.x)
      minY = Math.min(minY, n.y)
      maxX = Math.max(maxX, n.x + n.width)
      maxY = Math.max(maxY, n.y + n.height)
    }
    const cw = maxX - minX
    const ch = maxY - minY
    const rect = containerRef.current.getBoundingClientRect()
    const scale = Math.min(rect.width / (cw + 100), rect.height / (ch + 100), 1)
    setView({
      scale,
      offsetX: (rect.width - cw * scale) / 2 - minX * scale,
      offsetY: (rect.height - ch * scale) / 2 - minY * scale,
    })
  }, [])

  // ===== 节点拖拽 =====
  const handleNodeDragStart = React.useCallback((e: React.MouseEvent, nodeId: string): void => {
    if (editingNodeId === nodeId) return
    e.stopPropagation()
    const startX = e.clientX
    const startY = e.clientY
    const node = nodesRef.current.find((n) => n.id === nodeId)
    if (!node) return
    const origX = node.x
    const origY = node.y

    const onMove = (ev: MouseEvent): void => {
      const scale = viewRef.current.scale
      const nx = origX + (ev.clientX - startX) / scale
      const ny = origY + (ev.clientY - startY) / scale
      setNodes((prev) => prev.map((n) => (n.id === nodeId ? { ...n, x: nx, y: ny } : n)))
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      commit(nodesRef.current, edges)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [commit, edges, editingNodeId])

  // ===== 节点 resize =====
  const handleResizeStart = React.useCallback((e: React.MouseEvent, nodeId: string): void => {
    e.stopPropagation()
    const startX = e.clientX
    const startY = e.clientY
    const node = nodesRef.current.find((n) => n.id === nodeId)
    if (!node) return
    const origW = node.width
    const origH = node.height

    const onMove = (ev: MouseEvent): void => {
      const scale = viewRef.current.scale
      const nw = Math.max(80, origW + (ev.clientX - startX) / scale)
      const nh = Math.max(48, origH + (ev.clientY - startY) / scale)
      setNodes((prev) => prev.map((n) => (n.id === nodeId ? { ...n, width: nw, height: nh } : n)))
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      commit(nodesRef.current, edges)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [commit, edges])

  // ===== 画布平移 =====
  const handlePanStart = React.useCallback((e: React.MouseEvent): void => {
    if ((e.target as HTMLElement).closest('.canvas-node')) return
    const startX = e.clientX
    const startY = e.clientY
    const origOffsetX = viewRef.current.offsetX
    const origOffsetY = viewRef.current.offsetY
    setEditingNodeId(null)
    setEditingEdgeId(null)

    const onMove = (ev: MouseEvent): void => {
      setView((v) => ({ ...v, offsetX: origOffsetX + (ev.clientX - startX), offsetY: origOffsetY + (ev.clientY - startY) }))
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  // ===== 缩放 =====
  const handleWheel = React.useCallback((e: React.WheelEvent): void => {
    if (!containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    setView((v) => {
      const delta = e.deltaY > 0 ? 0.9 : 1.1
      const ns = Math.max(0.2, Math.min(3, v.scale * delta))
      return {
        scale: ns,
        offsetX: mx - (mx - v.offsetX) * (ns / v.scale),
        offsetY: my - (my - v.offsetY) * (ns / v.scale),
      }
    })
  }, [])

  // ===== 编辑节点文本 =====
  const handleNodeTextCommit = React.useCallback((nodeId: string, text: string): void => {
    const next = nodesRef.current.map((n) => (n.id === nodeId ? { ...n, text } : n))
    setNodes(next)
    commit(next, edges)
    setEditingNodeId(null)
  }, [commit, edges])

  // ===== 编辑连线标签 =====
  const handleEdgeLabelCommit = React.useCallback((edgeId: string, label: string): void => {
    const next = edges.map((e) => (e.id === edgeId ? { ...e, label } : e))
    setEdges(next)
    commit(nodesRef.current, next)
    setEditingEdgeId(null)
  }, [commit, edges])

  // ===== 自动整理 =====
  const handleAutoLayout = React.useCallback((): void => {
    const cloned = nodesRef.current.map((n) => ({ ...n, x: 0, y: 0 }))
    runForceLayout(cloned, edges)
    setNodes(cloned)
    commit(cloned, edges)
    requestAnimationFrame(() => fitView(cloned))
  }, [commit, edges, fitView])

  // ===== 截图当前视口 =====
  const handleScreenshot = React.useCallback(async (): Promise<void> => {
    if (!containerRef.current || !window.electronAPI.captureCanvasRegion) return
    const rect = containerRef.current.getBoundingClientRect()
    try {
      const dataUrl = await window.electronAPI.captureCanvasRegion({
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      })
      if (dataUrl) {
        toast.success('已截图并复制到剪贴板')
      } else {
        toast.error('截图失败')
      }
    } catch (err) {
      console.error('[Canvas] 截图失败:', err)
      toast.error('截图失败')
    }
  }, [])

  // ===== 渲染连线 =====
  const edgeColorFor = (color?: string): string =>
    color && COLOR_PRESETS[color] ? COLOR_PRESETS[color].border : 'var(--canvas-edge, hsl(var(--border)))'

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-content-area">
      {/* 工具栏 */}
      <div className="flex h-[38px] flex-shrink-0 items-center gap-1 border-b border-border/30 px-3">
        <span className="text-xs text-muted-foreground">Canvas</span>
        <span className="ml-1 text-[11px] text-muted-foreground/60">JSON Canvas · 自由画布</span>
        <div className="ml-auto flex items-center gap-0.5">
          <ToolbarButton label="自动整理" onClick={handleAutoLayout} icon={<LayoutGrid className="size-3.5" />} />
          <ToolbarButton label="回到中心" onClick={() => fitView(nodesRef.current)} icon={<Crosshair className="size-3.5" />} />
          <ToolbarButton label="截图当前视图到剪贴板" onClick={handleScreenshot} icon={<Camera className="size-3.5" />} />
        </div>
      </div>

      {/* 画布容器 */}
      <div
        ref={containerRef}
        className="canvas-grid relative min-h-0 flex-1 cursor-grab overflow-hidden active:cursor-grabbing"
        onMouseDown={handlePanStart}
        onWheel={handleWheel}
      >
        {!loaded ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground/40">加载中…</div>
        ) : nodes.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground/50">
            空画布 — 让 Agent 生成一个 canvas，或粘贴 JSON Canvas 数据
          </div>
        ) : (
          <div
            className="absolute left-0 top-0 origin-top-left"
            style={{ transform: `translate(${view.offsetX}px, ${view.offsetY}px) scale(${view.scale})` }}
          >
            {/* 连线层 */}
            <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" style={{ width: 1, height: 1 }}>
              <defs>
                <marker id="canvas-arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
                  <polygon points="0 0, 7 3, 0 6" fill="var(--canvas-edge, hsl(var(--border)))" />
                </marker>
              </defs>
              {edges.map((e) => {
                const from = nodes.find((n) => n.id === e.fromNode)
                const to = nodes.find((n) => n.id === e.toNode)
                if (!from || !to) return null
                const fromCx = from.x + from.width / 2
                const fromCy = from.y + from.height / 2
                const toCx = to.x + to.width / 2
                const toCy = to.y + to.height / 2
                const p1 = getRectEdgePoint(from, toCx, toCy)
                const p2 = getRectEdgePoint(to, fromCx, fromCy)
                const midX = (p1.x + p2.x) / 2
                const midY = (p1.y + p2.y) / 2
                const dx = p2.x - p1.x
                const dy = p2.y - p1.y
                const cpx = midX + dy * 0.08
                const cpy = midY - dx * 0.08
                return (
                  <g key={e.id}>
                    <path
                      d={`M ${p1.x} ${p1.y} Q ${cpx} ${cpy} ${p2.x} ${p2.y}`}
                      stroke={edgeColorFor(e.color)}
                      strokeWidth={1.5}
                      fill="none"
                      markerEnd="url(#canvas-arrow)"
                    />
                    {e.label && editingEdgeId !== e.id && (
                      <text
                        x={midX}
                        y={midY + 1}
                        textAnchor="middle"
                        dominantBaseline="middle"
                        className="canvas-edge-label pointer-events-auto cursor-text"
                        onDoubleClick={(ev) => {
                          ev.stopPropagation()
                          setEditingEdgeId(e.id)
                        }}
                      >
                        {e.label}
                      </text>
                    )}
                  </g>
                )
              })}
            </svg>

            {/* 连线标签编辑输入 */}
            {editingEdgeId && (() => {
              const e = edges.find((x) => x.id === editingEdgeId)
              if (!e) return null
              const from = nodes.find((n) => n.id === e.fromNode)
              const to = nodes.find((n) => n.id === e.toNode)
              if (!from || !to) return null
              const midX = (from.x + from.width / 2 + to.x + to.width / 2) / 2
              const midY = (from.y + from.height / 2 + to.y + to.height / 2) / 2
              return (
                <input
                  autoFocus
                  defaultValue={e.label || ''}
                  className="absolute z-20 -translate-x-1/2 -translate-y-1/2 rounded border border-primary bg-background px-1.5 py-0.5 text-[11px] text-foreground outline-none"
                  style={{ left: midX, top: midY }}
                  onBlur={(ev) => handleEdgeLabelCommit(e.id, ev.target.value)}
                  onKeyDown={(ev) => {
                    ev.stopPropagation()
                    if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur()
                    if (ev.key === 'Escape') setEditingEdgeId(null)
                  }}
                />
              )
            })()}

            {/* 节点层 */}
            {nodes.map((n) => {
              const preset = n.color ? COLOR_PRESETS[n.color] : undefined
              const isEditing = editingNodeId === n.id
              return (
                <div
                  key={n.id}
                  className="canvas-node group absolute flex select-none items-center rounded-md border shadow-sm transition-shadow hover:shadow-md"
                  style={{
                    left: n.x,
                    top: n.y,
                    width: n.width,
                    minHeight: n.height,
                    background: preset ? preset.bg : 'hsl(var(--card))',
                    borderColor: preset ? preset.border : 'hsl(var(--border))',
                    color: preset ? preset.text : 'hsl(var(--card-foreground))',
                    cursor: isEditing ? 'text' : 'move',
                  }}
                  onMouseDown={(e) => handleNodeDragStart(e, n.id)}
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    setEditingNodeId(n.id)
                  }}
                >
                  {isEditing ? (
                    <textarea
                      autoFocus
                      defaultValue={n.text}
                      className="h-full w-full resize-none bg-transparent p-3 text-[13px] leading-snug outline-none"
                      style={{ color: 'inherit' }}
                      onBlur={(ev) => handleNodeTextCommit(n.id, ev.target.value)}
                      onKeyDown={(ev) => {
                        ev.stopPropagation()
                        if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) (ev.target as HTMLTextAreaElement).blur()
                        if (ev.key === 'Escape') setEditingNodeId(null)
                      }}
                      onMouseDown={(ev) => ev.stopPropagation()}
                    />
                  ) : (
                    <div className="w-full whitespace-pre-wrap break-words p-3 text-[13px] leading-snug">{n.text}</div>
                  )}
                  {/* resize 手柄 */}
                  <div
                    className="absolute bottom-0 right-0 size-3.5 cursor-nwse-resize opacity-0 transition-opacity group-hover:opacity-60 hover:!opacity-100"
                    style={{
                      background: 'linear-gradient(135deg, transparent 50%, currentColor 50%)',
                      borderBottomRightRadius: 6,
                    }}
                    onMouseDown={(e) => handleResizeStart(e, n.id)}
                  />
                </div>
              )
            })}
          </div>
        )}

        {/* 缩放指示 */}
        {loaded && nodes.length > 0 && (
          <div className="absolute bottom-2.5 right-3 rounded border border-border/40 bg-background/80 px-2 py-0.5 text-[11px] text-muted-foreground">
            {Math.round(view.scale * 100)}%
          </div>
        )}
      </div>
    </div>
  )
}

interface ToolbarButtonProps {
  label: string
  onClick: () => void
  icon: React.ReactNode
}

function ToolbarButton({ label, onClick, icon }: ToolbarButtonProps): React.ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          className="flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
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
