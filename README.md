# Luker File Library

在 Luker 中统一管理 GCS 与 copyparty 文件：上传、浏览、预览、下载、删除，并附加给 Gemini。

## 功能

- **本地上传**：浏览器直接上传到私有 Google Cloud Storage（GCS）。
- **链接导入**：支持 HTTPS 文件直链，以及 Iwara、B站播放页；可选择处理节点，并勾选同步保存到 copyparty。
- **自动选择存储**：默认不超过 14 MB 的导入视频存放到 copyparty，较大视频上传到 GCS。
- **统一文件库**：实时读取 GCS 和 copyparty 目录，搜索、筛选、分页浏览。
- **文件操作**：从 copyparty 预览音视频、图片、PDF 和文本；GCS 文件先复制后预览，下载经配置的私有读取节点转发。
- **智能附加**：小文件使用直链，较大 copyparty 文件上传 GCS；已有 GCS 副本可复用。
- **多种文件**：Gemini 支持的 PDF、图片、音频、视频和 UTF-8 文本可附加；其他格式可存储和下载。
- **可视化设置**：管理员在 Luker 内配置可用模型、GCS 和导入节点，保存后立即生效。
- **仅本轮发送**：后续新消息不自动携带视频，需要时可重新附加。

## 安装

需要支持 Gemini 原生格式的 Luker 连接，以及用于视频存储的 GCS 桶。链接导入另需 Linux 处理节点；小视频直链功能需 copyparty。

在 Luker 的**服务端插件**和**前端扩展**管理入口，分别安装同一个仓库：

```text
https://github.com/kj1534/luker-video-toolkit
```

随后启用服务端插件并重启 Luker。管理员打开 **文件库 → 设置**，填写模型连接与 GCS 桶、选择服务账号 JSON，即可保存生效。使用链接导入时，在同一页面添加节点地址和令牌。详见[安装与配置指南](docs/installation.md)。

- [Luker 服务端配置示例](server/config.example.json)
- [处理节点配置示例](node/config.example.json)
- [节点安装包](https://github.com/kj1534/luker-video-toolkit/releases)

运行配置与凭据保存在安装目录之外，升级时保留。前端和服务端通过 Luker 插件管理入口更新，处理节点通过 Release 安装包更新。

## 使用

1. 打开附件菜单中的 **文件库：上传与管理**。
2. 在“上传文件”中选择本地文件，或在“链接导入”中粘贴链接并选择节点，按需勾选同步到 copyparty。
3. 回到“我的文件”，点击**附加**，输入问题并发送。

列表每页显示 12 条；可搜索已加载的视频、筛选 GCS/临时直链。数量较多时点击“加载更多”继续读取。

也可以手动添加 `gs://` 地址或配置允许的 HTTPS 文件直链。时长会尝试自动读取，未知时可留空；时长仅用于估算上下文。文件库支持复制链接和重新附加；文件过期后需要重新上传。

文件管理、目录权限与存储策略详见[统一文件库指南](docs/file-library.md)。

## 使用要求

- HTTPS 视频输入受模型接口大小限制，默认以 14 MB 为分流阈值；本地文件上传始终使用 GCS。
- 播放页能否解析取决于网站、节点所在地区及访问权限；需要登录或遭遇站点访问限制的链接可能失败。
- 文件保留时间由 GCS 生命周期和 copyparty 清理策略决定。
- 云存储、服务器流量及模型调用按各自服务计费。

## 开发

```sh
npm test
python3 -m unittest discover -s node -p 'test_*.py'
python3 scripts/build-release.py
```

发布时同步更新 `VERSION`、`package.json`、`manifest.json`，推送 `v<version>` 标签后由 GitHub Actions 构建节点安装包并发布 Release。

## 许可证

[AGPL-3.0-only](LICENSE)。yt-dlp、FFmpeg 和 copyparty 遵循各自许可证。
