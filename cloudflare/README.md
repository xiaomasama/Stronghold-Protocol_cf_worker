# Cloudflare Workers 部署（适配层）

把这个项目（卫戍协议：盟约 · 网页联机复刻）部署到 **Cloudflare Workers** 上，让朋友直接通过公网域名联机。

> **分步操作手册见 [DEPLOY.md](DEPLOY.md)**：从准备到上线、验证、运维、回滚、排错、成本，每一步都有命令与期望输出。本文是总览（架构、为什么是 Workers、实测结论、已知差异）。

**这个目录是纯增量适配层：游戏代码一个字节都没改**（fork 里唯一动过的上游文件，是根 `README.md` 顶部那三行指向本目录的说明）。以后 `git pull` 更新上游代码不会和它冲突；上游改了服务端逻辑，适配层通常也不用动（见下方「上游更新后」）。

**这份适配层在哪、怎么拿（三种都行）**：

1. **已经备好的仓库**：[`xiaomasama/Stronghold-Protocol_cf_worker`](https://github.com/xiaomasama/Stronghold-Protocol_cf_worker) = 上游 `sganggs/Stronghold-Protocol` + 本目录。clone 下来即可部署，`cloudflare/` 已经在仓库里，不需要再拷。
2. **任意上游检出**：把 `cloudflare/` 这个目录整个拷进检出根目录，然后在根目录 `npm ci`、`node tools/setup.mjs`（素材）。
3. **独立发布包**：`node tools/export.mjs` 导出一个只含适配层的目录，给"不想 fork、只想拿适配层"的人用（见下方「对外发布」）。

三种形态里的 `cloudflare/` 内容完全一致。

```
cloudflare/
├── wrangler.jsonc      Worker 配置（兼容标志、Durable Object、静态资源、data/*.json 的 Text 规则）
├── build.mjs           组装 dist/、.generated/ 与两个生成模块
├── src/
│   ├── worker.js       入口：路由 /ws、/healthz、/media/… 与静态资源
│   ├── game-server.js  Durable Object：跑原有的 Network + Lobby + Match
│   ├── ws-shim.js      把 workerd 的 WebSocket 包成 ws 库的接口（server/net.js 原样使用）
│   ├── req-shim.js     把 Worker 请求包成 net.js 读取的 node:http 请求视图
│   ├── data-preroll.js 在模块初始化阶段把数据写进 VFS（见下）
│   ├── data-boot.js    把打包进 Worker 的 data/*.json 写入 VFS，交给原 server/data.js 加载
│   ├── url-shim.js     修掉 import.meta.url 在打包后为 undefined 的问题（alias node:url）
│   └── media.js        /media/bgm/act1 → /assets/audio/bgm/act1.mp3 的无扩展名音频路由
└── tools/
    ├── smoke.mjs       端到端自检：静态资源 + /healthz + 真实对局协议（建房/加入/断线重连）
    ├── match-drive.mjs 真打一局：建房 → AI 补位 → 开打 → 走完全部阶段（验证服务端战斗模拟）
    ├── export.mjs      导出只含适配层的独立发布包（不含依赖与构建产物）
    └── stop-dev.mjs    停掉残留的 wrangler dev / workerd（Windows 上构建前必做，见 DEPLOY.md §14）
```

## 为什么是 Workers，不是 Pages

游戏需要服务器侧的有状态房间和长连接：Cloudflare 的 **Pages 不能绑定 Durable Objects**，所以 WebSocket 服务端状态放不下。Workers 现在同时支持「静态资源 + 服务端逻辑 + Durable Objects」，Cloudflare 官方也建议新项目用 Workers 而不是 Pages（[迁移指南](https://developers.cloudflare.com/workers/static-assets/migrate-from-pages/)）。本项目即：静态资源走 Workers 静态资源层，游戏服务端跑在一个 Durable Object 里。

## 架构：一个 Durable Object = 原来的一个 Node 进程

原服务器的状态（会话、房间、进行中的对局）**全在内存里**，适配层保持这一点：

| 原来的 Node 进程 | Cloudflare |
|---|---|
| `http` + `ws` 静态服务 | Workers 静态资源（`dist/`，保留 ETag / Range / gzip） |
| `/ws` WebSocket 服务 | `Worker → Durable Object`，每个连接仍是 `server/net.js` 的一个 socket |
| `Lobby` + `Match` 单进程内存态 | 同一个 Durable Object 实例（`GAME.idFromName('main')`） |
| 重启服务器 = 对局结束 | DO 被回收 = 对局结束（语义一致，仍是「无状态服务器」） |
| 定时器 / 心跳 / 比赛时钟 | DO 内的 `setTimeout` / `setInterval`（实测：无连接时也持续运行，见下） |

`server/net.js`、`server/lobby.js`、`server/match/*`、`server/sim/*`、`shared/*` **全部原样复用**，没有分支、没有复制粘贴。

## 部署步骤

前置：仓库根目录已经 `npm ci`（代码从哪来见上面「这份适配层在哪、怎么拿」；用现成仓库就直接 `git clone https://github.com/xiaomasama/Stronghold-Protocol_cf_worker.git`，国内网络可加 `ghproxy.net/` 前缀），并且建议先执行一次 `node tools/setup.mjs` 下载游戏素材（约 270 MB，`public/assets`、`public/fonts` 都在 `.gitignore` 里，不会随 git 走）。不下载也能部署，只是画面用占位图。

```bash
# 1. 安装适配层的依赖（只是 wrangler，装在 cloudflare/ 里，不动仓库的 package.json）
cd cloudflare
npm install

# 2. 组装 dist/ 并做一次本地跑通（默认 http://127.0.0.1:8787）
npx wrangler dev --port 8787      # 或 npm run dev（build + dev 一条龙）

# 3. 另开一个终端，端到端自检：静态资源、/healthz、建房/加入/断线重连
node tools/smoke.mjs http://127.0.0.1:8787

# 3b. 想验证服务端战斗模拟（AI 队友战场）就真打一局：建房 → 3 个 AI 补位 → 打完一轮
node tools/match-drive.mjs http://127.0.0.1:8787 --seconds=120

# 4. 用浏览器打开 http://127.0.0.1:8787 实际玩一局（标题页填昵称 → 创建房间）

# 5. 登录并发布到公网（首次会要求 wrangler login / OAuth）
npx wrangler deploy               # 或 npm run deploy
```

发布后 `https://<name>.<subdomain>.workers.dev` 就是游戏地址；也可以在 `wrangler.jsonc` 里加 `routes` 绑自己的域名。页面是 https，客户端会自动用 `wss://同一域名/ws`。

### 必须注意的两点

1. **计划选择**：建议用 Workers Paid（$5/月）。
   - 免费版 CPU 限制 10 ms/次调用，而本项目的 AI 队友/掉线托管战场是按 **8 ms 一片**分片跑的（`server/match/Match.js` 的 `BOT_SLICE_MS`），冷启动还要解析几 MB JSON —— 免费版会在这些路径上超限报错。
   - 付费版默认 30 s CPU/次调用，余量充足（文档里「每个房间每个作战回合约 1 ms CPU」）。
   - Durable Object 在「有连接或定时器」期间按持续时间计费；一台朋友局服务器量很小。
2. **素材与文件数**：把 `node tools/setup.mjs` 下全素材后，`dist/` 约 **5700 个文件 / 350 MB**（单文件最大约 3 MB）——远低于免费版 20000 个文件与 25 MiB/文件的上限。首次 `wrangler deploy` 会上传全部素材（较慢），之后只上传变化的文件。`build.mjs` 每次都会打印实际数字并在接近上限时提醒。

## 素材（`public/assets`、`public/fonts`、本地提取美术）

- `public/assets`（约 350 MB）和 `public/fonts` 由 `node tools/setup.mjs` 下载，`.gitignore` 里，**不随 git 走**；`data/local-assets.json` + `public/assets/local/` 是从本机《明日方舟》客户端提取的官方素材（官方 3D 棋盘、部分官方 UI 依赖它），同样是本机文件。
- `build.mjs` 会把它们一起复制进 `dist/`；`data/local-assets.json` 存在时用真清单，不存在时按 `server/index.js` 的行为写空清单（客户端就知道「没有本地美术」）。
- **改素材后必须重新 `npm run build` + `wrangler deploy`**：Cloudflare 的静态资源是随版本上传的不可变内容，而 Node 版服务器是每次请求重新读 `data/local-assets.json`。少 1 个文件不影响启动，只是那一处用占位/静默（`node tools/doctor.mjs` 会列出缺哪些）。
- `tools/smoke.mjs` 在这些文件存在时会额外检查：一张角色图、一首 BGM、`/media/…` 无扩展名音频路由、本地美术清单与其中一个文件、以及 `/assets/*` 的 1 天缓存头。

## 本地已实际验证的行为（wrangler 4.147 / workerd，2026-10）

适配层的每个关键假设都先在 `wrangler dev` 里实测过（连同真实浏览器客户端）：

| 结论 | 为什么重要 |
|---|---|
| Durable Object 里 **必须调用 `server.accept()`** | 不调用时 socket 会「打开但一个消息都收不到」（workerd 行为）；`src/game-server.js` 因此显式调用 |
| 关闭码 **1001 / 1008 / 4001 / 4002 原样透传**（只有保留码 1015 之类会被拒） | workerd 不强制 WHATWG 的「只允许 1000 或 3000–4999」限制，`server/net.js` 的 `CLOSE.REPLACED=4001`、`CLOSE.HELLO_TIMEOUT=4002` 语义完全保留（客户端就靠这两个码决定行为）；`ws-shim.js` 仍带一层「被拒就换等价自定义码」的兜底 |
| 转发前重建 Request（加 `x-sp-real-ip`）**不会破坏 WebSocket 升级** | 所以客户端 IP 能可靠地带进 DO，按网络限流（`NET_DEFAULTS.maxConnectionsPerAddr` 等）继续生效；`cf-connecting-ip` 本身也能直达 DO |
| `import.meta.url` 打包后是 `undefined` | `server/data.js` 模块顶层会因此抛错，用 `alias: node:url → src/url-shim.js` 解决（不改上游代码） |
| `node:fs` 需要 `enable_nodejs_fs_module`；**`/tmp` 是按请求隔离的** | 只有 `/tmp` 可写，且**跨请求不可见**：写入与读取必须在同一次调用里完成（`src/data-boot.js` 因此不做跨请求缓存）。`data/*.json` 由 `build.mjs` 以文本打进 Worker，写进 `/tmp` 后交给原 `server/data.js` 加载 |
| 模拟层的数据加载发生在**模块初始化**阶段 | `server/sim/nodeData.js`（Node 分支）会在模块顶层调用 `getData()`，早于 DO 构造：`src/data-preroll.js` 必须在那之前把数据写进 VFS，否则单例会缓存空对象、对局直接以「no chess pool」结束（踩过这个坑） |
| 内容模块的**计算型动态导入**打包后会静默失败 | `server/sim/content/{index,bonds,bands}.js` 用 `safeImport(\`./${n}.js\`)` 之类加载内容模块，打包器无法解析 → `build.mjs` 把它们改写成字面量（`.generated/` 副本，上游零改动），并在构建末尾扫描残留、发现就报错 |
| `setImmediate` / `process.env`（可读可写）/ `node:net.isIP` / `node:crypto` 均可用 | `server/lobby.js` 的 `setImmediate`、`server/match/Match.js` 的 `SP_VERIFY`/`SP_COMBAT`、`server/net.js` 的 `isIP` 都无需改动 |
| DO 无连接时仍持续跑 `setInterval`（实测 40 s / 79 次） | 掉线玩家的对局（AI 托管）不会因为「没人在线」而被回收 |
| **真打一局**：`tools/match-drive.mjs` 建房 → 3 个 AI 补位 → 打完整轮 | `SP_COMBAT=client` 下机器人战场由服务端模拟，`SP_COMBAT=server` 下四个战场全部服务端模拟：实测 2 轮完整推进（INFO_CHECK→…→UNITE→SETTLE→下一轮），2369 帧战斗快照，期间 `/healthz` 仍 p50=23ms / max=65ms |
| **真实浏览器客户端**：标题页 → 输入代号 → 大厅 → 创建房间 → 添加 AI 队友 | 客户端显示「已连接服务器」、延迟 1–2ms，房间密钥、座位、AI 队友、就绪状态全部来自 DO 的实时状态 |
| `dist/` 之外的路径、`/sim/nodeData.js`、目录遍历 | 由静态资源层 + `build.mjs` 的排除规则处理，`tools/smoke.mjs` 会逐条检查 |

## 已知差异（都是有意的）

- **静态响应的缓存头**：项目自己实现的是「html/代码 no-cache + revalidate；`/assets|/fonts|/vendor` 1 天；带 `?v=` 的 URL immutable」。适配层用 `_headers` 复刻了前两条；`?v=` 的 immutable 无法用路径规则表达，退化为正常的 revalidate（浏览器仍走缓存，只是多一次 304 协商）。
- **404/403 页面**：用平台默认的 404，而不是项目自带的中文错误页（只有直接访问错误 URL 时能看到差别）。
- **更新与预览**：部署新版本会重启游戏服务端对象（进行中的对局结束、玩家自动重连回大厅 —— 与 Node 版"重启服务器"同义，本项目无存档）。可在没人玩时部署；`wrangler.jsonc` 里已配 `durable_objects.code_update_strategy`（`deferred 900` 秒 = 最多再等 15 分钟）。想完全不打扰线上就用 `npm run deploy:preview` 起一个独立 Worker（独立 DO 与素材）。详见 DEPLOY.md §12.6。
- **站点公告与资源预载（适配层自带，不改游戏代码）**：`/api/announcement`、`/api/popup-announcement`、`POST /api/announce`（Bearer 令牌）与一个构建期注入 `dist/index.html` 的横幅/弹窗脚本 `public/sp-announce.js`——横幅关闭、弹窗点过之后，左下角还会留一个 `● 公告` 挂件（未读带 `新` 徽标），点开是把当前所有生效公告列在一起的面板，公告随时可查；资源预载/校验页在 `/preload`（清单由构建期生成，含每个文件的字节数与 SHA-256：可跳过本机已有的、也可逐个校验哈希）；首页左下角有一个注入的小挂件：既是入口（未预载时带提示徽章），也是**后台下载器**（点 ▶ 边玩边下、刷新续传、可暂停）。改公告用 KV 即可，不必重新部署（也就不会打断对局）。详见 DEPLOY.md §12.7。
- **内容包与语言（0.2.x）**：`/packs/index.json`（客户端启动时读取）与 `/packs/<id>/<file>`（只服务 manifest 点名的文件）由适配层实现 `src/packs.js`；索引与白名单在构建期用上游的 `server/packs.js` 扫描生成（Worker 读不了文件系统）。语言包本身是普通静态文件：`/i18n/<code>.json`、`/data/i18n/<code>.json`。
- **首页定制**：`GET /api/server-info`（KV / `SP_SERVER_INFO` / `cloudflare/config/server-info.json`）驱动标题页「关于本服务器」。注入的 `public/sp-tweaks.js` 在 fork 上替换其弹窗里的联系信息、并隐藏其自带但在此部署上不可用的「预载资源」pill（换成左下角 `/preload` 挂件）；**在原版（无此弹窗）上则自建一个左下角「ⓘ 关于本服务器」按钮 + 弹窗，未配置文档时不出现任何新增元素**。三个左下角挂件（资源预载 / 公告 / 关于本服务器）共用一个容器，**按界面自动显隐：公告与关于本服务器只在最初始的标题页出现，资源预载在大厅 / 房间仍可用、只在局内收起**（靠客户端 `.screen…` 类的变化判断，无轮询；见 DEPLOY.md §12.7.4）。见 DEPLOY.md §12.7.3。
- **自适应上游重构**：0.2.x 把 kits 加载搬进了 `server/sim/content/kits/index.js`（每个干员一个文件、209 个），`build.mjs` 会把这些"计算型动态导入"改写成字面量；写法一变构建就**报错**，不会让技能内容在运行时静默缺失。
- **延迟**：整台游戏服务端只活在**一个** Cloudflare 机房里（Durable Object 创建后不可迁移），所以"玩家→边缘"和"边缘→DO"两跳都要看。`GET /where` 会分别报出两处机房与 Cloudflare 实测的客户端 RTT；用 `[vars]` 的 `SP_DO_LOCATION_HINT` + 一个新 `SP_DO_NAME` 可以把 DO 换到离玩家更近的区域（本项目 DO 不存数据，换名零代价）。详见 DEPLOY.md §12.5。
- **`/healthz` 会唤醒 Durable Object**（页面每 60 秒轮询一次，用于「部署后自动刷新」）。空闲时这一次轮询会把 DO 冷启动一遍；对朋友局规模无所谓，若在意可以把它改成 Worker 直接回答静态字段。
- **`/media/…` 音频路由**是适配层重写的（原实现基于 `node:fs`）：候选扩展名顺序取自 `shared/media.js`，定位到文件后由静态资源层返回，Range/ETag/Content-Type 仍是原文件的那一套。
- **Range / 206**：Cloudflare 的静态资源层不支持 `Range` 请求，带 `Range` 的头会得到一个完整的 200（平台行为，本地和线上一致）。原 Node 服务器对音视频会答 206。本项目客户端从不用 Range（BGM 走 `fetch` + Web Audio 整段缓冲，没有 `seek`/`currentTime` 逻辑），所以实际无影响；将来若要加可拖动进度的音频/视频，需要在 Worker 里自己实现分段（`run_worker_first` + 手写 206）。

## 上游更新后

```bash
# 取新代码：从 fork 部署 → git pull 连适配层一起更新；要和上游同步则加一条 upstream 远程后合并
#   git remote add upstream https://github.com/sganggs/Stronghold-Protocol.git
#   git fetch upstream && git merge upstream/master     （根 README 顶部那几行说明如冲突，两边都保留）
# 从自己的上游检出部署 → git pull（不会碰到 cloudflare/ 这个新增目录）
cd cloudflare && npm run build    # 重新组装 dist/、.generated/ 与生成模块（新的 data/*.json 会自动进包）
npx wrangler deploy
```

`npm run build` 是安全网：新的数据文件、新的内容模块会被自动收进构建；如果上游把 `server/sim/content/index.js` 的动态导入写法、或 `bonds.js`/`bands.js` 的受保护导入形状改掉，构建会**直接报错并指出文件**，而不是让游戏在运行时悄悄少掉技能内容。

只有在下面这些情况下适配层才需要动：`server/net.js` 用到了 `ws` 的其它接口、`server/data.js` 换了数据加载方式、`server/index.js` 改了静态路由/`/healthz` 形状、或者上游新增了 Node 专有 API。`cloudflare/tools/smoke.mjs` 会第一时间把这些破坏性改动暴露出来（它检查静态路由、`/healthz` 字段、内容模块计数、数据键数，以及建房/加入/断线重连的完整协议流程）。

## 可选配置（wrangler.jsonc 的 vars）

与 Node 版一致的环境变量：`SP_VERIFY=off|sample|all`、`SP_COMBAT=client|server`、`SP_FULL`、`SP_DRAFT`、`DEBUG=1`；
以及 `LOBBY_DEFAULTS` / `NET_DEFAULTS` 里的数值项（如 `maxRooms`、`maxMatchesPerAddr`、`heartbeatMs`、`maxConnectionsPerAddr`），写成字符串或数字都可以。

## 对外发布

适配层是"拷进检出就能用"的形态：`node tools/export.mjs` 会生成一个独立目录（默认 `../Stronghold-Protocol-Cloudflare`），里面有面向使用者的 `README.md`、`VERSION`（记录验证过的上游版本与提交）、`LICENSE`/`NOTICE.md`，以及可直接拷入任意 Stronghold-Protocol 检出的 `cloudflare/`（不含依赖与构建产物，共 20 余个文件）。仓库 [`Stronghold-Protocol_cf_worker`](https://github.com/xiaomasama/Stronghold-Protocol_cf_worker) 里已经带着 `cloudflare/`，这个独立包是给"不想 fork、只想拿适配层"的人准备的。

兼容性：**原版 sganggs 0.2.1 / 0.2.2** 与 **fork xinhai-ai 0.2.0** 都实测通过 —— 构建会自动识别两者的差异：前者需要把 `server/sim/content` 里的计算型动态导入改写成字面量，后者源码本身就是字面量加载器（0 处改写）；前者由适配层注入公告横幅，后者自带的公告客户端接管显示且公告数据继续沿用其 `config/announcements.json`。
0.2.2 的实测：构建通过（209 个干员 kit、361 个模块改写）、`smoke` 全过、真打一局走完 2 个回合的服务端模拟、浏览器过一遍标题页 / 大厅 / 新的统计页。0.2.2 带来的两处适配层改动：构建标记（build tag）的输入扩到 `server/sim` + `shared` + `data`（上游 0.2.2 的 `buildTag.js` 同样这么做了，否则只改模拟代码的部署不会让已打开的页面刷新），以及公告横幅不再吃掉游戏顶栏控件的点击（0.2.2 新增的「统计」按钮正好落在横幅那一条上）。

## 许可

本适配层不含游戏素材，只包含适配代码；游戏本体与素材的许可见仓库根目录 `LICENSE` / `NOTICE.md`（素材版权归上海鹰角网络 / Yostar，仅限非商业同人使用）。
