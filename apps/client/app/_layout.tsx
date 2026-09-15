import { LocaleProvider, LanguageSelector } from '../src/i18n';
import { Slot } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <LocaleProvider>
        <StatusBar style="dark" />
        <LanguageSelector />
        <Slot />
      </LocaleProvider>
    </SafeAreaProvider>
  );
}
