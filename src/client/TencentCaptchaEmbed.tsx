import React, { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import {
  buildTencentCaptchaOptions,
  loadTencentCaptchaSdk,
  parseTencentCaptchaCallback,
  resolveTencentCaptchaConfig,
  type TencentCaptchaInstance,
} from './tencentCaptcha';

interface TencentCaptchaEmbedProps {
  url: string;
  sid: string;
  appId?: string;
  loginAppId?: string;
  uin?: string;
  reloadKey: number;
  submitting?: boolean;
  onVerified: (ticket: string, randstr: string) => void;
}

const TencentCaptchaEmbed: React.FC<TencentCaptchaEmbedProps> = ({
  url,
  sid,
  appId,
  loginAppId,
  uin,
  reloadKey,
  submitting = false,
  onVerified,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const onVerifiedRef = useRef(onVerified);
  onVerifiedRef.current = onVerified;

  const [status, setStatus] = useState<'loading' | 'ready' | 'cancelled' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    const host = containerRef.current;
    if (!host) return;

    let disposed = false;
    let verified = false;
    let instance: TencentCaptchaInstance | null = null;
    setStatus('loading');
    setErrorMessage('');

    const config = resolveTencentCaptchaConfig(
      { url, sid, appId, loginAppId },
      uin,
      typeof navigator !== 'undefined' ? navigator.userAgent : '',
    );

    loadTencentCaptchaSdk()
      .then((TencentCaptcha) => {
        if (disposed) return;

        const mountEl = document.createElement('div');
        host.appendChild(mountEl);
        instance = new TencentCaptcha(
          mountEl,
          config.appId,
          (res: unknown) => {
            if (disposed || verified) return;
            const parsed = parseTencentCaptchaCallback(res);
            if (parsed.status === 'success') {
              verified = true;
              onVerifiedRef.current(parsed.ticket, parsed.randstr);
            } else if (parsed.status === 'cancelled') {
              setStatus('cancelled');
            } else {
              setErrorMessage(parsed.message);
              setStatus('error');
            }
          },
          buildTencentCaptchaOptions(config),
        );
        setStatus('ready');
        instance.show();
      })
      .catch((err) => {
        if (disposed) return;
        setErrorMessage(err instanceof Error ? err.message : '安全验证加载失败，请检查网络或浏览器拦截设置');
        setStatus('error');
      });

    return () => {
      disposed = true;
      try {
        instance?.destroy?.();
      } catch {
        // Ignore SDK cleanup errors
      }
      host.replaceChildren();
    };
  }, [url, sid, appId, loginAppId, uin, reloadKey]);

  return (
    <div className="relative w-[316px] max-w-full overflow-x-auto rounded-xl bg-white p-2 shadow">
      {/* The SDK's embed iframe can be shorter than the instruction and image grid. */}
      <div ref={containerRef} className="w-[300px] min-h-[400px] [&_iframe]:min-h-[400px]" />

      {(submitting || status !== 'ready') && (
        <div role="status" className="absolute inset-0 z-[2000000003] flex items-center justify-center gap-2 bg-white px-4 text-center text-xs text-slate-600">
          {(submitting || status === 'loading') && <Loader2 size={16} className="animate-spin text-pink-500" />}
          {submitting ? '正在提交验证结果...' : status === 'loading' ? '正在加载安全验证...' :
            status === 'cancelled' ? '验证窗口已关闭' : errorMessage}
        </div>
      )}
    </div>
  );
};

export default TencentCaptchaEmbed;
