import { useEffect, useState } from 'react';
import Head from 'expo-router/head';
import { Link } from 'expo-router';
import { Platform, StyleSheet, Text, View, ScrollView, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

const colors = {
  paper: '#F5F4EE',
  surface: '#FFFFFF',
  ink: '#20372F',
  secondary: '#58675D',
  line: '#D9DFD5',
  accent: '#CFE2BD',
  muted: '#EAEDE4',
};

const foundations = [
  { number: '01', title: 'Conversations', detail: 'A familiar place for your people, with chat at the heart of it.' },
  { number: '02', title: 'Plans', detail: 'Turn the things you talk about into time spent together.' },
  { number: '03', title: 'Memories', detail: 'Keep the moments connected to the people who were there.' },
];

export default function HomeScreen() {
  const { width } = useWindowDimensions();
  const [layoutReady, setLayoutReady] = useState(Platform.OS !== 'web');

  useEffect(() => {
    setLayoutReady(true);
  }, []);

  // Match the compact static HTML during hydration before using browser dimensions.
  const wide = layoutReady && width >= 820;

  return (
    <SafeAreaView style={styles.safeArea}>
      {Platform.OS === 'web' && (
        <Head>
          <title>Larynx — Your people, together</title>
          <meta name="description" content="A home for your conversations, plans, and shared moments. Larynx is in early development." />
        </Head>
      )}
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={[styles.page, !wide && styles.pageCompact]}>
          <View style={styles.header}>
            <View style={styles.brand}>
              <View aria-hidden style={styles.brandMark}>
                <View style={styles.markInner} />
              </View>
              <Text style={styles.wordmark}>Larynx</Text>
            </View>
            <View style={styles.badge}>
              <Text style={styles.badgeText}>Early development</Text>
            </View>
          </View>

          <View style={[styles.hero, wide && styles.heroWide]}>
            <View style={styles.heroCopy}>
              <Text style={styles.eyebrow}>A LITTLE CLOSER TO YOUR PEOPLE</Text>
              <Text role="heading" aria-level={1} style={[styles.title, !wide && styles.titleCompact]}>
                Good things start with a conversation.
              </Text>
              <Text style={styles.intro}>
                Your chats, the plans that grow from them, and the moments you share. Together in one place.
              </Text>
              <View style={styles.platforms}>
                <Text style={styles.platformText}>Web</Text>
                <Text aria-hidden style={styles.separator}>/</Text>
                <Text style={styles.platformText}>iOS</Text>
                <Text aria-hidden style={styles.separator}>/</Text>
                <Text style={styles.platformText}>Android</Text>
              </View>
            </View>

            <View style={[styles.statusCard, wide && styles.statusCardWide]}>
              <View style={styles.cardTop}>
                <Text style={styles.cardEyebrow}>WHERE WE ARE</Text>
                <Text style={styles.step}>01</Text>
              </View>
              <View aria-hidden style={styles.conversationMark}>
                <View style={styles.bubbleBack} />
                <View style={styles.bubbleFront}>
                  <View style={styles.dot} />
                  <View style={styles.dot} />
                  <View style={styles.dot} />
                </View>
              </View>
              <Text role="heading" aria-level={2} style={styles.cardTitle}>Making room for connection.</Text>
              <Text style={styles.cardDescription}>
                Your account is ready to set up. Conversations and shared plans are coming next.
              </Text>
              <View style={styles.cardFooter}>
                <Text style={styles.cardFooterText}>Get started</Text>
                <Link href="/account" style={styles.cardFooterValue}>Your account →</Link>
              </View>
            </View>
          </View>

          <View style={styles.foundationSection}>
            <Text role="heading" aria-level={2} style={styles.sectionHeading}>What we’re building toward</Text>
            <View style={[styles.foundationList, wide && styles.foundationListWide]}>
              {foundations.map((foundation) => (
                <View key={foundation.number} style={styles.foundation}>
                  <Text style={styles.foundationNumber}>{foundation.number}</Text>
                  <Text role="heading" aria-level={3} style={styles.foundationTitle}>{foundation.title}</Text>
                  <Text style={styles.foundationDetail}>{foundation.detail}</Text>
                </View>
              ))}
            </View>
          </View>

          <View style={styles.footer}>
            <Text style={styles.footerText}>More time for your people.</Text>
            <Text style={styles.footerMeta}>Larynx · Foundation preview</Text>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.paper },
  scrollContent: { flexGrow: 1 },
  page: { width: '100%', maxWidth: 1220, alignSelf: 'center', paddingHorizontal: 48, paddingTop: 32, paddingBottom: 24 },
  pageCompact: { paddingHorizontal: 24, paddingTop: 20 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 16, paddingBottom: 26, borderBottomWidth: 1, borderBottomColor: colors.line },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 11 },
  brandMark: { width: 31, height: 31, backgroundColor: colors.ink, borderRadius: 11, borderBottomLeftRadius: 2, alignItems: 'center', justifyContent: 'center' },
  markInner: { width: 13, height: 13, borderWidth: 2, borderColor: colors.paper, borderRadius: 5, borderBottomRightRadius: 1 },
  wordmark: { color: colors.ink, fontSize: 27, fontWeight: '700', letterSpacing: -1 },
  badge: { borderRadius: 20, backgroundColor: colors.muted, paddingVertical: 8, paddingHorizontal: 12 },
  badgeText: { color: colors.ink, fontSize: 12, fontWeight: '600' },
  hero: { gap: 36, paddingTop: 48, paddingBottom: 48 },
  heroWide: { flexDirection: 'row', gap: 68, alignItems: 'center', paddingTop: 70, paddingBottom: 70 },
  heroCopy: { flex: 1, gap: 24 },
  eyebrow: { color: colors.secondary, fontSize: 11, letterSpacing: 1.5, fontWeight: '700', lineHeight: 18 },
  title: { fontSize: 58, lineHeight: 63, letterSpacing: -2.5, color: colors.ink, fontWeight: '600', maxWidth: 620 },
  titleCompact: { fontSize: 42, lineHeight: 47, letterSpacing: -1.7 },
  intro: { fontSize: 18, lineHeight: 28, color: colors.secondary, maxWidth: 490 },
  platforms: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingTop: 4 },
  platformText: { fontSize: 13, fontWeight: '600', color: colors.ink },
  separator: { fontSize: 14, color: colors.secondary },
  statusCard: { borderRadius: 24, padding: 28, backgroundColor: colors.ink },
  statusCardWide: { width: 350 },
  cardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardEyebrow: { color: colors.accent, fontSize: 11, fontWeight: '700', letterSpacing: 1.3 },
  step: { color: colors.accent, fontSize: 12 },
  conversationMark: { height: 100, width: 120, marginTop: 28, marginBottom: 8 },
  bubbleBack: { position: 'absolute', width: 68, height: 52, left: 37, top: 10, borderWidth: 1.5, borderColor: '#8CA286', borderRadius: 19, borderBottomRightRadius: 4 },
  bubbleFront: { position: 'absolute', width: 78, height: 58, left: 6, top: 27, borderRadius: 21, borderBottomLeftRadius: 4, backgroundColor: colors.accent, flexDirection: 'row', gap: 6, justifyContent: 'center', alignItems: 'center' },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.ink },
  cardTitle: { color: colors.paper, fontSize: 27, lineHeight: 34, fontWeight: '600', letterSpacing: -0.6 },
  cardDescription: { color: '#CDD6CE', fontSize: 16, lineHeight: 25, marginTop: 16 },
  cardFooter: { marginTop: 28, paddingTop: 18, borderTopWidth: 1, borderTopColor: '#4D6355', flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: 8 },
  cardFooterText: { color: '#CDD6CE', fontSize: 12 },
  cardFooterValue: { color: colors.accent, fontSize: 12, fontWeight: '600' },
  foundationSection: { gap: 22 },
  sectionHeading: { color: colors.secondary, fontSize: 14, fontWeight: '500' },
  foundationList: { gap: 16 },
  foundationListWide: { flexDirection: 'row' },
  foundation: { flex: 1, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, borderRadius: 16, padding: 24 },
  foundationNumber: { color: colors.secondary, fontSize: 12, marginBottom: 24 },
  foundationTitle: { color: colors.ink, fontSize: 20, fontWeight: '600', marginBottom: 10 },
  foundationDetail: { color: colors.secondary, fontSize: 16, lineHeight: 25 },
  footer: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: 12, marginTop: 48, paddingTop: 24, borderTopWidth: 1, borderTopColor: colors.line },
  footerText: { color: colors.ink, fontSize: 13, fontWeight: '500' },
  footerMeta: { color: colors.secondary, fontSize: 12 },
});
