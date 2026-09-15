import { useEffect, useState } from 'react';
import { Link, useRouter } from 'expo-router';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { accountRequest, clearSession, hasSession, restoreSession, signIn, signOut, type Account, type Session } from '../src/auth/session';

export default function AccountScreen() {
  const router = useRouter();
  const [account, setAccount] = useState<Account>();
  const [session, setSession] = useState<Session>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
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
    setBusy(true); setError(''); setNotice('');
    try { await action(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Something went wrong. Please try again.'); }
    finally {
      if (!hasSession()) { setAccount(undefined); setSession(undefined); }
      setBusy(false);
    }
  }
  useEffect(() => { void run(load); }, []);

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.page}>
        <Link href="/" style={styles.home}>← Larynx</Link>
        <Text role="heading" aria-level={1} style={styles.title}>Your account</Text>
        <Text style={styles.description}>A place for your identity and the devices you use to connect.</Text>
        {busy && <View role="status" style={styles.loading}><ActivityIndicator color="#20372F" /><Text style={styles.body}>Please wait…</Text></View>}
        {!!error && <Text role="alert" style={styles.error}>{error}</Text>}
        {!!notice && <Text role="status" style={styles.body}>{notice}</Text>}
        {!account && (
          <View style={styles.card}>
            <Text role="heading" aria-level={2} style={styles.heading}>Welcome to Larynx</Text>
            <Text style={styles.body}>Sign in or create an account securely. Account recovery is available on the sign-in page.</Text>
            <Pressable role="button" disabled={busy} style={[styles.button, busy && styles.disabled]} onPress={() => void run(async () => { await signIn(); if (Platform.OS !== 'web') router.replace('/account'); await load(); })}>
              <Text style={styles.buttonText}>Sign in or create account</Text>
            </Pressable>
            <Text style={styles.small}>Recovery restores access to your account. Encrypted history recovery is not yet available.</Text>
          </View>
        )}
        {account && session && (
          <>
            <View style={styles.card}>
              <Text role="heading" aria-level={2} style={styles.heading}>Signed in</Text>
              <Text style={styles.body}>Your account is verified. Manage the devices that can access it below.</Text>
              {account.recoveryGeneration > 0 && <Text style={styles.small}>Account recovery is complete. Previous devices have been signed out.</Text>}
              <Pressable role="button" disabled={busy} style={[styles.secondaryButton, busy && styles.disabled]} onPress={() => void run(async () => { try { await signOut(); setNotice('You have signed out of this device.'); } catch { setNotice('Signed out locally. The server could not be reached; sign in on another device to revoke this session.'); } })}>
                <Text style={styles.secondaryText}>Sign out</Text>
              </Pressable>
            </View>
            <View style={styles.sectionHeader}>
              <Text role="heading" aria-level={2} style={styles.heading}>Devices</Text>
              <Pressable role="button" disabled={busy} onPress={() => void run(load)}><Text style={styles.home}>Refresh devices</Text></Pressable>
            </View>
            {account.devices.map((device) => (
              <View key={device.id} style={styles.card}>
                <Text role="heading" aria-level={3} style={styles.deviceName}>{device.name}{device.id === session.deviceId ? ' · This device' : ''}</Text>
                <Text style={styles.small}>{device.revokedAt ? 'Revoked' : 'Active'} · Added {new Date(device.createdAt).toLocaleDateString()}</Text>
                <Text style={styles.small}>Encryption: not yet enabled. This device cannot recover encrypted history.</Text>
                {!device.revokedAt && (confirmDevice === device.id ? (
                  <View style={styles.actions}>
                    <Text style={styles.body}>{device.id === session.deviceId ? 'Revoke this device and sign out?' : 'Revoke this device and end its sessions?'}</Text>
                    <Pressable role="button" disabled={busy} style={styles.secondaryButton} onPress={() => void run(async () => {
                      await accountRequest(`/v1/devices/${encodeURIComponent(device.id)}/revoke`, 'POST');
                      setConfirmDevice(undefined);
                      if (device.id === session.deviceId) { await clearSession(); setNotice('This device has been revoked.'); }
                      else { await load(); setNotice('Device revoked. Its sessions can no longer access your account.'); }
                    })}><Text style={styles.secondaryText}>Confirm revocation</Text></Pressable>
                    <Pressable role="button" disabled={busy} onPress={() => setConfirmDevice(undefined)}><Text style={styles.home}>Cancel</Text></Pressable>
                  </View>
                ) : (
                  <Pressable role="button" disabled={busy} style={styles.secondaryButton} onPress={() => setConfirmDevice(device.id)}><Text style={styles.secondaryText}>Revoke device</Text></Pressable>
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
