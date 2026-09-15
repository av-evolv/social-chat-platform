import Head from 'expo-router/head';
import { Link } from 'expo-router';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { useI18n } from '../src/i18n';

export default function NotFoundScreen() {
  const { t } = useI18n();
  return <View style={styles.page}>
    {Platform.OS === 'web' && <Head><title>{t('client.common.pageTitle', { page: t('client.notFound.title') })}</title></Head>}
    <Text role="heading" aria-level={1} style={styles.heading}>{t('client.notFound.title')}</Text>
    <Text style={styles.body}>{t('client.notFound.description')}</Text>
    <Link href="/" style={styles.link}>{t('client.notFound.home')}</Link>
  </View>;
}
const styles = StyleSheet.create({
  page: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 28, gap: 24, backgroundColor: '#F5F4EE' },
  heading: { fontSize: 28, color: '#20372F', fontWeight: '600', textAlign: 'center' },
  body: { color: '#58675D', fontSize: 16, lineHeight: 24, maxWidth: 480, textAlign: 'center' },
  link: { color: '#20372F', fontSize: 16, textDecorationLine: 'underline', padding: 12 },
});
