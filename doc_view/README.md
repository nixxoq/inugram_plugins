# Doc Viewer

An in-app document viewer plugin for Inugram. 
It opens documents, spreadsheets, presentations, books, archives, and code files directly inside Telegram without third-party office apps.

All files are parsed and rendered locally on the device inside an isolated WebView.

## Supported Formats

- DOCX, DOC (Word 97-2004)
- ODT, RTF
- PPTX
- XLSX, ODS, CSV, TSV
- EPUB, FB2, CBZ
- ZIP, TAR (in-memory extraction and archive tree browsing)
- HTML, SVG (sandboxed scripts with alert/prompt polyfills)
- Markdown (.md)
- Jupyter Notebooks (.ipynb)
- Email messages (.eml)
- Plain text and source code

## Viewer Features

- Themes: System, Light, Dark, Sepia, OLED black
- Font size adjustment
- Color inversion (night mode)
- Reading position memory
- Volume key scrolling
- Keep screen on while reading
- Per-category format toggles in settings

## Installation & Updates

Install the plugin and receive automatic 1-tap updates via the official Inugram repository channel:

1. In Inugram, go to **Settings** → **Plugins** → **Repositories**.
2. Tap **+** and enter `@inu_nixxoq` (or visit [t.me/inu_nixxoq](https://t.me/inu_nixxoq)).
3. Tap **Install** on Doc Viewer.

Whenever a new release is posted, Inugram will prompt you to update in 1 tap, preserving all settings, reading history, and SQLite data.

## Planned

- [ ] 7z archives (.7z)
- [ ] RAR archives (.rar)
- [ ] Legacy formats (.xls BIFF8, .ppt)
- [ ] Additional book formats (MOBI, AZW3, DJVU, CBR)
- [ ] Password-protected files and archives
- [ ] In-document text search
- [ ] Paginated print layout for documents
- [ ] Export to PDF
- [ ] Cell selection and copying in spreadsheets
- [ ] Vertical scroll mode for PDF, comics, and presentations (Google Docs style)

## Requirements

- Inugram v49+
- Node.js 20+ & pnpm
