import fs from 'node:fs'
import path from 'node:path'

function listJsonFiles(dir) {
  const out = []
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) out.push(...listJsonFiles(full))
    else if (ent.isFile() && ent.name.endsWith('.json')) out.push(full)
  }
  return out
}

function loadJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch (error) {
    throw new Error(`Invalid locale JSON: ${p}`, { cause: error })
  }
}

function flattenKeys(obj, prefix = '') {
  const keys = []
  if (!obj || typeof obj !== 'object') return keys
  for (const [k, v] of Object.entries(obj)) {
    const next = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) keys.push(...flattenKeys(v, next))
    else keys.push(next)
  }
  return keys
}

function toRel(p, root) {
  return path.relative(root, p).replaceAll('\\', '/')
}

const localesRoot = path.resolve(process.cwd(), 'locales')
const localeNames = ['en', 'zh', 'zh-TW']
const localeRoots = Object.fromEntries(
  localeNames.map(locale => [locale, path.join(localesRoot, locale)])
)

for (const [locale, root] of Object.entries(localeRoots)) {
  if (!fs.existsSync(root)) {
    console.error(`[i18n:parity] Missing locale root for ${locale}: ${root}`)
    process.exit(2)
  }
}

const referenceRoot = localeRoots.en
const referenceFiles = listJsonFiles(referenceRoot)
  .map(p => toRel(p, referenceRoot))
  .sort()
let ok = true

for (const locale of localeNames.slice(1)) {
  const root = localeRoots[locale]
  const files = listJsonFiles(root)
    .map(p => toRel(p, root))
    .sort()
  const missingFiles = referenceFiles.filter(file => !files.includes(file))
  const extraFiles = files.filter(file => !referenceFiles.includes(file))

  if (missingFiles.length) {
    ok = false
    console.error(`[i18n:parity] Missing ${locale} files:`)
    for (const file of missingFiles) console.error(`- ${file}`)
  }
  if (extraFiles.length) {
    ok = false
    console.error(`[i18n:parity] Extra ${locale} files:`)
    for (const file of extraFiles) console.error(`- ${file}`)
  }

  for (const rel of referenceFiles) {
    if (!files.includes(rel)) continue
    const referenceKeys = new Set(flattenKeys(loadJson(path.join(referenceRoot, rel))))
    const localeKeys = new Set(flattenKeys(loadJson(path.join(root, rel))))
    const missingKeys = [...referenceKeys].filter(key => !localeKeys.has(key)).sort()
    const extraKeys = [...localeKeys].filter(key => !referenceKeys.has(key)).sort()

    if (!missingKeys.length && !extraKeys.length) continue
    ok = false
    console.error(`[i18n:parity] Key mismatch in ${locale}/${rel}`)
    if (missingKeys.length) {
      console.error(`  Missing ${locale} keys:`)
      for (const key of missingKeys) console.error(`  - ${key}`)
    }
    if (extraKeys.length) {
      console.error(`  Extra ${locale} keys:`)
      for (const key of extraKeys) console.error(`  - ${key}`)
    }
  }
}

if (!ok) process.exit(1)
console.log('[i18n:parity] OK')
