export type MarkdownToken = Record<string, unknown> & { type: string; raw?: string };
export type MarkdownTokens = MarkdownToken[];

/** Only forward browser-safe external links to the extension host. */
export function isAllowedMarkdownLink(href: string): boolean {
  try {
    const url = new URL(href);
    return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:";
  } catch {
    return false;
  }
}

/** Render marked inline tokens using the caller's HTML escaping function. */
export function renderInlineTokens(
  tokens: MarkdownTokens | undefined,
  escape: (text: string) => string,
): string {
  if (!tokens || tokens.length === 0) { return ""; }
  let result = "";
  for (const token of tokens) {
    switch (token.type) {
      case "text":
        result += Array.isArray(token.tokens)
          ? renderInlineTokens(token.tokens as MarkdownTokens, escape)
          : escape(token.text as string);
        break;
      case "strong":
        result += `<strong>${renderInlineTokens(token.tokens as MarkdownTokens | undefined, escape)}</strong>`;
        break;
      case "em":
        result += `<em>${renderInlineTokens(token.tokens as MarkdownTokens | undefined, escape)}</em>`;
        break;
      case "codespan":
        result += `<code>${escape(token.text as string)}</code>`;
        break;
      case "link":
        result += `<a href="${escape(token.href as string)}">${renderInlineTokens(token.tokens as MarkdownTokens | undefined, escape)}</a>`;
        break;
      case "del":
        result += `<del>${renderInlineTokens(token.tokens as MarkdownTokens | undefined, escape)}</del>`;
        break;
      case "image":
        result += `<img src="${escape(token.href as string)}" alt="${escape(token.text as string)}">`;
        break;
      case "br":
        result += "<br>";
        break;
      case "html":
        result += (token.text as string) || (token.raw as string) || "";
        break;
      case "escape":
        result += escape(token.text as string);
        break;
      default:
        result += escape((token.raw as string) || (token.text as string) || "");
    }
  }
  return result;
}
