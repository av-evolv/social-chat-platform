import { createInstance } from 'i18next';
import clientEn from './client.en.json' with { type: 'json' };
import clientFr from './client.fr.json' with { type: 'json' };
import serverEn from './server.en.json' with { type: 'json' };
import serverFr from './server.fr.json' with { type: 'json' };
import commonEn from './common.en.json' with { type: 'json' };
import commonFr from './common.fr.json' with { type: 'json' };
export const locales = ['en', 'fr'];
export const resources = { en: { translation: { ...clientEn, ...serverEn, ...commonEn } }, fr: { translation: { ...clientFr, ...serverFr, ...commonFr } } };
export function matchLocale(value) {
  if (typeof value !== 'string') return undefined;
  const language = value.trim().toLowerCase().split(/[-_]/)[0];
  return locales.includes(language) ? language : undefined;
}
export function normalizeLocale(value) { return matchLocale(value) ?? 'en'; }
export function negotiateLocale(value) {
  if (typeof value !== 'string') return 'en';
  const candidates = value.slice(0,1024).split(',').map((part,index) => {
    const [tag,...params] = part.trim().split(';');
    const quality = params.find(p => p.trim().startsWith('q='));
    const q = quality === undefined ? 1 : Number(quality.trim().slice(2));
    return {locale:matchLocale(tag),q,index};
  }).filter(p => p.locale && Number.isFinite(p.q) && p.q>0 && p.q<=1).sort((a,b) => b.q-a.q || a.index-b.index);
  return candidates[0]?.locale ?? 'en';
}
const instances = new Map();
for (const locale of locales) {
  const instance = createInstance();
  instance.init({lng:locale,fallbackLng:'en',supportedLngs:locales,resources,initAsync:false,keySeparator:false,nsSeparator:false,interpolation:{escapeValue:false},returnNull:false});
  instances.set(locale,instance);
}
/** Plain text only. HTML renderers must escape the resulting string. */
export function translate(locale,key,values={}) { return String(instances.get(normalizeLocale(locale)).t(key,values)); }
export function formatDate(locale,value,options={dateStyle:'medium'}) { return new Intl.DateTimeFormat(normalizeLocale(locale),options).format(new Date(value)); }
export function formatNumber(locale,value,options={}) { return new Intl.NumberFormat(normalizeLocale(locale),options).format(value); }
