import type { DocumentFormat, PaginatedDoc } from '../types.js'
import { settings } from '../settings.js'
import { readTextDocumentAsync, paginate } from '../viewer/text/textReader.js'
import { parseArchiveDocument } from '../archive/main.js'
import { formatCsvDocument, buildCsvSpreadsheetHtml } from '../spreadsheet/csv.js'
import { buildDocHtml, parseDocDocument } from '../office/doc.js'
import { buildDocxHtml, parseDocxDocument } from '../office/docx.js'
import { parseEmlText } from './eml.js'
import { parseEpubDocument } from '../books/epub.js'
import { parseFb2Xml } from '../books/fb2.js'
import { parseIpynbText } from './ipynb.js'
import { buildOdfHtml, parseOdfDocument } from '../office/odf.js'
import { parsePptxDocument } from '../office/pptx.js'
import { buildRtfHtml, parseRtfDocument } from '../office/rtf.js'
import { buildMarkdownHtml, buildSvgHtml } from '../web/render.js'
import { buildXlsxHtml, parseXlsxDocument } from '../spreadsheet/xlsx.js'
import { buildOdsSpreadsheetHtml } from '../spreadsheet/ods.js'

export async function buildHtmlDocumentAsync(
  filePath: string,
  format: DocumentFormat,
  extension: string,
  theme: { bg: string; fg: string; alt: string }
): Promise<string> {
  switch (format) {
    case 'doc':
      return buildDocHtml(filePath, theme)
    case 'docx':
      return buildDocxHtml(filePath, theme)
    case 'xlsx':
      return buildXlsxHtml(filePath, theme)
    case 'csv':
      return buildCsvSpreadsheetHtml(filePath, extension, theme)
    case 'odf':
      return extension === 'ods' || extension === 'ots'
        ? buildOdsSpreadsheetHtml(filePath, theme)
        : buildOdfHtml(filePath, theme)
    case 'rtf':
      return buildRtfHtml(filePath, theme)
    case 'web':
    default: {
      const text = (await readTextDocumentAsync(filePath)).pages.join('')
      if (extension === 'svg') return buildSvgHtml(text)
      if (extension === 'md' || extension === 'markdown' || extension === 'mdown') {
        return buildMarkdownHtml(text, theme)
      }
      return text
    }
  }
}

export async function buildDocumentAsync(
  filePath: string,
  format: DocumentFormat,
  extension: string,
  desiredCharset?: string
): Promise<PaginatedDoc> {
  switch (format) {
    case 'doc': return parseDocDocument(filePath)
    case 'docx': return parseDocxDocument(filePath)
    case 'xlsx': return parseXlsxDocument(filePath)
    case 'pptx': return parsePptxDocument(filePath)
    case 'odf': return parseOdfDocument(filePath)
    case 'rtf': return parseRtfDocument(filePath)
    case 'archive': return parseArchiveDocument(filePath, desiredCharset)
    case 'epub': return parseEpubDocument(filePath)
    case 'fb2': return parseFb2Xml((await readTextDocumentAsync(filePath, desiredCharset)).pages.join(''))
    case 'eml': return parseEmlText((await readTextDocumentAsync(filePath, desiredCharset)).pages.join(''))
    case 'csv': {
      const doc = await readTextDocumentAsync(filePath, desiredCharset)
      return settings.get('csv_table') ? formatCsvDocument(doc.pages.join(''), extension) : doc
    }
    case 'ipynb': return parseIpynbText((await readTextDocumentAsync(filePath, desiredCharset)).pages.join(''))
    case 'json': {
      const doc = await readTextDocumentAsync(filePath, desiredCharset)
      if (settings.get('prettyjson')) {
        try {
          return {
            pages: paginate(JSON.stringify(JSON.parse(doc.pages.join('')), null, 2)),
            font: 2,
            wrap: doc.wrap,
            encoding: doc.encoding,
          }
        } catch {
          return doc
        }
      }
      return doc
    }
    case 'text':
    default:
      return readTextDocumentAsync(filePath, desiredCharset)
  }
}