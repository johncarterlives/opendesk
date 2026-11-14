// Applies the saved theme before first paint so a dark app never flashes white.
// Same key and rules as src/lib/theme.ts. In the desktop app it also marks
// <html data-desktop> (src/lib/desktop.ts) so the window chrome is right from
// the first frame.
(function () {
  var dark = false;
  var t = "light";
  try {
    t = localStorage.getItem("od-theme") || "light";
    if (t !== "dark" && t !== "system") t = "light";
    dark = t === "dark" || (t === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  } catch (e) {}
  var root = document.documentElement;
  root.classList.toggle("dark", dark);
  root.style.colorScheme = dark ? "dark" : "light";
  root.dataset.themePref = t;
  // Text size, same key and values as src/lib/textSize.ts.
  try {
    var s = localStorage.getItem("od-text-size");
    var z = s === "large" ? "1.125" : s === "larger" ? "1.25" : "";
    if (z) {
      root.style.setProperty("--od-zoom", z);
      root.dataset.textSize = s;
    }
  } catch (e) {}
  var d = window.opendeskDesktop;
  if (d && typeof d.notify === "function") root.dataset.desktop = d.platform === "darwin" || d.platform === "win32" ? d.platform : "linux";
})();
