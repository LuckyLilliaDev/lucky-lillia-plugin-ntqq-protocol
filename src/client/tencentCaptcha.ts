export const DEFAULT_TCAPTCHA_APP_ID = '2081081773';
export const DEFAULT_TCAPTCHA_SID = '2000000038';

export const TCAPTCHA_SCRIPT_URLS = [
  'https://captcha.gtimg.com/TCaptcha.js',
  'https://ssl.captcha.qq.com/TCaptcha.js',
] as const;

export interface CaptchaChallengePayload {
  url: string;
  sid: string;
  appId?: string;
  loginAppId?: string;
}

export interface ResolvedTencentCaptchaConfig {
  appId: string;
  sid: string;
  uin: string;
  loginAppId: string | null;
  enableAged: 'true' | 'force';
}

export type ParsedCaptchaCallback =
  | { status: 'success'; ticket: string; randstr: string }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };

export interface TencentCaptchaInstance {
  show: () => void;
  destroy?: () => void;
  refresh?: () => void;
}

export type TencentCaptchaConstructor = new (
  container: HTMLElement,
  appId: string,
  callback: (res: unknown) => void,
  options?: Record<string, unknown>,
) => TencentCaptchaInstance;

interface WindowWithTencentCaptcha {
  TencentCaptcha?: TencentCaptchaConstructor;
}

export function extractQueryParam(url: string, key: string): string | null {
  const qIdx = url.indexOf('?');
  if (qIdx < 0) return null;
  const hashIdx = url.indexOf('#', qIdx + 1);
  const query = hashIdx >= 0 ? url.slice(qIdx + 1, hashIdx) : url.slice(qIdx + 1);
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    if (pair.slice(0, eq) === key) {
      try {
        return decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' '));
      } catch {
        return pair.slice(eq + 1);
      }
    }
  }
  return null;
}

export function resolveTencentCaptchaConfig(
  captcha: CaptchaChallengePayload,
  uin?: string,
  userAgent = '',
): ResolvedTencentCaptchaConfig {
  const urlUin = extractQueryParam(captcha.url, 'uin');
  const resolvedUin = (uin && uin.trim()) || (urlUin && urlUin !== '0' ? urlUin : '') || '';
  const sid = captcha.sid || extractQueryParam(captcha.url, 'sid') || DEFAULT_TCAPTCHA_SID;
  const aid = captcha.appId || extractQueryParam(captcha.url, 'aid');
  const fromOldPc = extractQueryParam(captcha.url, 'fromOldPc');
  const appId = aid || (fromOldPc ? '1' : DEFAULT_TCAPTCHA_APP_ID);
  const loginAppId = captcha.loginAppId || extractQueryParam(captcha.url, 'login_appid') || null;
  const enableAged = userAgent.includes('CurrentMode/3') ? 'force' : 'true';
  return { appId, sid, uin: resolvedUin, loginAppId, enableAged };
}

export function buildTencentCaptchaOptions(config: ResolvedTencentCaptchaConfig): Record<string, unknown> {
  return {
    bizState: { uin: config.uin },
    type: 'embed',
    showHeader: true,
    login_appid: config.loginAppId,
    uin: config.uin,
    sid: config.sid,
    enableAged: config.enableAged,
    captchaWidth: 300,
  };
}

export function parseTencentCaptchaCallback(res: unknown): ParsedCaptchaCallback {
  if (!res || typeof res !== 'object') {
    return { status: 'error', message: '滑块返回结果格式无效，请刷新重试' };
  }
  const record = res as Record<string, unknown>;
  if (record.ret === 2) {
    return { status: 'cancelled' };
  }
  if (typeof record.errorCode === 'number' && record.errorCode !== 0) {
    const detail = typeof record.errorMessage === 'string' && record.errorMessage ? ` (${record.errorMessage})` : '';
    return { status: 'error', message: `滑块组件加载异常${detail}，请刷新重试` };
  }
  if (record.ret !== 0) {
    return { status: 'error', message: '滑块验证未通过，请刷新重试' };
  }
  const ticket = typeof record.ticket === 'string' ? record.ticket.trim() : '';
  const randstrRaw = typeof record.randstr === 'string'
    ? record.randstr
    : typeof record.randStr === 'string'
      ? record.randStr
      : '';
  const randstr = randstrRaw.trim();
  if (!ticket || !randstr || ticket.startsWith('terror_')) {
    return { status: 'error', message: '滑块组件未能获取有效票据，请刷新重试' };
  }
  return { status: 'success', ticket, randstr };
}

function defaultLoadScriptTag(src: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const tag = document.createElement('script');
    tag.async = true;
    tag.onload = () => {
      tag.onload = null;
      tag.onerror = null;
      resolve();
    };
    tag.onerror = () => {
      tag.onload = null;
      tag.onerror = null;
      tag.parentNode?.removeChild(tag);
      reject(new Error(`加载 ${src} 失败`));
    };
    tag.src = src;
    document.head.appendChild(tag);
  });
}

function defaultGetGlobalConstructor(): TencentCaptchaConstructor | undefined {
  if (typeof window === 'undefined') return undefined;
  const ctor = (window as unknown as WindowWithTencentCaptcha).TencentCaptcha;
  return typeof ctor === 'function' ? ctor : undefined;
}

let inflightSdkPromise: Promise<TencentCaptchaConstructor> | null = null;

/**
 * Loads `TCaptcha.js` at most once per window (`TCaptcha.js` throws if injected twice)
 * and falls back across Tencent CDN endpoints on network failure.
 */
export function loadTencentCaptchaSdk(deps?: {
  loadScript?: (src: string) => Promise<void>;
  getGlobal?: () => TencentCaptchaConstructor | undefined;
  urls?: readonly string[];
}): Promise<TencentCaptchaConstructor> {
  const getGlobal = deps?.getGlobal ?? defaultGetGlobalConstructor;
  const existing = getGlobal();
  if (existing) return Promise.resolve(existing);

  const isDefaultRuntime = !deps;
  if (isDefaultRuntime && inflightSdkPromise) {
    return inflightSdkPromise;
  }

  const loadScript = deps?.loadScript ?? defaultLoadScriptTag;
  const urls = deps?.urls ?? TCAPTCHA_SCRIPT_URLS;

  const task = (async () => {
    let lastError: unknown;
    for (const url of urls) {
      try {
        await loadScript(url);
        const loaded = getGlobal();
        if (loaded) return loaded;
        lastError = new Error(`脚本 ${url} 加载后未注册 TencentCaptcha`);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('滑块验证脚本加载失败');
  })();

  if (isDefaultRuntime) {
    inflightSdkPromise = task.catch((err) => {
      inflightSdkPromise = null;
      throw err;
    });
    return inflightSdkPromise;
  }

  return task;
}

export function _resetTencentCaptchaSdkLoaderForTest(): void {
  inflightSdkPromise = null;
}
