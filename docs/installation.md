# Installation and upgrade to 1.0

The independent application owns storage settings and task state. Luker installs the frontend and server components from the same repository using its official extension and plugin controls; these are one connector release with two host-required installation locations.

## Independent service

1. Extract the application release, install Node 24+ and run `npm ci --omit=dev --ignore-scripts`.
2. Create a dedicated unprivileged service user and a private state directory (700; files 600). Copy `server/config.example.json` to this directory and supply only a bucket-restricted uploader credential. Add `public_url`, `app_port` and `retention_days` as described in [operations](independent-app.md).
3. Initialize an account with `node scripts/create-account.mjs --config /private/config.json --handle owner --admin`. It writes a generated first-login password to a private file and does not print it. Never check this file into Git.
4. Run `sudo python3 scripts/install-app.py --source /opt/file-library --config /private/config.json --node /absolute/node --user file-library` after setting state ownership to the service user. Add the unchanged application URL path to your existing HTTPS reverse proxy with a 256 KiB request limit. Do not open public origin ports to bypass a Tunnel.
5. Sign in, configure/test nodes and storage, create a user-scoped plugin token, then open Luker's **File library** menu entry and paste it into the connection dialog. The host operator configures the trusted `service_url` in `config/gcs-video/connection.json`; ordinary users cannot select arbitrary control servers.

## Upgrade from 0.7

Before switching the connector, export the old private configuration, its referenced uploader/node token files, `direct-videos.json`, and `file-copies.json`. Copy them into the independent state directory and update only local credential paths. Create one account per actual old owner, preserving each original handle and GCS prefix. In particular, bind `default-user` exclusively to its original owner. Do not combine administrators into one account.

Migrate while the previous task queue is idle. Existing bytes, object names, GS URIs, direct references and copy keys remain unchanged. Back up the old frontend/backend and node versions. Start the independent service and verify user/source/index counts before switching Luker. Remove active legacy credential copies from the connector host after verification, retaining the private recovery archive. See [recovery details](independent-app.md).

## Worker installation reference

# 安装与配置

## 安装 Luker 连接器

使用 Luker 官方的服务端插件和前端扩展入口安装同一个仓库：`https://github.com/kj1534/luker-video-toolkit`。两侧保持同一版本，启用服务端插件后按 Luker 提示重启。宿主配置 `config/gcs-video/connection.json` 的 `service_url`，用户通过附件菜单的“文件库”入口绑定自己的专用令牌；连接后，上传、链接导入、文件附加及更换连接都在同一入口内。

全部存储、节点和凭据配置在独立应用的设置页维护。连接器不再持有 GCS 上传凭据和节点控制令牌。

## 配置 GCS

建立一个私有桶，配置上传来源 CORS 和生命周期。专用上传账号只需要目标桶的 `roles/storage.objectCreator`、`roles/storage.objectViewer` 和对象删除权限；模型使用的 Vertex 身份另需该桶的 objectViewer。在独立应用设置页选择该账号的 JSON 密钥文件。

建议按用途设置对象保留天数；如果希望到期清理不继续产生软删除保留费用，需同时检查桶的 soft-delete policy。浏览器直接上传的视频字节不经过 Luker 主机。

## 安装节点

要求 Linux、Python 3.11+、FFmpeg、python3-venv。每台节点独立安装：

1. 从 [Releases](https://github.com/kj1534/luker-video-toolkit/releases) 下载对应版本的 `video-toolkit-node-<version>.tar.gz` 和 `SHA256SUMS`，校验后解压。
2. 将 `node/config.example.json` 复制为 `/etc/video-toolkit/node.json`，按实际路径修改。生成强随机控制令牌，存入 `token_file`；将同一令牌填写到 独立应用设置页面对应节点的“控制令牌”。

   `parser_proxies` 可分别指定 Iwara、B站和 YouTube 的本地 HTTP/SOCKS
   代理。Iwara与B站仅在解析阶段使用对应代理，媒体地址由处理节点直接下载；
   YouTube 的解析与下载使用同一个代理，以避免签名媒体地址因出口变化而失效。
3. 若启用小视频直链，配置 copyparty 专用读写账号、卷地址、密码文件和保留时间。专用账号只授权临时导入卷，不需要管理所有文件。示例卷：
   `/srv/video-imports:/imports:g:rw,video-import:c,e2d:c,fk=16:c,lifetime=604800:c,rm_partial`
   `g` 允许持有 filekey 的外部读取；不要给匿名用户列目录权限。
4. 执行 `sudo python3 scripts/install-node.py --config /etc/video-toolkit/node.json`。安装器读取配置中的用户、目录和资源限制，安装锁定依赖，启用 systemd 服务。
5. 参考 [Nginx 配置示例](node-nginx.example.conf)，在现有 HTTPS 站点内代理控制接口。Worker 只监听 loopback；控制接口要求 Bearer 令牌，copyparty 文件使用独立 filekey。
6. 在独立应用 **文件库 → 设置 → 导入节点** 中添加节点 ID、名称、控制 API URL 和同一令牌；“允许附加的 HTTPS 视频来源”中加入 copyparty 公开文件 URL 的 origin。

升级节点：下载新版本、验证 checksum、解压，再运行同一个安装命令。配置和凭据不覆盖；先前程序保存在安装目录 `previous/`。升级/重启会丢失在途任务，不要在有重要传输时升级。实例重建可用相同配置重新安装。

若不需要 copyparty，设 `small_video.enabled: false`，所有链接导入结果都进 GCS。`small_video.max_bytes` 与 Luker 的 `https_max_bytes` 应一致。copyparty 的实际清理周期需与 `retention_seconds` 匹配，后者用于文件库到期显示。


低内存节点应设置合适的 systemd 内存限额，并为其他服务留出余量。

共享目录管理及 GCS 删除权限配置见[统一文件库指南](file-library.md)。
