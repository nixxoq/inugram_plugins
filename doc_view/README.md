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
- [ ] Updater (notify only)

## Requirements

- Inugram v49+
- Node.js 20+ & pnpm

## Requirements

- Inugram v49+
- Node.js 20+ & pnpm
