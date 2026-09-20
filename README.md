# Luker Video Toolkit

Turn-scoped HTTPS and GCS video attachments for Luker, with configurable remote import nodes.

**适用于 Gemini 原生兼容连接。** 浏览器可以直接上传本地文件到私有 GCS；也可以提交一个视频链接，选择解析上传节点：

- 公网 HTTPS 视频直链：节点下载并读取时长。
- Iwara / B站播放页：yt-dlp 解析、下载；必要时 FFmpeg 合并。
- 默认 ≤ **14,000,000 bytes**：发布到配置的 copyparty 临时卷，返回带 filekey 的 HTTPS 直链。
- 更大的视频：上传到 GCS，返回 `gs://`。
- 在 Luker 视频库附加到当前用户轮次，插件将引用转换为 Gemini 原生 `fileData`；下一条用户消息不自动重发。

节点、API 上游、模型 ID、GCS 桶、凭据文件、copyparty 地址与阈值都来自配置。仓库不包含生产配置、密钥或用户视频。

## 安装 Luker 插件

同一个仓库同时提供前端扩展和服务端插件，使用 Luker 的两个官方管理入口安装：

1. **管理面板 → 服务端插件 → 安装**，仓库 URL：`https://github.com/kj1534/luker-video-toolkit`。
2. **扩展 → 安装扩展**，使用同一个仓库 URL。需安装到运行该服务端插件的 Luker 实例。
3. 确保 Luker `config.yaml` 中 `enableServerPlugins: true`。
4. 将 `server/config.example.json` 复制到 **Luker 工作目录的 `config/gcs-video/config.json`**，修改上游地址、模型 ID、桶、节点与凭据路径。该文件位于 Git 克隆目录之外，插件更新不会覆盖。
5. 放置专用上传服务账号 JSON 与节点令牌，限制文件权限；不要使用 Owner 服务账号作为运行凭据。
6. 重启 Luker，刷新浏览器。保持使用自己的 Gemini 原生兼容连接；连接地址和模型必须与插件配置相符。

升级时，在官方管理入口分别更新前端扩展与服务端插件，再按提示重启服务。**不要直接改克隆目录内的源码或存放运行配置。** 两侧建议保持相同版本。

插件没有修改 Luker 核心，也不把程序自动复制到另一个未受 Git 管理的扩展目录。`message.extra.gcs_video` 是附件的持久字段，HTTPS 与 GCS 都使用同一结构。

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
5. 参考 `docs/node-nginx.example.conf`，在现有 HTTPS 站点内代理控制接口。Worker 只监听 loopback；控制接口要求 Bearer 令牌，copyparty 文件使用独立 filekey。
6. 在 Luker 配置 `import_workers` 中添加节点 ID、名称、控制 API URL 和令牌文件。`direct_media_origins` 必须包含 copyparty 公开文件 URL 的 origin。

升级节点：下载新版本、验证 checksum、解压，再运行同一个安装命令。配置和凭据不覆盖；先前程序保存在安装目录 `previous/`。升级/重启会丢失在途任务，不要在有重要传输时升级。实例重建可用相同配置重新安装。

若不需要 copyparty，设 `small_video.enabled: false`，所有链接导入结果都进 GCS。`small_video.max_bytes` 与 Luker 的 `https_max_bytes` 应一致。copyparty 的实际清理周期需与 `retention_seconds` 匹配，后者用于视频库到期显示。

## 使用与限制

附件菜单 → **视频库：上传与管理**。本地文件入口浏览器直传 GCS；链接入口自动分流，关闭面板后云端任务继续。完成后复制地址或附加到本轮。也可手动添加允许来源的 HTTPS 直链或 GCS 地址，并填写时长。

默认单文件 2 GiB、下载最长 30 分钟、两条执行线程、最多八个任务。文件下载/合并后自动获取时长；临时下载完成/失败后清理，等待上传会话超时也会清理。资源限额在节点配置中控制，低配机器建议降低内存上限并保持足够余量。

网站支持不等于所有视频可下载：云厂商 IP、区域、验证码、登录、私有视频和会员权限都可能阻止解析。不会导入浏览器 Cookie、代过验证码、下载 DRM 或整个播放列表。失败时可以换节点，或将有权访问的真实视频直链提交给节点。Iwara 浏览器脚本原生 fetch 成功，不代表服务器请求也会成功。

视频只在所属用户轮次发送；该轮重答/工具调用仍可能重复计算输入费用。对象到期后可以继续使用此前文字回答，需要重看则重新附加有效文件。可配置安全阈值不代表模型所有内置保护可关闭；本插件不实现“防审查”传输。

## 费用

Vertex 的普通 HTTP(S) 视频 URI 文档限制为 **15 MB**，因此默认分流采用 14 MB 留余量。HTTPS 直链省去 GCS 存储/操作费用，但模型视频 token 费用相同，并会消耗文件服务器流量。

GCE 公网入站通常无网络流量费；同区域 GCE → GCS 的网络传输免费，跨区域和公网出站需另看费率。存储、API 操作、实例、磁盘与 Gemini tokens 分别计费。不能只凭“都是 Google”就认为任意路径免费。

- [Vertex 视频输入与 HTTP URI 限制](https://cloud.google.com/vertex-ai/generative-ai/docs/multimodal/video-understanding)
- [Google Cloud 网络价格](https://cloud.google.com/vpc/network-pricing)
- [Cloud Storage 价格](https://cloud.google.com/storage/pricing)

## 开发与发版

```sh
npm test
python3 -m unittest discover -s node -p 'test_*.py'
python3 scripts/build-release.py
```

普通 CI 会跳过依赖完整 Luker 运行目录的转换器集成测试；可将仓库挂载到 Luker 环境，在 Luker 根目录运行该测试文件完成集成验证。单元与 HTTP 测试不使用真实账号或云凭据。

修改 `VERSION`、`package.json`、`manifest.json` 的版本并推送 `v<version>` tag，GitHub Actions 跑测试、生成节点包和 SHA256SUMS、创建 GitHub Release。前后端通过官方 Git 更新入口升级，节点通过 Release 包升级。

许可证：AGPL-3.0-only，与 Luker 保持一致。yt-dlp、FFmpeg、copyparty 分别遵循各自许可证；本仓库不重新打包它们的运行时或私有配置。
