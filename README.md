# NTQQ 协议

LuckyLillia 的 NTQQ 插件。支持扫码、快速登录、自动登录，以及桥接本机官方 QQ 客户端。

登录后，插件通过宿主的 `ctx.bots` 注册 `ntqq:<QQ号>`，提供消息收发、事件转换和 `bot.internal`，供指令、聊天插件和 Satori 使用。这些实现都在本插件的 `src/universal/` 中，Bot 不再内置独立的“NTQQ 消息服务”。

同一账号短暂断线时保留 Bot 并更新在线状态；退出登录、切换账号或停用插件时清理 Bot 和账号资源。OneBot 11、Milky 分别安装，Satori 仍由宿主提供。

