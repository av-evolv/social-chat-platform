import { matchLocale, negotiateLocale, translate, type Locale } from '@larynx/i18n';
export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export function requestedLocale(uiLocales: unknown, header: unknown): Locale {
  const selected = typeof uiLocales === 'string' ? uiLocales.slice(0,256).split(/\s+/).map(matchLocale).find(Boolean) : undefined;
  return selected ?? negotiateLocale(header);
}
export function languageLinks(locale: Locale, path: string, parameters: Record<string,string> = {}): string {
  const links = (['en','fr'] as const).map(language => {
    const query = new URLSearchParams({...parameters,lang:language});
    return `<a lang="${language}" href="${escapeHtml(`${path}?${query}`)}"${language === locale ? ' aria-current="true"' : ''}>${language === 'en' ? 'English' : 'Français'}</a>`;
  }).join(' · ');
  return `<nav aria-label="${escapeHtml(translate(locale,'server.language'))}">${links}</nav>`;
}
