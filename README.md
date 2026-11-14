# NTQQ 协议

LuckyLillia 的可选 NTQQ 插件，npm 包名为 @luckylillia/plugin-nt-protocol。支持扫码、快速登录、自动登录，以及桥接本机官方 QQ 客户端。

Bot 本体不再包含 NTQQ 和原生模块。只使用 QQ 官方机器人时无需安装本插件；需要 OneBot 11、Milky、WebQQ 或 Satori 的个人 QQ 账号功能时安装它。OneBot 11 和 Milky 的网络服务分别由 @luckylillia/plugin-onebot11、@luckylillia/plugin-milky 提供。

## 安装与使用

在 Bot 插件页安装此包，确认信任后启用；源码联调可把构建后的目录放进 Bot 的插件扫描目录，或者在本目录执行 npm pack，再通过本地安装入口上传生成的 tgz。

启用后打开「NTQQ 协议」页，选择纯协议或官方 QQ 客户端桥接，设置 Auth Token。桥接模式还需要本机安装 QQ，路径留空时自动检测。登录成功后出现「自动登录」勾选框，保存的是当前实例的 QQ 号，修改该选项不会中断当前会话。启动参数 -q / --qq 优先于保存的账号。

停用或卸载插件会关闭它的会话、登录路由和账号资源；依赖这些服务的插件等待 NTQQ 重新启用和登录。协议暂时断线会保留同一身份的数据库和服务。FFmpeg 是另一个可选插件，媒体功能需要它时会提示安装。

## 配置与数据

插件开关、登录模式和 autoLoginUin 存在当前实例的 plugins.json 中。旧版 builtin:nt-protocol 条目由 Bot 启动迁移为本包名，保留 ID、配置、生效范围和界面位置；迁移不会自动安装包，也不会新增第三方信任。

已有 Auth Token、加密 session、机器标识、设备信息和 NT 消息数据库继续沿用原来的 data 布局，避免升级后丢失登录记录。插件更新和卸载不会删除这些账号数据。多个实例共享安装目录时，共享的是包版本；每个实例的开关、设置和运行会话仍独立。

## 开发与构建

要求 Node.js 22.15 或更新版本。

    npm ci
    npm run check
    npm test
    npm run build
    npm pack

构建同时输出后端、WebUI、公共声明及 OneBot action 名单，并校验 native/production 下所有平台的完整性，不执行原生模块。测试使用隔离临时目录与模拟协议，不启动 QQ、不登录账号。

原生模块源码仍在独立 LuckyLillia.node 仓库。在那个仓库构建并同步已校验的产物：

    npm run build
    npm run sync:plugin -- --plugin-dir <本插件的绝对路径>

同步目标是 native/production/<平台>/LuckyLillia.NTQQ.node。原生构建本身支持 Windows x64、macOS x64/arm64、Linux glibc x64/arm64 和 musl x64/arm64；发布包的支持范围以随包 manifest 为准。开发授权产物放 native/development，只用于 --dev，发布白名单只包含 production。

加载前会把完整目标目录（包括 Windows 旁加载文件）复制到系统临时目录，以内容 hash 隔离原生文件，避免更新时覆盖正在使用的 .node。原生 init 的回调通过进程级转发器接到本次插件实例，热重载不会继续调用旧实例。

## 对其他插件开放的入口

| 入口 | 内容 |
| --- | --- |
| /types | 可供前端使用的 NT 枚举和数据类型 |
| /api | 数据、协议结构与消息构造工具；导入不加载原生模块 |
| /contracts | 注入服务的类型约定 |
| /onebot | 无 HTTP/WS 连接的 OneBot 账号 action 实现 |

运行时通过 ctx 注入 qqProtocol、NT API、app、store 或 ntOnebot；不要创建另一套账号服务。NTQQ 登录后由 Bot 的中立层注册平台名 ntqq 的 bot。需要跨平台的插件优先使用 SDK 的 session.bot / ctx.bots。

Bot 内保存一份纯 API 和声明快照，普通 Bot 构建无需此仓库。修改公开接口后，在 Bot 仓库执行 node scripts/sync-ntqq-api.mjs <本插件路径>，再运行 SDK 生成和一致性检查。
