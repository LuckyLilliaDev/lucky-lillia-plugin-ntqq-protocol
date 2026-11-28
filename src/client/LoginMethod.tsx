import React, { useEffect, useState } from 'react'
import { Cpu, Loader2, MonitorSmartphone, Save } from 'lucide-react'
import { PathInput, SelectInput, usePluginContext, type PluginConfigState } from '@luckylillia-dev/plugin-sdk/webui'
import type { NTProtocolConfig } from '../support/types'
import {
  describeMethod, LOGIN_MODES, LoginMode, PROTOCOLS, ProtocolId,
} from './loginOptions'

const ICONS = { direct: Cpu, native: MonitorSmartphone }

/** GET /api/nativeqq/qq-path: the QQ NativeQQ finds by itself, and the bot machine's platform */
interface QQPathFound {
  detected: string | null
  platform: string
}

const QQ_FILE: Record<string, string> = { win32: 'QQ.exe', linux: '/opt/QQ/qq', darwin: 'QQ.app/Contents/MacOS/QQ' }

/** The QQ the bridge starts: one picked on the bot's machine, or, left empty, the one found there */
const QQPathField: React.FC<{ value: string; onChange(qqPath: string): void }> = ({ value, onChange }) => {
  const ctx = usePluginContext()
  const [found, setFound] = useState<QQPathFound | null>(null)
  useEffect(() => {
    let current = true
    ctx.api('/api/nativeqq/qq-path').then(
      data => current && setFound(data as QQPathFound),
      () => current && setFound({ detected: null, platform: '' }),
    )
    return () => {
      current = false
    }
  }, [])

  const detected = found?.detected ?? undefined
  let note: React.ReactNode
  if (!found) note = '正在查找这台机器上安装的 QQ…'
  else if (value) note = detected ? `清空后改用自动检测到的 ${detected}` : '清空后改用自动检测'
  else if (detected) note = `自动检测到 ${detected}`
  else {
    note = (
      <span className="text-amber-600 dark:text-amber-400">
        这台机器上没找到 QQ，请点「浏览」选择{QQ_FILE[found.platform] ? ` ${QQ_FILE[found.platform]}` : ' QQ 的可执行文件'}
      </span>
    )
  }
  return (
    <div>
      <label className="block text-sm font-medium text-theme-secondary mb-2">QQ 可执行文件</label>
      <PathInput
        value={value}
        onChange={onChange}
        accept={found?.platform === 'win32' ? ['.exe'] : undefined}
        start={detected}
        placeholder="留空自动检测"
        title="选择 QQ 可执行文件"
      />
      <p className="text-xs text-theme-muted mt-1 break-all">{note}</p>
      <p className="text-xs text-theme-muted mt-1">保存后在这里点「启动 QQ」；登录成功后可勾选「自动登录」，下次启动实例时自动启动 QQ 并登录</p>
    </div>
  )
}

interface LoginMethodProps {
  config: PluginConfigState<NTProtocolConfig>
  /** Switching the mode logs this account out */
  online: boolean
  onSaved: (methodChanged: boolean) => void
  /** The mode & protocol picked in the open editor, null when it is closed */
  onDraftChange?: (draft: { mode: LoginMode; protocol: ProtocolId } | null) => void
}

/** The login method of builtin:nt-protocol: which one, and the form to change it. */
const LoginMethod: React.FC<LoginMethodProps> = ({ config, online, onSaved, onDraftChange }) => {
  const { value, save, saving, error } = config
  // The settings while editing
  const [draft, setDraft] = useState<NTProtocolConfig | null>(null)
  const draftMode = draft ? draft.mode : null
  const draftProtocol = draft ? draft.protocol : null
  // A logged-in account keeps its login method: the editor goes once the account is online
  useEffect(() => {
    if (online) setDraft(null)
  }, [online])
  useEffect(() => {
    onDraftChange?.(draftMode && draftProtocol ? { mode: draftMode, protocol: draftProtocol } : null)
  }, [draftMode, draftProtocol, onDraftChange])

  if (error) return <p className="mb-6 text-sm text-red-500">读取登录方式失败：{error}</p>
  if (!value) return null
  const current = value

  if (!draft) {
    return (
      <div className="flex items-center gap-3 p-4 mb-6 bg-theme-item rounded-xl">
        <div className="flex-1 min-w-0">
          <div className="text-xs text-theme-muted">登录方式</div>
          <div className="text-sm font-medium text-theme mt-0.5">{describeMethod(current)}</div>
          {online && (
            <div className="text-xs text-theme-muted mt-1">
              {current.mode === 'native' ? '已登录：在 QQ 客户端里退出登录后才能更改' : '已登录：退出登录后才能更改'}
            </div>
          )}
        </div>
        {!online && (
          <button onClick={() => setDraft(value)} className="btn-glass px-4 py-1.5 text-sm flex-shrink-0">更改</button>
        )}
      </div>
    )
  }

  const shown = draft
  const protocol = PROTOCOLS.find(item => item.id === shown.protocol)
  const change = (patch: Partial<NTProtocolConfig>) => setDraft({ ...draft, ...patch })

  const submit = async () => {
    const methodChanged = shown.mode !== current.mode || (shown.mode === 'direct' && shown.protocol !== current.protocol)
    if (await save(draft, { message: '登录方式已保存' })) {
      setDraft(null)
      onSaved(methodChanged)
    }
  }

  return (
    <div className="p-4 mb-6 border border-theme-divider rounded-xl space-y-4">
      <div className="text-sm font-medium text-theme">登录方式</div>
      <div role="radiogroup" className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {LOGIN_MODES.map((mode) => {
          const selected = shown.mode === mode.id
          const Icon = ICONS[mode.id]
          return (
            <button
              key={mode.id}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => change({ mode: mode.id })}
              className={`text-left p-4 rounded-xl border-2 transition-all disabled:cursor-not-allowed ${selected
                ? 'border-pink-500 bg-pink-50 dark:bg-pink-900/20'
                : 'border-theme-divider hover:border-theme-muted hover:bg-theme-item disabled:opacity-50 disabled:hover:bg-transparent'}`}
            >
              <div className={`flex items-center gap-2 text-sm font-medium ${selected ? 'text-pink-500' : 'text-theme'}`}>
                <Icon size={18} className={selected ? 'text-pink-500' : 'text-theme-muted'} />
                {mode.label}
              </div>
              <p className="text-xs text-theme-secondary mt-1.5">{mode.hint}</p>
            </button>
          )
        })}
      </div>

      {shown.mode === 'direct' ? (
        <div>
          <label className="block text-sm font-medium text-theme-secondary mb-2">协议</label>
          <SelectInput
            value={shown.protocol}
            options={PROTOCOLS.map(item => ({ value: item.id, label: item.label }))}
            onChange={protocol => change({ protocol })}
          />
          <p className="text-xs text-theme-muted mt-1">
            不同协议的登录记录分开保存，换了以后要重新登录
          </p>
          {protocol?.hint && <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">{protocol.hint}</p>}
        </div>
      ) : (
        <QQPathField
          value={shown.nativeQQ.qqPath}
          onChange={qqPath => change({ nativeQQ: { ...draft.nativeQQ, qqPath } })}
        />
      )}

      <div className="flex justify-end gap-3">
        <button
          onClick={() => setDraft(null)}
          disabled={saving}
          className="px-4 py-2 bg-theme-item hover:bg-theme-item-hover text-theme rounded-xl transition-colors font-medium"
        >
          取消
        </button>
        <button onClick={submit} disabled={saving} className="btn-primary flex items-center gap-2">
          {saving ? <Loader2 size={20} className="animate-spin" /> : <Save size={20} />}
          {saving ? '保存中...' : '保存配置'}
        </button>
      </div>
    </div>
  )
}

export default LoginMethod
