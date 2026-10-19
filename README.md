# 图提取 ImageGrab

一个可直接加载运行的 Chrome Manifest V3 扩展：在淘宝、天猫、京东、拼多多商品详情页中提取商品图片，在新标签页集中预览、勾选，并批量转换为 PNG 下载。

![Manifest](https://img.shields.io/badge/Manifest-V3-4f46e5) ![Chrome](https://img.shields.io/badge/Chrome-109%2B-4285f4)
（README 中的徽章仅作展示，扩展和官网运行不依赖任何远程资源。）

## 快速开始

### 安装扩展

1. 打开官网 `docs/index.html`，或直接解压 `docs/downloads/imagegrab-v1.0.0.zip`。
2. 在 Chrome 地址栏打开 `chrome://extensions`。
3. 打开右上角「开发者模式」。
4. 点击「加载已解压的扩展程序」，选择包含 `manifest.json` 的插件文件夹。
5. 打开支持的电商商品详情页，右下角会出现「获取图片」按钮。

开发时也可以直接加载本项目根目录 `imagegrab/`。`docs/`、`tests/` 不是扩展运行所需文件。

### 使用

1. 打开淘宝、天猫、京东或拼多多商品详情页。
2. 点击右下角「获取图片」。
3. 画廊自动打开后，全选、反选或逐张勾选图片。
4. 点击「下载选中」，等待逐张转换和保存。
5. PNG 文件会保存到浏览器默认下载目录，文件名依次为 `商品图_001.png`、`商品图_002.png`……

## 功能

- 详情页精准识别：只匹配三个平台的商品详情页，首页、搜索页、购物车不显示按钮。
- 多种图片来源：`img`、`srcset`、`data-src`、`data-original`、拼多多/京东常见懒加载属性、CSS `background-image`、`og:image` 和 Product JSON-LD。
- 基础过滤：去掉明显图标、logo、占位图、小于 `100 × 100` 的图片；未知尺寸会在画廊加载后二次判断，下载时也会再次拒绝小图。
- 去重与绝对地址：对相对路径补全，移除 hash 后去重。
- 集中预览：真实尺寸、懒加载缩略图、点击放大、上一张/下一张。
- 自由选择：默认全选，支持全选、反选、实时已选数量和文件名预览。
- PNG 统一：跨域取图后在 Service Worker 中用 `createImageBitmap` + `OffscreenCanvas` 转码，保留透明通道。
- 批量进度：逐张串行下载，显示读取、转换、编码、保存阶段，完成/失败数量与失败原因。
- 本地隐私：图片不上传第三方服务器；提取结果只保存在 `storage.session` 中，关闭浏览器后清除。

## 目录结构

```text
imagegrab/
├── manifest.json          # Manifest V3 清单
├── background.js          # Service Worker：会话存储、开画廊、下载任务
├── content.js             # 注入按钮、识别详情页、提取与过滤图片
├── content.css            # 悬浮按钮样式
├── gallery.html           # 图片画廊
├── gallery.js             # 勾选、预览、下载进度与结果
├── gallery.css            # 画廊响应式样式
├── lib/
│   ├── image-core.js      # 可测试的 URL/详情页/过滤纯函数
│   ├── session-store.js   # storage.session 捕获记录
│   └── downloader.js      # 取图、PNG 编码、下载落盘
├── assets/                # 16/32/48/128 图标
├── docs/                  # 纯静态官网（可直接双击 index.html）
│   ├── index.html
│   ├── css/style.css
│   ├── js/main.js
│   ├── assets/favicon.svg
│   └── downloads/imagegrab-v1.0.0.zip
├── tests/
│   ├── image-core.test.js # 共享逻辑单元测试
│   ├── static.test.js     # 文件/清单/官网静态契约测试
│   ├── e2e.mjs            # 真实浏览器端到端测试
│   └── site-check.mjs     # 官网页与交互检查
├── package.json
└── README.md
```

## 官网

官网位于 `docs/`，纯 HTML + CSS + 原生 JS，不依赖框架、CDN、外部图片或构建工具。

- 预览：直接双击 `docs/index.html`。
- 也可以执行 `npx serve docs` 或任意静态服务器预览。
- 主色与圆角等设计变量都在 `docs/css/style.css` 的 `:root` 中，例如修改 `--primary` 与 `--accent` 即可换色。
- 文案与区块内容在 `docs/index.html` 中。
- 导航高亮、滚动淡入、移动端菜单和命令复制逻辑在 `docs/js/main.js`。

## 权限说明

| 权限 | 用途 |
| --- | --- |
| `activeTab` / `scripting` | 预留页面操作能力与 Manifest V3 兼容 |
| `downloads` | 调用浏览器下载 PNG，打开下载目录 |
| `storage` | 使用 `storage.session` 暂存当前提取结果 |
| 平台 host 权限 | 注入内容脚本、读取页面 |
| 图片 CDN host 权限 | 跨域 fetch 阿里/京东/拼多多图片（含 `alicdn`、`360buyimg`、`pddpic`） |
| `optional_host_permissions` | 如商品图来自其他 CDN，画廊在用户点击下载时申请对应域名权限 |

扩展不会收集账号信息、浏览历史或图片内容。

## 本地测试

测试只依赖 Node.js 18+ 与已安装的 Chromium 浏览器。无需安装 npm 依赖。

```bash
# 共享逻辑 + 静态契约检查
npm test

# 官网结构、响应式、菜单、导航高亮、滚动动画、复制按钮
npm run test:site

# 加载未打包扩展，模拟淘宝详情页并完成真实 PNG 下载
npm run test:e2e
```

说明：

- 浏览器测试默认使用 `C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe`。可通过参数指定其他 Chromium 路径：
  `node tests/e2e.mjs "C:/path/to/chrome.exe"`
- 从 Chrome 137 起，Google Chrome 正式版在部分环境会忽略命令行 `--load-extension`；自动化测试推荐使用 Edge、Chromium 或 Chrome for Testing。
- Edge Headless 会在 CDP 下载模式下把所有落盘文件重命名为 `download.png`，因此 E2E 会同时校验 PNG data URL 的签名和尺寸，文件命名规则由 `image-core.test.js` 覆盖。
- 手动安装测试不受上述 Headless 限制，`chrome.downloads.download` 会使用扩展传入的 `商品图_001.png` 文件名。

## 实现要点

- **SPA 适配**：定时检查 URL 与详情页结构，淘宝/天猫等客户端路由切换后可移除或重新注入按钮。
- **懒加载兼容**：按来源优先级读取 `data-original`、`data-src`、`data-ks-lazyload`、`srcset` 等属性。
- **跨域 PNG**：Service Worker `fetch` + `createImageBitmap` + `OffscreenCanvas.convertToBlob`，不依赖外部服务。
- **可靠下载**：`chrome.downloads.download` 使用 `conflictAction: uniquify`；通过 `onChanged` 与定时查询等待真实落盘完成。
- **任务生命周期**：画廊与后台使用长连接推送进度，Service Worker 下载期间发送保活请求；关闭画廊会取消当前任务。
- **安全边界**：后台只接受来自受支持平台内容脚本的捕获请求，重新校验 URL，并只允许下载已存储在会话中的图片。

## 已知边界

- 仅支持 Chrome 109+；需要浏览器的跨域 fetch、`storage.session` 和 OffscreenCanvas 能力。
- 不能绕过电商站点自身的登录权限、签名过期或 CDN 防盗链限制；这类图片会显示失败原因。
- 小于 `100 × 100` 的图片按产品规则排除；商品长条图（如 `1200 × 80`）不会被尺寸规则误删。
- 同名文件由浏览器自动追加序号，例如 `商品图_001 (1).png`。
- 官网 GitHub 链接为占位地址，发布前替换为真实仓库。

## License

仅供学习与项目演示使用。
