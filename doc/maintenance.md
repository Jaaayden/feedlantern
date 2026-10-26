# 升级维护

以下命令在部署目录执行。

```sh
docker compose ps
docker compose logs --tail=100 feedlantern
docker compose restart
docker compose stop
docker compose start
```

## 升级

默认的 `latest` 镜像跟随通过全部 CI 及 amd64/arm64 容器验证的 `main` 分支。代码推送后需等待 GitHub Actions 的 `publish` 作业成功；仅有代码更新不代表新镜像已经可拉取。运行中的容器不会自动升级。

升级前从网页导出完整备份，并保存当前部署文件及 `.env`。查看变更说明，尤其是数据库兼容性变更。

### 从 v0.9.0 升级到 v0.10.0

可以直接更新，数据库仍为 schema 23，无需手工执行 SQL。翻译统计索引在启动时自动创建；原账号、订阅地址、保留设置、已保存内容和累计统计保持不变。

“需要检查”默认改为连续抓取失败 3 次后计入，可在“设置 → 通知 → 告警策略”按用户调整；成功一次清零。推送通知仍使用独立阈值，核心规则异常仍按原判定提示。未达到次数的抓取失败会保留原因和日志，启用中的订阅显示“等待重试”。

镜像已精简，抓取和可视化编辑仍使用带沙箱的 Chromium。没有编辑或抓取任务时，浏览器空闲 60 秒后退出，下次需要时重新启动。升级前仍应备份完整数据卷及部署配置。

### 从 v0.7.0 升级到 v0.9.0

可以直接更新镜像，无需先安装 v0.8.x，也无需手工执行 SQL。启动时程序自动将数据库从 schema 19 依次迁移到 23，增加账号语言、PubMed 验证记录和仪表盘统计；保留账号、订阅地址、已保存内容及译文。原数据卷中的 `master.key` 必须一起保留，否则已有加密配置无法解密。

累计采集和翻译从升级启用统计时开始记录，界面显示起始日期；旧版已清理的历史不能补算。之后清理内容、删除订阅和清理日志均不会减少累计，完整备份也会保存这些值。PubMed RSS 订阅不会自动转换，需要在界面核对后确认。回退必须同时恢复升级前数据，不能只换回旧镜像。

### 旧部署首次切换

在原部署目录，编辑当前实际使用的 Compose 文件（可能是 `docker-compose.yml` 或旧版 `compose.yaml`），将服务的镜像改为：

```yaml
image: ghcr.io/jaaayden/feedlantern:latest
```

也可保留变量写法 `image: ghcr.io/jaaayden/feedlantern:${FEEDLANTERN_VERSION:-latest}`，但需将 `.env` 或 shell 中已有的 `FEEDLANTERN_VERSION` 改为 `latest`，避免旧值继续锁定版本。不要同时新建另一份 Compose 文件；保留项目名、端口、环境配置、沙箱规则和数据卷挂载。

确认最终镜像是 `ghcr.io/jaaayden/feedlantern:latest`：

```sh
docker compose config --images
```

### 每次更新

在同一部署目录执行（如果原来使用 `-f` 或 `-p`，继续使用相同参数）：

```sh
docker compose pull feedlantern
docker compose up -d --wait feedlantern
docker compose ps
docker compose logs --tail=50 feedlantern
```

`pull` 下载镜像，`up` 使用新镜像重建容器并保留挂载的数据卷。单独 `restart` 不会切换到新镜像。不需要先 `down`，不要执行 `down -v`。

确认登录、订阅历史、RSS 和立即刷新正常。后续重复上述命令即可，无需改版本号；只有部署配置或沙箱规则有变更时才需对照更新相关文件，避免覆盖自己的配置。

直接用 `docker run` 部署的用户，先运行 `docker pull ghcr.io/jaaayden/feedlantern:latest`，再停止并删除旧容器（不要加 `-v`），用原来的参数和同一数据卷重新创建容器，将镜像替换为 `latest`。不要创建新数据卷代替原卷。

## 回退与停机备份

数据库迁移不保证旧代码可读。回退需要旧镜像与升级前数据，不能只替换镜像版本。

需要原始数据备份时先停止应用，再复制整个卷：

```sh
docker compose stop
mkdir -p volume-backup
docker compose cp feedlantern:/app/data/. ./volume-backup/
docker compose start
```

备份目录包含本机密钥，必须限制访问并妥善保存，不能提交到仓库。恢复原始目录前停止目标服务，保存目标现有数据，复制完整目录并恢复容器用户 UID 1000 的拥有权。网页加密备份是跨服务器迁移的首选。

`docker compose down` 保留命名卷；不要使用 `down -v` 或清理该卷。镜像版本可固定为具体版本，需更严格锁定时按 Release 镜像摘要使用 `image@sha256:…`。

## 数据库体积

数据库不会无限增长，各类数据都有上限：

| 数据 | 上限 |
| --- | --- |
| 每个订阅的文章 | 按订阅保留设置，详见[订阅设置](user-guide.md#订阅设置) |
| 仪表盘日趋势 | 最近 90 天 |
| 累计采集、累计翻译 | 长期保留，不随内容或订阅清理减少；删除用户时一并删除 |
| 翻译进度事件 | 每个订阅最新 200 条（界面只显示最近 100 条） |
| 翻译缓存 | 20000 条 |
| 抓取日志 | 按「设置 → 日志保留天数」，默认 30 天 |
| 访问令牌调用记录 | 按「日志保留天数」，且每个令牌最多 2000 条、全站最多 20000 条 |
| 登录会话 | 过期后每小时清理 |

新建的数据库会启用增量回收，清理掉的空间每小时逐步还给磁盘。旧版本创建的数据库文件不会自动变小：清理后空间留在文件里重复使用，所以体积不会再涨，但也不会降。想让它立即缩小，在停机状态下运行一次压缩脚本（需要的磁盘空间不小于当前数据库大小，脚本会先检查，不够就中止且不改动数据）：

```sh
docker compose stop feedlantern
docker compose run --rm --no-deps feedlantern node --import tsx scripts/compact-db.ts --dry-run   # 只查看，不修改
docker compose run --rm --no-deps feedlantern node --import tsx scripts/compact-db.ts
docker compose up -d --wait feedlantern
```

脚本会把翻译事件裁剪到上限、启用增量回收并整理文件，最后输出完整性检查结果。运行前建议先备份，运行期间服务不可用。

## 多用户升级注意事项

升级会事务迁移用户及资源归属，保留原管理员密码和所有 RSS 地址，并要求原管理员重新登录。请先保存升级前的完整数据卷；回退程序时同时回退数据卷。管理员登录后从“用户管理”创建、改名、停用、重置密码、调整角色或永久删除用户，`pnpm admin:reset` 在多个管理员存在时先要求输入目标管理员用户名，仅修改选定账号的密码并撤销其会话。详见[备份与迁移](backup-and-migration.md)。
