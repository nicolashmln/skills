export default defineI18nConfig(() => ({
  legacy: false,
  locale: 'en',
  fallbackLocale: 'en',
  locales: [
    { code: 'en', name: 'English' },
    { code: 'fr', name: 'Français' }
  ]
}))
