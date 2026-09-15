export type Locale = 'en' | 'fr';
export const locales: readonly Locale[];
export const resources: Record<Locale,{translation:Record<string,string>}>;
export function matchLocale(value:unknown):Locale|undefined;
export function normalizeLocale(value:unknown):Locale;
export function negotiateLocale(value:unknown):Locale;
export function translate(locale:string,key:string,values?:Record<string,unknown>):string;
export function formatDate(locale:string,value:string|number|Date,options?:Intl.DateTimeFormatOptions):string;
export function formatNumber(locale:string,value:number,options?:Intl.NumberFormatOptions):string;
