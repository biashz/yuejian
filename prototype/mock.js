/* 阅笺原型 · 唯一数据源（mock schema 见 docs/design-contract.md） */

const BOOKS = [
  {
    id: "b1", title: "纸页上的呼吸", subtitle: "论长文本的排版节奏",
    author: "林敬之", kind: "pdf", pages: 6, progress: 0.42, favorite: true,
    lastOpened: "刚刚", tint: "clay", year: "2024"
  },
  {
    id: "b2", title: "Rust 程序设计语言", subtitle: "The Rust Programming Language",
    author: "Steve Klabnik / Carol Nichols", kind: "pdf", pages: 562, progress: 0.18,
    favorite: false, lastOpened: "2 小时前", tint: "indigo", year: "2023"
  },
  {
    id: "b3", title: "数字阅读的排版语法", subtitle: "Markdown 与长文的视觉秩序",
    author: "沈砚", kind: "md", words: 6420, progress: 0.73, favorite: true,
    lastOpened: "昨天", tint: "olive", year: "2025"
  },
  {
    id: "b4", title: "一本书的诞生", subtitle: "从手稿到成书的三百天",
    author: "周慕云", kind: "pdf", pages: 216, progress: 0.06, favorite: false,
    lastOpened: "3 天前", tint: "sand", year: "2022"
  },
  {
    id: "b5", title: "Type & Space", subtitle: "Notes on typographic rhythm",
    author: "M. Hollis", kind: "md", words: 3180, progress: 1, favorite: false,
    lastOpened: "上周", tint: "plum", year: "2021"
  },
  {
    id: "b6", title: "Markdown 写作手册", subtitle: "结构、语义与可移植性",
    author: "沈砚", kind: "md", words: 8900, progress: 0.31, favorite: false,
    lastOpened: "上周", tint: "clay", year: "2024"
  },
  {
    id: "b7", title: "纸质书的未来", subtitle: "一场关于阅读介质的访谈",
    author: "编辑室", kind: "pdf", pages: 96, progress: 0, favorite: false,
    lastOpened: "未开始", tint: "indigo", year: "2020"
  },
  {
    id: "b8", title: "夜读笔记", subtitle: "关于注意力与光",
    author: "无名", kind: "md", words: 2240, progress: 0.55, favorite: true,
    lastOpened: "昨天", tint: "sand", year: "2025"
  }
];

/* ---------- PDF 演示内容（6 页） ---------- */
const PDF_PAGES = [
  {
    no: 1,
    text: "纸页上的呼吸 论长文本的排版节奏 林敬之 摘要 排版不是装饰 它是阅读的呼吸系统 行距 版心 字距与分栏共同决定了眼睛在纸面上移动的速度 本文以中文长文为对象 讨论一套可复用的排版节奏",
    html: `
      <div class="page-runner"><span>文献与阅读 · 第 3 期</span><span>2024 · 秋</span></div>
      <h1 class="page-title">纸页上的呼吸</h1>
      <p class="page-subtitle">论长文本的排版节奏</p>
      <p class="page-byline">林敬之 · 排版研究室</p>
      <div class="page-abstract"><b>摘要　</b>排版不是装饰，而是阅读的呼吸系统。行距、版心、字距与分栏共同决定了眼睛在纸面上移动的速度。本文以中文长文为对象，讨论一套可复用的排版节奏：它不追求视觉上的惊艳，只让注意力平稳地走下去。</div>
      <div class="page-columns">
        <p>我们通常把排版理解为“好看”。但在长文阅读里，好看只是一个副产品。真正决定读者能否读完的，是眼睛每一次落点之间的距离，是段落与段落之间留出的那口气。</p>
        <p>一份排得好的文稿，读者不会注意到它。它像房间里的通风，只有在缺失的时候，人才会觉得闷。排版的全部技艺，都藏在这种“不被注意”里。</p>
        <p>中文长文的特殊性在于字面密度。方块字没有词间空格，行与行之间若不留出足够的空白，整页纸就会变成一堵墙。于是行距成为第一位的呼吸器官。</p>
        <p>本文尝试把经验转写成规则：行距、版心、栏宽、标题层级与页边距，如何共同构成一种稳定而可持续的阅读节奏。</p>
      </div>
      <div class="page-foot"><span>YUEJIAN · TYPOGRAPHY STUDIES</span><span class="page-no">1</span></div>
    `
  },
  {
    no: 2,
    text: "一 纸面的呼吸 行距是长文排版的第一个变量 中文正文的行距通常在字号的 1 点七到二倍之间 低于这个区间 阅读速度会上升 理解率却下降 空白不是浪费 它是让句子彼此不挤压的空气",
    html: `
      <div class="page-runner"><span>纸页上的呼吸</span><span>林敬之</span></div>
      <h2 class="page-section">一、纸面的呼吸</h2>
      <div class="page-columns">
        <p>行距是长文排版的第一个变量。中文正文的行距通常落在字号的 1.7 到 2.0 倍之间：低于这个区间，阅读速度会上升，理解率却下降；高于这个区间，节奏变得松散，读者容易在行间走神。</p>
        <p>这里有一个常被忽略的事实：行距并不是一个独立参数。它与字号、栏宽和页边距互相牵制。同样 1.8 倍的行距，在 34 字的窄栏里显得舒展，在 60 字的宽栏里却显得局促。</p>
        <div class="page-pull">空白不是浪费。<br>它是让句子彼此不挤压的空气。</div>
        <p>所以我们谈“节奏”，而不是谈“参数”。节奏是一组参数在具体语境里的关系，是快与慢、密与疏的交替。一个段落结束后多留出来的六像素，比任何字体选择都更能让读者松一口气。</p>
        <p>这也是纸质书在数百年里反复试验出来的东西：它不是美学偏好，而是生理经验。</p>
      </div>
      <div class="page-foot"><span>YUEJIAN · TYPOGRAPHY STUDIES</span><span class="page-no">2</span></div>
    `
  },
  {
    no: 3,
    text: "一点一 行距作为节奏 分栏与视线 双栏让单行字数落在三十到四十字之间 接近人眼一次注视的舒适范围 视线在栏间折返 形成稳定的阅读频率",
    html: `
      <div class="page-runner"><span>纸页上的呼吸</span><span>林敬之</span></div>
      <h2 class="page-section">1.1　行距作为节奏</h2>
      <div class="page-columns">
        <p>把一行字控制在三四十字，是中文阅读的舒适区。超过五十字，眼睛回行时容易错位；少于二十字，回行过于频繁，注意力被反复打断。</p>
        <p>双栏排版的价值正在于此：它让单行字数落在舒适区内，同时保持整页的信息量。视线在栏间折返，形成一种稳定的、可预期的阅读频率。</p>
        <div class="page-figure">
          <div class="figure-box">FIG. 01 — 单栏 72 字与双栏 34 字的回行路径对比</div>
          <div class="figure-cap">图 1　同一版心宽度下，栏数与回行次数的关系。图示为示意，非真实测量。</div>
        </div>
        <p>折返是有成本的。每一次回行，眼睛都需要重新定位下一行的起点。栏越宽，定位误差越大，读者越容易跳行。这也是为什么长论文几乎从不采用通栏。</p>
        <p class="no-indent">分栏不是版式花样，而是对眼球运动的迁就。</p>
      </div>
      <div class="page-foot"><span>YUEJIAN · TYPOGRAPHY STUDIES</span><span class="page-no">3</span></div>
    `
  },
  {
    no: 4,
    text: "二 版心的重量 标题层级 字号对比 层级不是靠加粗 而是靠字号 字距与留白的组合 表格 不同介质下的阅读速度对照 纸面 屏幕 打印稿",
    html: `
      <div class="page-runner"><span>纸页上的呼吸</span><span>林敬之</span></div>
      <h2 class="page-section">二、版心的重量</h2>
      <div class="page-columns">
        <p>版心是一页纸的重心。它不必居中，但必须稳定。传统书籍把版心略微上移，让下方的页边留出更多空白——那是手指托住书页的位置。</p>
        <p>标题层级不是靠加粗堆出来的。字号、字距与上下留白的组合，比字重更能建立秩序。一个安静的小标题，往往比一个大号粗体更有效。</p>
        <table class="page-table">
          <thead><tr><th>介质</th><th>平均速度</th><th>理解率</th></tr></thead>
          <tbody>
            <tr><td>纸面</td><td>238 字/分</td><td>0.82</td></tr>
            <tr><td>屏幕</td><td>276 字/分</td><td>0.71</td></tr>
            <tr><td>打印稿</td><td>244 字/分</td><td>0.79</td></tr>
          </tbody>
        </table>
        <p>速度与理解并不总是同向。屏幕读得更快，却更容易在段落之间失去线索。这也是“回看”在电子阅读中变得重要的原因。</p>
      </div>
      <div class="page-footnote">注：数据来自本研究室的内部测试，样本 42 人，仅用于说明趋势，不构成普遍结论。</div>
      <div class="page-foot"><span>YUEJIAN · TYPOGRAPHY STUDIES</span><span class="page-no">4</span></div>
    `
  },
  {
    no: 5,
    text: "二点一 数字媒介的对照 屏幕的问题不是分辨率 而是边界 无限滚动的页面没有页脚 读者失去了空间记忆 目录与进度条是对这种缺失的补偿",
    html: `
      <div class="page-runner"><span>纸页上的呼吸</span><span>林敬之</span></div>
      <h2 class="page-section">2.1　数字媒介的对照</h2>
      <div class="page-columns">
        <p>屏幕的问题从来不是分辨率。今天的屏幕足以还原纸的质地。真正的差异在于边界：一张纸有明确的四边，而无限滚动的页面没有页脚。</p>
        <p>没有边界，就没有空间记忆。读者记不住“那段话在右下角”，只能依赖搜索与目录。于是目录、进度条与书签，成了数字阅读器对空间感的补偿机制。</p>
        <div class="page-pull">好的阅读器不模拟纸张，<br>它模拟的是纸给人的方位感。</div>
        <p>这也是本文的立场：数字阅读器不必假装自己是纸。它需要保留的是纸的结构——可预期的层级、明确的进度、随时可回退的位置。</p>
        <p>当这些结构被建立起来，读者才会忘记介质的存在，重新回到句子本身。</p>
      </div>
      <div class="page-foot"><span>YUEJIAN · TYPOGRAPHY STUDIES</span><span class="page-no">5</span></div>
    `
  },
  {
    no: 6,
    text: "三 结语 排版的终点是让读者忘记排版 参考文献 书籍设计 中文排版需求 编辑的技艺 阅读的生态",
    html: `
      <div class="page-runner"><span>纸页上的呼吸</span><span>林敬之</span></div>
      <h2 class="page-section">三、结语</h2>
      <div class="page-columns">
        <p>排版的终点，是让读者忘记排版。所有关于行距、版心与分栏的讨论，最终都指向同一件事：让句子被安静地读完。</p>
        <p>这并不是一个消极的目标。恰恰相反，它要求排版者同时具备工程师的精确与编辑的分寸：知道每一个像素为什么在那里，也知道什么时候应该撤掉它。</p>
        <p>纸质书用了五百年学会这件事。数字阅读器才刚开始。</p>
        <h3 class="page-section">参考文献</h3>
        <ol class="page-refs">
          <li>《中文排版需求》，W3C 工作草案，2019。</li>
          <li>Jan Tschichold，《书籍的形式》，1948。</li>
          <li>Robert Bringhurst，《The Elements of Typographic Style》，1992。</li>
          <li>编辑部访谈记录，《编辑的技艺》，2023。</li>
        </ol>
      </div>
      <div class="page-foot"><span>YUEJIAN · TYPOGRAPHY STUDIES</span><span class="page-no">6</span></div>
    `
  }
];

const PDF_TOC = [
  { level: 1, id: 1, text: "摘要与引言", page: 1 },
  { level: 1, id: 2, text: "一、纸面的呼吸", page: 2 },
  { level: 2, id: 3, text: "1.1　行距作为节奏", page: 3 },
  { level: 2, id: 3, text: "1.2　分栏与视线", page: 3 },
  { level: 1, id: 4, text: "二、版心的重量", page: 4 },
  { level: 2, id: 5, text: "2.1　数字媒介的对照", page: 5 },
  { level: 1, id: 6, text: "三、结语", page: 6 }
];

/* ---------- Markdown 演示内容 ---------- */
const MD_HTML = `
  <p class="md-kicker">NOTE · 6420 字 · 2025</p>
  <h1 id="md-0">数字阅读的排版语法</h1>
  <p class="md-lead">Markdown 把写作从排版软件里解放出来，却把排版的责任留给了阅读器。这篇笔记讨论：当结构由标记决定，样式应该如何接手。</p>

  <h2 id="md-1">一、为什么是排版</h2>
  <p>写作是一种结构行为。你先决定什么是标题，什么是引用，什么只是强调；至于它长什么样，应该由渲染端决定。这是 Markdown 最重要的契约。</p>
  <p>但契约常常被破坏。很多编辑器把 Markdown 当作富文本的快捷方式，行内塞满 HTML，样式写死在文档里。结果是：文档失去了可移植性，读者失去了选择权。</p>
  <blockquote>结构属于作者，样式属于读者。</blockquote>
  <p>阅读器应该守住后半句。同一份文档，在白天可以是纸白色，在夜里可以是深墨色；字号可以随视力和距离调整，行宽可以随窗口变化。这些都不该由作者预先决定。</p>

  <h2 id="md-2">二、Markdown 的语义赤字</h2>
  <p>Markdown 的标记集很小。它没有“图注”，没有“侧栏”，没有“定义列表”。当文档需要这些结构时，作者往往退回到 HTML，或者干脆用加粗来冒充。</p>

  <h3 id="md-2-1">2.1 结构先于样式</h3>
  <p>一个可行的做法是：为阅读器定义一套“语义扩展”，但不改变 Markdown 的本体。例如引用块可以被解释为三种：普通引用、摘录、警告。它们的区别来自上下文，而不是语法。</p>
  <p>在实现层面，这意味着一件事：解析在前，装饰在后。Rust 端负责把 Markdown 解析为带层级的 HTML，前端只负责根据主题与设置把它排好。</p>
  <pre><code><span class="tok-com">// Rust：一次解析，交给前端渲染</span>
<span class="tok-kw">let</span> html = <span class="tok-fn">markdown_to_html</span>(source);
<span class="tok-kw">let</span> toc  = <span class="tok-fn">collect_headings</span>(&amp;html);
<span class="tok-kw">return</span> <span class="tok-fn">Ok</span>(Document { html, toc });</code></pre>
  <p>这样做的好处是：同一份 Markdown 可以被不同的阅读器渲染出不同的风格，而结构始终一致。</p>

  <h2 id="md-3">三、一套可移植的阅读设置</h2>
  <p>下面这张表是本文建议的默认值，它不试图取悦所有人，只是给出一个不需要反复调整的起点。</p>
  <table>
    <thead><tr><th>参数</th><th>默认值</th><th>可调范围</th></tr></thead>
    <tbody>
      <tr><td>正文字号</td><td>17 px</td><td>15 – 21 px</td></tr>
      <tr><td>行高</td><td>1.9</td><td>1.7 – 2.1</td></tr>
      <tr><td>版心宽度</td><td>720 px</td><td>620 – 820 px</td></tr>
      <tr><td>段间距</td><td>1.1 em</td><td>0.8 – 1.4 em</td></tr>
    </tbody>
  </table>
  <p>阅读器的责任，是让这些参数随时可调，并且在下次打开时记得。设置的记忆，比设置的丰富更重要。</p>

  <h2 id="md-4">四、结语</h2>
  <p>我们不需要更多的排版选项，我们需要更少但更可靠的默认值。一个好的阅读器，应该在第一次打开时就接近正确，然后安静地待在后台。</p>
  <ul>
    <li class="task"><input type="checkbox" checked disabled> 主题与排版可持久化</li>
    <li class="task"><input type="checkbox" checked disabled> 目录由结构自动生成</li>
    <li class="task"><input type="checkbox" checked disabled> 进度在关闭时保存</li>
    <li class="task"><input type="checkbox" disabled> 跨文档全文检索（后续）</li>
  </ul>
  <p class="md-note">这篇笔记以 Markdown 写成，由阅笺的 Rust 解析器渲染。排版参数来自上表的第一列。</p>
`;

const MD_TOC = [
  { level: 1, id: "md-0", text: "数字阅读的排版语法" },
  { level: 1, id: "md-1", text: "一、为什么是排版" },
  { level: 1, id: "md-2", text: "二、Markdown 的语义赤字" },
  { level: 2, id: "md-2-1", text: "2.1　结构先于样式" },
  { level: 1, id: "md-3", text: "三、一套可移植的阅读设置" },
  { level: 1, id: "md-4", text: "四、结语" }
];

/* 命令面板动作 */
const ACTIONS = [
  { id: "a-import", title: "导入本地文档", sub: "PDF / Markdown", icon: "folder-plus", run: "import" },
  { id: "a-theme", title: "切换主题", sub: "纸白 → 夜读 → 护眼", icon: "sun", run: "theme" },
  { id: "a-zen", title: "专注模式", sub: "隐藏书架与状态栏", icon: "maximize", run: "zen" },
  { id: "a-settings", title: "阅读设置", sub: "字号、行高、版心", icon: "settings", run: "settings" },
  { id: "a-pdf", title: "打开演示 PDF", sub: "纸页上的呼吸 · 6 页", icon: "file-text", run: "open:b1" },
  { id: "a-md", title: "打开演示 Markdown", sub: "数字阅读的排版语法", icon: "file-text", run: "open:b3" }
];
