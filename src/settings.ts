import Schema from 'schemastery'
import type { NTProtocolConfig } from './support/types'

// An entry is saved without what equals these defaults, so changing one changes every entry that left it out:
// installs from before the change get the old value written in (migrateToInstances in main/config/migrate.ts)
export const NTProtocolSchema: Schema<NTProtocolConfig> = Schema.object({
  mode: Schema.union([
    Schema.const('direct').description('纯协议'),
    Schema.const('native').description('官方 QQ 客户端桥接'),
    // Anything else is the pure protocol: a mistyped --ntqq-mode, or nativeqq saved before the bridge was renamed
    Schema.transform(Schema.any(), () => 'direct' as const),
  ]).default('direct').description('登录方式'),
  protocol: Schema.union([
    Schema.const('linux').description('Linux'),
    Schema.const('macos').description('macOS'),
    Schema.const('windows').description('Windows'),
    Schema.const('watch').description('Android 手表'),
    Schema.const('ipad').description('iPad'),
    Schema.const('iphone').description('iPhone'),
    Schema.const('harmonypad').description('鸿蒙 Pad'),
    Schema.const('harmony').description('鸿蒙手机'),
  ]).default('linux').description('协议'),
  nativeQQ: Schema.object({
    qqPath: Schema.string().default('').description('QQ 可执行文件绝对路径（留空自动检测）'),
    hookMode: Schema.string().default('').hidden().description('NativeQQ 注入方式（留空：docker 里用 inline，其他用 NativeQQ 的默认）'),
  }).description('官方 QQ 客户端桥接'),
  signCDN: Schema.union([
    Schema.const('cf').description('Cloudflare'),
    Schema.const('china').description('中国大陆'),
  ]).default('cf').hidden().description('签名服务线路'),
  autoLoginUin: Schema.string().pattern(/^(?:[1-9][0-9]*)?$/).default('').hidden()
    .description('实例启动时自动登录的 QQ 号，登录成功后设置，留空关闭'),
}) as Schema<NTProtocolConfig>
