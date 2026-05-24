# Agent 工作约定

本文件是给 Codex、自动化代理和新开的本地修改进程看的仓库入口说明。开始修改或提交前必须先读本文件。

## 本地数据和服务端数据必须分离

- `data/db.json` 是本地开发样例和本地刷新缓存，不是生产运行数据。
- 服务端真实运行数据在 `/var/lib/yhunter/db.json`，由 `YHUNTER_DATA_DIR=/var/lib/yhunter` 指向，部署时不能用 Git 里的 `data/db.json` 覆盖它。
- 本地刷新、页面调试或接口测试会改动 `data/db.json`，这些改动默认只留在本机。
- 除非用户明确说“更新仓库里的样例数据”或“提交 data/db.json”，否则不要 stage、commit、push `data/db.json`。
- 提交前必须检查 `git status --short` 和 `git diff --cached --name-only`。如果看到 `data/db.json` 被暂存，而用户没有明确要求更新样例数据，必须先取消暂存并恢复为仓库样例版本后再提交。

## 提交前检查

- 代码修改通常需要运行 `npm run typecheck`。
- 文档-only 修改不需要强行跑构建，但仍要检查 `git status --short --branch`。
- 推送前再次确认提交内容只包含本次用户要求的代码或文档变更。
- 不要从本机手动 SSH 到服务器部署。日常部署路径是提交并 `git push origin main`，由仓库的 `Deploy` GitHub Action 使用服务器凭据触发服务器侧 `git pull`、`npm install`、`npm run build` 和 PM2 重启。除非用户明确要求，不要运行 `scripts/deploy.sh` 或手动 SSH 登录服务器部署。

更多部署细节见 `DEPLOY.md`。
