import React, { useState, useEffect, useRef, useCallback } from 'react';
import { RefreshCw, Loader2, ExternalLink, ShieldCheck } from 'lucide-react';
import { usePluginContext } from '@luckylillia-dev/plugin-sdk/webui';
import { isQuickLoginUnsupported, readQuickLoginList } from './quickLoginList';
import { protocolLoginMethods, type InteractiveLoginMethod, type ProtocolId } from './loginOptions';
import TencentCaptchaEmbed from './TencentCaptchaEmbed';

interface Account {
  uin: string;
  uid: string;
  nickName?: string;
  faceUrl: string;
  loginType: number;
  isQuickLogin: boolean;
  isAutoLogin: boolean;
  isUserLogin: boolean;
}

interface QRCodeData {
  pngBase64QrcodeData: string;
  qrcodeUrl: string;
  expireTime: number;
  pollTimeInterval: number;
}

interface QuickLoginResult {
  result: string;
  loginErrorInfo: { errMsg: string };
}

interface GetLoginListResult {
  /** false while the bridge's login service cannot supply the account list */
  ready?: boolean;
  LocalLoginInfoList: Account[];
}

interface PasswordLoginState {
  supported: boolean;
  phase: 'idle' | 'logging_in' | 'captcha' | 'new_device_qr' | 'online' | 'error';
  uin?: string;
  message?: string;
  error?: string;
  captcha?: {
    url: string;
    sid: string;
    appId?: string;
    loginAppId?: string;
  };
  newDevice?: {
    qrUrl?: string;
    qrPng?: string;
    jumpUrl?: string;
    guaranteeStatus?: number;
    manualFallback: boolean;
  };
}

interface QQLoginProps {
  /** Running pure-protocol id, used to resolve supported login methods. */
  protocol?: ProtocolId;
  /** Primary login method reported by /api/login-info. */
  loginMethod?: InteractiveLoginMethod;
  /** All interactive login methods supported by the running protocol (`qr`, `password`, or both). */
  loginMethods?: InteractiveLoginMethod[];
  /** A quick or password login went through: the account is online now */
  onLogin?: () => void;
}

/** Quick login, QR login (desktop/watch), and password + captcha/new-device login (desktop/iOS/HarmonyOS). */
const QQLogin: React.FC<QQLoginProps> = ({ protocol, loginMethod, loginMethods, onLogin }) => {
  const ctx = usePluginContext();
  const showToast = ctx.toast;
  const resolvedMethods: InteractiveLoginMethod[] = loginMethods && loginMethods.length > 0
    ? loginMethods
    : loginMethod === 'password'
      ? ['password']
      : protocolLoginMethods(protocol);
  const canQr = resolvedMethods.includes('qr');
  const canPassword = resolvedMethods.includes('password');
  const canSwitchQrAndPassword = canQr && canPassword;
  const primaryFallbackMode: InteractiveLoginMethod = canQr ? 'qr' : 'password';

  // Quick login only once QQ has returned a saved account.
  const [loginMode, setLoginMode] = useState<'loading' | 'quick' | 'qr' | 'password'>('loading');
  const [waitingLoginService, setWaitingLoginService] = useState(false);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [listUnsupported, setListUnsupported] = useState(false);
  // Why the quick login did not get online, kept on screen: a toast is easily missed
  const [error, setError] = useState('');
  const [showAccountList, setShowAccountList] = useState(false);
  const [loginLoading, setLoginLoading] = useState(false);
  const [qrExpired, setQrExpired] = useState(false);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccount, setSelectedAccount] = useState<Account | null>(null);

  // Mobile password login form & challenge state
  const [pwUin, setPwUin] = useState('');
  const [pwPassword, setPwPassword] = useState('');
  const [pwState, setPwState] = useState<PasswordLoginState | null>(null);
  const [pwSubmitting, setPwSubmitting] = useState(false);
  const [captchaReloadKey, setCaptchaReloadKey] = useState(0);
  const [newDeviceSig, setNewDeviceSig] = useState('');
  const [showManualNewDevice, setShowManualNewDevice] = useState(false);

  const qrCanvasRef = useRef<HTMLCanvasElement>(null);
  const qrRefreshIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const qrRetryTimerRef = useRef<NodeJS.Timeout | null>(null);
  const listRequestRef = useRef<AbortController | null>(null);
  const generateQrCodeRef = useRef<(() => void) | undefined>(undefined);
  const pwSubmittingRef = useRef(false);

  const displayQrCode = useCallback((base64Data: string) => {
    if (!qrCanvasRef.current) return;
    const canvas = qrCanvasRef.current;
    const canvasCtx = canvas.getContext('2d');
    if (!canvasCtx) return;

    const img = new Image();
    img.onload = () => {
      canvasCtx.clearRect(0, 0, 200, 200);
      canvasCtx.drawImage(img, 0, 0, 200, 200);
    };
    img.src = base64Data;
  }, []);

  const generateQrCode = useCallback(async () => {
    if (!canQr || !qrCanvasRef.current) return;

    try {
      const data = await ctx.api<QRCodeData>('/api/login-qrcode');
      if (qrRetryTimerRef.current) {
        clearTimeout(qrRetryTimerRef.current);
        qrRetryTimerRef.current = null;
      }
      displayQrCode(data.pngBase64QrcodeData);

      const expireTime = data.expireTime * 1000;
      if (qrRefreshIntervalRef.current) clearTimeout(qrRefreshIntervalRef.current);
      qrRefreshIntervalRef.current = setTimeout(() => setQrExpired(true), expireTime);

      setQrExpired(false);
    } catch {
      // 刚录入 token 或切换协议重挂载时 client 可能还在初始化, 静默重试
      if (qrRetryTimerRef.current) clearTimeout(qrRetryTimerRef.current);
      qrRetryTimerRef.current = setTimeout(() => generateQrCodeRef.current?.(), 1200);
    }
  }, [canQr, displayQrCode, ctx]);

  const refreshQrCode = useCallback(async () => {
    await generateQrCode();
    showToast('二维码已刷新', 'success');
  }, [generateQrCode, showToast]);

  const fetchQuickLoginList = useCallback(async () => {
    listRequestRef.current?.abort();
    const controller = new AbortController();
    listRequestRef.current = controller;
    setListLoading(true);
    setListError('');
    setListUnsupported(false);
    setWaitingLoginService(false);
    try {
      const data = await readQuickLoginList(
        () => ctx.api<GetLoginListResult>('/api/quick-login-list'),
        controller.signal,
        setWaitingLoginService,
      );
      if (!data || controller.signal.aborted) return;
      const quickLoginAccounts = (data?.LocalLoginInfoList ?? []).filter(item => item.isQuickLogin && !item.isUserLogin);
      setAccounts(quickLoginAccounts);
      if (quickLoginAccounts.length > 0) {
        setSelectedAccount(prev => quickLoginAccounts.find(account => account.uin === prev?.uin) ?? quickLoginAccounts[0]);
        // A user can choose QR / password while the list loads; finishing the request must keep that choice.
        setLoginMode(mode => (mode === 'loading' ? 'quick' : mode));
      } else {
        setLoginMode(primaryFallbackMode);
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      setListError(err instanceof Error ? err.message : '读取快速登录账号失败，请重试');
      setListUnsupported(isQuickLoginUnsupported(err));
      setLoginMode(primaryFallbackMode);
    } finally {
      if (!controller.signal.aborted) {
        setListLoading(false);
        setWaitingLoginService(false);
      }
    }
  }, [ctx, primaryFallbackMode]);

  // The request returns once the login has an outcome: online, or the reason it is not
  const handleQuickLogin = useCallback(async () => {
    if (!selectedAccount) return;
    setError('');
    setLoginLoading(true);
    try {
      const data = await ctx.api<QuickLoginResult>('/api/quick-login', { method: 'POST', body: { uin: selectedAccount.uin } });
      if (data?.result !== '0') throw new Error(data?.loginErrorInfo?.errMsg || '登录失败');
      onLogin?.();
    } catch (e) {
      const message = e instanceof Error ? e.message : '登录失败';
      setError(message);
      showToast(message, 'error');
      setLoginMode(primaryFallbackMode);
    } finally {
      setLoginLoading(false);
    }
  }, [selectedAccount, onLogin, ctx, showToast, primaryFallbackMode]);

  const applyPasswordState = useCallback((state: PasswordLoginState) => {
    setPwState(state);
    if (state.phase === 'online') {
      onLogin?.();
    } else if (state.phase === 'error' && state.error) {
      setError(state.error);
    }
  }, [onLogin]);

  const handlePasswordSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pwUin.trim() || !pwPassword) {
      setError('请填写 QQ 号和密码');
      return;
    }
    if (pwSubmittingRef.current) return;
    pwSubmittingRef.current = true;
    setError('');
    setPwSubmitting(true);
    setCaptchaReloadKey(k => k + 1);
    setNewDeviceSig('');
    setShowManualNewDevice(false);
    try {
      const state = await ctx.api<PasswordLoginState>('/api/password-login', {
        method: 'POST',
        body: { uin: pwUin.trim(), password: pwPassword },
      });
      applyPasswordState(state);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '登录失败';
      setError(msg);
      showToast(msg, 'error');
    } finally {
      pwSubmittingRef.current = false;
      setPwSubmitting(false);
    }
  }, [pwUin, pwPassword, ctx, applyPasswordState, showToast]);

  const submitCaptchaCredentials = useCallback(async (ticket: string, randstr: string) => {
    const cleanTicket = ticket.trim();
    const cleanRandStr = randstr.trim();
    if (!cleanTicket || !cleanRandStr) {
      setError('请填写完整的 ticket 和 randstr');
      return;
    }
    if (pwSubmittingRef.current) return;
    pwSubmittingRef.current = true;
    setError('');
    setPwSubmitting(true);
    try {
      const state = await ctx.api<PasswordLoginState>('/api/login-captcha', {
        method: 'POST',
        body: {
          ticket: cleanTicket,
          randstr: cleanRandStr,
          sid: pwState?.captcha?.sid,
        },
      });
      applyPasswordState(state);
      if (state.phase === 'captcha') {
        setCaptchaReloadKey(k => k + 1);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : '提交滑块验证失败';
      setError(msg);
      showToast(msg, 'error');
      setCaptchaReloadKey(k => k + 1);
    } finally {
      pwSubmittingRef.current = false;
      setPwSubmitting(false);
    }
  }, [pwState?.captcha?.sid, ctx, applyPasswordState, showToast]);

  const handleNewDeviceSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDeviceSig.trim()) {
      setError('请填写新设备验证凭证');
      return;
    }
    if (pwSubmittingRef.current) return;
    pwSubmittingRef.current = true;
    setError('');
    setPwSubmitting(true);
    try {
      const state = await ctx.api<PasswordLoginState>('/api/login-new-device', {
        method: 'POST',
        body: { sig: newDeviceSig.trim() },
      });
      applyPasswordState(state);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '提交新设备验证失败';
      setError(msg);
      showToast(msg, 'error');
    } finally {
      pwSubmittingRef.current = false;
      setPwSubmitting(false);
    }
  }, [newDeviceSig, ctx, applyPasswordState, showToast]);

  const handleCancelPasswordLogin = useCallback(async () => {
    setError('');
    try {
      await ctx.api('/api/login-cancel', { method: 'POST' });
    } catch {
      // Ignore cancel error
    }
    setPwState({ supported: true, phase: 'idle' });
  }, [ctx]);

  const toggleAccountList = () => setShowAccountList(!showAccountList);
  const selectAccount = (account: Account) => { setSelectedAccount(account); setShowAccountList(false); };

  useEffect(() => {
    void fetchQuickLoginList();
    return () => {
      listRequestRef.current?.abort();
      if (qrRefreshIntervalRef.current) clearTimeout(qrRefreshIntervalRef.current);
      if (qrRetryTimerRef.current) clearTimeout(qrRetryTimerRef.current);
    };
  }, []);

  // Keep mode consistent with the running protocol's supported methods.
  useEffect(() => {
    if (!canQr && loginMode === 'qr') setLoginMode('password');
    if (!canPassword && loginMode === 'password') setLoginMode('qr');
  }, [canQr, canPassword, loginMode]);

  // Resume any in-progress captcha / new-device verification when password login is supported.
  useEffect(() => {
    if (!canPassword) return;
    let active = true;
    ctx.api<PasswordLoginState>('/api/login-state').then((state) => {
      if (!active) return;
      setPwState(state);
      if (state.phase === 'captcha' || state.phase === 'new_device_qr' || state.phase === 'logging_in') {
        setLoginMode('password');
        if (state.uin) setPwUin(state.uin);
      } else if (state.phase === 'online') {
        onLogin?.();
      }
    }).catch(() => {});
    return () => { active = false; };
  }, [canPassword, ctx, onLogin]);

  // Poll /api/login-state while an async verification challenge is active.
  useEffect(() => {
    if (loginMode !== 'password') return;
    const phase = pwState?.phase;
    if (phase !== 'logging_in' && phase !== 'captcha' && phase !== 'new_device_qr') return;
    let stopped = false;
    const timer = setInterval(() => {
      if (pwSubmittingRef.current) return;
      ctx.api<PasswordLoginState>('/api/login-state').then((state) => {
        if (!stopped && !pwSubmittingRef.current) applyPasswordState(state);
      }).catch(() => {});
    }, 1500);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [loginMode, pwState?.phase, ctx, applyPasswordState]);

  useEffect(() => {
    if (loginMode === 'qr' && canQr) {
      setTimeout(() => generateQrCode(), 100);
    } else if (qrRefreshIntervalRef.current) {
      clearTimeout(qrRefreshIntervalRef.current);
    }
  }, [loginMode, canQr, generateQrCode]);

  useEffect(() => {
    generateQrCodeRef.current = generateQrCode;
  }, [generateQrCode]);

  const activePhase = pwState?.phase ?? 'idle';

  const switchToQrMode = useCallback(() => {
    setError('');
    if (activePhase === 'logging_in' || activePhase === 'captcha' || activePhase === 'new_device_qr') {
      void handleCancelPasswordLogin();
    }
    setLoginMode('qr');
  }, [activePhase, handleCancelPasswordLogin]);

  const switchToPasswordMode = useCallback(() => {
    setError('');
    setLoginMode('password');
  }, []);

  return (
    <div className="flex flex-col items-center text-center">
      {error && (
        <div className="w-full max-w-md mb-6 p-3 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-xl text-red-600 dark:text-red-400 text-sm text-left">
          {error}
        </div>
      )}
      {listError && (
        <div className="w-full max-w-md mb-6 p-3 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 rounded-xl text-amber-700 dark:text-amber-300 text-sm" role="status">
          <p>{listError}</p>
          {!listUnsupported && (
            <button onClick={() => void fetchQuickLoginList()} className="mt-2 text-pink-500 hover:underline">重新读取账号</button>
          )}
        </div>
      )}

      {loginMode === 'loading' && (
        <div className="flex flex-col items-center gap-4 py-10 text-sm text-theme-secondary">
          <div className="flex items-center gap-2">
            <Loader2 size={18} className="animate-spin text-pink-500" />
            {waitingLoginService ? '正在连接 QQ 登录服务...' : '正在读取可快速登录的账号...'}
          </div>
          <div className="flex gap-6 justify-center">
            {canQr && (
              <button type="button" onClick={switchToQrMode} className="text-pink-500 hover:underline">
                扫码登录
              </button>
            )}
            {canPassword && (
              <button type="button" onClick={switchToPasswordMode} className="text-pink-500 hover:underline">
                账号密码登录
              </button>
            )}
          </div>
        </div>
      )}

      {canSwitchQrAndPassword && (loginMode === 'qr' || loginMode === 'password') && (
        <div className="inline-flex p-1 mb-6 bg-theme-item rounded-xl border border-theme-divider">
          <button
            type="button"
            disabled={pwSubmitting}
            onClick={switchToQrMode}
            className={`px-4 py-1.5 text-sm font-medium rounded-lg transition-all disabled:opacity-50 ${
              loginMode === 'qr'
                ? 'bg-theme-card text-pink-500 shadow-sm'
                : 'text-theme-secondary hover:text-theme'
            }`}
          >
            扫码登录
          </button>
          <button
            type="button"
            disabled={pwSubmitting}
            onClick={switchToPasswordMode}
            className={`px-4 py-1.5 text-sm font-medium rounded-lg transition-all disabled:opacity-50 ${
              loginMode === 'password'
                ? 'bg-theme-card text-pink-500 shadow-sm'
                : 'text-theme-secondary hover:text-theme'
            }`}
          >
            账号密码登录
          </button>
        </div>
      )}

      {/* Quick Login Mode */}
      {loginMode === 'quick' && (
        <div className="flex flex-col items-center gap-6">
          {!showAccountList && selectedAccount && (
            <div className="flex flex-col items-center cursor-pointer p-4 rounded-2xl transition-colors hover:bg-pink-50 dark:hover:bg-pink-900/30" onClick={toggleAccountList}>
              <div className="w-20 h-20 rounded-full overflow-hidden mb-3 shadow-lg">
                <img src={selectedAccount.faceUrl} alt={selectedAccount.nickName} className="w-full h-full object-cover" />
              </div>
              <div className="text-base text-theme mb-2">{selectedAccount.nickName}</div>
            </div>
          )}

          {showAccountList && (
            <div className="grid grid-cols-2 gap-4 my-5 w-full max-w-md">
              {accounts.map((account) => (
                <div key={account.uin} className="flex flex-col items-center p-4 rounded-2xl cursor-pointer transition-all border-2 border-transparent hover:bg-pink-50 dark:hover:bg-pink-900/30 hover:border-pink-500" onClick={() => selectAccount(account)}>
                  <div className="w-[60px] h-[60px] rounded-full overflow-hidden mb-2 shadow-md">
                    <img src={account.faceUrl} alt={account.nickName} className="w-full h-full object-cover" />
                  </div>
                  <div className="text-sm text-theme text-center truncate w-full px-1">{account.nickName}</div>
                </div>
              ))}
            </div>
          )}

          {!showAccountList && (
            <button onClick={handleQuickLogin} disabled={!selectedAccount || loginLoading} className="w-[280px] h-11 px-5 gradient-primary text-white rounded-full font-medium text-base disabled:opacity-50 disabled:cursor-not-allowed hover:shadow-lg transition-all flex items-center justify-center gap-2">
              {loginLoading ? (<><Loader2 size={20} className="animate-spin flex-shrink-0" /><span className="truncate">正在登录 {selectedAccount?.nickName ?? ''}...</span></>) : '登录'}
            </button>
          )}

          <div className="flex flex-wrap gap-6 justify-center">
            {!showAccountList && <button type="button" onClick={toggleAccountList} className="text-pink-500 text-sm hover:underline">切换账号</button>}
            {canQr && (
              <button type="button" onClick={switchToQrMode} className="text-pink-500 text-sm hover:underline">
                扫码登录
              </button>
            )}
            {canPassword && (
              <button type="button" onClick={switchToPasswordMode} className="text-pink-500 text-sm hover:underline">
                账号密码登录
              </button>
            )}
          </div>
        </div>
      )}

      {/* QR Code Login Mode (Desktop / Watch) */}
      {loginMode === 'qr' && canQr && (
        <div className="flex flex-col items-center gap-5">
          <div className="relative inline-block">
            <div className="relative p-5 bg-white rounded-2xl shadow-lg">
              <canvas ref={qrCanvasRef} width="200" height="200" className="block rounded-lg" />
              {qrExpired && (
                <div className="absolute inset-0 bg-black/70 flex flex-col items-center justify-center text-white cursor-pointer rounded-2xl transition-opacity hover:opacity-90" onClick={refreshQrCode}>
                  <RefreshCw size={32} className="mb-2" /><div>点击刷新</div>
                </div>
              )}
            </div>
          </div>
          <div className="text-theme-secondary">请使用手机QQ扫码登录</div>
          {listLoading && (
            <div className="flex items-center gap-2 text-xs text-theme-muted">
              <Loader2 size={14} className="animate-spin" />
              正在读取可快速登录的账号...
            </div>
          )}
          {!listLoading && !listError && accounts.length === 0 && (
            <div className="text-sm text-theme-muted">
              <p>没有可快速登录的账号</p>
              <button onClick={() => void fetchQuickLoginList()} className="mt-2 text-pink-500 hover:underline">重新读取账号</button>
            </div>
          )}
          {qrExpired && (
            <div className="text-sm px-4 py-2 rounded-lg bg-red-100 text-red-800">二维码已过期，请刷新</div>
          )}
          {accounts.length > 0 && (
            <button onClick={() => setLoginMode('quick')} className="text-pink-500 text-sm hover:underline">快速登录</button>
          )}
        </div>
      )}

      {/* NTLogin Password Mode (Desktop / iPad / iPhone / HarmonyPad / HarmonyPhone) */}
      {loginMode === 'password' && canPassword && (
        <div className="w-full max-w-md flex flex-col items-center gap-5">
          {activePhase === 'logging_in' && (
            <div className="flex flex-col items-center gap-3 py-8 text-sm text-theme-secondary">
              <Loader2 size={24} className="animate-spin text-pink-500" />
              <div>{pwState?.message || '正在登录...'}</div>
              <button type="button" onClick={() => void handleCancelPasswordLogin()} className="text-xs text-theme-muted hover:underline">取消</button>
            </div>
          )}

          {activePhase === 'captcha' && pwState?.captcha && (
            <div className="w-full p-5 bg-theme-item rounded-2xl flex flex-col items-center gap-4 text-left">
              <TencentCaptchaEmbed
                url={pwState.captcha.url}
                sid={pwState.captcha.sid}
                appId={pwState.captcha.appId}
                loginAppId={pwState.captcha.loginAppId}
                uin={pwState.uin || pwUin.trim()}
                reloadKey={captchaReloadKey}
                submitting={pwSubmitting}
                onVerified={(ticket, randstr) => {
                  void submitCaptchaCredentials(ticket, randstr);
                }}
              />
              <button
                type="button"
                disabled={pwSubmitting}
                onClick={() => setCaptchaReloadKey(k => k + 1)}
                className="text-xs text-theme-secondary hover:text-theme disabled:opacity-50 flex items-center gap-1"
              >
                <RefreshCw size={13} />
                刷新验证码
              </button>
              <button type="button" onClick={() => void handleCancelPasswordLogin()} className="text-xs text-theme-muted hover:underline">
                取消并返回
              </button>
            </div>
          )}

          {activePhase === 'new_device_qr' && pwState?.newDevice && (
            <div className="w-full p-5 bg-theme-item rounded-2xl flex flex-col items-center gap-4">
              <div className="flex items-center gap-2 text-base font-medium text-theme">
                <ShieldCheck size={20} className="text-pink-500" />
                新设备安全验证
              </div>
              <p className="text-xs text-theme-secondary">
                {pwState.message || `请使用已登录 QQ ${pwState.uin ?? ''} 的手机 QQ 扫描二维码确认`}
              </p>
              {pwState.newDevice.qrPng && (
                <div className="p-3 bg-white rounded-xl shadow">
                  <img src={pwState.newDevice.qrPng} alt="新设备验证二维码" className="w-48 h-48 block rounded" />
                </div>
              )}
              {!pwState.newDevice.manualFallback && (
                <div className="flex items-center gap-2 text-xs text-theme-muted">
                  <Loader2 size={14} className="animate-spin" />
                  等待手机 QQ 扫码确认...
                </div>
              )}
              {(pwState.newDevice.qrUrl || pwState.newDevice.jumpUrl) && (
                <a
                  href={pwState.newDevice.qrUrl || pwState.newDevice.jumpUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-pink-500 hover:underline flex items-center gap-1"
                >
                  打开验证链接
                  <ExternalLink size={12} />
                </a>
              )}
              {!pwState.newDevice.manualFallback && (
                <button
                  type="button"
                  onClick={() => setShowManualNewDevice(v => !v)}
                  className="text-xs text-pink-500 hover:underline"
                >
                  {showManualNewDevice ? '收起手动凭证输入' : '手动提交验证凭证 (deviceCheckSucceedSig)'}
                </button>
              )}
              {(pwState.newDevice.manualFallback || showManualNewDevice) && (
                <form onSubmit={handleNewDeviceSubmit} className="w-full space-y-3 pt-2 border-t border-theme-divider">
                  <input
                    type="text"
                    value={newDeviceSig}
                    onChange={e => setNewDeviceSig(e.target.value)}
                    placeholder="deviceCheckSucceedSig"
                    className="w-full px-3 py-2 text-sm rounded-xl bg-theme-card border border-theme-divider text-theme"
                  />
                  <button
                    type="submit"
                    disabled={pwSubmitting}
                    className="w-full h-10 gradient-primary text-white rounded-xl text-sm font-medium disabled:opacity-50"
                  >
                    {pwSubmitting ? '提交中...' : '提交验证凭证'}
                  </button>
                </form>
              )}
              <button type="button" onClick={() => void handleCancelPasswordLogin()} className="text-xs text-theme-muted hover:underline">
                取消并返回
              </button>
            </div>
          )}

          {(activePhase === 'idle' || activePhase === 'error' || activePhase === 'online') && (
            <form onSubmit={handlePasswordSubmit} className="w-full space-y-4 text-left">
              <div>
                <label className="block text-xs font-medium text-theme-secondary mb-1.5">QQ 号</label>
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="username"
                  value={pwUin}
                  onChange={e => setPwUin(e.target.value)}
                  placeholder="请输入 QQ 号"
                  disabled={pwSubmitting}
                  className="w-full px-4 py-2.5 text-sm rounded-xl bg-theme-item border border-theme-divider text-theme focus:outline-none focus:border-pink-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-theme-secondary mb-1.5">QQ 密码</label>
                <input
                  type="password"
                  autoComplete="current-password"
                  value={pwPassword}
                  onChange={e => setPwPassword(e.target.value)}
                  placeholder="请输入 QQ 密码"
                  disabled={pwSubmitting}
                  className="w-full px-4 py-2.5 text-sm rounded-xl bg-theme-item border border-theme-divider text-theme focus:outline-none focus:border-pink-500"
                />
              </div>
              <button
                type="submit"
                disabled={pwSubmitting || !pwUin.trim() || !pwPassword}
                className="w-full h-11 px-5 gradient-primary text-white rounded-full font-medium text-base disabled:opacity-50 disabled:cursor-not-allowed hover:shadow-lg transition-all flex items-center justify-center gap-2"
              >
                {pwSubmitting ? (<><Loader2 size={18} className="animate-spin" />正在登录...</>) : '登录'}
              </button>
            </form>
          )}

          {accounts.length > 0 && activePhase !== 'captcha' && activePhase !== 'new_device_qr' && (
            <button onClick={() => setLoginMode('quick')} className="text-pink-500 text-sm hover:underline">
              快速登录已保存账号
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default QQLogin;
