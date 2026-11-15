(() => {
  const allowed = new Set(["p", "h2", "h3", "strong", "em", "u", "ul", "ol", "li", "br", "a"]);
  const tags = { div: "p", b: "strong", i: "em" };

  function safeLink(value) {
    try {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol) && url.hostname ? url.href : "";
    } catch {
      return "";
    }
  }

  function read(container) {
    function readNode(node) {
      if (node.nodeType === Node.TEXT_NODE) return [node.textContent];
      if (node.nodeType !== Node.ELEMENT_NODE) return [];
      const tag = tags[node.localName] || node.localName;
      const children = [...node.childNodes].flatMap(readNode);
      if (!allowed.has(tag)) return children;
      if (tag === "a") {
        const href = safeLink(node.getAttribute("href"));
        return href ? [{ tag, href, children }] : children;
      }
      return [{ tag, children }];
    }
    return [...container.childNodes].flatMap(readNode);
  }

  function render(container, content) {
    function make(node) {
      if (typeof node === "string") return document.createTextNode(node);
      if (!allowed.has(node?.tag) || !Array.isArray(node.children)) return document.createTextNode("");
      const element = document.createElement(node.tag);
      if (node.tag === "a") {
        const href = safeLink(node.href);
        if (href) {
          element.href = href;
          element.target = "_blank";
          element.rel = "noopener noreferrer";
        }
      }
      element.append(...node.children.map(make));
      return element;
    }
    container.replaceChildren(...(Array.isArray(content) ? content.map(make) : []));
  }

  window.g19AnnouncementContent = { read, render, safeLink };
})();
