/* 移动端导航开合：仅此一处交互，保持页面零依赖 */
const navToggle = document.getElementById("navToggle");
const siteNav = document.getElementById("siteNav");

/* 语言切换后取当前语种的文案，未加载 i18n 时回退中文 */
const t = (key, fallback) => window.siteI18n?.t(key) ?? fallback;

if (navToggle && siteNav) {
  const setOpen = (open) => {
    siteNav.classList.toggle("is-open", open);
    navToggle.setAttribute("aria-expanded", String(open));
    navToggle.setAttribute("aria-label", open ? t("nav.collapse", "收起导航") : t("nav.expand", "展开导航"));
  };

  navToggle.addEventListener("click", () => {
    setOpen(!siteNav.classList.contains("is-open"));
  });

  // 点击导航项或在窄屏下点击外部时收起
  siteNav.addEventListener("click", (event) => {
    if (event.target.closest("a")) setOpen(false);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setOpen(false);
  });

  // 切换语言时同步按钮的无障碍文案
  document.addEventListener("site:langchange", () => {
    setOpen(siteNav.classList.contains("is-open"));
  });
}

const yearNode = document.getElementById("year");
if (yearNode) yearNode.textContent = String(new Date().getFullYear());
