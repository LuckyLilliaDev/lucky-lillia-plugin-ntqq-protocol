import { Context } from 'cordis'
import { isNativeQQMode } from './support/utils/environment'
import { Hono } from 'hono'
import { createAuthTokenRoutes } from './authTokenRoutes'
import { QuickLoginUnsupportedError } from './qqProtocol/base'

/** QR / quick login and logout of the scanned account; mounted by NTLoginRoutes while the NT protocol runs. */
export function createLoginRoutes(ctx: Context): Hono {
  const router = new Hono()

  router.get('/login-qrcode', async (c) => {
    try {
      const data = await ctx.ntLoginApi.getLoginQrCode()
      return c.json({
        success: true,
        data,
      })
    } catch (e) {
      return c.json({ success: false, message: '获取登录二维码失败', error: e }, 500)
    }
  })

  router.get('/quick-login-list', async (c) => {
    try {
      const data = await ctx.ntLoginApi.getQuickLoginList()
      return c.json({
        success: true,
        data,
      })
    } catch (e) {
      return c.json({ success: false, message: e instanceof Error ? e.message : '获取快速登录账号列表失败' },
        e instanceof QuickLoginUnsupportedError ? 501 : 500)
    }
  })

  // Protocol implementations wait for the selected account to be online; FE then refreshes login-info.
  router.post('/quick-login', async (c) => {
    const { uin } = await c.req.json()
    if (!uin) {
      return c.json({ success: false, message: '没有选择QQ号' }, 400)
    }
    try {
      await ctx.qqProtocol.quickLogin(String(uin))
      // QQLogin.tsx 用 data.result === '0' 判断成功
      return c.json({ success: true, data: { result: '0', loginErrorInfo: { errMsg: '' } } })
    } catch (e) {
      return c.json({
        success: false,
        message: (e as Error).message || '快速登录失败',
        data: { result: '-1', loginErrorInfo: { errMsg: (e as Error).message || '快速登录失败' } },
      }, e instanceof QuickLoginUnsupportedError ? 501 : 500)
    }
  })

  // 官方 QQ 客户端桥接: 启动本机 QQ 并注入, 之后的进度看 /api/login-info 的 nativeQQ.status
  router.post('/nativeqq/launch', async (c) => {
    if (!isNativeQQMode()) return c.json({ success: false, message: '只有官方 QQ 客户端桥接需要启动 QQ' }, 400)
    try {
      await ctx.qqProtocol.launch()
      return c.json({ success: true })
    } catch (e) {
      return c.json({ success: false, message: (e as Error).message || '启动 QQ 失败' }, 500)
    }
  })

  // 移动端 (iPad / iPhone / 鸿蒙 Pad / 鸿蒙手机) 账号密码登录状态机与交互接口
  router.get('/login-state', (c) => {
    return c.json({
      success: true,
      data: ctx.qqProtocol.getPasswordLoginState(),
    })
  })

  router.post('/password-login', async (c) => {
    const body = await c.req.json().catch(() => ({})) as { uin?: string; password?: string }
    const uin = String(body.uin ?? '').trim()
    const password = String(body.password ?? '')
    if (!uin || !password) {
      return c.json({ success: false, message: '请填写 QQ 号和密码' }, 400)
    }
    try {
      const state = await ctx.qqProtocol.passwordLogin(uin, password)
      return c.json({ success: true, data: state })
    } catch (e) {
      return c.json({ success: false, message: (e as Error).message || '密码登录失败' }, 400)
    }
  })

  router.post('/login-captcha', async (c) => {
    const body = await c.req.json().catch(() => ({})) as { ticket?: string; randstr?: string; randStr?: string; sid?: string }
    const ticket = String(body.ticket ?? '').trim()
    const randStr = String(body.randstr ?? body.randStr ?? '').trim()
    const sid = body.sid ? String(body.sid).trim() : undefined
    if (!ticket || !randStr) {
      return c.json({ success: false, message: '请填写完整的 ticket 和 randstr' }, 400)
    }
    try {
      const state = await ctx.qqProtocol.submitLoginCaptcha(ticket, randStr, sid)
      return c.json({ success: true, data: state })
    } catch (e) {
      return c.json({ success: false, message: (e as Error).message || '提交滑块验证失败' }, 400)
    }
  })

  router.post('/login-new-device', async (c) => {
    const body = await c.req.json().catch(() => ({})) as { sig?: string }
    const sig = String(body.sig ?? '').trim()
    if (!sig) {
      return c.json({ success: false, message: '请填写新设备验证凭证' }, 400)
    }
    try {
      const state = await ctx.qqProtocol.submitNewDeviceSig(sig)
      return c.json({ success: true, data: state })
    } catch (e) {
      return c.json({ success: false, message: (e as Error).message || '提交新设备验证失败' }, 400)
    }
  })

  router.post('/login-cancel', (c) => {
    ctx.qqProtocol.cancelPasswordLogin()
    return c.json({ success: true })
  })

  // NativeQQ 模式的登录归外部 QQ 客户端管, 直接拒绝
  router.post('/logout', async (c) => {
    if (isNativeQQMode()) {
      return c.json({ success: false, message: '官方 QQ 客户端桥接的登录由 QQ 客户端管理，不能在这里退出' }, 400)
    }
    try {
      await ctx.qqProtocol.logout()
      return c.json({ success: true })
    } catch (e) {
      return c.json({ success: false, message: (e as Error).message || '退出登录失败' }, 500)
    }
  })

  return router
}

/** The login routes of the scanned account, present only while the NT protocol plugin runs. */
export const NTLoginRoutes = {
  name: 'webui-nt-login-routes',
  inject: ['webuiServer', 'ntLoginApi', 'qqProtocol'],
  apply(ctx: Context) {
    const app = new Hono()
      .route('/api', createLoginRoutes(ctx))
      .route('/api', createAuthTokenRoutes(ctx))
    for (const prefix of [
      '/api/login-qrcode',
      '/api/quick-login-list',
      '/api/quick-login',
      '/api/login-state',
      '/api/password-login',
      '/api/login-captcha',
      '/api/login-new-device',
      '/api/login-cancel',
      '/api/logout',
      '/api/auth-token',
      '/api/nativeqq/launch',
    ]) {
      ctx.webuiServer.route(prefix, app)
    }
  },
}
