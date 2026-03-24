# 部署说明

## 当前部署形态

- 代码目录：`/opt/yHunter`
- 运行数据目录：`/var/lib/yhunter`
- 运行数据文件：`/var/lib/yhunter/db.json`
- 进程管理：`pm2`
- 反向代理：`nginx`
- Node 版本：`22.x`

项目代码通过 Git 更新，运行数据不跟着 Git 走。

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

启动：

```bash
cd /opt/yHunter
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

如果 `pm2 startup` 输出额外命令，按提示再执行一次。

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

代码更新后，在服务器执行：

```bash
cd /opt/yHunter
git pull
npm install
npm run build
pm2 restart ecosystem.config.cjs --update-env
pm2 save
```

如果你想在本机一键部署，可以使用仓库自带脚本。

### 本机一键部署

先复制配置文件：

```bash
cp scripts/deploy.example.env scripts/deploy.env
```

按实际情况填写：

```bash
DEPLOY_HOST=your-server-ip
DEPLOY_USER=root
DEPLOY_PATH=/opt/yHunter
```

然后在本机执行：

```bash
./scripts/deploy.sh
```

脚本会自动完成：

- SSH 登录服务器
- `git pull`
- `npm install`
- `npm run build`
- `pm2 restart ecosystem.config.cjs --update-env`
- `pm2 save`

## GitHub Actions 自动部署

如果希望 `push 到 main` 后自动更新服务器，可以使用仓库自带工作流：

`[deploy.yml](/Users/fan/Documents/project/yHunter/.github/workflows/deploy.yml)`

### 需要配置的 GitHub Secrets

在 GitHub 仓库：

- `Settings`
- `Secrets and variables`
- `Actions`

新增这些 secrets：

- `DEPLOY_HOST`
- `DEPLOY_USER`
- `DEPLOY_SSH_KEY`
- `DEPLOY_PORT`（可选，默认 `22`）

推荐值：

- `DEPLOY_HOST`: 服务器公网 IP
- `DEPLOY_USER`: `root`
- `DEPLOY_PORT`: `22`

`DEPLOY_SSH_KEY` 需要填写“GitHub Actions 用来登录服务器”的私钥内容。

### 服务器侧准备

1. 在服务器上生成一把专门给 GitHub Actions 使用的 SSH key，或使用现有允许登录服务器的私钥对应公钥。
2. 把公钥加入服务器用户的 `~/.ssh/authorized_keys`。
3. 确保服务器上这些命令已经可用：

```bash
cd /opt/yHunter
git pull
npm install
npm run build
pm2 restart ecosystem.config.cjs --update-env
pm2 save
```

### 工作流行为

触发条件：

- push 到 `main`
- 手动点击 `Run workflow`

执行内容：

- SSH 登录服务器
- 进入 `/opt/yHunter`
- `git pull`
- `npm install`
- `npm run build`
- `pm2 restart ecosystem.config.cjs --update-env`
- `pm2 save`

## 常用运维命令

```bash
pm2 status
pm2 logs yhunter
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
