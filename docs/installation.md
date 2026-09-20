# 安装与配置

## 安装 Luker 插件

同一个仓库同时提供前端扩展和服务端插件，使用 Luker 的两个官方管理入口安装：

1. **管理面板 → 服务端插件 → 安装**，仓库 URL：`https://github.com/kj1534/luker-video-toolkit`。
2. **扩展 → 安装扩展**，使用同一个仓库 URL。需安装到运行该服务端插件的 Luker 实例。
3. 确保 Luker `config.yaml` 中 `enableServerPlugins: true`。
4. 将 `server/config.example.json` 复制到 **Luker 工作目录的 `config/gcs-video/config.json`**，修改上游地址、模型 ID、桶、节点与凭据路径。该文件位于 Git 克隆目录之外，插件更新不会覆盖。
5. 放置专用上传服务账号 JSON 与节点令牌，限制文件权限；不要使用 Owner 服务账号作为运行凭据。
6. 重启 Luker，刷新浏览器。保持使用自己的 Gemini 原生兼容连接；连接地址和模型必须与插件配置相符。

升级时，在官方管理入口分别更新前端扩展与服务端插件，再按提示重启服务。**不要直接改克隆目录内的源码或存放运行配置。** 两侧建议保持相同版本。

## 配置 GCS

建立一个私有桶，配置上传来源 CORS 和生命周期。专用上传账号只需要目标桶的 `roles/storage.objectCreator`、`roles/storage.objectViewer`；模型使用的 Vertex 身份另需该桶的 objectViewer。将该账号 JSON 的路径填入 `credential_file`。

建议按用途设置对象保留天数；如果希望到期清理不继续产生软删除保留费用，需同时检查桶的 soft-delete policy。浏览器直接上传的视频字节不经过 Luker 主机。

## 安装节点

要求 Linux、Python 3.11+、FFmpeg、python3-venv。每台节点独立安装：

1. 从 [Releases](https://github.com/kj1534/luker-video-toolkit/releases) 下载对应版本的 `video-toolkit-node-<version>.tar.gz` 和 `SHA256SUMS`，校验后解压。
2. 将 `node/config.example.json` 复制为 `/etc/video-toolkit/node.json`，按实际路径修改。生成强随机控制令牌，存入 `token_file`；将同一令牌安全地配置到 Luker 对应节点的 `token_file`。
3. 若启用小视频直链，配置 copyparty 专用读写账号、卷地址、密码文件和保留时间。专用账号只授权临时导入卷，不需要管理所有文件。示例卷：
   `/srv/video-imports:/imports:g:rw,video-import:c,e2d:c,fk=16:c,lifetime=259200:c,rm_partial`
   `g` 允许持有 filekey 的外部读取；不要给匿名用户列目录权限。
4. 执行 `sudo python3 scripts/install-node.py --config /etc/video-toolkit/node.json`。安装器读取配置中的用户、目录和资源限制，安装锁定依赖，启用 systemd 服务。
5. 参考 [Nginx 配置示例](node-nginx.example.conf)，在现有 HTTPS 站点内代理控制接口。Worker 只监听 loopback；控制接口要求 Bearer 令牌，copyparty 文件使用独立 filekey。
6. 在 Luker 配置 `import_workers` 中添加节点 ID、名称、控制 API URL 和令牌文件。`direct_media_origins` 必须包含 copyparty 公开文件 URL 的 origin。

升级节点：下载新版本、验证 checksum、解压，再运行同一个安装命令。配置和凭据不覆盖；先前程序保存在安装目录 `previous/`。升级/重启会丢失在途任务，不要在有重要传输时升级。实例重建可用相同配置重新安装。

若不需要 copyparty，设 `small_video.enabled: false`，所有链接导入结果都进 GCS。`small_video.max_bytes` 与 Luker 的 `https_max_bytes` 应一致。copyparty 的实际清理周期需与 `retention_seconds` 匹配，后者用于视频库到期显示。

