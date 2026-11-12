/* 移动端导航开合：仅此一处交互，保持页面零依赖 */
const navToggle = document.getElementById("navToggle");
const siteNav = document.getElementById("siteNav");

if (navToggle && siteNav) {
  const setOpen = (open) => {
    siteNav.classList.toggle("is-open", open);
    navToggle.setAttribute("aria-expanded", String(open));
    navToggle.setAttribute("aria-label", open ? "收起导航" : "展开导航");
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
}

const yearNode = document.getElementById("year");
if (yearNode) yearNode.textContent = String(new Date().getFullYear());
