import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  _resetTencentCaptchaSdkLoaderForTest,
  buildTencentCaptchaOptions,
  loadTencentCaptchaSdk,
  parseTencentCaptchaCallback,
  resolveTencentCaptchaConfig,
  type TencentCaptchaConstructor,
} from '../../src/client/tencentCaptcha';

describe('WebUI TencentCaptcha helpers', () => {
  beforeEach(() => {
    _resetTencentCaptchaSdkLoaderForTest();
  });

  it('resolves TCaptcha config from server payload and raw verification URL', () => {
    const config = resolveTencentCaptchaConfig(
      {
        url: 'https://ti.qq.com/safe/verify?uin=0&sid=5223612026&login_appid=16',
        sid: '5223612026',
      },
      '721011692',
    );
    expect(config).toEqual({
      appId: '2081081773',
      sid: '5223612026',
      uin: '721011692',
      loginAppId: '16',
      enableAged: 'true',
    });
    expect(buildTencentCaptchaOptions(config)).toEqual({
      bizState: { uin: '721011692' },
      type: 'embed',
      showHeader: true,
      login_appid: '16',
      uin: '721011692',
      sid: '5223612026',
      enableAged: 'true',
      captchaWidth: 300,
    });

    const oldPc = resolveTencentCaptchaConfig(
      { url: 'https://ti.qq.com/safe/verify?uin=10001&fromOldPc=1', sid: '' },
      undefined,
      'Mozilla/5.0 CurrentMode/3',
    );
    expect(oldPc).toEqual({
      appId: '1',
      sid: '2000000038',
      uin: '10001',
      loginAppId: null,
      enableAged: 'force',
    });
  });

  it('parses callback payloads and rejects cancelled or terror fallback tickets', () => {
    expect(parseTencentCaptchaCallback({
      ret: 0,
      ticket: 't03_valid_ticket',
      randstr: '@9xZ',
      appid: '2081081773',
    })).toEqual({
      status: 'success',
      ticket: 't03_valid_ticket',
      randstr: '@9xZ',
    });

    expect(parseTencentCaptchaCallback({ ret: 2, ticket: '', randstr: '' })).toEqual({
      status: 'cancelled',
    });

    expect(parseTencentCaptchaCallback({
      ret: 0,
      ticket: 'terror_1001_2081081773_1700000000',
      randstr: '@err',
      errorCode: 1001,
      errorMessage: 'jsload_error',
    })).toEqual({
      status: 'error',
      message: '滑块组件加载异常 (jsload_error)，请刷新重试',
    });

    expect(parseTencentCaptchaCallback({
      ret: 0,
      ticket: 'terror_1002_fallback',
      randstr: '@err',
    })).toEqual({
      status: 'error',
      message: '滑块组件未能获取有效票据，请刷新重试',
    });
  });

  it('falls back to backup CDN URL when primary fails and returns registered constructor', async () => {
    let fakeCtor: TencentCaptchaConstructor | undefined;
    const loadScript = vi.fn(async (src: string) => {
      if (src.includes('captcha.gtimg.com')) {
        throw new Error('CDN blocked');
      }
      fakeCtor = class {
        show() {}
      } as unknown as TencentCaptchaConstructor;
    });

    const ctor = await loadTencentCaptchaSdk({
      loadScript,
      getGlobal: () => fakeCtor,
      urls: ['https://captcha.gtimg.com/TCaptcha.js', 'https://ssl.captcha.qq.com/TCaptcha.js'],
    });
    expect(ctor).toBe(fakeCtor);
    expect(loadScript).toHaveBeenCalledTimes(2);
  });
});
