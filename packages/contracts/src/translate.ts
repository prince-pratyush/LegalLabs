/** The languages a thread can translate into, by the code the API takes. */
export const TRANSLATION_LANGUAGES = {
  en: "English",
  fr: "French",
  de: "German",
  es: "Spanish",
  it: "Italian",
  pt: "Portuguese",
  nl: "Dutch",
  "zh-CN": "Chinese (Simplified)",
  ja: "Japanese",
  ko: "Korean",
  ar: "Arabic",
  hi: "Hindi",
} as const;
export type TranslationLanguage = keyof typeof TRANSLATION_LANGUAGES;

export const TRANSLATE_LIMITS = {
  documents: 10,
  /** Pasted or sent text, in one request. */
  textChars: 30_000,
  /** All the words of one request, files together. */
  totalChars: 200_000,
} as const;
