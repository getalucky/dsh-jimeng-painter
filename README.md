# dsh-jimeng-painter

把**即梦网页版生图**接进 DeepSeek Harness。agent 调用 `jimeng_paint`，可直接选择即梦页面上不同的生图模型（Seedream 5.5 / 5.0 Pro / ImageMax 等，价格不同），拿到下载到本地的原图。

提交前会按风格补上镜头、景别、机位、构图、光线和色彩锚点，让 agent 写的一句话更容易出有辨识度的成片；也可以 `preview` 只看最终提示词，不花积分。

> 网页版没有公开 API，所以本插件用 **Edge 独立 profile + CDP** 驱动页面。首次登录由你在弹出的 Edge 里扫码，登录态保存在独立 profile 里，后续复用。

## 原理

```
jimeng_paint
  ├─ lib/prompt.mjs          # 按 style 编排提示词；preview=true 到这里就返回
  └─ node tools/paint.mjs --stdin-json
       └─ lib/bridge.mjs
            ├─ 启动 Edge（独立 profile，--remote-debugging-port=9335）
            ├─ 打开即梦生图页
            ├─ 选模型（li[role=option] 坐标点击）
            ├─ 设比例 / 清晰度（tooltip 文本点击）
            ├─ 填提示词、点生成、轮询结果
            └─ 通过 /mweb/v1/get_image_by_uri 换原图签名 URL 并下载
```

不依赖公开 API、不需要 API Key；默认抓 1248×1872 或更大原图，无水印。

## 安装

```powershell
dsh plugin --profile desktop add "link:D:\dsh-plugins\dsh-jimeng-painter"
```

然后在 `D:\DSH\profiles\desktop\package.json` 的 `dsh.profile.bundles` 里加上 `"dsh-jimeng-painter"`，重启 DSH。

首次使用前，插件会用 `profileDir` 启动 Edge；如果没有登录票，会停在即梦登录页，需要你在弹出的窗口里扫码登录一次。

## 工具

### `jimeng_paint`

| 参数 | 必填 | 说明 |
|---|---|---|
| `prompt` | 是 | 主体描述。写清主体、动作、场景和图上文字；镜头/风格可交给下面的参数补 |
| `style` | 否 | 风格包；不传用设置页默认（`auto`）。`auto` 按提示词自动选，`off` 原样送即梦。可选 `cinematic / portrait / film / guofeng / illustration / anime / cyber / product / deepsea / ink` |
| `lens` | 否 | 覆盖风格默认镜头，如 `wide-24`、`portrait-85`、`50mm`、`85mm 人像`、`微距` |
| `shot` | 否 | 覆盖景别：`closeup / medium-close / medium / full / wide / detail`，也可写中文 |
| `angle` | 否 | 覆盖机位：`eye-level / low / high / three-quarter / over-shoulder / pov / bird-eye / side`，也可写中文 |
| `composition` | 否 | 覆盖构图，最多 2 个，逗号分隔；如 `三分法,前景虚化` |
| `lighting` | 否 | 覆盖光线：`golden-hour / window / tyndall / rembrandt / rim / neon` 等，也可写中文 |
| `preview` | 否 | `true` 只返回最终提示词，不启动 Edge、不消耗积分 |
| `model` | 否 | 即梦模型名；不传用设置页的默认模型 |
| `ratio` | 否 | `智能 / 1:1 / 3:4 / 16:9 / 4:3 / 9:16 / 2:3 / 3:2 / 21:9`；不传用设置页的默认比例 |
| `resolution` | 否 | `1.5K / 2K / 4K`（自定义需在页面手动填尺寸）；不传用设置页的默认清晰度 |
| `count` | 否 | 生成张数，1–4；不传用设置页的默认张数 |
| `out_dir` | 否 | 输出目录；默认会话工作区下 `jimeng-images/` |
| `timeout_ms` | 否 | 等待超时，默认 300000 |

返回：`files`（本地绝对路径数组）、`urls`（CDN 原图地址，有时效）、`model`、`format`、`count`、`seconds`，以及 `prompt`（实际送进即梦的最终提示词）、`style / styleId`、`promptLength`、`warnings`、`notes`。

## 提示词风格编排

`lib/prompt.mjs` 只做确定性的文字编排，不调模型。顺序按即梦更吃的自然语言权重：

```
画质/媒介 → 镜头焦距 + 景别 + 机位 → 构图 → 主体 → 光线 → 色彩/材质/情绪 → 避免项
```

如果提示词里已经写了镜头、景别、构图或光线，风格默认值会跳过，不重复堆叠；显式传 `lens / shot / angle / composition / lighting` 时以参数为准。构图最多 2 个，提示词超过 360 字会返回 `warnings`，但不硬截断主体。

| id | 名称 | 适合 |
|---|---|---|
| `cinematic` | 电影写实 | 大多数场景、叙事感画面 |
| `portrait` | 人像写真 | 人像、头像、自拍 |
| `film` | 胶片日常 | 生活感、街拍、复古 |
| `guofeng` | 新中式 | 国风、古风、东方留白 |
| `illustration` | 绘本插画 | 手绘、水彩、绘本 |
| `anime` | 日系动画 | 二次元、赛璐璐 |
| `cyber` | 赛博霓虹 | 赛博朋克、未来都市 |
| `product` | 产品静物 | 商品、电商、棚拍 |
| `deepsea` | 深海梦境 | 深海、鲸、生物荧光 |
| `ink` | 水墨国画 | 水墨、宣纸、山水 |

`style=auto` 会按提示词关键词挑：水墨/动漫/插画/国风/赛博/产品/深海/人像/胶片，都没命中就走 `cinematic`。遇到油画、像素、3D、黑白等没有对应风格包的明确媒介时，auto 会保留原文不改写，避免摄影词把原风格洗掉；这时想加镜头感就显式传 `style`。不想改写也可以直接传 `style=off`。

先看提示词再决定要不要花积分：

```powershell
node tools/paint.mjs --preview --style deepsea "蓝发鲸鱼少女在珊瑚礁间自拍"
```

每次生成后，返回里的 `prompt` 就是实际送进即梦的版本；`warnings` 会提示提示词偏长等问题。

预设都在 `lib/presets/`：

- `frames.json`：镜头、景别、机位、构图、光线词表；每个词有 `phrase` 和用于去重的 `keywords`。
- `styles.json`：风格包，引用上面的 key，并带 `palette / texture / mood / avoid`。

加风格时在 `styles.json` 里复制一段，改 `id / label / aliases` 和引用的 key 即可；`tests/prompt.test.mjs` 会检查所有引用是否存在。

### `jimeng_status`

检查 CDP 端口、页面、编辑器、登录态和当前模型。排障先跑它。`models` 会尽量从页面实时读（`modelsLive: true`）；读不到时退回静态清单并给 `modelsError`。

## 模型

页面当前可选的生图模型（按页面顺序）：

| 模型 | 备注 |
|---|---|
| `Seedream 5.5` | 默认，界面价 5/张 |
| `Seedream 5.0 Pro` | 价 2.5/张（5/张），切换后会重置张数 |
| `即梦 ImageMax 1.0` | 会员/高清模型 |
| `图片美学模型 V8.2` | 风格化 |
| `Seedream 5.0 Aurora` / `5.0 Flash` / `5.0 Lite` | 5.0 系列，价格不同 |
| `Anycook 1.0` | 风格模型 |
| `Seedream 4.7` / `4.6` / `4.5` / `4.1` / `4.0` / `3.1` / `3.0` | 旧版模型 |

价格与额度以页面实际显示为准；不同模型消耗积分不同，agent 会按你在对话里指定的模型传入 `model`。

## 设置页

DSH 设置 → 左侧「即梦生图」（`settings.section`，id `jimeng-painter`）：

- **默认模型**：下拉框列出模型；点「刷新列表」会**自己拉起**装好调试端口的那个 Edge（独立 profile，首次约 10–30 秒），打开即梦生成页，点开模型下拉读 `li[role="option"]` 的首行（顺便带出价格），然后按 Escape 关掉，**不改页面当前选择**。读不到（Edge 起不来 / 页面没登录 / 加载太慢）就退回插件里的静态清单，页面顶部徽章显示「静态模型清单」，下面给出失败原因。
  - 注意：读的是插件自己那套 Edge（`profileDir`，CDP `cdpPort`），不是你在普通窗口里开的即梦——普通窗口没开远程调试，接不上。
  - 如果弹出的窗口停在登录页，扫码登录一次，再点「刷新列表」。
- **默认比例 / 默认清晰度 / 默认张数**：与页面上能选的保持一致（比例 9 档、清晰度 1.5K/2K/4K、张数 1–4）。
- **默认风格**：`auto` 按提示词自动识别；`off` 原样送即梦；也可以固定成 `cinematic / portrait / deepsea` 等风格 id。工具调用显式传 `style` 时优先。
- 五项一起保存，写回插件自己的 `cordis.patch.yml`（只改对应行，留 `.bak`，原子替换，回读校验）。本次运行立刻生效，重启后仍在。
- 工具调用时显式传的 `model` / `ratio` / `resolution` / `count` / `style` 仍然优先；不传才用设置页的默认值。

设置页的后端接口（同源，不写死端口）：

| 接口 | 说明 |
|---|---|
| `GET /dsh-jimeng-painter/api/config` | 当前默认值、可选比例/清晰度/张数、patch 状态 |
| `POST /dsh-jimeng-painter/api/config` | 保存默认值（白名单四个字段） |
| `GET /dsh-jimeng-painter/api/models` | 实时模型列表；`?refresh=1` 跳过 60s 缓存，`?launch=1` 允许自动拉起 Edge |

`launch=1` 只在用户点刷新时带（页面首次加载只读已开着的 CDP，不弹窗）；失败原因里会带 `reason`：`cdp-offline` / `launch-failed` / `no-page` / `login-required` / `not-ready` / `read-failed`。

`webServer` 是可选服务：宿主没提供时接口不挂载，工具与 CLI 照常工作，只是设置页读不到数据。

## 配置

`cordis.patch.yml` 的 `config`：

```yaml
enabled: true
cdpPort: 9335
edgeExe: ''          # 留空自动找 Edge
profileDir: 'D:\DSH\dsh-fish\home\jimeng-probe\profile3'
timeoutMs: 300000
outSubdir: jimeng-images
defaultModel: 'Seedream 5.5'
defaultRatio: '智能'
defaultResolution: '1.5K'
defaultCount: 1
defaultStyle: 'auto'
```

`defaultModel` / `defaultRatio` / `defaultResolution` / `defaultCount` / `defaultStyle` 一般不用手改，在设置页选就行；手改也不会坏，插件会校验并归一化。

换机器时把 `profileDir` 指到自己的独立 Edge profile，首次扫码登录。

## 注意

- 生成期间不要手动改页面模型/比例，否则可能抓错结果。
- 即梦网页有每日免费额度，用完会提示积分不足并弹会员；插件不会替你充值。
- `model` 必须精确匹配页面上的模型名；不匹配会报错，不会静默退回默认模型。
- 2K/4K 和会员模型会消耗更多积分，调用前确认清楚。
- 风格编排只改提示词，不会改模型/比例；`preview=true` 不连 Edge、不消耗积分。
- 镜头、景别、构图、光线用的是摄影语汇；如果画面本身是抽象插画，可以少传这些参数，或直接 `style=off`。

## 开发

```powershell
npm test            # 插件基础测试
npm run test:prompt # 提示词编排 + 预设引用完整性
npm run test:all    # 插件/设置/接口/客户端/编排，共 54 项
node tools/paint.mjs --dry-run "测试"
```

网页半边（`lib/client.js`）是宿主 `__ModuleLoader__` 的经典脚本，不能写 `import` / `export`；改完先用 `node --check lib/client.js` 和 `npm run test:client` 确认能加载，再重启 DSH 看真页面。

命令行直接出图：

```powershell
node tools/paint.mjs "冬日雪夜，蓝发鲸鱼少女自拍" --style deepsea --model "Seedream 5.5" --ratio 3:4 --resolution 1.5K
node tools/paint.mjs --preview --style portrait "窗边的银发少女"
```

## License

MIT
