# 安装与配置

## 安装 Luker 插件

同一个仓库同时提供前端扩展和服务端插件，使用 Luker 的两个官方管理入口安装：

1. **管理面板 → 服务端插件 → 安装**，仓库 URL：`https://github.com/kj1534/luker-video-toolkit`。
2. **扩展 → 安装扩展**，使用同一个仓库 URL。需安装到运行该服务端插件的 Luker 实例。
3. 确保 Luker `config.yaml` 中 `enableServerPlugins: true`。
4. 重启 Luker 并刷新浏览器，打开附件菜单中的 **文件库：上传与管理 → 设置**（仅管理员可见）。
5. 在“模型连接”填写与 Luker Gemini 连接一致的 HTTPS 接口地址。可用模型每行填写一个 ID，或留空允许该连接的所有模型；实际模型需支持视频，连接身份需有视频读取权限。
6. 在“视频存储”填写私有 GCS 桶名称、选择专用服务账号 JSON；如需直接附加 HTTPS 视频，填写允许的来源域名。
7. 如需链接导入，在“导入节点”中填写节点 ID、名称、HTTPS 控制接口和令牌，选择默认节点。
8. 点击 **保存设置**，再点击 **检测已保存的连接** 检查 GCS 和节点。保存即时生效，无需重启；已有导入进行中时，请等任务完成再保存。

无需手动编辑 Luker 插件配置文件。设置自动写入 Luker 工作目录 `config/gcs-video/`；密钥和令牌分开存放，设置界面只显示是否已保存，不回显密钥。更换凭据时选择新文件或填写新令牌，留空则保留当前值。原有配置会自动载入界面。

升级时，在官方管理入口分别更新前端扩展与服务端插件，再按提示重启服务。**不要直接改克隆目录内的源码或存放运行配置。** 两侧建议保持相同版本。

## 配置 GCS

建立一个私有桶，配置上传来源 CORS 和生命周期。专用上传账号只需要目标桶的 `roles/storage.objectCreator`、`roles/storage.objectViewer`；模型使用的 Vertex 身份另需该桶的 objectViewer。在 Luker 设置页选择该账号的 JSON 密钥文件。

建议按用途设置对象保留天数；如果希望到期清理不继续产生软删除保留费用，需同时检查桶的 soft-delete policy。浏览器直接上传的视频字节不经过 Luker 主机。

## 安装节点

要求 Linux、Python 3.11+、FFmpeg、python3-venv。每台节点独立安装：

1. 从 [Releases](https://github.com/kj1534/luker-video-toolkit/releases) 下载对应版本的 `video-toolkit-node-<version>.tar.gz` 和 `SHA256SUMS`，校验后解压。
2. 将 `node/config.example.json` 复制为 `/etc/video-toolkit/node.json`，按实际路径修改。生成强随机控制令牌，存入 `token_file`；将同一令牌填写到 Luker 设置页面对应节点的“控制令牌”。

   `parser_proxies` 可分别指定 Iwara、B站和 YouTube 的本地 HTTP/SOCKS
   代理。Iwara与B站仅在解析阶段使用对应代理，媒体地址由处理节点直接下载；
   YouTube 的解析与下载使用同一个代理，以避免签名媒体地址因出口变化而失效。
3. 若启用小视频直链，配置 copyparty 专用读写账号、卷地址、密码文件和保留时间。专用账号只授权临时导入卷，不需要管理所有文件。示例卷：
   `/srv/video-imports:/imports:g:rw,video-import:c,e2d:c,fk=16:c,lifetime=259200:c,rm_partial`
   `g` 允许持有 filekey 的外部读取；不要给匿名用户列目录权限。
4. 执行 `sudo python3 scripts/install-node.py --config /etc/video-toolkit/node.json`。安装器读取配置中的用户、目录和资源限制，安装锁定依赖，启用 systemd 服务。
5. 参考 [Nginx 配置示例](node-nginx.example.conf)，在现有 HTTPS 站点内代理控制接口。Worker 只监听 loopback；控制接口要求 Bearer 令牌，copyparty 文件使用独立 filekey。
6. 在 Luker **文件库 → 设置 → 导入节点** 中添加节点 ID、名称、控制 API URL 和同一令牌；“允许附加的 HTTPS 视频来源”中加入 copyparty 公开文件 URL 的 origin。

升级节点：下载新版本、验证 checksum、解压，再运行同一个安装命令。配置和凭据不覆盖；先前程序保存在安装目录 `previous/`。升级/重启会丢失在途任务，不要在有重要传输时升级。实例重建可用相同配置重新安装。

若不需要 copyparty，设 `small_video.enabled: false`，所有链接导入结果都进 GCS。`small_video.max_bytes` 与 Luker 的 `https_max_bytes` 应一致。copyparty 的实际清理周期需与 `retention_seconds` 匹配，后者用于文件库到期显示。


低内存节点应设置合适的 systemd 内存限额，并为其他服务留出余量。

共享目录管理及 GCS 删除权限配置见[统一文件库指南](file-library.md)。
