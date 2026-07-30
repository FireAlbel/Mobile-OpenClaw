import { builtinLanguages, UNKNOWN } from '@renderer/config/languages'
import { useCallback } from 'react'

export default function useLanguages() {
  const getLanguageByLangcode = useCallback(
    (langCode: string) => builtinLanguages.find((language) => language.langCode === langCode) ?? UNKNOWN,
    []
  )

  return { languages: builtinLanguages, getLanguageByLangcode }
}
