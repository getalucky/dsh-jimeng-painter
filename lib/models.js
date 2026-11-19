/**
 * 即梦网页「图片生成」页面截至 2026-11 的模型清单。
 * 顺序与页面下拉框一致；页面新增模型时仍可直接传名字，不依赖此表。
 */
export const MODELS = [
  { name: 'Seedream 5.5', note: 'SOTA，真实感、复杂图文场景强' },
  { name: 'Seedream 5.0 Pro', note: '商业设计、影视、高密度图文' },
  { name: '即梦 ImageMax 1.0', note: 'Beta，平面设计、影视、图片编辑' },
  { name: '图片美学模型 V8.2', note: '偏美学创作，艺术感强' },
  { name: 'Seedream 5.0 Aurora', note: '搜索、编码、反思，多文字海报' },
  { name: 'Seedream 5.0 Flash', note: '轻量版 5.0 Pro，更快更便宜' },
  { name: 'Seedream 5.0 Lite', note: '指令响应更精准' },
  { name: 'Anycook 1.0', note: '场景设计、滤镜添加' },
  { name: 'Seedream 4.7', note: '画质与指令优化' },
  { name: 'Seedream 4.6', note: '人像一致性、性价比' },
  { name: 'Seedream 4.5', note: '一致性、风格、图文响应' },
  { name: 'Seedream 4.1', note: '创意、美学、一致性' },
  { name: 'Seedream 4.0', note: '多参考图、系列组图' },
  { name: 'Seedream 3.1', note: '美学多样性' },
  { name: 'Seedream 3.0', note: '影视质感、文字、直出 2K' },
]

export const MODEL_NAMES = MODELS.map((m) => m.name)

export const RATIOS = ['智能', '1:1', '3:4', '16:9', '4:3', '9:16', '2:3', '3:2', '21:9']
/** 页面实际列出的清晰度档位（自定义需要页面手动填尺寸，工具暂不暴露）。 */
export const RESOLUTIONS = ['1.5K', '2K', '4K', '自定义']

/** 工具允许直接选择的档位。 */
export const TOOL_RESOLUTIONS = RESOLUTIONS.filter((x) => x !== '自定义')
