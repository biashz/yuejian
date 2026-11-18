/**
 * 全书搜索：把 foliate 的异步生成器收敛成「按章分组」的结果。
 *
 * 库的 `view.search()` 是边搜边吐的异步生成器——先按 spine 顺序吐 `{progress}`，
 * 命中章节再吐 `{label, subitems:[{cfi, excerpt}]}`。这种形状直接丢给侧栏没法用：
 * 侧栏要的是「一次性结果 + 分组标题 + 可控条数」，而且需要知道搜到哪了。
 *
 * 五百章的书要搜十几秒，没有进度反馈用户会以为卡死；所以进度一路回报给调用方。
 */

/** 结果上限：再多的命中列表也没人往下翻，反而会把侧栏渲染拖慢 */
const MAX_HITS = 300;

/**
 * @param {{ view: any }} reader  EbookReader（只用它的 view）
 * @param {string} query
 * @param {{ onProgress?: (fraction: number) => void, token?: { cancelled: boolean } }} [options]
 * @returns {Promise<Array<{ label: string, hits: Array<{ cfi: string, excerpt: string }> }>>}
 */
export async function searchBook(reader, query, { onProgress, token } = {}) {
  const view = reader?.view;
  const groups = [];
  if (!view || !query) return groups;

  let total = 0;
  for await (const item of view.search({ query })) {
    // 生成器不能从外部中断，只能在每一轮之间检查一次
    if (token?.cancelled) {
      view.clearSearch();
      return groups;
    }
    if (item === "done") break;
    if (typeof item?.progress === "number") {
      onProgress?.(item.progress);
      continue;
    }
    if (!item?.subitems?.length) continue;
    const hits = [];
    for (const hit of item.subitems) {
      if (total >= MAX_HITS) break;
      // excerpt 是 `{ pre, match, post }` 三段（见库里的 makeExcerpt），
      // 不是纯文本——照抄才能把命中词单独包成 <mark>
      const excerpt = hit.excerpt || {};
      hits.push({ cfi: hit.cfi, pre: excerpt.pre || "", match: excerpt.match || "", post: excerpt.post || "" });
      total += 1;
    }
    if (hits.length) groups.push({ label: item.label || "", hits });
  }
  return groups;
}

export { MAX_HITS };
