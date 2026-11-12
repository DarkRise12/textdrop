'use strict';
(() => {
  // Return text segments, never markup. URL parsing is a second, independent check.
  function parts(text) {
    const result = [];
    const pattern = /https?:\/\/[^\s<>"'`«»“”‘’]+/giu;
    let offset = 0;
    for (const match of text.matchAll(pattern)) {
      let candidate = match[0].replace(/[.,!?;:]+$/u, '');
      const balance = {')': 0, ']': 0, '}': 0};
      for (const char of candidate) {
        if (char === '(') balance[')']--;
        else if (char === '[') balance[']']--;
        else if (char === '{') balance['}']--;
        else if (char in balance) balance[char]++;
      }
      let end = candidate.length;
      while (end) {
        const last = candidate[end - 1];
        if (last in balance && balance[last] > 0) { balance[last]--; end--; }
        else if (/[.,!?;:]/u.test(last)) end--;
        else break;
      }
      candidate = candidate.slice(0, end);
      let url;
      try { url = new URL(candidate); } catch { continue; }
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || candidate.includes('\\')) continue;
      if (match.index > offset) result.push({text: text.slice(offset, match.index)});
      result.push({text: candidate, href: url.href});
      offset = match.index + candidate.length;
    }
    if (offset < text.length) result.push({text: text.slice(offset)});
    return result;
  }
  function append(container, text) {
    const fragment = document.createDocumentFragment();
    for (const part of parts(text)) {
      if (!part.href) fragment.append(document.createTextNode(part.text));
      else {
        const link = document.createElement('a');
        link.href = part.href;
        link.textContent = part.text;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        fragment.append(link);
      }
    }
    container.replaceChildren(fragment);
  }
  window.TextdropLinks = {parts, append};
})();
