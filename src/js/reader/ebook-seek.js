/**
 * 进度条上的章节刻度与预览气泡。
 *
 * 刻度位置来自各节的 `size`（EPUB 是章节 XHTML 的字节数，与阅读时长近似成正比）：
 * 累加归一后就是每章在全书里的起点。拿不到 size 的格式（漫画）退化成等分。
 * 超过 40 根就按步长抽稀——刻度是「章与章的边界感」，密到糊成一条反而没了意义。
 *
 * 气泡文案来自目录：把每条目录 href 解析成 spine 下标（同步、不加载文档），
 * 映射到同一个起点比例上；预览时取「不超过目标位置的最后一章」。
 */

const MAX_TICKS = 40;

async function buildSeekData(pane) {
  const reader = pane.ebook;
  const sections = reader?.book?.sections || [];
  if (!sections.length || !reader.view) return null;
  const sizes = await Promise.all(
    sections.map((section) => Promise.resolve(section?.size).catch(() => 0)),
  );
  let weights = sizes.map((value) => Number(value) || 0);
  if (!weights.some((value) => value > 0)) weights = sections.map(() => 1);
  const total = weights.reduce((sum, value) => sum + value, 0);
  const starts = [];
  let acc = 0;
  for (const weight of weights) {
    starts.push(acc / total);
    acc += weight;
  }
  let ticks = starts.slice(1).filter((frac) => frac > 0.002 && frac < 0.998);
  if (ticks.length > MAX_TICKS) {
    const stride = Math.ceil(ticks.length / MAX_TICKS);
    ticks = ticks.filter((_, index) => index % stride === 0);
  }
  const marks = [];
  for (const item of pane.ebookToc || []) {
    const index = reader.view.resolveNavigation(item.href)?.index;
    if (index == null || index < 0 || index >= starts.length) continue;
    const frac = starts[index];
    if (!marks.some((mark) => Math.abs(mark.frac - frac) < 0.001)) {
      marks.push({ frac, label: item.label });
    }
  }
  marks.sort((a, b) => a.frac - b.frac);
  pane.seekData = { ticks, marks };
  return pane.seekData;
}

function seekLabel(pane, fraction) {
  const marks = pane?.seekData?.marks || [];
  let label = "";
  for (const mark of marks) {
    if (mark.frac > fraction + 0.001) break;
    label = mark.label;
  }
  return label;
}

function ticksHtml(pane) {
  return (pane?.seekData?.ticks || [])
    .map((frac) => `<span class="ebook-tick" style="left:${(frac * 100).toFixed(2)}%"></span>`)
    .join("");
}

export { buildSeekData, seekLabel, ticksHtml };