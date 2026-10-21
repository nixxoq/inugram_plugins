# Inugram Plugins

Plugins collection for Inugram.

## Official Channel & Plugin Repository

All plugin releases are published to our official Inugram repository channel:  
👉 **[@inu_nixxoq](https://t.me/inu_nixxoq)**

To receive automatic 1-tap plugin updates directly in Inugram:
1. Open Inugram.
2. Go to **Settings** → **Plugins** → **Repositories**.
3. Tap **+** and add `@inu_nixxoq`.

## Plugins

| Plugin | Directory | Description |
| --- | --- | --- |
| [Doc Viewer](doc_view/README.md) | [`doc_view/`](doc_view/) | In-app document viewer for office files (DOCX, DOC, XLSX, PPTX, ODF, RTF), books (EPUB, FB2, CBZ), archives (ZIP, TAR), and code. |

## Development

### Setup

```bash
# Install workspace dependencies
pnpm install

# Typecheck all plugins
pnpm run typecheck

# Build all plugins
pnpm run build

# Run unit tests
pnpm test

# Publish plugin to Telegram channel (@inu_nixxoq)
pnpm publish:tg
```

