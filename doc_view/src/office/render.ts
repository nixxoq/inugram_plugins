import { escapeHtml } from '../utils/html.js'
import type { ThemeColors } from '../spreadsheet/types.js'

export interface OfficeHtmlShellOptions {
  title?: string
  bodyHtml: string
  theme: ThemeColors
  containerClass?: string
  extraCss?: string
}

/**
 * Builds standard Word-compatible HTML shell with strict CSP and responsive typography.
 */
export function renderOfficeHtmlShell(options: OfficeHtmlShellOptions): string {
  const containerClass = options.containerClass || 'office-container'
  const title = options.title ? `<title>${escapeHtml(options.title)}</title>` : ''
  const extraCss = options.extraCss ? `\n${options.extraCss}` : ''

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=3.0, user-scalable=yes">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: https: http:; font-src data:; form-action 'none';">
  ${title}
  <style>
html, body {
  margin: 0; padding: 0;
  background-color: ${options.theme.bg}; color: ${options.theme.fg};
  font-family: "Times New Roman", Times, "Liberation Serif", serif;
  font-size: 14pt; line-height: 1.3;
}
body { padding: 16px; word-wrap: break-word; overflow-wrap: anywhere; }
.${containerClass} { max-width: 820px; margin: 0 auto; }
h1, h2, h3, h4, h5, h6 { font-weight: bold; margin: 10pt 0 4pt 0; }
img { max-width: 100%; height: auto; }${extraCss}
  </style>
</head>
<body>
  <div class="${containerClass}">
    ${options.bodyHtml}
  </div>
</body>
</html>`
}

