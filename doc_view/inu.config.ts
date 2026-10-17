import { defineConfig } from '@inugram/cli'

export default defineConfig({
  outDir: 'dist',
  plugins: {
    doc_viewer: {
      entry: 'src/index.ts',
      manifest: {
        id: 'net.nixxo.doc_viewer',
        name: 'Doc Viewer',
        author: '@nixxoq',
        version: '0.1.6',
        description: {
          en: 'Enhanced Inugram port of the original ExteraGram plugin "Doc Viewer" by Daxo-Developer (@Daxo_OS), with expanded document viewing, archive browsing, and CBZ comic reading.',
          ru: 'Улучшенный порт оригинального Doc Viewer для ExteraGram плагина от Daxo-Developer (@Daxo_OS), с расширенным просмотром документов, браузером архивов и чтением комиксов CBZ.',
        },
        icon: 'inu://bookmark',
        grants: [
          'unsafe.xposed',
          'unsafe.jvm',
          'clipboard.write',
          'openUrl',
        ],
      },
    },
  },
})

