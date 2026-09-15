import { createContext, useContext, useEffect, useState, useSyncExternalStore, type PropsWithChildren } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { translate, type Locale } from '@larynx/i18n';
import { getLocale, initializeLocale, setLocale, subscribeLocale } from './state';
import { hasSession, saveLocalePreference } from '../auth/session';
const LocaleContext = createContext<Locale>('en');
export function useI18n() {
  const locale = useContext(LocaleContext);
  return { locale, t: (key: string, values?: Record<string,unknown>) => translate(locale,key,values) };
}
export function LocaleProvider({children}: PropsWithChildren) {
  const locale = useSyncExternalStore(subscribeLocale,getLocale,() => 'en' as Locale);
  useEffect(() => { void initializeLocale(); }, []);
  useEffect(() => { if (Platform.OS === 'web') document.documentElement.lang = locale; }, [locale]);
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}
export function LanguageSelector() {
  const {locale,t} = useI18n();
  const insets = useSafeAreaInsets();
  const [busy,setBusy] = useState(false);
  const [failed,setFailed] = useState(false);
  async function change(next: Locale) {
    setBusy(true); setFailed(false);
    try { await Promise.all([setLocale(next),hasSession() ? saveLocalePreference(next) : Promise.resolve()]); }
    catch { setFailed(true); }
    finally { setBusy(false); }
  }
  return <View style={[styles.container,{paddingTop:Math.max(10,insets.top)}]}>
    <View style={styles.row}>
      <Text style={styles.label}>{t('common.language')}</Text>
      {(['en','fr'] as const).map(value => <Pressable key={value} role="button" aria-label={value === 'en' ? 'English' : 'Français'} aria-selected={locale === value} disabled={busy} onPress={() => void change(value)} style={[styles.button,locale === value && styles.selected]}>
        <Text style={[styles.label,locale === value && styles.selectedText]}>{value === 'en' ? 'English' : 'Français'}</Text>
      </Pressable>)}
    </View>
    {failed && <Text role="status" style={styles.label}>{t('common.preferenceFailed')}</Text>}
  </View>;
}
const styles = StyleSheet.create({
  container:{backgroundColor:'#F5F4EE',paddingHorizontal:20,paddingVertical:10,gap:8},
  row:{flexDirection:'row',alignItems:'center',justifyContent:'flex-end',flexWrap:'wrap',gap:8},
  label:{color:'#20372F',fontSize:14},
  button:{paddingHorizontal:12,paddingVertical:10,borderWidth:1,borderColor:'#D9DFD5',borderRadius:8},
  selected:{backgroundColor:'#20372F'},selectedText:{color:'#FFFFFF'},
});
