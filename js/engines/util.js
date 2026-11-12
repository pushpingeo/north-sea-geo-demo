const loaded = new Map();

export function loadScript(src) {
  if (!loaded.has(src)) {
    loaded.set(
      src,
      new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = src;
        s.onload = resolve;
        s.onerror = () => reject(new Error(`Could not load ${src}`));
        document.head.appendChild(s);
      })
    );
  }
  return loaded.get(src);
}

export function stripFences(code) {
  return code.replace(/^\s*```[a-z]*\s*\n?/i, "").replace(/\n?```\s*$/, "").trim();
}
