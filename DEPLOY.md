# 部署说明

## 当前部署形态

- 代码目录：`/opt/yHunter`
- 运行数据目录：`/var/lib/yhunter`
- 运行数据文件：`/var/lib/yhunter/db.json`
- 进程管理：`pm2`
- 反向代理：`nginx`
- Node 版本：`22.x`

项目代码通过 Git 更新，运行数据不跟着 Git 走。

## Git 提交约定

- `data/db.json` 只作为本地开发样例和本地刷新缓存使用。
- 服务器真实运行数据在 `/var/lib/yhunter/db.json`，部署时不会从 Git 覆盖。
- 本地执行刷新后如果 `data/db.json` 出现变更，默认不要提交到 GitHub，除非明确要更新仓库里的样例数据。
- 新开的 Codex/自动化进程开始修改前必须先读根目录 `AGENTS.md`。
- 提交前必须检查 `git status --short` 和 `git diff --cached --name-only`。如果 `data/db.json` 被暂存，而本次任务没有明确要求更新样例数据，必须取消暂存并恢复为仓库样例版本后再提交。
- 如果只是为了本地页面或接口验证刷了数据，可以在本机对 `data/db.json` 使用 `git update-index --skip-worktree data/db.json` 降低误提交风险；这只是本机保护，不代表可以把刷新数据推到远端。

## 首次部署

### 1. 服务器准备

确保服务器已安装：

- `git`
- `node`
- `npm`
- `pm2`
- `nginx`

Ubuntu 24.04 上可参考：

```bash
npm install -g pm2
apt update
apt install -y nginx
```

### 2. GitHub SSH

在服务器上配置好 GitHub SSH，并验证：

```bash
ssh -T git@github.com
```

预期返回：

```text
Hi <your-github-name>! You've successfully authenticated, but GitHub does not provide shell access.
```

### 3. 拉取代码并准备数据目录

```bash
mkdir -p /opt /var/lib/yhunter
cd /opt
git clone git@github.com:w2fan/yHunter.git
cd /opt/yHunter
cp data/db.json /var/lib/yhunter/db.json
```

### 4. 兼容浦发旧 TLS

服务器访问浦发部分站点时需要开启 legacy renegotiation。创建：

`/opt/yHunter/openssl-legacy.cnf`

内容：

```ini
openssl_conf = default_conf

[default_conf]
ssl_conf = ssl_sect

[ssl_sect]
system_default = system_default_sect

[system_default_sect]
Options = UnsafeLegacyRenegotiation
```

可用下面命令验证：

```bash
OPENSSL_CONF=/opt/yHunter/openssl-legacy.cnf curl -I https://per.spdb.com.cn/api/search
```

### 5. 安装依赖并构建

```bash
cd /opt/yHunter
npm install
npm run build
```

### 6. PM2 配置

项目使用根目录下的 `ecosystem.config.cjs`，其中已经包含：

- `PORT=3000`
- `YHUNTER_DATA_DIR=/var/lib/yhunter`
- `OPENSSL_CONF=/opt/yHunter/openssl-legacy.cnf`
- 一个每日自动刷新进程 `yhunter-refresh-scheduler`

启动：

```bash
cd /opt/yHunter
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

如果 `pm2 startup` 输出额外命令，按提示再执行一次。

`yhunter-refresh-scheduler` 默认每天服务器本地时间 `09:20,16:20,22:20` 调用 `/api/dashboard`，用于把浦银理财这类“官网只返回当前万份收益”的数据源固化到 `/var/lib/yhunter/db.json`。同一净值日期会按来源和日期去重，多次刷新不会重复污染数据；这样做是为了降低官网较晚更新时漏掉当天万份收益的概率。如果要调整时间，修改 `ecosystem.config.cjs` 里的 `YHUNTER_REFRESH_AT` 后重新执行：

```bash
pm2 restart ecosystem.config.cjs --update-env
pm2 save
```

需要手动补一次当天数据时，可在服务器执行：

```bash
cd /opt/yHunter
npm run refresh
```

## 收益历史口径

货币类产品的业绩追踪以管理人官网披露的每日万份收益为主线。评分、动能和前端曲线只使用带 `per10kProfit` 的官网历史点：

- 民生理财、招银理财、光大理财、信银理财：官网历史接口可以返回日频万份收益，刷新时会尽量补齐完整历史。
- 浦银理财：官网当前接口只返回最新万份收益，历史需要依赖定时刷新逐日固化。
- 浦发列表中的 `近七日年化` 只作为榜单快照和横向参考，不进入万份收益曲线。
- 季报 PDF 中的 `spdb_report` 点不是日频数据，不进入评分、动能和图表，也不会在后续刷新时继续写入有效 `navHistory`。

如果发现某个产品日频样本不足，优先检查 `pm2 logs yhunter-refresh-scheduler` 和 `/var/lib/yhunter/db.json` 中该产品的 `navHistory` 来源。

### 7. Nginx 反向代理

写入 `/etc/nginx/sites-available/yhunter`：

```nginx
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

启用：

```bash
rm -f /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/yhunter /etc/nginx/sites-enabled/yhunter
nginx -t
systemctl reload nginx
```

## 更新部署

日常部署依赖仓库里的 `Deploy` GitHub Action：本地提交并 `git push origin main` 后，GitHub Action 使用仓库 secrets 中的服务器凭据连接服务器，然后在服务器本机进入 `/opt/yHunter` 执行拉取、构建和 PM2 重启。Codex 或本机操作员通常只需要完成提交和推送，不需要从本机手动 SSH 登录服务器部署。

服务器侧自动化的等价执行内容是：

```bash
cd /opt/yHunter
git pull
npm install
npm run build
pm2 restart ecosystem.config.cjs --update-env
pm2 save
```

`scripts/deploy.sh` 是早期本机 SSH 部署脚本，当前不是默认部署路径。除非明确要走 SSH 兜底，不要使用它。

## GitHub Actions

仓库保留 `.github/workflows/deploy.yml` 作为唯一的部署 workflow。它在 push 到 `main` 时自动触发，也可以通过 GitHub 页面上的 `workflow_dispatch` 手动触发。workflow 不把本地数据推到服务器，而是通过 SSH 进入服务器，在服务器本机执行 `git pull`、安装依赖、构建和 PM2 重启。

旧的 nightly refresh GitHub Action 已移除。定时刷新由 PM2 进程 `yhunter-refresh-scheduler` 在服务器本地执行，避免 GitHub Actions 定时任务和服务器内置刷新重复写数据。

## 常用运维命令

```bash
pm2 status
pm2 logs yhunter
pm2 logs yhunter-refresh-scheduler
pm2 restart yhunter
pm2 restart ecosystem.config.cjs --update-env
systemctl status nginx
```

## 故障排查

### 页面出现 `curl exited with code 35`

优先检查：

```bash
cat /opt/yHunter/openssl-legacy.cnf
pm2 env 0 | grep OPENSSL_CONF
```

确认 PM2 进程带上了：

```text
OPENSSL_CONF=/opt/yHunter/openssl-legacy.cnf
```

### 验证应用是否在线

```bash
curl http://127.0.0.1:3000/
curl http://127.0.0.1:3000/api/dashboard/progress
curl http://127.0.0.1/
```

### 数据位置

线上真实运行数据在：

```text
/var/lib/yhunter/db.json
```

不要把服务器上的这个文件用 `git pull` 覆盖掉。
