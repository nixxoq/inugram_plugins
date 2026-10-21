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
        version: '0.1.7',
        description: {
          en: 'Enhanced Inugram port of **Doc Viewer** by @Daxo_OS, with expanded document viewing, archive browsing, and CBZ comic reading.',
          ru: 'Улучшенный порт **Doc Viewer** от @Daxo_OS, с расширенным просмотром документов, браузером архивов и чтением комиксов CBZ.',
        },
        icon: 'inu://bookmark',
        grants: [
          'unsafe.xposed',
          'unsafe.jvm',
          'clipboard.write',
          'openUrl',
          'sqlite',
        ],
      },
    },
  },
})

