# 统一文件库

## 存储与附加

文件库在打开、切换目录或刷新时读取 GCS 与启用的 copyparty 目录。GCS 按 Luker 登录用户隔离，共享 copyparty 目录仅管理员可见。较多 GCS 对象使用“加载更多”；搜索作用于当前已加载的条目。

本插件每轮附加一个文件，可与 Luker 原生的其他附件混用。链接导入默认勾选同步到 copyparty，可取消以仅保留自动选择的一份：

- 本地上传默认“自动”：不超过阈值只存 copyparty，更大的文件先保存 copyparty，再由同一节点上传 GCS。浏览器只上传一次。可选“仅 copyparty”“两边各一份”，或主动选择“仅 GCS”由浏览器直传。共享存储上传仅管理员可用，普通用户保留自己的 GCS 直传。
- 链接导入默认将不超过配置阈值的文件存到 copyparty，更大的文件上传 GCS。
- 已在 copyparty 的受支持小文件直接附加 HTTPS 地址；超过阈值时，“上传并附加”先复制到 GCS。再次附加会复用仍然存在的 GCS 副本。
- “复制到另一存储”保留原文件。GCS → copyparty 由管理员配置的 GCS 读取节点读取，再上传目标目录。再次复制会复用仍存在且未变化的副本。

HTTP 视频、音频和文档输入受模型接口 15 MB 限制，默认阈值为 14,000,000 字节；图片使用更保守的 7 MB 阈值。各模型仍有独立的格式、大小和上下文限制。PDF、图片、音频、视频与 UTF-8 文本均使用 Gemini `fileData` 和对应 MIME 类型。其他格式可管理、复制、下载，不提供附加按钮。

## 预览、下载与删除

copyparty 支持浏览器可解码的音视频、图片、PDF 与文本预览，文本最多读取 1 MiB，不执行 HTML/脚本。禁止直接预览 GCS 文件；管理员点击“复制后预览”先复制到 copyparty，再播放该副本。普通用户不能写入管理员共享目录。

GCS 下载与预览都会先经配置的读取节点复制到默认 copyparty 目标；浏览器随后从 copyparty 获取文件，支持其原有播放与断点下载能力。已有副本未变化且未过期时直接复用，不重新读取 GCS。浏览器不会收到 GCS 签名下载地址，也没有读取节点的公开下载入口。普通用户不开放管理员共享目录操作；GCS 下载与预览复制入口仅管理员可用。

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
      "retention_seconds": 604800
    }
  ]
}
```

为此专用 copyparty 账号授予指定卷的 `rwd` 权限（读取、写入、删除），不要授予服务器管理权限。使用带 filekey 的外部读取链接，匿名用户不应具有列目录权限。程序只读取配置中的密码文件，不把 copyparty 密码发送给浏览器。

节点安装/升级后，在 Luker **文件库 → 设置 → 导入节点** 勾选“在文件库显示该节点的共享目录”。服务端依据登录用户的管理员身份检查每次共享目录操作；普通用户不能通过手工调用接口访问这些目录。

GCS 上传账号要使用删除功能，还需要目标桶的 `storage.objects.delete` 权限。可把仅包含该权限的自定义角色绑定在目标桶；上传与查看继续使用原有 Object Creator / Object Viewer。运行账号不需要 Owner 权限。

## 链接同步与 GCS 读取节点

输入链接、选择解析下载节点后，管理员默认勾选“同时保存到 copyparty”。大文件复用本次本地下载完成同步，再上传 GCS；小文件默认就存 copyparty，不重复复制。同步失败会显示提示并继续 GCS 上传，可事后重试复制。取消勾选时保持单份策略。

在文件库设置中选择“GCS 下载与复制节点”、默认 copyparty 目标节点和卷 ID（默认 `imports`）。该节点应位于与桶相同的 GCP 区域，节点配置填写 `gcs_private_endpoint: "199.36.153.8"`，使用 Google `private.googleapis.com` VIP。代码固定连接 VIP，同时保留 `storage.googleapis.com` 的 Host、TLS SNI 与证书验证，不修改整台服务器 DNS。节点的 GCS 上传也使用此私有地址；非 GCP 的普通导入节点留空该项。网络必须能够访问 Google 私有 API VIP；无外部 IP 的 GCE 通常还需子网启用 Private Google Access。此配置不会自动更改 VPC 路由、网络层级或公网 IP。

读取节点的 `library_volumes` 需要映射目标 copyparty 卷（卷 ID 与共享库节点一致），其中 `api_url` 指向目标的 HTTPS 地址，密码文件保存在节点本地。它不需要 GCS 服务账号 JSON，只接受已鉴权控制请求中的目标桶签名地址。复制目标需为管理员配置的这些卷。

`retention_seconds` 用于界面记录链接有效期；实际自动删除由 copyparty 的卷参数 `lifetime` 决定，两者应一致。例如七天均设置为 `604800` 秒，修改元数据不会延长已删除文件的寿命。

## 网络费用

同区域 GCE → GCS 的网络传输通常免费。同区域 GCS → GCE 读取后再向浏览器或 copyparty 发送，后半段按 GCE 所选网络层级计费；GCS 读取操作费仍存在。Standard Tier 每账号跨区域共享前 200 GiB/月免费额度，不是每台实例独享。是否比 GCE 直接出站便宜，取决于区域、网络层级、用量和免费额度。避免不必要的双份文件通常比改变传输路径更节省。

- [Cloud Storage 价格](https://cloud.google.com/storage/pricing)
- [Google Cloud VPC 网络价格](https://cloud.google.com/vpc/network-pricing)
- [Gemini 文件输入](https://cloud.google.com/vertex-ai/generative-ai/docs/model-reference/inference#filedata)

## 本地上传与操作提示

上传节点使用配置的默认 copyparty 节点与目标卷。浏览器以 4 MiB 分片发送，每次最多缓存 256 KiB 到本地临时文件；控制令牌与 copyparty 密码不发送给浏览器。上传票据只允许单文件和指定浏览器 Origin，闲置一小时失效；暂停后可重选同一文件续传。节点/插件重启后未完成会话需重新创建。节点收到完整文件后，通过 copyparty 接口登记，保留临时文件供需要的 GCS 上传复用，完成后清理。反向代理需允许 5 MiB 请求并关闭请求缓冲，见 Nginx 示例。

按钮统一描述用户目的，内部传输由说明确认：GCS 预览/下载先复用或创建 copyparty 副本；较大的 copyparty 文件附加前复用或上传 GCS。每行“管理 → 操作说明”可查看全部行为。“删除这一份”只删除当前存储对象。成功提示约 4.5 秒后消失；刷新和下一项操作会清除旧提示。
