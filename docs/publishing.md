# 自动发布到 npm

[Publish to npm](https://github.com/LuckyLilliaDev/lucky-lillia-plugin-ntqq-protocol/actions/workflows/publish.yml) 在推送 `v<版本号>` 标签时发布，也支持从 `main` 手动运行。手动运行默认勾选 `dry_run`，只检查、测试、构建和上传打包产物；取消勾选才会发布。正式版本使用 npm 的 `latest` 标签，带 `-beta.1` 等后缀的预发布版本使用 `next`。

CI 使用 Node.js 24 和 npm 11.16.0，通过 GitHub Actions OIDC 发布，无需配置 `NPM_TOKEN`。首次配置时，在 npm 包 `@luckylillia/plugin-nt-protocol` 的 Settings → Trusted Publisher 中选择 GitHub Actions，并填写：

| 字段 | 值 |
| --- | --- |
| Organization or user | `LuckyLilliaDev` |
| Repository | `lucky-lillia-plugin-ntqq-protocol` |
| Workflow filename | `publish.yml` |
| Environment | 留空 |

每次发布先更新 `package.json`、`package-lock.json` 与 `src/version.ts` 中的版本，并提交推送，再创建与版本一致的标签，例如：

```sh
git tag v1.0.2
git push origin v1.0.2
```

工作流先运行类型检查、单元测试及完整构建，再打包一次，解包检查后端、WebUI、公共声明和七个平台的 production 原生文件及哈希。原生模块使用仓库中已经构建并校验的完整产物，包括配套的 sidecar / VMP 加载库；CI 不重新编译原生模块，也不启动 QQ。更新原生模块时，先在 LuckyLillia.node 仓库运行 sync:plugin 同步并提交完整 `native/production`。

发布任务单独获得 `id-token: write` 权限，下载并校验前一任务的同一份 tarball，以 `--provenance` 发布。正式发布前会拒绝 npm 上已经存在的版本；所有成功构建（包括 dry run）都保留 `npm-package` artifact 14 天，包含 `.tgz`、文件清单与完整性记录。

发布后 CI 检查公共 registry 中的精确版本、npm 标签与产物 SHA-512。若 npm 仍在自动审核或暂存，CI 会明确报出版本尚未公开；此时查看 npm 的 Staged Packages，等待审核并按要求批准，不要对同一版本反复发布。发布成功后还需更新插件市场目录中的版本，Bot 才会提示市场更新。
