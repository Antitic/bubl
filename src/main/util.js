'use strict';

/**
 * Decide whether the address-bar input is a URL to visit or a search query.
 * Returns a fully-qualified URL string in both cases.
 */
function resolveInput(input, searchEngines) {
  const text = (input || '').trim();
  if (!text) return null;

  // Explicit scheme (http, https, file, etc.) — visit as-is.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^(about|data|bubl):/i.test(text)) {
    return text;
  }

  const looksLikeUrl =
    // localhost[:port][/path]
    /^localhost(:\d+)?(\/.*)?$/i.test(text) ||
    // bare IPv4 [:port]
    /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/.*)?$/.test(text) ||
    // domain.tld style: a dot, no spaces, looks host-y
    (/^[^\s]+\.[^\s]{2,}$/.test(text) && !text.includes(' ') && /^[^\s]+\.[a-z]{2,}([:/?#].*)?$/i.test(text));

  if (looksLikeUrl) {
    return `https://${text}`;
  }

  return searchEngines.searchUrl(text);
}

/** Extract a hostname from a URL, or '' if it has none. */
function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

module.exports = { resolveInput, hostnameOf };
