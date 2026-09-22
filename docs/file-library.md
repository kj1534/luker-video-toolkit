# 统一文件库

## 存储与附加

文件库在打开、切换目录或刷新时读取 GCS 与启用的 copyparty 目录。GCS 按 Luker 登录用户隔离，共享 copyparty 目录仅管理员可见。较多 GCS 对象使用“加载更多”；搜索作用于当前已加载的条目。

本插件每轮附加一个文件，可与 Luker 原生的其他附件混用。默认不自动镜像：

- 本地文件由浏览器直接上传 GCS。
- 链接导入默认将不超过配置阈值的文件存到 copyparty，更大的文件上传 GCS。
- 已在 copyparty 的受支持小文件直接附加 HTTPS 地址；超过阈值时，“上传并附加”先复制到 GCS。再次附加会复用仍然存在的 GCS 副本。
- “复制到另一存储”保留原文件。GCS → copyparty 由目标节点直接读取临时签名 URL，不通过 Luker 主机或另一个导入节点中转。

HTTP 视频、音频和文档输入受模型接口 15 MB 限制，默认阈值为 14,000,000 字节；图片使用更保守的 7 MB 阈值。各模型仍有独立的格式、大小和上下文限制。PDF、图片、音频、视频与 UTF-8 文本均使用 Gemini `fileData` 和对应 MIME 类型。其他格式可管理、复制、下载，不提供附加按钮。

## 预览、下载与删除

支持浏览器可解码的音视频、图片、PDF 与文本预览。文本预览最多读取 1 MiB，不执行文件中的 HTML/脚本。GCS 预览/下载使用 15 分钟有效的签名 URL；桶保持私有。播放、拖动进度和下载会产生实际读取及出站流量费用。

删除需要在界面确认，操作的是原存储对象，不只是从列表隐藏。已有聊天中的引用随原文件删除而失效。GCS 删除使用对象 generation 条件；copyparty 删除前检查大小和修改时间，不提供递归目录删除。

## 启用 copyparty 目录

节点配置 `library_volumes` 列出可管理的卷。只配置希望开放给 Luker 管理员的目录，例如：

```json
{
  "library_volumes": [
    {
      "id": "files",
      "label": "临时文件",
      "api_url": "http://127.0.0.1:3923/files/",
      "public_url": "https://media.example/files/",
      "username": "file-library",
      "password_file": "/etc/video-toolkit/library.password",
      "retention_seconds": 259200
    }
  ]
}
```

为此专用 copyparty 账号授予指定卷的 `rwd` 权限（读取、写入、删除），不要授予服务器管理权限。使用带 filekey 的外部读取链接，匿名用户不应具有列目录权限。程序只读取配置中的密码文件，不把 copyparty 密码发送给浏览器。

节点安装/升级后，在 Luker **文件库 → 设置 → 导入节点** 勾选“在文件库显示该节点的共享目录”。服务端依据登录用户的管理员身份检查每次共享目录操作；普通用户不能通过手工调用接口访问这些目录。

GCS 上传账号要使用删除功能，还需要目标桶的 `storage.objects.delete` 权限。可把仅包含该权限的自定义角色绑定在目标桶；上传与查看继续使用原有 Object Creator / Object Viewer。运行账号不需要 Owner 权限。

## 网络费用

同区域 GCE → GCS 的网络传输通常免费。GCS → 公网节点或用户浏览器属于 GCS 出站；改由 GCS 提供下载并不意味着免费。是否比 GCE 直接出站便宜，取决于区域、网络层级、用量和免费额度。避免不必要的双份文件通常比改变传输路径更节省。

- [Cloud Storage 价格](https://cloud.google.com/storage/pricing)
- [Google Cloud VPC 网络价格](https://cloud.google.com/vpc/network-pricing)
- [Gemini 文件输入](https://cloud.google.com/vertex-ai/generative-ai/docs/model-reference/inference#filedata)
