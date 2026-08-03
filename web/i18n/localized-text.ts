export type LocalizedText = {
  en: string
  zh: string
  zhTW: string
}

export function selectLocalizedText(language: unknown, text: LocalizedText): string {
  const code = String(language || 'en')
    .toLowerCase()
    .replace('_', '-')
  if (['zh-tw', 'zh-hant', 'zh-hk'].includes(code)) return text.zhTW
  return code.startsWith('zh') ? text.zh : text.en
}
