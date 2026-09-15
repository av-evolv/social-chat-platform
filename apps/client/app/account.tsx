import Head from 'expo-router/head';
import { formatDate } from '@larynx/i18n';
import { useI18n } from '../src/i18n';
import { useEffect, useState } from 'react';
import { Link, useRouter } from 'expo-router';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { localizeError, accountRequest, clearSession, hasSession, restoreSession, signIn, signOut, type Account, type Session } from '../src/auth/session';

export default function AccountScreen() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [account, setAccount] = useState<Account>();
  const [session, setSession] = useState<Session>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState('');
  const [confirmDevice, setConfirmDevice] = useState<string>();

  async function load() {
    await restoreSession();
    if (!hasSession()) { setAccount(undefined); setSession(undefined); return; }
    const [nextAccount, nextSession] = await Promise.all([accountRequest<Account>('/v1/account'), accountRequest<Session>('/v1/session')]);
    setAccount(nextAccount);
    setSession(nextSession);
  }
  async function run(action: () => Promise<void>) {
    setBusy(true); setError(undefined); setNotice('');
    try { await action(); }
    catch (failure) { setError(failure); }
    finally {
      if (!hasSession()) { setAccount(undefined); setSession(undefined); }
      setBusy(false);
    }
  }
  useEffect(() => { void run(load); }, []);

  return (
    <SafeAreaView style={styles.safe}>
      {Platform.OS === 'web' && <Head><title>{t('client.common.pageTitle', { page: t('client.account.title') })}</title></Head>}
      <ScrollView contentContainerStyle={styles.page}>
        <Link href="/" style={styles.home}>← Larynx</Link>
        <Text role="heading" aria-level={1} style={styles.title}>{t('client.account.title')}</Text>
        <Text style={styles.description}>{t('client.account.description')}</Text>
        {busy && <View role="status" style={styles.loading}><ActivityIndicator color="#20372F" /><Text style={styles.body}>{t('client.common.wait')}</Text></View>}
        {!!error && <Text role="alert" style={styles.error}>{localizeError(error, locale)}</Text>}
        {!!notice && <Text role="status" style={styles.body}>{t(notice)}</Text>}
        {!account && (
          <View style={styles.card}>
            <Text role="heading" aria-level={2} style={styles.heading}>{t('client.account.welcome')}</Text>
            <Text style={styles.body}>{t('client.account.signInDescription')}</Text>
            <Pressable role="button" disabled={busy} style={[styles.button, busy && styles.disabled]} onPress={() => void run(async () => { await signIn(); if (Platform.OS !== 'web') router.replace('/account'); await load(); })}>
              <Text style={styles.buttonText}>{t('client.account.signIn')}</Text>
            </Pressable>
            <Text style={styles.small}>{t('client.account.recoveryWarning')}</Text>
          </View>
        )}
        {account && session && (
          <>
            <View style={styles.card}>
              <Text role="heading" aria-level={2} style={styles.heading}>{t('client.account.signedIn')}</Text>
              <Text style={styles.body}>{t('client.account.verified')}</Text>
              <Link href="/social" style={styles.home}>{t('client.common.socialLink')}</Link>
              <Link href="/invitations" style={styles.home}>{t('client.common.invitationsLink')}</Link>
              {account.recoveryGeneration > 0 && <Text style={styles.small}>{t('client.account.recoveryComplete')}</Text>}
              <Pressable role="button" disabled={busy} style={[styles.secondaryButton, busy && styles.disabled]} onPress={() => void run(async () => { try { await signOut(); setNotice('client.account.signedOut'); } catch { setNotice('client.account.localSignOut'); } })}>
                <Text style={styles.secondaryText}>{t('client.account.signOut')}</Text>
              </Pressable>
            </View>
            <View style={styles.card}>
              <Text role="heading" aria-level={2} style={styles.heading}>{t('client.account.emails')}</Text>
              <Text style={styles.body}>{t('client.account.emailsDescription')}</Text>
              {account.emails.map(email => <Text key={email} selectable style={styles.body}>{email}</Text>)}
            </View>
            <View style={styles.sectionHeader}>
              <Text role="heading" aria-level={2} style={styles.heading}>{t('client.account.devices')}</Text>
              <Pressable role="button" disabled={busy} onPress={() => void run(load)}><Text style={styles.home}>{t('client.account.refreshDevices')}</Text></Pressable>
            </View>
            {account.devices.map((device) => (
              <View key={device.id} style={styles.card}>
                <Text role="heading" aria-level={3} style={styles.deviceName}>{device.id === session.deviceId ? t('client.account.thisDevice', { name: device.name }) : device.name}</Text>
                <Text style={styles.small}>{t(device.revokedAt ? 'client.account.deviceRevokedDate' : 'client.account.deviceActive', { date: formatDate(locale, device.createdAt) })}</Text>
                <Text style={styles.small}>{t('client.account.encryption')}</Text>
                {!device.revokedAt && (confirmDevice === device.id ? (
                  <View style={styles.actions}>
                    <Text style={styles.body}>{device.id === session.deviceId ? t('client.account.confirmThisDevice') : t('client.account.confirmOtherDevice')}</Text>
                    <Pressable role="button" disabled={busy} style={styles.secondaryButton} onPress={() => void run(async () => {
                      await accountRequest(`/v1/devices/${encodeURIComponent(device.id)}/revoke`, 'POST');
                      setConfirmDevice(undefined);
                      if (device.id === session.deviceId) { await clearSession(); setNotice('client.account.thisDeviceRevoked'); }
                      else { await load(); setNotice('client.account.deviceRevoked'); }
                    })}><Text style={styles.secondaryText}>{t('client.account.confirmRevoke')}</Text></Pressable>
                    <Pressable role="button" disabled={busy} onPress={() => setConfirmDevice(undefined)}><Text style={styles.home}>{t('client.common.cancel')}</Text></Pressable>
                  </View>
                ) : (
                  <Pressable role="button" disabled={busy} style={styles.secondaryButton} onPress={() => setConfirmDevice(device.id)}><Text style={styles.secondaryText}>{t('client.account.revokeDevice')}</Text></Pressable>
                ))}
              </View>
            ))}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#F5F4EE' },
  page: { width: '100%', maxWidth: 760, alignSelf: 'center', padding: 24, gap: 20, paddingBottom: 60 },
  home: { color: '#20372F', fontSize: 15, fontWeight: '600', paddingVertical: 10 },
  title: { color: '#20372F', fontSize: 38, fontWeight: '600', letterSpacing: -1 },
  description: { color: '#58675D', fontSize: 18, lineHeight: 27 },
  card: { backgroundColor: '#FFFFFF', borderColor: '#D9DFD5', borderWidth: 1, borderRadius: 20, padding: 24, gap: 16 },
  heading: { color: '#20372F', fontSize: 24, fontWeight: '600' },
  deviceName: { color: '#20372F', fontSize: 18, fontWeight: '600' },
  body: { color: '#20372F', fontSize: 16, lineHeight: 24 },
  small: { color: '#58675D', fontSize: 14, lineHeight: 22 },
  error: { color: '#922E24', backgroundColor: '#FFF0E9', padding: 16, borderRadius: 12, fontSize: 16, lineHeight: 24 },
  button: { backgroundColor: '#20372F', padding: 16, borderRadius: 12, alignItems: 'center' },
  buttonText: { color: '#F5F4EE', fontSize: 16, fontWeight: '600' },
  secondaryButton: { borderColor: '#D9DFD5', borderWidth: 1, padding: 14, borderRadius: 12, alignItems: 'center' },
  secondaryText: { color: '#20372F', fontSize: 16, fontWeight: '600' },
  disabled: { opacity: 0.5 },
  loading: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  sectionHeader: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  actions: { gap: 14 },
});
