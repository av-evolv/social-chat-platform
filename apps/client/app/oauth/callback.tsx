import { useEffect, useState } from 'react';
import { Link, useRouter } from 'expo-router';
import { ActivityIndicator, Platform, StyleSheet, Text, View } from 'react-native';
import { completeWebSignIn } from '../../src/auth/session';

export default function OAuthCallback() {
  const router = useRouter();
  const [error, setError] = useState('');
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    void completeWebSignIn().then(() => router.replace('/account')).catch((failure: unknown) => setError(failure instanceof Error ? failure.message : 'Sign-in could not be completed. Please start again.'));
  }, [router]);
  return (
    <View style={styles.page}>
      <Text role="heading" aria-level={1} style={styles.heading}>Completing sign-in</Text>
      {error ? <Text role="alert" style={styles.error}>{error}</Text> : <ActivityIndicator accessibilityLabel="Verifying your sign-in" color="#20372F" />}
      <Link href="/account" style={styles.link}>Return to your account</Link>
    </View>
  );
}
const styles = StyleSheet.create({
  page: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 28, gap: 24, backgroundColor: '#F5F4EE' },
  heading: { fontSize: 28, color: '#20372F', fontWeight: '600' },
  error: { color: '#922E24', fontSize: 16, lineHeight: 24, maxWidth: 480 },
  link: { color: '#20372F', fontSize: 16, textDecorationLine: 'underline', padding: 12 },
});
