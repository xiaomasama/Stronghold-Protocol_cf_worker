# Cloudflare Workers 部署与运维手册

把《卫戍协议：盟约》部署到 Cloudflare Workers 的**完整操作手册**：从零开始，每一步的命令、期望输出、验证方法和出错处理。

- 只想快速跑起来 → 看 [README.md](README.md) 的「部署步骤」四步。
- 想知道**为什么**是这个架构（Workers 而不是 Pages、一个 Durable Object 顶一个 Node 进程、适配层改了哪几处）→ 看 README 的架构与实测章节。
- 本文档 = **照着做就行**的操作手册，含线上运维（更新、回滚、日志、排错、成本）。

> 命令里的路径都以仓库根目录 `Stronghold-Protocol\` 为准；`cloudflare\` 是适配层目录。Windows 用 PowerShell 或 Git Bash 均可，涉及 Node 的命令两边一样。

---

## 0. 一分钟原理（读完再看步骤会更顺）

| 概念 | 在这个项目里是什么 |
|---|---|
| **Worker** | 一个部署单元 = 一份服务端脚本 + 一份静态资源（`dist/`）。静态资源由 Cloudflare 直接分发；只有 `/ws`、`/healthz`、`/media/…` 会真正执行脚本。 |
| **Durable Object（DO）** | 有状态对象。游戏的服务端（`server/net.js` + `lobby.js` + `match/*`）整个跑在**一个** DO 实例里，等价于原来的一个 Node 进程。房间、对局、会话都在它的内存里。 |
| **一次部署 = 一个不可变版本** | 每次 `wrangler deploy` 产生一个新版本（新代码 + 新素材快照）。改了素材/代码必须**重新部署**才生效（这点和 Node 版不同，Node 版改 `data/local-assets.json` 不必重启）。 |
| **本地就是同一个运行时** | `wrangler dev` 跑的是 Cloudflare 线上同款 workerd，本地验证过的行为线上一致（WebSocket、DO、兼容标志都一样）。 |

---

## 1. 准备清单

| 需求 | 说明 |
|---|---|
| Node.js | **22 或更高**（本项目 `package.json` 要求 `>=22`；开发用 24 已验证） |
| 磁盘 | 代码 + 依赖约 200 MB，游戏素材约 **350 MB**，`cloudflare/dist`（构建产物）再占约 **350 MB** |
| 网络 | 首次需要：拉依赖、下载素材（约 270 MB，可跳过）、部署时上传约 350 MB |
| Cloudflare 账号 | 免费注册即可。**强烈建议开 Workers Paid（$5/月）**，理由见 §12 |
| 一个终端 + 浏览器 | `wrangler login` 需要浏览器完成 OAuth（无浏览器环境见 §7.3） |

检查 Node：

```powershell
node -v      # 需要 v22.x 或更高，例如 v24.14.1
npm -v
```

---

## 2. 第 1 步：拿到代码并安装依赖

**代码从哪来（二选一）**：

- **方式 A（省事，推荐）：clone 已经备好的仓库** —— [`xiaomasama/Stronghold-Protocol_cf_worker`](https://github.com/xiaomasama/Stronghold-Protocol_cf_worker) = 上游 `sganggs/Stronghold-Protocol` + 本适配层（`cloudflare/` 已在仓库里，clone 下来就能直接部署）：

  ```powershell
  git clone https://github.com/xiaomasama/Stronghold-Protocol_cf_worker.git
  cd Stronghold-Protocol_cf_worker
  # 国内网络 github.com:443 不通时，走实时代理（§13.1 末尾有"抓到的提交号与官方 API 对得上"的校验方法）：
  # git clone https://ghproxy.net/https://github.com/xiaomasama/Stronghold-Protocol_cf_worker.git
  ```

- **方式 B：用你自己的上游检出**（原始 sganggs，或 xinhai-ai 的 fork）—— 把适配层目录 `cloudflare/` 整个放进检出根目录即可。适配层不含任何对上游文件的改动，`git pull` 不会和它冲突；独立发布包见 [README.md](README.md) 的「对外发布」。

然后安装依赖（在**仓库根目录**跑，不是 `cloudflare/` 里）：

```powershell
cd <你的 Stronghold-Protocol 项目目录>
npm ci
```

`npm ci` 会装齐服务端与前端库，并自动执行 `postinstall` → `tools/vendor.mjs`，把 PixiJS / three.js / Preact 等复制到 `public/vendor/`（**这一步必须有**，浏览器客户端要加载它们）。

**期望结果**：末尾出现 `added NNN packages`，且 `public/vendor/` 里有 `pixi.min.js`、`pixi-spine.js`、`preact.module.js`、`hooks.module.js`、`htm.module.js`、`three.core.js`、`three.module.js`。

**出错**：
- 卡在 `postinstall` → 网络问题，重试；或手动 `node tools/vendor.mjs`。
- `npm ci` 要求 `package-lock.json` 与 `package.json` 一致；如果你改过 `package.json`，改用 `npm install`。

---

## 3. 第 2 步：准备游戏素材（三选一）

素材是**按机器准备**的，`public/assets`、`public/fonts`、`data/local-assets.json` 都在 `.gitignore` 里，不会随 git 走。三条路：

### 3.1 推荐：从 Release「完整包」复制

在仓库的 [Releases](https://github.com/sganggs/Stronghold-Protocol/releases) 下载与代码**同版本**的完整包，把它里面的：

- `public/assets/`（约 350 MB，含官方 3D 棋盘所需的本地提取美术 `assets/local/`）
- `public/fonts/`
- `data/local-assets.json`

复制到本仓库的相同位置。**必须同版本**：不同版本提取的内容/清单不同，混用会缺图或用错图。

### 3.2 或者：用项目自带脚本下载

```powershell
node tools/setup.mjs
```

它会下载公开镜像的素材与字体（约 270 MB，可中断后续传），检测到本机装有《明日方舟》客户端时还会询问是否提取官方素材（可跳过）。
注意：它会重新生成受版本控制的 `data/assets.json`；跑完用 `git status data/assets.json` 看一眼，有意外差异就 `git checkout -- data/assets.json`。

### 3.3 或者：先跳过

不准备素材也能部署：游戏用占位图运行、缺的声音不播放、界面用系统字体。**不影响**服务端逻辑与联机功能。

### 3.4 校验素材完整性（每次准备完素材都做）

```powershell
node tools/doctor.mjs
```

只看「美术/音频」「字体」「本地客户端美术」三行。示例输出：

```
✔ 美术/音频 public/assets     4014/4023 项
! 字体 public/fonts           未生成（随素材下载一起生成；缺失时用系统字体）
✔ 本地客户端美术（可选）      1481 项，3D 棋盘可用
```

左侧 `✔`=齐，`!`=有缺但可运行（缺哪些会列出来），`✖`=缺到影响运行。**缺几个文件不必纠结**：缺的那一处降级（占位图/静音/系统字体），随时可以再补。

---

## 4. 第 3 步：安装适配层依赖

适配层只依赖 `wrangler`（Cloudflare 官方 CLI），装在 `cloudflare/` 自己的 `node_modules` 里，**不动仓库根目录的 `package.json`**：

```powershell
cd cloudflare
npm install
```

**期望结果**：`cloudflare/node_modules/.bin/wrangler` 存在。验证：

```powershell
npx wrangler --version      # 应打印 4.147.0 或更高
```

> 后续命令如果没写 `npx`，请保持当前目录在 `cloudflare/`（或者在仓库根用 `npx --prefix cloudflare wrangler …`）。
>
> ⚠️ **Windows 注意**：`npm install` 期间不要有正在运行的 `wrangler dev` —— 它会锁住 `node_modules`，npm 会报 `EBUSY: resource busy or locked, rename …miniflare…`。首次安装不会有这个问题（还没启动过 dev）；**更新依赖或重新安装前先执行 `npm run dev:stop`**（见 §6）。

---

## 5. 第 4 步：构建（把仓库组装成可部署形态）

```powershell
cd cloudflare
npm run build          # 等价于 node build.mjs
```

> ⚠️ 构建前先执行 `npm run dev:stop`：Windows 上正在运行的 `wrangler dev` 锁着 `dist/`，构建会报 `EPERM: Permission denied … dist`。

构建做四件事（全部是新增文件，仓库源码零改动）：

1. **`dist/`** —— 静态站快照，镜像 Node 版服务器的 URL 空间：`public/**` → `/`、`data/**` → `/data/`、`shared/**` → `/shared/`、`server/sim/**`（去掉 Node 专用加载器 `nodeData.js`）→ `/sim/`、再加生成的 `/data.js`（浏览器用数据替身）与 `_headers`（缓存策略）。
2. **`.generated/`** —— `server/` + `shared/` 的副本，仅把 `server/sim/content/*.js` 里**打包器无法解析的计算型动态导入**改写成字面量（否则技能/道具内容会在运行时静默消失）。
3. **`src/data-modules.generated.js`** —— 把所有 `data/*.json` 以文本形式引入 Worker（数据进服务端包）。
4. **`src/build-info.generated.js`** —— `/healthz` 上报的构建标记（页面据此在部署后自动刷新）。

**期望输出（示例，注意数字会随素材变化）**：

```
[cf-build] .generated/: content modules 9 domains (tokens, devices, enemies, bosses, bonds, garrisons, items, bands, choices)
[cf-build] .generated/: kit registry — 209 kit files (129 tier, 9 stand-in, 71 自选) made literal
[cf-build] .generated/: 358 modules adapted (3 guarded-import helpers, 6 call sites made literal)
[cf-build] packs: 4 loaded (languages: en, ja, ko, zh-TW), 0 servable file(s)
[cf-build] dist: 6015 files, 365.7 MiB (largest TX_autochessi_D.png 3.1 MiB)
[cf-build] data/*.json bundled into the Worker: 19 files
[cf-build] build tag: 2b22aab60dc9
[cf-build] WARNING: public/fonts is missing — run `node tools/setup.mjs`
[cf-build] local art manifest: 1481 entries
[cf-build] done. next: npx wrangler dev   (or npx wrangler deploy)
```

**读这几行**：

| 输出 | 含义 |
|---|---|
| `dist: N files, X MiB` | 素材有没有进去。没下素材时约 190 文件 / 18 MiB；全素材约 5700 文件 / 350 MiB。 |
| `data/*.json bundled into the Worker` | 服务端数据文件数（15 个必需 + `tuning.json`/`local-assets.json`/`emotes.json` 等）。 |
| `local art manifest: N entries` | 官方美术清单是否生效（有 `data/local-assets.json` 时应为 1481 之类；没有则写空清单）。 |
| `WARNING: public/assets is missing` | 没准备素材（§3.3），可以继续。 |
| `WARNING: public/fonts is missing` | 字体没下（系统字体降级），可以继续。 |
| `ERROR: … no longer matches the expected dynamic-import shape` | **上游改了 `server/sim/content` 的加载写法**，适配层需要同步更新（见 README「上游更新后」）。构建会**故意失败**，避免线上技能内容静默缺失。 |
| `computed dynamic import … cannot resolve` | 同上。 |

**构建是幂等的**：随时重跑，覆盖 `dist/` 与生成文件。

---

## 6. 第 5 步：本地跑通（`wrangler dev`）

```powershell
cd cloudflare
npx wrangler dev --port 8787 --ip 127.0.0.1
```

**期望输出**：

```
Your Worker has access to the following bindings:
Binding                         Resource
env.GAME (GameServer)           Durable Object
env.ASSETS                      Assets
env.SP_VERIFY ("off")           Environment Variable
env.SP_COMBAT ("client")        Environment Variable

⎔ Starting local server...
[wrangler:info] Ready on http://127.0.0.1:8787
```

保持这个终端开着（它是服务器）。浏览器打开 <http://127.0.0.1:8787>。

**手工验收清单**（照着点）：

1. 标题页出现，右下角显示 **已连接服务器**（说明 `/ws` 与 DO 通了）
2. 输入代号 → 点「开始」→ 进入「选择模拟协议」，右上角显示**延迟（个位数 ms）**
3. 选「同盟模拟」→ 点「创建同盟」→ 进入房间页：出现 4 位**同盟密钥**、4 个座位
4. 点某个空位的「添加 AI 队友」→ 出现「AI·华法琳」且「已就绪」
5. 点「开始模拟」→ 进入对局（AI 队友的战场由服务端模拟，几秒后出战斗画面）
6. 关掉浏览器标签再打开同一地址 → 用同一浏览器会自动恢复会话（10 分钟内同盟对局/独立对局更久）

**跳过端口/IP 参数**时的默认值是 `127.0.0.1:8787`；想让局域网其它设备访问，用 `--ip 0.0.0.0 --port 8787`。

想在**部署前先试真实边缘环境**（用线上的 Durable Object 与资源，需要已登录）：

```powershell
npx wrangler dev --remote --port 8787
```

它与纯本地模式的区别：代码跑在 Cloudflare 网络上、DO 是真实对象、域名是随机的 `*.workers.dev` 临时地址；用来确认"本地能跑但线上不行"类的差异（如公司网络对 WebSocket 的限制）。注意它操作的是**真实的 DO 状态**（会建房、会对局），玩完记得别把房间留着。

**停止服务器**：在该终端按 `Ctrl+C`。若终端已被关掉而进程还在（之后 `npm install` / `npm run build` 会因文件被锁而报 `EBUSY`/`EPERM`，或端口被占），用适配层自带的一条命令收尾：

```powershell
cd cloudflare
npm run dev:stop        # 停掉本目录的 wrangler dev / workerd（只动 cloudflare/ 下的进程）
```

等价的手工命令（没有 Node 时用）：

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe' or Name='workerd.exe'" |
  Where-Object { $_.CommandLine -like '*cloudflare*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

---

## 7. 第 6 步：本地自检（两条脚本）

这两个脚本是适配层自带的，`wrangler dev` 开着时在**另一个终端**运行。

### 7.1 端到端自检（约 15 秒，50+ 项）

```powershell
cd cloudflare
node tools/smoke.mjs http://127.0.0.1:8787
```

覆盖：静态路由（`/`、`/js`、`/css`、`/shared`、`/sim`、`/vendor`、`/data`、`/data.js`）、`/sim/nodeData.js` 必须 404、**内容包与语言**（`/packs/index.json`、`/i18n/<code>.json`、`/data/i18n/<code>.json`，以及 `/packs/README.md`、目录穿越、`/packs/<lang>/<file>` 必须 404 的白名单）、`/healthz` 字段、**内容模块计数与数据键数**、素材（角色图、BGM、`/media/…` 无扩展名音频路由、本地美术清单与文件、1 天缓存头）、以及完整的联机协议：`hello → welcome`、`ping → pong`、建房、第二人加入、**用 token 断线重连恢复会话**、离开房间。

结尾应打印 `All checks passed.`。任何 `FAIL` 都会带上实际值，便于定位。

### 7.2 真打一局（约 1–3 分钟）

```powershell
node tools/match-drive.mjs http://127.0.0.1:8787 --seconds=100
```

它会自己建房、塞 3 个 AI、开打，并替你这个"人类"完成每个阶段（情报确认 / 选策略 / 机变 / 准备就绪），结束时打印阶段轨迹、帧统计与 `/healthz` 延迟。

**判读**：

- `verdict : OK — COMBAT reached; the bot fields run on the server…` → 服务端 AI 战场模拟正常（默认 `SP_COMBAT=client` 时，人类战场等浏览器上报，所以停在 COMBAT 是正常的）
- 想看**四个战场全在服务端模拟**（最重负载，也是"能不能扛住"的实测）：另开一个实例

  ```powershell
  npx wrangler dev --port 8792 --ip 127.0.0.1 --var SP_COMBAT:server
  node tools/match-drive.mjs http://127.0.0.1:8792 --seconds=150 --combat=server
  ```

  期望：`verdict : OK — a server-side battle started AND finished inside the Durable Object`，且 `frames` 里有上千条 `b.snap`。实测该模式下 `/healthz` 仍保持 p50≈25 ms（8 ms 分片机制在 DO 里同样有效）。

---

## 8. 第 7 步：登录 Cloudflare

### 8.1 交互式登录（有浏览器）

```powershell
cd cloudflare
npx wrangler login
```

流程：自动打开浏览器 → 选择你的 Cloudflare 账号 → 点 **Allow** → 回到终端显示成功。凭据存在本机（Windows 一般在 `%APPDATA%\xdg.config\.wrangler\config\default.toml`）。

验证：

```powershell
npx wrangler whoami
```

会列出账号名、账号 ID、以及可用权限。**记下账号 ID**（多账号时后续用得到）。

### 8.2 没有浏览器 / 远程 SSH / 容器

```powershell
npx wrangler login --browser=false     # 只打印登录链接，你在别处打开并粘贴授权码
# 或
npx wrangler login --device           # OAuth 设备码流程（适合完全无图形界面）
```

### 8.3 CI / 自动化（不交互）

在 Cloudflare 控制台 **My Profile → API Tokens → Create Token**，用模板 **Edit Cloudflare Workers**，或自定义权限：

- `Account` → **Workers Scripts: Edit**（必须）
- `Account` → **Account Settings: Read**（wrangler 读取账号信息用）
- `Zone` → Workers Routes: Edit（只有绑定自定义域名时需要）

然后：

```powershell
$env:CLOUDFLARE_API_TOKEN = "…"
$env:CLOUDFLARE_ACCOUNT_ID = "…"      # 多账号时必填
npx wrangler deploy
```

---

## 9. 第 8 步：首次部署

### 9.1 先做一次"不联网"的预检（推荐）

```powershell
npx wrangler deploy --dry-run --outdir .wrangler/dryrun
```

它会把配置和代码完整打包一遍但不推送，用来提前发现配置错误与体积问题。期望输出：

```
✨ Read 6xxx files from the assets directory …\cloudflare\dist
Total Upload: 9738.46 KiB / gzip: 1366.41 KiB      # 含打进 Worker 的 data/*.json（各作为一个文本模块，chess/stages/backups 最大）
Your Worker has access to the following bindings:
Binding                         Resource
env.GAME (GameServer)           Durable Object
env.ASSETS                      Assets
env.SP_VERIFY ("off")           Environment Variable
env.SP_COMBAT ("client")        Environment Variable
--dry-run: exiting now.
```

**读法**：
- `Read N files from the assets directory` —— 素材文件数（wranger 把目录也计入，实际文件数 ≈ 5700）。免费版上限 20000 文件、单文件 25 MiB；超过时构建阶段会提示。
- `Total Upload: 6307.42 KiB / gzip: 955.56 KiB` —— **Worker 脚本包体**（含打进包里的 `data/*.json`），上限 64 MiB（未压缩），余量充足。素材不计入包体，它们走静态资源通道。

### 9.2 真正部署

```powershell
npx wrangler deploy
```

**首次会发生什么**：

1. 若这是账号第一次用 Workers，且没有 `workers.dev` 子域，会提示去注册 —— 打开提示里的链接（或在控制台 **Workers & Pages → 你的 Worker → Settings → Domains & Routes**）注册一个子域（例如 `myteam`）。
2. 上传静态资源与 Worker 脚本（全素材约 350 MB，第一次会慢一些，之后只上传变化部分）。
3. 结尾打印部署结果（大致长这样）：

```
Uploaded stronghold-protocol (12.34 sec)
Deployed stronghold-protocol triggers (2.05 sec)
  https://stronghold-protocol.<你的子域>.workers.dev
Current Version ID: 1a2b3c4d-…
```

**读法**：
- `https://stronghold-protocol.<你的子域>.workers.dev` 就是**游戏地址**，发这个（或自定义域名，见 §10）给朋友即可。
- `Current Version ID` 是本次版本号，回滚时要用（§11.5）。

### 9.3 首次部署常见拦路石

| 现象 | 处理 |
|---|---|
| `You need to register a workers.dev subdomain` | 按提示打开链接注册一次（免费） |
| `Authentication error` / `not logged in` | `npx wrangler whoami` 看是否还有效；失效就 `npx wrangler login` |
| 有多个账号，报找不到账号 | 加 `$env:CLOUDFLARE_ACCOUNT_ID = "账号ID"` |
| `A Worker with this name already exists` | 名字被你自己占用了（正常，直接部署即可，是同一个 Worker 的新版本）；若想换名字，改 `wrangler.jsonc` 的 `"name"` —— **注意换名字相当于新建一个空服务器**（DO 内存态不迁移） |
| 免费版部署成功但一玩就报错 | 见 §12「为什么建议付费计划」 |

---

## 10. 第 9 步：验证线上部署

把线上地址填进同一个自检脚本（它只是 HTTP/WS 客户端，不依赖本地）：

```powershell
node tools/smoke.mjs https://stronghold-protocol.<你的子域>.workers.dev
```

期望同样 `All checks passed.`。这一步会实际验证：**HTTPS 页面 + WSS 长连接 + 建房/加入/断线重连 + 素材可访问**。

再打开浏览器访问线上地址，重复 §6 的 6 条手工验收清单。手机也可以打开同一个地址（横屏体验更好）。

`/healthz` 可以直接看运行状态：

```powershell
curl https://stronghold-protocol.<你的子域>.workers.dev/healthz
# {"ok":true,"version":1,"app":"0.2.1","uptimeSec":…,"build":"…","sockets":…,"sessions":…,"rooms":…,"matches":…,
#  "content":{"kits":209,"domains":9},"dataKeys":19}
```

- `content.domains` 必须是 9、`content.kits` 应为 129 左右、`dataKeys` ≥ 15 —— 这三个是"服务端内容/数据装载正确"的信号（缺了就会是 0，说明构建产物不对）。
- `build` 是构建标记；页面每 60 秒对一次，部署新版本后**已打开的页面会自己刷新**。

---

## 11. 第 10 步（可选）：绑定自己的域名

1. 域名必须已托管在同一个 Cloudflare 账号（Workers 路由需要）。
2. 在 `cloudflare/wrangler.jsonc` 里加：

```jsonc
  // 整站走自有域名（替换成你的域名）
  "routes": [{ "pattern": "game.example.com", "custom_domain": true }]
```

   或只用子路径（此时 Worker 只接管该路径，静态资源也在该路径下）：

```jsonc
  "routes": [{ "pattern": "example.com/game/*", "zone_name": "example.com" }]
```

3. 重新部署 `npx wrangler deploy`。首次会为该域名自动申请证书（几分钟内生效）。
4. 客户端会在 https 页面自动使用 `wss://同一域名/ws`，无需改任何配置。
5. 不想再公开 `workers.dev` 地址：控制台 **Worker → Settings → Domains & Routes → workers.dev → Disable**。

> 注意：游戏必须部署在**域名根路径**（客户端用 `/data/`、`/vendor/`、`/ws` 等绝对路径）。用子路径路由时，`/data/…` 这类绝对路径仍会打到域名根，会被其它站点接管 —— **子路径方式不适用于本项目，请用独立子域**（`game.example.com`）。

---

## 12. 成本、限额与"为什么要付费计划"

| 项目 | Workers Free | Workers Paid（$5/月） |
|---|---|---|
| 请求 | 10 万/天 | 1000 万/月（含），超出按量 |
| **CPU 时间/次调用** | **10 ms** | 默认 30 s（可调） |
| Durable Object | 可用（SQLite 后端） | 可用 |
| 静态资源文件数 | 2 万/版本 | 10 万/版本（单文件 25 MiB 两者相同） |
| Worker 脚本包体 | 64 MiB（未压缩） | 64 MiB |

**为什么建议付费**：本项目的 AI 队友/掉线托管战场是按 **8 ms 一片**分片跑的（`server/match/Match.js` 的 `BOT_SLICE_MS`），冷启动还要解析几 MB 游戏数据。免费版 **10 ms/次调用**的 CPU 上限会让这些路径间歇性失败（报 `Error 1102`），表现为"打一会儿就掉线/战斗不结算"。付费版默认 30 s，实测（`SP_COMBAT=server` 四战场全模拟）也只用到几十毫秒/次调用。

**Durable Object 计费**：在"有连接或定时器"期间按持续时间计费；一台朋友局服务器（几个人、偶尔几局）量很小，正常在 $5 订阅内。

**省流量小技巧**：素材走静态资源通道，带 `Cache-Control: public, max-age=86400`（`/assets`、`/fonts`、`/vendor` 1 天），客户端刷新不会重复拉取；页面/代码/数据是 `must-revalidate`，总是最新的（部署后自动刷新靠 `/healthz`）。

---

## 12.5 延迟优化（把游戏服务端搬到离玩家更近的区域）

**先理解延迟从哪来**。这个部署有两跳：

1. **玩家 → Cloudflare 边缘**：由玩家的网络到 Cloudflare 最近可用机房的物理距离决定，**部署侧改不了**；
2. **边缘 → Durable Object**：整台游戏服务端（房间、对局、所有 WebSocket）只活在**一个**机房里，而且 **Cloudflare 的 Durable Object 一旦创建就不再迁移**。这一跳可以优化。

### 第一步：量一下（`/where`）

部署后直接访问 `https://<你的地址>/where`，会得到：

```json
{
  "edge": { "colo": "SJC", "clientTcpRttMs": 160, "city": "Shanghai", "asn": 24400, "country": "CN" },
  "durableObject": { "colo": "SJC", "name": "main" },
  "instance": "main", "locationHint": null
}
```

- `edge.clientTcpRttMs` 是 **Cloudflare 替你测的、你的网络到边缘的往返延迟** —— 这部分是物理距离，任何放置策略都去不掉。
- `edge.colo`（边缘）与 `durableObject.colo`（游戏服务端）**同区域 = 最优**；不同区域就多一个跨洋来回。注意"区域"是粗粒度的：**`LAX` 与 `SJC` 同属 `wnam`（北美西部），这一对是正常的**；跨区域才是 `SJC` ↔ `HKG`、`LAX` ↔ `SIN` 这种。
- 也可以看游戏内的延迟数字（标题页/大厅右上角，客户端每 4 秒 ping 一次）。

> 参考实测（上海，中国联通 ASN 24400）：`edge.colo = SJC`、`clientTcpRttMs = 160`，而同一台机器本地跑 `wrangler dev` 时延迟只有 1–3 ms。**160 ms 这一跳就是"延迟高"的主体**，它来自"大陆访问 Cloudflare 没有就近节点"（免费与普通付费计划都没有大陆机房；China Network 需要企业版 + ICP 备案）。

### 第二步：把 DO 放到与边缘相同的区域（唯一的部署侧杠杆）

位置提示只在**对象创建的那一刻**生效，所以要"换房" = **起一个新对象**：

```jsonc
// cloudflare/wrangler.jsonc
"vars": {
  "SP_VERIFY": "off",
  "SP_COMBAT": "client",
  "SP_DO_NAME": "main-2",              // ← 改一个新名字（旧对象被弃用）
  "SP_DO_LOCATION_HINT": "wnam"        // ← 可选值见下
}
```

```powershell
cd cloudflare
npm run build
npx wrangler deploy
curl https://<你的地址>/where        # 复核：edge.colo 与 durableObject.colo 是否同区域
```

可选提示值（粗粒度，Cloudflare 尽力而为，不保证落在指定机房）：

| 提示 | 区域 | 什么时候用 |
|---|---|---|
| `wnam` | 北美西部（SJC/LAX/SEA…） | 玩家边缘落在美西时（**大陆访问 Cloudflare 最常见的落点**） |
| `enam` | 北美东部 | 边缘在 IAD/EWR… |
| `apac` | 亚太 | 边缘在 HKG/SIN/NRT…（沿海部分 ISP、香港/东南亚玩家） |
| `apac-ne` / `apac-se` | 亚太东北 / 东南亚 | 玩家集中在日本·韩国·港台 / 新加坡一带 |
| `weur` / `eeur` / `sam` / `oc` / `afr` / `me` | 西欧 / 东欧 / 南美 / 大洋洲 / 非洲 / 中东 | 对应地区的玩家 |

**先采样，再决定**（同一台机器先后落在过 `LAX` / `SJC` / `SEA` / `AMS`，单次结果不足以判断）——在客户端定时跑 20 次：

```powershell
1..20 | ForEach-Object {
  $r = Invoke-RestMethod https://<你的地址>/where
  "{0}  edge={1} rtt={2}ms  do={3}" -f (Get-Date -Format 'HH:mm:ss'), $r.edge.colo, $r.edge.clientTcpRttMs, $r.durableObject.colo
  Start-Sleep 30
}
```

多数落在哪个区域就用哪个提示；两片区域来回漂说明放哪都一样（省了这边就多那边），保持现状即可 —— 因为**`clientTcpRttMs` 那一跳与 DO 位置无关**，它才是延迟主体。

**照着"玩家边缘的落点"选**：先让几位朋友各自打开 `/where` 看 `edge.colo`，多数人落在哪个区域就用哪个提示。**换名是零代价的**：本项目 DO 不存任何数据（房间与对局都在内存里，和 Node 版"重启服务器"等价），旧对象直接弃用即可。

> 本地 `wrangler dev` 里的 `/where` 只有 `edge` 部分有参考价值（那时根本没有真实 DO，`durableObject.colo` 反映的是你本机出口的机房）——位置结论要以**部署后**的 `/where` 为准。

### 第三步：如果 160 ms 这一跳仍然不可接受

Cloudflare 侧已无更好办法（大陆没有就近节点）。可选的替代路线：

- **自建服务器**：仓库本来就带 Node 版部署（`docs/DEPLOY.md`），把它放到**香港 / 日本 / 新加坡**的 VPS，从上海实测约 30–80 ms；适配层只在 Cloudflare 上才需要，自建时完全用不到。
- **Cloudflare 企业版 + China Network**（需要 ICP 备案与商务流程），才有大陆就近节点。
- **接受现状**：本项目是「浏览器各自模拟战斗、服务端只管回合/经济/校验」的架构，对延迟的敏感点是**操作响应与状态广播**，不是逐帧同步 —— 160 ms 会让手感变钝，但不会让战斗本身卡顿或不同步（这一点在设计上已经避开了高延迟最痛的部分）。

## 12.6 更新会不会影响正在进行的对局？· 预览通道

### 直接回答：会有影响，但可以控制时机

部署 = 上线一个新版本。**游戏服务端对象（DO）会被重启**，它的内存里装着房间、会话和进行中的对局 —— 重启后这些全部清空：

- 正在打的**对局立即结束**（结算不会正常走完）；
- 在线玩家**断开连接**（客户端会自动重连，但会话也是内存态，所以他们会回到标题页/大厅重新进房）；
- 这与项目文档里 Node 版的语义完全一致：「重启服务器会结束正在进行的对局」—— 本项目**没有存档**。

**缓冲窗口**：Wrangler ≥ 4.141 支持 Durable Object 代码更新策略，本项目已在 `wrangler.jsonc` 显式配置：

```jsonc
"durable_objects": {
  "bindings": [{ "name": "GAME", "class_name": "GameServer" }],
  "code_update_strategy": { "mode": "deferred", "max_delay": 900 }   // 秒；默认 300，上限 86400
}
```

| 模式 | 部署后的行为 |
|---|---|
| `deferred`（默认，本项目 900 秒 = 15 分钟） | **等对象空闲**（玩家全部退出、对象被回收）之后才切换；到 `max_delay` 秒仍未空闲 → 强制切换 |
| `immediate` | 部署完成即重启对象，进行中的对局**立刻**结束 |

因为本项目的 DO 由 WebSocket 与对局定时器常驻，**只要还有人在线就不会“空闲”** —— 所以 `deferred` 实际等于“最多再等 15 分钟”。想更宽裕就把 `max_delay` 调大（例如 `3600`），或者干脆挑没人玩的时间部署（最简单也最有效）。

### 想完全不打扰线上：走预览通道

**方案 A（推荐，确定可行）：另起一个“预览 Worker”**

Worker 名字不同 → **独立的 Durable Object 命名空间**（预览里的房间/对局与线上彼此不可见）+ 独立素材版本 + 独立地址：

```powershell
cd cloudflare
npm run deploy:preview      # = node build.mjs && wrangler deploy --name stronghold-protocol-preview
# → https://stronghold-protocol-preview.<你的子域>.workers.dev

node tools/smoke.mjs https://stronghold-protocol-preview.<你的子域>.workers.dev
# 在这里随便建房、开打、验证新代码；线上玩家毫无感知

npx wrangler delete --name stronghold-protocol-preview   # 不再需要时删除
```

代价：素材要再上传一次（首次约 350 MB；预览 Worker 之后的每次部署同样要上传，静态资源随版本走），以及多占一个 Worker 名额（免费版 100 个）。适合“改动较大、先让朋友在预览地址上试一局”。

**方案 B（beta）：`npx wrangler preview`（Worker Previews）**

Cloudflare 会为每个预览**自动创建独立的 Durable Object 命名空间**，URL 形如 `<预览名>-stronghold-protocol.<你的子域>.workers.dev`，要求 wrangler ≥ 4.135（本项目 4.147 ✓）：

```powershell
npx wrangler preview --name trial      # 预览名默认取当前 git 分支
```

注意：beta 功能；官方文档**没有明确静态资源（assets）在预览里的行为**，而本部署有 350 MB 素材 —— 想用之前先跑一次，然后在预览 URL 上访问 `/css/theme.css` 与一张 `/assets/...` 图，确认是 200 再依赖它。预览也不复制路由/Cron（它们指向生产）。

**✗ 不要走的弯路**：`wrangler versions upload --preview-alias`。Cloudflare 明确说明**包含 Durable Object 的 Worker 不生成版次预览 URL**（也不隔离 DO），对我们是无效路径。

### 推荐的更新流程

```powershell
cd cloudflare
npm run build                         # 1. 构建（先 npm run dev:stop）
npx wrangler dev --port 8787          # 2. 本地：node tools/smoke.mjs http://127.0.0.1:8787
npm run deploy:preview                # 3.（可选）线上预览验证
npm run deploy                        # 4. 挑没人玩时部署（或依赖 15 分钟缓冲）
node tools/smoke.mjs https://<你的地址>   # 5. 线上复核 + /where 看机房
```

## 12.7 站点公告与资源预载（适配层自带，不改游戏代码）

这两项都在适配层里实现：服务端代码在 `src/announce.js`，客户端是一个构建期注入 `dist/index.html` 的小脚本
（`cloudflare/public/sp-announce.js`）与一个独立页面（`cloudflare/public/preload.html`）。**仓库里的游戏代码一行都没动**，
上游更新照常可用。

### 12.7.1 公告

**数据格式**（与 xinhai-ai fork 的 `config/announcements.json` 相同，见 `config/announcements.example.json`）：

```jsonc
{ "announcements": [
  { "id": "maintenance-1",          // 唯一 id（1..64，字母数字_-）——客户端按它记住"已关闭"
    "type": "scroll",               // scroll = 顶部横幅；popup = 弹窗
    "text": "今晚 22:00 维护，请提前结束对局。",
    "title": "维护提醒",             // 可选，横幅/弹窗的加粗前缀
    "url": "https://…",             // 仅 popup：弹窗里的"查看详情"
    "autoPopup": true,              // 仅 popup：为 true 时即使点过也会再弹一次（可选）
    "level": "warning",             // info | warning | urgent（只影响颜色）
    "startAt": "2026-10-08T00:00:00+08:00",   // 必须带时区
    "durationSeconds": 3600,        // 1..86400（单条最长 24 小时）
    "enabled": true } ] }
```

窗口结束公告自动消失；一条公告最长 24 小时，更长的通知请按天续发或分多条。

**存放与发布（两种方式）**：

| 方式 | 怎么用 | 改公告要不要重新部署 |
|---|---|---|
| **KV（推荐）** | ① `npm run kv:create`（= `wrangler kv namespace create ANNOUNCE --binding ANNOUNCE --update-config`，**自动把 `kv_namespaces` 写进 `wrangler.jsonc`**）<br>② `npm run announce:push`（= `wrangler kv key put --binding=ANNOUNCE --remote announcements --path config/announcements.json`） | **不用**（对局不会被打断） |
| 变量 `SP_ANNOUNCEMENTS` | 不需要任何额外资源：把同一份 JSON 写进 `wrangler.jsonc` 的 `SP_ANNOUNCEMENTS`（默认注释里给了可直接粘贴的写法） | 要（每次部署都会重启游戏服务端对象） |

> ⚠️ **必须带 `--remote`**：Wrangler 4 的 `kv key put` / `kv key get` 默认操作**本地模拟存储**（输出里会写 `Resource location: local`），命令看起来成功、内容却只写进了 `.wrangler/state`，线上 Worker 读的是真实命名空间 —— 于是"公告推不上去"。两个 npm 脚本已内置 `--remote`；手动敲命令时别忘。
> `wrangler.jsonc` 里默认**没有**生效的 `kv_namespaces`（避免写一个假 id 让 `wrangler deploy` 失败），只有一段注释掉的模板：
> `// "kv_namespaces": [{ "binding": "ANNOUNCE", "id": "<命名空间 id>" }]`。
> 用 `npm run kv:create` 会自动补上；想手动来就先 `npx wrangler kv namespace create ANNOUNCE` 拿到 id 再取消注释填进去。
> 注意 `--update-config` 会重写 `wrangler.jsonc`，JSONC 注释可能被重排，建议先提交一次。

**实时发布 / 广播**：设了 `SP_ADMIN_TOKEN` 之后，向 `POST /api/announce` 发一份同样的 JSON（`Authorization: Bearer <token>`）即可：

```powershell
curl.exe -X POST https://<你的地址>/api/announce ^
  -H "Authorization: Bearer 你的令牌" -H "Content-Type: application/json" ^
  --data-binary "@config/announcements.json"
# → {"ok":true,"count":2,"stored":"kv","subscribers":3}
```

发布后：文档写入 KV，并**立即通过 `/announce-ws` 推送给所有在线页面**（实测：`subscribers` 是当前在线页数，DO 日志 `[announce] pushed to N client(s)`）。
没有 KV 时也能发布（只存在游戏对象的内存里，对象重启即失效）——适合临时通知。

**客户端怎么拿**：页面启动时拉一次 `/api/announcement`（滚动）与 `/api/popup-announcement`（弹窗），之后每 15 秒拉一次；同时保持一条 `/announce-ws` 连接用于即时推送。关闭过的公告按 `id` 记在浏览器里，不会反复弹。两项接口都是 `Cache-Control: no-store`，与 Node 版同形。

**「公告」挂件与公告面板（不会再把公告弄丢）**：横幅被关掉、弹窗点过"知道了"之后，公告不会就此消失——
左下角（`资源预载` 挂件上方，与 `关于本服务器` 同一个挂件栈）会留一个 `● 公告` 挂件，只要还有生效中的公告它就在，
点开是一个面板，把当前所有生效公告（滚动 + 弹窗）列在一起（多条时标题为 `公告（N）`，逐条带标题、正文与"查看详情"）。
要点：

- 任一公告还没被本浏览器读过时，挂件上带一个 `新` 徽标；打开面板即视为已读（徽标消失），**但不会**把横幅重新弹出来。
- 挂件上的小圆点按公告级别着色（info 绿 / warning 橙 / urgent 红）。
- 公告窗口结束或被 `POST /api/announce` 清空时，挂件会**实时**消失（同一秒，无需刷新）；新公告到达时同理实时出现。
- 所有生效公告都设 `"autoPopup": false` 时，页面不会自动弹窗，只留挂件——相当于"安静模式"：公告随时可查，不打扰玩家。
- 挂件/面板只在有公告时存在，纯静态部署（没有任何公告）时页面上看不到它们。
- **横幅不挡操作**：横幅是浮层，但只有它自己的文字与「关闭」按钮接收点击（`pointer-events`），游戏顶栏里的按钮照常点得到；横幅显示期间，标题页右上角的工具（语言、0.2.2 新增的「统计」）与大厅 / 房间的顶栏会整体下移 42px（`html.sp-ann-on`），避免被那一条压住。

> 提示：可以把"首次进入建议先预载资源"做成一条 `popup` 公告，`url` 填**完整的** `https://<你的地址>/preload`（`url` 必须是绝对 HTTP(S) 地址，相对路径会被拒绝）—— 这就是给预载页做入口的最省事办法（不用改游戏 UI）。
> 校验规则与 fork 一致：`id` 唯一（1..64，字母数字 `_ -`）、`text` 1..500 字符、`startAt` 必须带时区、`durationSeconds` 1..86400、`title` ≤80 字符、`url`/`autoPopup` 只允许用在 `popup` 上；文档整体校验，**格式错的一条会让整份文档被忽略**并在日志里给出原因（`[announce] ignoring an invalid document: …`）。

### 12.7.2 资源预载 / 校验页 `/preload`

打开 `https://<你的地址>/preload`。清单由**服务器在构建时生成**（`dist/data/preload-manifest.json`）：列出客户端会请求的每个 URL
及其**字节数与 SHA-256**（素材清单 + 本地美术 + `/data/*.json` + 语言包），因此页面本身不需要知道客户端如何拼 URL。清单里
还单独记录"游戏清单点名、但服务器上还没有"的文件（例如上游更新后还没跑 `node tools/setup.mjs`），页面上会直接提示。

两个动作：

| 动作 | 行为 |
|---|---|
| **开始预载（跳过已有）** | 先对每个 URL 做 `only-if-cached` 探测：**已在本机缓存的文件不发任何请求直接跳过**；其余才下载（并读干响应体以确保缓存落盘）。第二次点击通常几秒到几十秒（实测同一会话第二轮：跳过 3274 / 421 个每秒，第一轮 62.7s → 第二轮 13.1s）。 |
| **校验资源** | 逐个取回文件内容，核对**长度 + SHA-256**（`crypto.subtle`，仅 https/localhost 等安全上下文可用；不可用时退化为只比长度并如实说明）。这是"缓存里的确实就是服务器上的那份"的证明，而不只是"请求成功了"。实测 5509 个文件 3.9 秒（全部命中缓存）。 |

反馈是明确的：运行结束会给出**醒目的结果条**（✓ 成功 / ✗ 有失败），并把结果写进**标签页标题**（`✓ 完成 · 资源预载`），
所以切到后台也能看到结论；失败项逐条列出**原因**（`HTTP 404`、`长度不符`、`哈希不符`、`未缓存`…），并且可以"重试失败项"。
统计里区分"已有（跳过）""已获取""校验通过""失败"，并显示总体积、用时与速度。

- 6 路并发、可随时停止；失败不会中断整轮。
- 素材没预载也能玩（游戏按需加载、缺的用占位图），预载只是让"第一次见到某个干员/某段 BGM"不卡顿；校验则适合在
  "感觉画面不对/怀疑素材坏了"时排查（哈希不符 = 服务器上的文件变了或缓存损坏，重新预载即可）。
- **后台下载 / 边玩边下**：左下角挂件本身就是一个下载器（`public/sp-preload-link.js`）。点 ▶ 就在**当前页面后台**开始下载 —— 你可以照常进房间、打对局；两个文件并发、已在本机的用 `only-if-cached` 探测直接跳过、**刷新/重开标签页会自动续传**（进度与断点写在 localStorage），随时可用 ⏸ 暂停。
  - 实测（fork 实例，4043 个文件 / 284.6 MiB）：35 秒 63%，刷新页面后自动从 93% 继续；暂停后计数不再增长，恢复后继续（33% → 50%）。
  - 与 `/preload` 页互斥：预载页运行期间会写一个心跳，挂件等它过期再动（反之页面上会提示"后台下载进行中"），不会重复下载。
  - 页面上没有任何定时器（纯 `await` 链），所以标签页切到后台也不会被节流拖慢。
- **首页入口**：构建时会往 `dist/index.html` 注入一个左下角小挂件（`public/sp-preload-link.js`，游戏代码零改动），点它就到 `/preload`；
  浏览器还没成功预载过时挂件带一个「未预载」小徽章，预载/校验成功后在 `/preload` 里写入标记，徽章自动消失（构建版本变化会再次显示，提示重新预载）；
  挂件可以点 × 永久关闭（记在 localStorage）。在 fork（自带公告客户端）上挂件同样注入，只是不注入公告横幅。
- 另外也可以把"首次进入建议先预载"做成一条 `popup` 公告，`url` 填完整的 `https://<你的地址>/preload`。

> 与 xinhai-ai fork 的 `resources` 子系统的区别：那边是游戏内面板 + Service Worker（离线播放、资源哈希、可配 CDN），
> 整套约 90 KB 客户端代码并要改游戏 UI；这里是**适配层自带的独立页面**，同样能填满缓存、零上游改动，并且多了
> "跳过已有 / 哈希校验"这两点。要离线能力再考虑移植 fork 那套。

### 12.7.3 首页定制（隐藏 fork 自带的预载入口 · 自定义「关于本服务器」）

标题页上与本服务器相关的两处 UI 都由注入的 `public/sp-tweaks.js` 处理，**不改上游代码**。原版（sganggs）与 fork（例如 xinhai-ai）的区别在构建时自动检测，
并写在注入的 `<script src="/sp-tweaks.js" data-about-ui="checkout|none">` 上：

| 上游自带 | 在我们的部署上 | 适配层的处理 |
|---|---|---|
| 右下角「预载资源 / PRELOAD」pill（以及 设置 ▸ 预载资源 那一行）——**仅 fork 有** | **不可用**：它依赖 fork 自己的 `/data/resource-manifest.json`、Service Worker 与 Node 服务端端点 | 用 CSS 隐藏（`.title-preload`、`.res-pill`）并隐藏设置里对应的行；可用入口换成左下角的「资源预载」挂件（接 `/preload`，功能更全：跳过已有 + SHA-256 校验） |
| 「关于本服务器」 | fork：弹窗里的**联系方式/反馈/仓库**写死为 fork 作者的邮箱、B 站、仓库，与你的服务器无关；**原版 0.2.1：压根没有这个弹窗** | 都读 `GET /api/server-info`：fork 上用它替换弹窗里的那一段（未配置时保持原样）；**原版上适配层会在左下角（预载挂件正上方）自建一个「ⓘ 关于本服务器」按钮 + 弹窗**，标题/说明/条目/免责声明都来自配置。**未配置时页面上不会出现任何新增元素**，效果与原版完全一致 |

自建弹窗支持点遮罩或按 Esc 关闭；条目里的 `href` 是站内 `/路径` 时在本页打开，`http(s)`/`mailto` 新标签打开。

**配置「关于本服务器」**（三选一，优先级从高到低）：

```powershell
# 方式一（推荐，改内容不用重新部署）：KV
npm run kv:create                                       # 一次性，创建 ANNOUNCE 命名空间并写入 wrangler.jsonc
copy config\server-info.example.json config\server-info.json   # 改成你自己的内容
npm run info:push                                       # 写入 KV（key: server-info）
#   → 也可直接改 KV：npx wrangler kv key put --binding=ANNOUNCE server-info --path config/server-info.json

# 方式二：把同一份 JSON 写进 wrangler.jsonc 的 SP_SERVER_INFO（需重新部署，会重启游戏服务端对象）
# 方式三：放 cloudflare/config/server-info.json（构建时打进 Worker，同样需重新部署）
```

配置格式（示例见 `config/server-info.example.json`，校验规则与公告一致：行数 ≤ 20、`href` 仅支持 http(s)/mailto/`/path`）：

```jsonc
{ "title": "关于本服务器",              // 可选：弹窗标题
  "intro": "一句话介绍",                // 可选：正文前的说明
  "rows": [                             // 要展示的条目（会替换弹窗里的联系信息段）
    { "label": "联系邮箱", "value": "you@example.com", "href": "mailto:you@example.com" },
    { "label": "资源预载", "value": "先在首页左下角预载素材", "href": "/preload" } ],
  "disclaimer": null }                  // 可选：写成字符串数组可替换"版权与免责声明"段落（默认保留）
```

在线更新（免部署）：`POST /api/server-info`，`Authorization: Bearer <SP_ADMIN_TOKEN>`，body 为同一份 JSON（同样立即推送给在线页面）。
`GET /api/server-info` 无配置时返回 `204`：fork 的弹窗保持它自己的内容，原版页面上不出现任何新增入口。

> 验证过的行为（原版 sganggs 0.2.1，`wrangler dev` 本地实测）：配置了文档 → 左下角出现「ⓘ 关于本服务器」，
> 点开的弹窗含标题 / 说明 / 条目（含 hint 与链接）/ 免责声明；把 `SP_SERVER_INFO`（或 KV 里 `server-info`）清掉后刷新，按钮消失、页面与原版一致。
> 公告同理：顶部横幅 + `popup` 弹窗 + `POST /api/announce` 实时推送（无需刷新）。

### 12.7.4 左下角挂件的显示范围（按界面自动隐藏）

三个挂件共用一个容器 `#sp-chips`，但按各自用途在不同界面出现——隐藏只是给容器加类、按 id 收起某个挂件，不碰游戏 UI、不改上游代码：

| 界面 | 根元素 | 资源预载 | 公告 | 关于本服务器 |
|---|---|---|---|---|
| 标题页（最初始页面） | `.screen.title-screen` | 显示 | 显示 | 显示 |
| 大厅（选择模拟协议） | `.screen.lobby-screen` | 显示 | 隐藏 | 隐藏 |
| 房间 / 同盟 | `.screen.room-screen` | 显示 | 隐藏 | 隐藏 |
| 编队备赛 | `.screen.brief` | 隐藏 | 隐藏 | 隐藏 |
| 盟约选择 | `.screen.draft` | 隐藏 | 隐藏 | 隐藏 |
| 战斗中 | `.screen.gm`（`gm--prep` / `gm--battle` …） | 隐藏 | 隐藏 | 隐藏 |
| 结算 | `.screen.result` | 隐藏 | 隐藏 | 隐藏 |
| 载入 / 崩溃 | `.screen.gload` / `.screen.crash` | 隐藏 | 隐藏 | 隐藏 |

即：**「公告」与「关于本服务器」只属于最初始的标题页**；**「资源预载」在大厅、房间这类菜单里仍然可用**（等队友时可以先预载），只在局内收起。

判据来自客户端自己的界面类，而不是"猜"（`public/js/screens/*`）。实现（三个注入脚本里各一份相同的 `chipStack()`，谁先跑谁建容器）：
路由切换时客户端会把 `.screen…` 元素整体换掉（`<${Screen} key=${route}/>`），所以只需一个 `MutationObserver` 观察
"出现了 / 移除了 / 换了 class 的 `.screen` 节点"来重算，**没有轮询、没有定时器**；战斗中的高频 DOM 变化不会碰到 `.screen` 节点，
因此不会误触发。容器上同步三个类：`sp-off-title`（当前不是标题页 → 收起公告与关于本服务器）、`sp-in-game`（当前不是任何菜单屏 →
收起资源预载）、`sp-away`（见下）。

**与 0.2.3 新增 UI 的避让**（都是实测，不是写死数值）：

- **标题页底栏的「添加到桌面」**（0.2.3 的 PWA 安装按钮，`.title-foot`，`left:.44rem / bottom:.3rem`——正好在左下角）：
  整列挂件会**停在那一行上方 8px**（读它的 `getBoundingClientRect()`），视图缩放、切换语言、出现「继续对局」按钮都会自动重算
  （`ResizeObserver` 盯着底栏），不会像固定值那样削掉按钮的上沿。
- **竖屏旋转提示遮罩**（`.rotate-hint`，手机竖屏时铺满全屏，z-index 100，在本挂件之下）：它显示期间整列挂件 `display:none`，
  转回横屏立刻恢复。触发来自方向媒体查询与 `sp-rotatable`（device.js 打在 `<html>` 上的类），两者都监听。。两条判定都是"非菜单即视为局内"，所以上游将来新增的局内界面默认也是隐藏的。

> 顺带说明：顶部那条**公告横幅不受影响**（它是单独的元素 `#sp-ann-bar`，不在挂件栈里）——急事（如"服务器即将维护"）在局内也能看到；
> 公告的"未读推送"（横幅 + `popup` 自动弹窗）也照旧，只是左下角那个"随时回看"的入口只在标题页。若希望连横幅也只在标题页显示，说一声即可（一行 CSS + 一行类名）。

### 12.7.5 游戏内伤害统计（`public/sp-damage.js`）

对局内左下角有一条「⚔ 伤害统计」小条：点一下展开/收起，选择记在 `localStorage`。它读的是**游戏自己的实时数据**
（浏览器战斗模拟 `public/js/battle/runner.js` —— 游戏自己把它挂在 `globalThis.__SP_RUNNER__`，0.2.1 起就有），不重算任何数值：

| 面板显示 | 数据来源 |
|---|---|
| 总输出 / DPS | 我方各单位 `stats.dmg` 之和；DPS 再除以 `battle.time`（只算"打到对面身上"的伤害，与结算口径一致）|
| 我的 | `battle._perPlayer[我的 playerId].damageDealt`，括号里是占本场总输出的比例 |
| 对领袖 / 治疗 | `_perPlayer[*].bossDamage` / `healingDone` |
| 击杀 / 漏怪 | `battle.killed` / `leakedCount`（`共 N` 为本回合排入的敌人数）|
| 阵亡 | `_perPlayer[*].deaths` 之和 |
| **输出来源** | 逐个单位按 `kind` 归并：干员（`op`）直接成行；**召唤物（`token`）归给它的 `ownerUnit`**；装置（`device`，不属任何玩家）单列；只在玩家总量里出现、归不到单位的差额单列「其它（未归属）」 |
| 羁绊 | `runner.state().bondLayers`（我这边的羁绊层数，最多 5 条）|

口径说明：模拟里羁绊的效果是**给干员加成**（`dmgDealtMul` 之类），所以羁绊带来的伤害体现在**被加成干员的输出**上、不会单独成为一行；
会单列的"非干员来源"是装置，以及归不到单位的差额。羁绊层数单独一行列出，便于对照。

位置与开关：只在 `.screen.gm`（对局内）出现；桌面位置在左下角、**贴着游戏自带工具栏（交流 / ⚙ / 图鉴 / 全屏）的上沿**——
这个下边距是**实测**的（`placeAboveToolbar()` 读真实按钮的 `getBoundingClientRect()`，加 8px 余量），
所以视口缩放、旋转、安全区变化都会跟着走，不会像写死数值那样削掉「交流」按钮的一小条；展开约 206px 宽、最高 42vh，亦不压住那些按钮；
**「交流」轮盘打开时整条面板自动让开**（连刷新计时器一起停），
轮盘一关就回来——轮盘面板正好展开在同一个角落（`.ewheel__panel`，`bottom: calc(100% + .02rem)`）；
战斗结束到下一场开始之间保留「上一场」的数字。
刷新间隔 250ms（与游戏自己的详情卡同频），收起时不跑任何定时器；**竖屏旋转提示遮罩显示期间同样整块让开**。

**不想要这个面板**：删掉 `cloudflare/public/sp-damage.js` 即可 —— 构建会自动跳过它的注入（日志里会说一句
`not injecting it (feature disabled)`），`tools/smoke.mjs` 也会跳过对应的两条自检；把文件放回来就恢复。

## 13. 日常运维

### 13.1 更新游戏版本（上游有新提交 / 新 Release）

**先取新代码**（看你用哪种部署形态）：

- **部署的就是 fork（`Stronghold-Protocol_cf_worker`）**：`git pull` 会连适配层更新一起拿到；要和上游保持同步，加一条 `upstream` 远程再合并：

  ```powershell
  git remote add upstream https://github.com/sganggs/Stronghold-Protocol.git   # 只需一次
  git fetch upstream && git merge upstream/master
  #   合并时根目录 README.md 顶部那几行「本仓库 = 上游 + 适配层」的说明若与上游冲突，两边都保留即可
  ```

- **自己的上游检出 + 把 `cloudflare/` 放进去**：`git pull` 不会碰到 `cloudflare/` 这个新增目录（要更新适配层时，用发布包覆盖该目录）。

**然后重新构建并部署**：

```powershell
cd <你的 Stronghold-Protocol 项目目录>
npm ci                         # 依赖有变化时
node tools/setup.mjs           # 有新素材时（会跳过已存在的）
cd cloudflare
npm run build                  # 重新组装 dist/、.generated/、生成模块
#    ↳ 这次更新会不会打断正在进行的对局？能延后多久？要不要先走预览？见 §12.6
node tools/smoke.mjs http://127.0.0.1:8787   # （可选）本地先验证：先 npx wrangler dev
npx wrangler deploy
```

**git 连不上 GitHub 时**（大陆常见：`github.com:443` 超时，而 `api.github.com` / `codeload.github.com` 正常）—— 走实时代理拉取，再用官方 API 校验拿到的提交号就是上游最新提交（commit 哈希覆盖整棵树，对得上即内容可信）：

```powershell
# 1) 官方 API 报的 master 最新提交号
curl.exe -s https://api.github.com/repos/sganggs/Stronghold-Protocol/commits/master | findstr /C:"\"sha\""
# 2) 经实时代理抓取（gitclone.com 是缓存、可能落后；ghproxy.net 实时转发）
git fetch --depth=1 https://ghproxy.net/https://github.com/sganggs/Stronghold-Protocol.git master
git rev-parse FETCH_HEAD        # ← 必须与第 1 步的 sha 一致
git reset --hard FETCH_HEAD     # 浅克隆没有共同祖先，--ff-only 会被拒
```

> 同一手法也适用于你自己的 fork（含适配层）：把 URL 换成
> `https://ghproxy.net/https://github.com/<你的用户名>/Stronghold-Protocol_cf_worker.git`；push 也可以走它——
> `git push https://ghproxy.net/https://github.com/<你>/Stronghold-Protocol_cf_worker.git master`（代理会转发你的 GitHub 凭据）。

要点：
- **每次都要 `npm run build`**：`dist/` 是快照，不重新构建就不会带上新代码/新数据/新素材。
- 构建会在上游破坏适配假设时**主动报错**（§5 表格里的 ERROR 行），这时按 README「上游更新后」调整适配层。
- 部署完成后，正在打开的页面会在一两分钟内自动刷新到新版本（`/healthz` 的 build 标记连续两次变化即触发；这个标记已覆盖 `server/sim`、`shared`、`data`，与上游 0.2.2 的 `buildTag.js` 一致 —— 只改模拟逻辑的部署也会让旧页面刷新）。
- **0.2.2 起**：素材清单新增了条目（日语语音树等，见 `data/assets.json` 的 `audio`），更新后跑一次 `node tools/setup.mjs` 补齐（已存在的会跳过），否则它们会出现在预载页的"缺失"体检里。更新完对一下版本：标题页页脚与 `GET /healthz` 的 `app` 应显示 `0.2.2`。

### 13.2 只改素材（补字体、重新提取本地美术…）

同样要**重新构建 + 重新部署**：Cloudflare 的静态资源随版本不可变（Node 版服务器是每请求重读 `data/local-assets.json`，两者不同）。

```powershell
# 例如：补下缺失的字体与 BGM
node tools/setup.mjs
cd cloudflare
npm run build
npx wrangler deploy
```

### 13.3 看日志

```powershell
cd cloudflare
npx wrangler tail                       # 实时日志（服务端 console.log/warn/error）
npx wrangler tail --status error        # 只看报错
npx wrangler tail --format pretty
```

服务端自带的日志前缀：`[lobby]`（建房/开局/结束）、`[match <CODE>]`（对局内异常）、`[net]`（连接与限流）、`[data-boot]`（数据装载，正常应为 `game data: 18 keys`）、`[content]`（内容模块，正常应**一条都没有**）。
`[content] failed to load …` 或 `[data] missing data files` 说明构建产物有问题 → 重新 `npm run build` 再部署。

### 13.4 查看/回滚版本

```powershell
npx wrangler deployments list                # 最近部署记录
npx wrangler versions list                   # 版本列表（拿 Version ID）
npx wrangler rollback                        # 回滚到上一个版本
npx wrangler rollback <VERSION_ID> -m "回滚原因"
```

因为本项目用了 Durable Object，回滚会同时回滚 DO 的代码；进行中的对局本来就只在内存里（等价于重启服务器），回滚不会造成额外数据损失。

### 13.5 调参（不用改代码）

编辑 `cloudflare/wrangler.jsonc` 的 `vars` 后重新部署：

| 变量 | 作用 |
|---|---|
| `SP_VERIFY` | `off`（默认）/`sample`/`all` —— 服务端复算客户端战报的比例。`all` 明显吃 CPU，朋友局建议 `off` 或 `sample` |
| `SP_COMBAT` | `client`（默认，战斗在浏览器里跑）/`server`（全部由服务端模拟，负载高，仅排障用） |
| `SP_FULL` / `SP_DRAFT` | 内容开关（一般不用动） |
| `DEBUG` | 设为 `1` 打开 net/match 的调试日志 |
| `maxRooms` / `maxMatchesPerAddr` / `heartbeatMs` / `maxConnectionsPerAddr` … | 对应 `LOBBY_DEFAULTS` / `NET_DEFAULTS` 的数值项，写成数字或字符串都行 |

也可用命令行临时覆盖（仅本地 dev）：`npx wrangler dev --var SP_VERIFY:sample`。

### 13.6 对外发布（打包成独立目录）

```powershell
cd cloudflare
node tools/export.mjs                        # 默认输出到 ../Stronghold-Protocol-Cloudflare
node tools/export.mjs D:\发布\sp-cloudflare   # 或指定目录
```

生成的是"试用包"：`README.md`（面向使用者）、`VERSION`（上游版本 + 提交 + 兼容性声明）、`LICENSE`/`NOTICE.md`，以及一个可直接拷进任意 Stronghold-Protocol 检出的 `cloudflare/`（排除 `node_modules`、`dist`、`.generated`、生成模块与日志）。

> 已经有一个把两者合到一起的仓库：[`xiaomasama/Stronghold-Protocol_cf_worker`](https://github.com/xiaomasama/Stronghold-Protocol_cf_worker)（上游 + `cloudflare/`，见 §2 方式 A）。
> 想把适配层更新推回那个仓库：`cd <该仓库>` → 把 `cloudflare/` 覆盖成最新 → `git add cloudflare && git commit && git push`（仓库里已有 `cloudflare/`，不需要 export 再拷）。

### 13.7 用 Workers Builds 从仓库自动构建部署（可选，与本地部署并存）

Cloudflare 的 Git 集成（Workers Builds）可以把**已经存在的这个 Worker**接到 GitHub 仓库上：以后往仓库推提交，Cloudflare
自己构建并部署。**本地 `npx wrangler deploy` 那条路完全保留**——两条路按需使用，关系见文末。

**素材从哪来**：游戏素材（`public/assets` ~350 MB、`public/fonts`、`data/local-assets.json`）不在仓库里（500 MB 游戏数据不该进 git），
构建环境用 `node tools/setup.mjs` 自己下载（公开镜像，约 270 MB）。`cloudflare/tools/ci-build.mjs` 就是为此准备的构建入口，四步：
仓库根 `npm ci`（游戏依赖，`postinstall` 会填 `public/vendor`）→ `node tools/setup.mjs` → **体检**（`public/assets` 为空就**直接失败**，
绝不部署一个只剩占位图的站点）→ `node build.mjs`。已装依赖、已下素材会自动跳过，所以这条命令本地也能直接跑。

**不需要 KV / 公告 / 服务器信息**：这条路由可以完全不配 KV——适配层的公告横幅与「关于本服务器」入口在无 KV、无配置时**自动静默**
（页面上不出现任何新增元素）。将来想启用公告，再按 §12.7 加 KV 与绑定即可。

**设置（Dashboard → Workers & Pages → 选中 `stronghold-protocol` → Settings → Builds → Connect）**：

| 字段 | 值 |
|---|---|
| 仓库 / 生产分支 | 你的 fork `xiaomasama/Stronghold-Protocol_cf_worker` / `master` |
| **Root directory** | `cloudflare`（`wrangler.jsonc` 在这里；整个仓库仍完整检出，构建脚本照旧能读 `../public`、`../server`）|
| **Build command** | `node tools/ci-build.mjs` |
| **Deploy command** | `npx wrangler deploy`（默认值即可）|
| 构建变量（可选）| `NODE_VERSION=22`（镜像默认 Node 24，本项目 22/24 都行；想锁定就设它）|

**两条路的关系（重要）**：

- 用**同一个 Worker 名**（`wrangler.jsonc` 里的 `name`）时，两条路会**互相覆盖**：CI 部署按配置文件重建绑定，会把本地部署时
  加上的 KV 绑定**摘掉**（公告随之停用——这与"CI 不需要公告"一致）；下次本地部署又把它加回来。
- 想让两条路**同时在线、互不影响**：给 CI 那条单独一个 Worker 名。做法是在 `wrangler.jsonc` 里加一个 env（注意 env 不继承顶层，
  需要自带 `durable_objects` / `migrations` / `assets`），例如：
  `"env": { "ci": { "name": "stronghold-protocol-ci", "main": "src/worker.js", "compatibility_date": …, "compatibility_flags": […], "alias": {…}, "rules": […], "assets": {…}, "durable_objects": {…}, "migrations": [ … ] } }`，
  部署命令写 `npx wrangler deploy --env ci`；dashboard 里那个项目的名字要与该 env 的 `name` 一致（否则构建会失败）。

**其它要点**：

- **第一次 CI 部署前，建议先在本地对同样内容 `npx wrangler deploy` 一次**：静态资源按内容哈希去重，CI 首次就不用重传约 500 MB，
  也不至于逼近 20 分钟的构建上限。
- 本机提取的官方美术（`public/assets/local/` + `data/local-assets.json`，约 74 MB，来自本机《明日方舟》客户端）**无法在 CI 复现**：
  不额外处理的话，CI 构建的站点这部分退化为占位图（3D 棋盘与少数官方 UI）；想与本地构建一致，就把它提交进仓库，或做成一个小
  release asset 在构建命令里解开。
- 平台额度（免费版够用）：每月 3,000 构建分钟、并发 1、单次构建上限 20 分钟、磁盘 20 GB；本项目一次完整构建约 4–9 分钟。
- 非生产分支会生成 Preview URL；本项目的服务端是 Durable Object，Preview 对 DO 的支持官方文档没写死，要用先拿一个分支试。

### 13.8 彻底删除

```powershell
cd cloudflare
npx wrangler delete                 # 删除 Worker（含静态资源与它的 Durable Object）
# 自定义域名：控制台 → Worker → Settings → Domains & Routes 里删掉路由
```

---

## 14. 排错手册（按现象查）

| 现象 | 原因 / 处理 |
|---|---|
| `npm ci` / `npm install` 报网络错误（`ETIMEDOUT`、`ECONNRESET`、`network If you are behind a proxy…`） | 换国内镜像重试：`npm ci --registry=https://registry.npmmirror.com`（锁文件里的 `integrity` 哈希会逐个校验包内容，镜像无法替换成别的东西） |
| 上游升级后 `node tools/doctor.mjs` 显示素材缺失很多 | 新版本通常带来新干员/新素材：`node tools/setup.mjs` 会下载新增的部分（已存在的文件会跳过），之后再 `npm run build` + 部署 |
| `npm install` 报 `EBUSY: resource busy or locked, rename …miniflare…` | 有 `wrangler dev`（或它启动的 `workerd.exe`）正在运行，锁着 `node_modules` → `npm run dev:stop` 后重跑 `npm install`（可安全重跑，会补齐被中断的部分） |
| `npm run build` 报 `EPERM: Permission denied … dist` | 同上，这次锁的是 `dist/`：`npm run dev:stop` 后重新构建 |
| `wrangler dev` 报端口占用 | 换端口：`--port 8791`；或先 `npm run dev:stop` 停掉残留的 dev 进程 |
| Windows 上 `wrangler dev` 启动即崩：`✘ [ERROR] write EOF`（前面常有一串 `TimeoutError` 堆栈） | **与本项目无关，是 workerd 缺 MSVC 运行库**：workerd 是原生程序，Windows 上需要 [Microsoft Visual C++ 2015–2022 Redistributable](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist)（**x64 与 x86 都装**），装完**重启**即可。同类报告：[workers-sdk#6262](https://github.com/cloudflare/workers-sdk/issues/6262)、[workerd#4391](https://github.com/cloudflare/workerd/issues/4391)；社区定位见 [这篇排查记录](https://dev.to/mrtoxas/wrangler-write-eof-on-windows-the-actual-fix-31aj)。<br>注意 `npm run deploy` / `npm run build` **不受影响**（不启动本地 workerd）—— 修好之前可以先直接部署到线上验证，或改在 WSL 里跑 dev |
| 本地 dev 启动时 `[wrangler:warn] Unable to fetch the Request.cf object! … TimeoutError` | **无害**：miniflare 会拉一次 `https://workers.cloudflare.com/cf.json`（3 秒超时）给本地模拟 `request.cf` 用，拉不到就退回占位值 —— 只影响本地 `/where` 显示的机房名，不影响运行。想消掉这行：设环境变量 `CLOUDFLARE_CF_FETCH_ENABLED=false`，或把一份 cf.json 放到 `cloudflare/node_modules/.mf/cf.json`（缓存 30 天内有效，不再发这次请求） |
| 本地打开页面白屏 / 404 | 忘了 `npm run build`（`dist/` 不存在）；或 `wrangler dev` 不是从 `cloudflare/` 目录启动的（配置 `wrangler.jsonc` 在那里） |
| 页面能开但**没有样式 / 元素特别大 / 被裁掉** | 先分清两种情况：<br>① **窗口（CSS 视口）小于 768×432 像素**：整页缩放靠 `html{font-size: clamp(40px, min(100vw/19.2, 100vh/10.8), 240px)}`（设计基准 1920×1080），小于这个下限就不再缩小、直接裁切。**最常见的原因是浏览器缩放被拉高**（Edge/Chrome 会按站点记住缩放级别，`Ctrl+0` 重置；还可在设置 → 外观 → 页面缩放里检查），其次是 Windows 显示缩放（设置 → 系统 → 显示 → 缩放，高 DPI 会压小 CSS 视口），最后才是窗口本身太小。<br>控制台一行自测：`[innerWidth, innerHeight, getComputedStyle(document.documentElement).fontSize]` —— 正常应为 `innerWidth ≥ 768`、`innerHeight ≥ 432`、字号跟随窗口（如 1440×900 → `"75px"`）；出现 `[80, 153, "40px"]` 这类数字就是缩放/窗口被压到了下限以下。<br>② **页面是在 `npm run build` 期间/之前加载的**：构建会先删再重建 `dist/`，那一瞬间所有资源都是 404，浏览器（以及 dev 的资源缓存）可能把这个坏结果留下 —— 强刷（Ctrl+Shift+R）或换隐私窗口重开；以后构建前先 `npm run dev:stop`。 |
| 页面能开，但一直"未连接服务器" | `wrangler dev` 终端里看是否有 `/ws 101`；线上则是公司/校园网拦截 WebSocket，换网络或用手机热点试 |
| 建房按钮点了没反应 | 看 `/healthz` 的 `content.domains` 是否 0；为 0 说明构建产物不对 → 重新 `npm run build` 并部署 |
| 对局刚开始就"以 error 结束" | 服务端日志若为 `[match …] game data unusable (no chess pool)` → 数据装载失败：确认部署的是 build 之后的版本、`/healthz` 的 `dataKeys` ≥ 15 |
| 日志刷 `[content] failed to load ./devices.js` 之类 | 打包器适配失效（上游改了 `server/sim/content` 的加载写法）→ 重新 `npm run build`，构建会直接报错指出文件 |
| 一玩就断线 / `Error 1102` | 免费版 CPU 10 ms 上限 → 换 Workers Paid（§12） |
| 图标/语音缺失 | `node tools/doctor.mjs` 找出缺哪些 → 补齐后**重新构建并部署** |
| `/fonts/fonts.css` 404 | 正常：没下字体时用系统字体；想用原版字体就跑 `node tools/setup.mjs` |
| 改了本地提取美术，线上没变 | 静态资源随版本不可变 → 必须 `npm run build` + `wrangler deploy` |
| 部署后浏览器还显示旧界面 | 页面最长 60 秒后自动刷新；也可以强刷（Ctrl+F5） |
| 想看真实错误堆栈 | `npx wrangler tail --status error`，或在控制台 Worker → Logs（已在配置里开启 `observability`） |
| 房间里的对局在"所有人都掉线"后消失 | 对局中的定时器会让 DO 保持存活（实测 40 秒无连接仍持续运行）；但**完全空闲**（没有对局、没有连接、没有定时器）时 DO 会被回收，内存态清空 —— 与原 Node 版"重启服务器"等价，本项目本来就没有存档 |
| 线上延迟高 / 手感很钝 | 先访问 `/where` 看两跳：`edge.clientTcpRttMs`（你到 Cloudflare 边缘，物理距离，改不了）与 `edge.colo` vs `durableObject.colo`（跨区域就多一个来回）。给 DO 指定区域见 §12.5。大陆访问 Cloudflare 免费/普通付费计划没有就近节点，想真正低延迟要用香港/日本/新加坡的自建服务器（`docs/DEPLOY.md`） |
| 公告不显示 | ① 看 `GET /api/announcement` 是否 204（窗口已过/未开始/`enabled:false`）；② 单条最长 24 小时、`startAt` 必须带时区；③ 浏览器控制台看 `/sp-announce.js` 是否加载、`/api/announcement` 是否 200 |
| `/preload` 里大量 404 | 那就是服务器缺这些素材：`node tools/setup.mjs` 补齐后重新构建 + 部署，再点"重试失败项" |
| 想自动化部署（GitHub push 自动上线） | ① 控制台 **Workers → 你的 Worker → Settings → Builds** 连接 GitHub 仓库；或 ② GitHub Actions 里用 `cloudflare/wrangler-action`，仓库 Secrets 放 `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID`，命令 `npm run build && npx wrangler deploy`（注意仓库不含素材，CI 需要额外准备素材或跳过） |

---

## 15. 附录

### 15.1 目录与产物

```
cloudflare/
├── wrangler.jsonc              配置：兼容标志、DO 绑定与迁移、静态资源、data/*.json 的 Text 规则、vars
├── build.mjs                   构建：dist/ + .generated/ + 两个生成模块（会打印上表里的那些行）
├── dist/                       静态站快照（构建产物，.gitignore）
├── .generated/                 server/ + shared/ 副本（仅动态导入被改写，构建产物，.gitignore）
├── src/
│   ├── worker.js               入口：/ws、/healthz、/media/…、其余交给静态资源
│   ├── game-server.js          Durable Object：Network + Lobby + Match（复用上游代码）
│   ├── ws-shim.js              workerd WebSocket → ws 接口
│   ├── req-shim.js             Worker 请求 → node:http 请求视图（含客户端 IP）
│   ├── data-boot.js            数据写入 VFS 并交给上游 server/data.js
│   ├── data-preroll.js         在模块初始化阶段先把数据写进 VFS
│   ├── url-shim.js             node:url 垫片（修 import.meta.url 打包后为 undefined）
│   ├── media.js                /media/bgm/act1 → /assets/audio/bgm/act1.mp3
│   ├── data-modules.generated.js / build-info.generated.js   （构建产物，.gitignore）
└── tools/
    ├── smoke.mjs               端到端自检（36 项）
    ├── match-drive.mjs         真打一局（服务端 AI 战场验证）
    └── stop-dev.mjs            停掉本目录的 wrangler dev / workerd（npm run dev:stop）
```

### 15.2 实测过的平台事实（本地 `wrangler dev`，wrangler 4.147 / workerd）

- Durable Object 里**必须调用 `server.accept()`**，否则 socket 会打开但收不到任何消息。
- 关闭码 1001/1008/4001/4002 **原样透传**（客户端"被顶号/未 hello"的判定依赖 4001/4002）。
- 转发前重建 Request（加客户端 IP 头）**不会破坏 WebSocket 升级**。
- `import.meta.url` 打包后是 `undefined`（所以需要 `alias node:url`）。
- `node:fs` 需要 `enable_nodejs_fs_module`，且 **`/tmp` 按请求隔离**：写入与读取必须在同一次调用内完成。
- `setImmediate`、`process.env`（可读可写）、`node:net.isIP`、`node:crypto`（`randomBytes`/`randomInt`）都可用。
- DO 在无连接但仍有定时器时**不会被回收**（实测 40 秒 79 次 tick），所以掉线玩家的对局会继续跑。
- **静态资源不支持 `Range`/206**（带 Range 也返回完整 200）。本项目客户端从不用 Range（BGM 走 `fetch` + Web Audio 整段缓冲），实际无影响。

### 15.3 与 Node 版（`docs/DEPLOY.md`）的行为差异

| 方面 | Node 版 | Cloudflare 版 |
|---|---|---|
| 静态响应缓存头 | `/assets`、`/fonts`、`/vendor` 1 天；`?v=` immutable | 同前者；`?v=` 退化为正常 revalidate（功能无差） |
| 404 页面 | 项目自带中文错误页 | 平台默认 404 页 |
| Range | 音频/视频答 206 | 忽略 Range，整段 200（客户端不需要） |
| 改 `data/local-assets.json` | 不必重启，刷新页面即可 | 必须重新构建 + 重新部署 |
| 服务器重启 | `npm start` 后房间清空 | DO 被回收时等价（无存档，语义一致） |
| 局域网访问 | 直接 `http://192.168.x.x:3000` | 走公网域名（局域网设备同样用域名访问） |

### 15.4 每次更新后的检查清单

- [ ] `git pull` 后 `npm ci`（依赖变了才需要）
- [ ] `node tools/setup.mjs`（有新素材才需要）→ `node tools/doctor.mjs` 看三行状态
- [ ] `cd cloudflare && npm run build` —— **没有 ERROR 行**
- [ ] 本地 `npx wrangler dev` + `node tools/smoke.mjs` —— `All checks passed.`
- [ ] `npx wrangler deploy`
- [ ] `node tools/smoke.mjs https://<你的地址>` —— `All checks passed.`
- [ ] 浏览器开一局（标题页 → 建房 → 加 AI → 开始）
