/**
 * ToolSettings - 工具设置页
 *
 * Chat 模式工具统一管理 tab。
 * 管理 GPT Image 生图与自定义工具配置；旧搜索/Nano Banana 已随上游 #2008 移除。
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { toast } from 'sonner'
import { Loader2, CheckCircle2, XCircle, Trash2 } from 'lucide-react'
import type { Channel } from '@proma/shared'
import { isLikelyImageModel } from '@proma/shared'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { SettingsSection, SettingsCard } from './primitives'
import { SettingsSelect } from './primitives/SettingsSelect'
import { chatToolsAtom } from '@/atoms/chat-tool-atoms'
import { toolSettingsFocusAtom, type ToolSettingsFocus } from '@/atoms/settings-tab'

/** 刷新全局工具列表 atom */
async function refreshChatTools(setter: (tools: Awaited<ReturnType<typeof window.electronAPI.getChatTools>>) => void): Promise<void> {
  try {
    const tools = await window.electronAPI.getChatTools()
    setter(tools)
  } catch (err) {
    console.error('[ToolSettings] 刷新工具列表失败:', err)
  }
}

/** GPT Image 生图工具设置区域 */
function GPTImageSettings(): React.ReactElement {
  const [enabled, setEnabled] = React.useState(false)
  const [channels, setChannels] = React.useState<Channel[]>([])
  const [selectedValue, setSelectedValue] = React.useState('')
  const [showAllModels, setShowAllModels] = React.useState(false)
  const [loading, setLoading] = React.useState(true)
  const [testing, setTesting] = React.useState(false)
  const [testResult, setTestResult] = React.useState<{ success: boolean; message: string } | null>(null)
  const setChatTools = useSetAtom(chatToolsAtom)

  // 加载开关状态、凭据引用与渠道列表
  React.useEffect(() => {
    Promise.all([
      window.electronAPI.getChatTools(),
      window.electronAPI.getChatToolCredentials('gpt-image'),
      window.electronAPI.listChannels(),
    ]).then(([tools, credentials, channelList]) => {
      const tool = tools.find((t) => t.meta.id === 'gpt-image')
      if (tool) setEnabled(tool.enabled)
      if (credentials.channelId && credentials.modelId) {
        setSelectedValue(`${credentials.channelId}::${credentials.modelId}`)
      }
      setChannels(channelList)
    }).catch((err: unknown) => {
      console.error('[GPT Image 设置] 加载失败:', err)
    }).finally(() => {
      setLoading(false)
    })
  }, [])

  const handleToggle = async (checked: boolean): Promise<void> => {
    try {
      await window.electronAPI.updateChatToolState('gpt-image', { enabled: checked })
      setEnabled(checked)
      await refreshChatTools(setChatTools)
    } catch (error) {
      console.error('[GPT Image 设置] 切换失败:', error)
    }
  }

  /** 选择渠道/模型并立即保存引用 */
  const handleSelectModel = async (value: string): Promise<void> => {
    const separatorIndex = value.indexOf('::')
    if (separatorIndex < 0) return
    const channelId = value.slice(0, separatorIndex)
    const modelId = value.slice(separatorIndex + 2)
    setSelectedValue(value)
    try {
      await window.electronAPI.updateChatToolCredentials('gpt-image', { channelId, modelId })
      await refreshChatTools(setChatTools)
      toast.success('GPT Image 生图模型已保存')
    } catch (error) {
      console.error('[GPT Image 设置] 保存失败:', error)
      toast.error('保存生图模型失败')
    }
  }

  const handleTest = async (): Promise<void> => {
    setTesting(true)
    setTestResult(null)
    try {
      const result = await window.electronAPI.testChatTool('gpt-image')
      setTestResult(result)
    } catch (error) {
      setTestResult({ success: false, message: error instanceof Error ? error.message : String(error) })
    } finally {
      setTesting(false)
    }
  }

  if (loading) {
    return <div className="text-sm text-muted-foreground py-8 text-center">加载中...</div>
  }

  // 聚合启用的渠道与模型，默认只列疑似生图模型
  const enabledChannels = channels.filter((c) => c.enabled)
  const allOptions = enabledChannels.flatMap((channel) =>
    channel.models
      .filter((m) => m.enabled)
      .filter((m) => showAllModels || isLikelyImageModel(m.id))
      .map((m) => ({
        value: `${channel.id}::${m.id}`,
        label: `${channel.name} / ${m.id}`,
      })),
  )
  // 已保存的选择即使不在过滤结果中也要保留在选项里，避免回显丢失
  const options = allOptions.some((o) => o.value === selectedValue)
    ? allOptions
    : enabledChannels.flatMap((channel) =>
        channel.models
          .filter((m) => channel.id + '::' + m.id === selectedValue)
          .map((m) => ({ value: `${channel.id}::${m.id}`, label: `${channel.name} / ${m.id}` })),
      ).concat(allOptions)

  const hasChannels = enabledChannels.length > 0

  return (
    <SettingsSection
      title="GPT Image"
      description="启用后 AI 可以生成和编辑图片（基于 OpenAI Images 协议，凭据复用模型配置中的渠道）"
      action={
        <Switch
          checked={enabled}
          onCheckedChange={handleToggle}
        />
      }
    >
      <SettingsCard divided={false}>
        <div className="space-y-4 p-4">
          {/* 引导说明 */}
          <div className="rounded-lg bg-muted/50 p-3 space-y-2 text-sm text-muted-foreground">
            <p>GPT Image 通过 <span className="font-medium text-foreground">OpenAI Images 协议</span> 提供生图能力，直接复用「模型配置」中渠道的 API 地址与 Key，无需重复配置。</p>
            <p className="text-xs">配置步骤：</p>
            <ol className="text-xs list-decimal list-inside space-y-1">
              <li>在「模型配置」中添加包含生图模型（如 gpt-image）的渠道</li>
              <li>在下方选择该渠道里的生图模型</li>
              <li>开启开关后，Chat 会话与 Agent 会话（含所有工作区）均可调用生图</li>
            </ol>
            <p className="text-xs">渠道更换 API Key 或地址后自动跟随；支持 gpt-image、dall-e 等 OpenAI Images 兼容模型。</p>
          </div>

          {hasChannels ? (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium">生图模型</label>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={testing || !selectedValue}
                  onClick={handleTest}
                >
                  {testing ? <><Loader2 size={14} className="animate-spin mr-1.5" />测试中...</> : '测试连接'}
                </Button>
              </div>
              <SettingsSelect
                label=""
                value={selectedValue}
                onValueChange={handleSelectModel}
                options={options}
                placeholder="选择渠道中的生图模型"
              />
              <div className="flex items-center justify-between px-4">
                <label className="text-xs text-muted-foreground flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={showAllModels}
                    onChange={(e) => setShowAllModels(e.target.checked)}
                    className="rounded border-muted-foreground/40"
                  />
                  显示全部模型（未识别为生图模型时勾选）
                </label>
              </div>
            </div>
          ) : (
            <div className="rounded-lg bg-muted/30 p-3 text-sm text-muted-foreground">
              尚无可用渠道。请先在「模型配置」中添加包含生图模型的渠道。
            </div>
          )}

          {testResult && (
            <div className={`flex items-start gap-2 rounded-lg p-3 text-sm ${testResult.success ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-destructive/10 text-destructive'}`}>
              {testResult.success ? <CheckCircle2 size={16} className="mt-0.5 shrink-0" /> : <XCircle size={16} className="mt-0.5 shrink-0" />}
              <span>{testResult.message}</span>
            </div>
          )}
        </div>
      </SettingsCard>
    </SettingsSection>
  )
}

/** 自定义工具列表区域 */
function CustomToolsSection(): React.ReactElement | null {
  const tools = useAtomValue(chatToolsAtom)
  const setChatTools = useSetAtom(chatToolsAtom)

  const customTools = tools.filter((t) => t.meta.category === 'custom')
  if (customTools.length === 0) return null

  const handleToggle = async (toolId: string, checked: boolean): Promise<void> => {
    try {
      await window.electronAPI.updateChatToolState(toolId, { enabled: checked })
      await refreshChatTools(setChatTools)
    } catch (error) {
      console.error('[自定义工具] 切换失败:', error)
    }
  }

  const handleDelete = async (toolId: string, toolName: string): Promise<void> => {
    try {
      await window.electronAPI.deleteCustomChatTool(toolId)
      await refreshChatTools(setChatTools)
      toast.success(`已删除工具: ${toolName}`)
    } catch (error) {
      console.error('[自定义工具] 删除失败:', error)
      toast.error('删除工具失败')
    }
  }

  return (
    <SettingsSection
      title="自定义工具"
      description="通过 Agent 模式创建的 HTTP API 工具"
    >
      <SettingsCard divided>
        {customTools.map((tool) => (
          <div key={tool.meta.id} className="flex items-center justify-between p-4">
            <div className="flex-1 min-w-0 mr-4">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{tool.meta.name}</span>
                {tool.meta.httpConfig && (
                  <span className="text-xs text-muted-foreground font-mono">
                    {tool.meta.httpConfig.method}
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-0.5 truncate">
                {tool.meta.description}
              </p>
              {tool.meta.httpConfig && (
                <p className="text-xs text-muted-foreground/60 mt-0.5 truncate font-mono">
                  {tool.meta.httpConfig.urlTemplate}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Switch
                checked={tool.enabled}
                onCheckedChange={(checked) => handleToggle(tool.meta.id, checked)}
              />
              <Button
                size="icon"
                variant="ghost"
                className="h-8 w-8 text-muted-foreground hover:text-destructive"
                onClick={() => handleDelete(tool.meta.id, tool.meta.name)}
              >
                <Trash2 size={14} />
              </Button>
            </div>
          </div>
        ))}
      </SettingsCard>
    </SettingsSection>
  )
}

export function ToolSettings(): React.ReactElement {
  const [focusedTool, setFocusedTool] = useAtom(toolSettingsFocusAtom)
  const gptImageRef = React.useRef<HTMLDivElement>(null)
  const customToolsRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    if (!focusedTool) return
    const refs: Record<ToolSettingsFocus, React.RefObject<HTMLDivElement>> = {
      'gpt-image': gptImageRef,
      'custom-tools': customToolsRef,
    }
    window.requestAnimationFrame(() => {
      refs[focusedTool].current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
      setFocusedTool(null)
    })
  }, [focusedTool, setFocusedTool])

  return (
    <div className="space-y-8">
      {/* GPT Image 生图工具 */}
      <div ref={gptImageRef}>
        <GPTImageSettings />
      </div>

      {/* 自定义工具 */}
      <div ref={customToolsRef}>
        <CustomToolsSection />
      </div>

    </div>
  )
}
