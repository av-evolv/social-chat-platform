import Head from 'expo-router/head';
import { useI18n } from '../../src/i18n';
import { useEffect, useState } from 'react';
import { Link, useRouter } from 'expo-router';
import { ActivityIndicator, Platform, StyleSheet, Text, View } from 'react-native';
import { localizeError, completeWebSignIn } from '../../src/auth/session';

export default function OAuthCallback() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    void completeWebSignIn().then(() => router.replace('/account')).catch((failure: unknown) => setError(failure));
  }, [router]);
  return (
    <View style={styles.page}>
      {Platform.OS === 'web' && <Head><title>{t('client.common.pageTitle', { page: t('client.callback.heading') })}</title></Head>}
      <Text role="heading" aria-level={1} style={styles.heading}>{t('client.callback.heading')}</Text>
      {error ? <Text role="alert" style={styles.error}>{localizeError(error, locale)}</Text> : <ActivityIndicator accessibilityLabel={t('client.callback.verifying')} color="#20372F" />}
      <Link href="/account" style={styles.link}>{t('client.callback.return')}</Link>
    </View>
  );
}
const styles = StyleSheet.create({
  page: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 28, gap: 24, backgroundColor: '#F5F4EE' },
  heading: { fontSize: 28, color: '#20372F', fontWeight: '600' },
  error: { color: '#922E24', fontSize: 16, lineHeight: 24, maxWidth: 480 },
  link: { color: '#20372F', fontSize: 16, textDecorationLine: 'underline', padding: 12 },
});
