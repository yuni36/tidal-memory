/* theme-follow.js — 子页静默跟随 companion_theme / data-theme */
(function () {
  const KEY = "companion_theme";
  function apply(t) {
    const theme = t === "night" ? "night" : "day";
    document.documentElement.setAttribute("data-theme", theme);
    // 兼容旧 light 命名
    if (theme === "day") {
      document.documentElement.removeAttribute("data-theme-legacy");
    }
  }
  try {
    apply(localStorage.getItem(KEY) || "day");
  } catch (_) {
    apply("day");
  }
  window.addEventListener("storage", (e) => {
    if (e.key === KEY) apply(e.newValue || "day");
  });
})();
