/**
 * 电子书版式：把散落在 settings 里的十几个平铺字段，收成一个「版式对象」。
 *
 * 为什么要有这一层：面板要读、样式要算、预设要反推，三方都需要「当前版式」这个
 * 概念。谁都直接去摸 `settings.ebookFontSize` 这类键，迟早出现三处各写一份 clamp
 * 和默认值，改一个范围要改三遍。
 *
 * 存储仍是平铺字段（Rust 侧 `Settings` 是强类型 struct + 容器级 `serde(default)`，
 * 追加字段零成本；改成嵌套对象会让旧 `state.json` 的键被 serde 静默丢弃，等于升级丢设置）。
 * 这一层只做「读出来归一化」和「写回去」，不持有状态。
 */
import { clamp } from "../core/dom.js";
import { FONT_IDS } from "./fonts.js";

/** 各项的取值范围：面板的滑杆上下限、样式的 clamp 都用这一份 */
const RANGE = {
  size: [14, 28],
  letter: [-0.5, 2],
  lineHeight: [1.3, 2.4],
  paraSpacing: [0, 32],
  margin: [8, 120],
  measure: [480, 1200],
  gap: [2, 14],
};

/** 字号步进的步长；滑杆类用各自 step（见 PANEL_RANGE） */
const SIZE_STEP = 1;

/**
 * 预设。
 *
 * 不存「当前是哪个预设」——反推。存 id 的话，用户改完某一项、id 还挂在旧值上，
 * 面板就会显示「紧凑」而实际不是，这种错没法自愈。反推的代价是每次比较十几项，
 * 一次面板同步跑一遍，无所谓。
 */
const PRESETS = {
  comfort: {
    family: "serif", size: 19, letter: 0.25, lineHeight: 1.85,
    breakMode: "indent", paraSpacing: 0, align: "justify",
    margin: 56, measure: 660, gap: 8, hyphenate: false, punctuate: true,
  },
  compact: {
    family: "sans", size: 17, letter: 0, lineHeight: 1.65,
    breakMode: "space", paraSpacing: 8, align: "justify",
    margin: 40, measure: 780, gap: 6, hyphenate: false, punctuate: true,
  },
  latin: {
    family: "serif", size: 17, letter: 0, lineHeight: 1.7,
    breakMode: "space", paraSpacing: 12, align: "left",
    margin: 48, measure: 640, gap: 8, hyphenate: true, punctuate: false,
  },
};

/** 参与预设比较的字段（`spread` / 覆盖开关不属于「版式风格」，不进预设） */
const PRESET_KEYS = Object.keys(PRESETS.comfort);

const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const pick = (value, options, fallback) => (options.includes(value) ? value : fallback);

/** 分段方式由两个字段推出来：缩进优先，其次段距，都没有就是「无」 */
function breakModeOf(indent, paraSpacing) {
  if (indent > 0) return "indent";
  return paraSpacing > 0 ? "space" : "none";
}

/**
 * 从 settings 读出归一化后的版式对象。
 * 所有数字都 clamp 过：state.json 可能是手改过的，也可能是旧版本留下的。
 */
function readLayout(settings) {
  const size = Math.round(clamp(num(settings?.ebookFontSize, 19), ...RANGE.size));
  const paraSpacing = clamp(num(settings?.ebookParaSpacing, 0), ...RANGE.paraSpacing);
  const indent = clamp(num(settings?.ebookIndent, 0), 0, 2);
  return {
    family: pick(settings?.ebookFamily, FONT_IDS, "serif"),
    size,
    letter: clamp(num(settings?.ebookLetterSpacing, 0), ...RANGE.letter),
    lineHeight: clamp(num(settings?.ebookLineHeight, 1.85), ...RANGE.lineHeight),
    indent,
    paraSpacing,
    breakMode: breakModeOf(indent, paraSpacing),
    align: settings?.ebookAlign === "left" ? "left" : "justify",
    margin: Math.round(clamp(num(settings?.ebookMargin, 56), ...RANGE.margin)),
    measure: Math.round(clamp(num(settings?.ebookMeasure, 660), ...RANGE.measure)),
    gap: clamp(num(settings?.ebookGap, 8), ...RANGE.gap),
    spread: settings?.ebookSpread !== false,
    hyphenate: Boolean(settings?.ebookHyphenate),
    punctuate: settings?.ebookPunctuate !== false,
    override: Boolean(settings?.ebookOverride),
    /*
     * 配色覆盖**独立**于排版覆盖，且缺省为开。
     *
     * 理由是真机上撞见的一件事：夜读主题下不接管书内字色，书里写死的 `#333`
     * 就压在深色底上——几乎读不清。书架页面是应用的主题说了算，正文页也该如此；
     * 想看出版方原色的人可以自己关掉。
     *
     * `null` / 缺失（旧 state.json）都按开处理。
     */
    overrideColor: settings?.ebookOverrideColor !== false,
  };
}

/** 改分段方式：另存的那个值不清零，切回来还能用；「无」才是真的两个都清 */
function setBreakMode(settings, mode) {
  if (mode === "indent") {
    settings.ebookIndent = 2;
  } else if (mode === "space") {
    settings.ebookIndent = 0;
    // 段距为 0 时给个能看见的起点，否则选了「段间距」却什么都没发生
    if (!(Number(settings.ebookParaSpacing) > 0)) settings.ebookParaSpacing = 10;
  } else {
    settings.ebookIndent = 0;
    settings.ebookParaSpacing = 0;
  }
}

/** 把某个预设整组写回 settings（只写它管的那几项，双页与覆盖开关不动） */
function applyPreset(settings, name) {
  const preset = PRESETS[name];
  if (!preset) return false;
  settings.ebookFamily = preset.family;
  settings.ebookFontSize = preset.size;
  settings.ebookLetterSpacing = preset.letter;
  settings.ebookLineHeight = preset.lineHeight;
  settings.ebookParaSpacing = preset.paraSpacing;
  settings.ebookIndent = preset.breakMode === "indent" ? 2 : 0;
  settings.ebookAlign = preset.align;
  settings.ebookMargin = preset.margin;
  settings.ebookMeasure = preset.measure;
  settings.ebookGap = preset.gap;
  settings.ebookHyphenate = preset.hyphenate;
  settings.ebookPunctuate = preset.punctuate;
  return true;
}

/**
 * 当前版式命中哪个预设；都不命中返回空串（面板显示「自定义」）。
 *
 * 比较时把「缩进模式下那个不生效的段距」抹平：用户在缩进模式下动过段距滑杆、
 * 又切回缩进，值还留着但已经不起作用，不该因此判成自定义。
 */
function activePreset(layout) {
  for (const [name, preset] of Object.entries(PRESETS)) {
    const same = PRESET_KEYS.every((key) => {
      if (key === "paraSpacing") {
        const left = layout.breakMode === "indent" ? 0 : layout.paraSpacing;
        const right = preset.breakMode === "indent" ? 0 : preset.paraSpacing;
        return left === right;
      }
      return layout[key] === preset[key];
    });
    if (same) return name;
  }
  return "";
}

/** 回出厂：先清掉覆盖配色（它是「从没碰过」= null，由 override 推），再套默认预设 */
function resetLayout(settings) {
  applyPreset(settings, "comfort");
  settings.ebookSpread = true;
  settings.ebookOverride = false;
  settings.ebookOverrideColor = true;
}

export { RANGE, SIZE_STEP, PRESETS, readLayout, breakModeOf, setBreakMode, applyPreset, activePreset, resetLayout };
