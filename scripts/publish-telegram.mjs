#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const isDryRun = args.includes('--dry-run') || args.includes('-d')
const publishAll = args.includes('--all')

function getOpt(flags) {
  for (let i = 0; i < args.length; i++) {
    for (const f of flags) {
      if (args[i] === f && i + 1 < args.length) return args[i + 1]
      if (args[i].startsWith(`${f}=`)) return args[i].slice(f.length + 1)
    }
  }
  return null
}

const BOT_TOKEN = getOpt(['--token', '-t']) || process.env.BOT_TOKEN
const CHAT_ID = getOpt(['--channel', '-c']) || process.env.CHAT_ID
const targetInput = args.find((a) => !a.startsWith('-'))

function findInuFiles(dir) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.inu.js'))
    .map((e) => path.join(dir, e.name))
}

function resolveTargets(input) {
  if (input) {
    const p = path.resolve(process.cwd(), input)
    if (fs.existsSync(p)) {
      if (fs.statSync(p).isFile() && p.endsWith('.inu.js')) return [p]
      const dist = findInuFiles(path.join(p, 'dist'))
      if (dist.length) return dist
      const root = findInuFiles(p)
      if (root.length) return root
    }
    const asDist = findInuFiles(path.resolve(process.cwd(), input, 'dist'))
    if (asDist.length) return asDist
    console.error(`[Error] Built .inu.js file not found for: "${input}"`)
    process.exit(1)
  }

  const cwd = process.cwd()
  const files = [
    ...findInuFiles(path.join(cwd, 'dist')),
    ...findInuFiles(path.join(cwd, 'doc_view', 'dist')),
  ]
  const pluginsDir = path.join(cwd, 'plugins')
  if (fs.existsSync(pluginsDir)) {
    for (const d of fs.readdirSync(pluginsDir)) {
      files.push(...findInuFiles(path.join(pluginsDir, d, 'dist')))
    }
  }

  const unique = [...new Set(files)]
  if (!unique.length) {
    console.error('[Error] No built .inu.js files found. Run "pnpm build" first.')
    process.exit(1)
  }
  if (publishAll || unique.length === 1) return unique

  console.log('Multiple plugins found. Specify one or pass --all:')
  unique.forEach((f) => console.log(`  ${path.relative(cwd, f)}`))
  process.exit(1)
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function parsePlugin(filePath) {
  const buf = fs.readFileSync(filePath)
  const filename = path.basename(filePath)
  const head = buf.slice(0, 16384).toString('utf-8')
  const tag = (name) => head.match(new RegExp(`//\\s*@${name}\\s+([^\\r\\n]+)`))?.[1]?.trim()

  let pkg = {}
  try {
    pkg = JSON.parse(fs.readFileSync(path.resolve(path.dirname(filePath), '..', 'package.json'), 'utf-8'))
  } catch {}

  const name = tag('name') || pkg.displayName || pkg.name || filename.replace(/\.inu\.js$/, '')
  const version = tag('version') || pkg.version || '0.1.0'
  const id = tag('id') || pkg.name || `net.inugram.${filename.replace(/\.inu\.js$/, '')}`
  const desc = tag('description') || pkg.description || ''

  const safeDesc = desc ? escapeHtml(desc).replace(/\*\*(.*?)\*\*/g, '<b>$1</b>').replace(/\*(.*?)\*/g, '<i>$1</i>') : ''
  const slug = (id.split('.').pop() || name).toLowerCase().replace(/[^a-z0-9]/g, '_')

  const caption = [
    `📦 <b>${escapeHtml(name)}</b> <code>v${escapeHtml(version)}</code>`,
    ...(safeDesc ? ['', safeDesc] : []),
    '',
    `🆔 ID: <code>${escapeHtml(id)}</code>`,
    `🌐 GitHub: https://github.com/nixxoq/inugram_plugins`,
    `📢 Repository: https://t.me/inu_nixxoq`,
    '',
    `#inugram #plugin #${slug}`,
  ].join('\n')

  return { filePath, filename, buf, name, version, id, caption }
}

async function upload(meta) {
  console.log(`Publishing ${meta.name} v${meta.version} (${meta.filename}) -> ${CHAT_ID}`)
  if (isDryRun) {
    console.log(`[Dry Run] Caption preview:\n${meta.caption}\n`)
    return
  }

  const form = new FormData()
  form.append('chat_id', CHAT_ID)
  form.append('caption', meta.caption)
  form.append('parse_mode', 'HTML')
  form.append('document', new Blob([meta.buf], { type: 'application/javascript' }), meta.filename)

  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, { method: 'POST', body: form })
  const data = await res.json()
  if (!res.ok || !data.ok) {
    throw new Error(`Telegram error: ${data.description || res.statusText}`)
  }
  console.log(`Published ${meta.name}: message_id ${data.result.message_id}\n`)
}

for (const file of resolveTargets(targetInput)) {
  await upload(parsePlugin(file))
}
