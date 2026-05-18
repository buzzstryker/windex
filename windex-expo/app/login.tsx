import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { useAuth } from '@/contexts/AuthContext';
import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';

export default function LoginScreen() {
  const insets = useSafeAreaInsets();
  const colorScheme = useColorScheme();
  const muted = Colors[colorScheme ?? 'light'].icon;
  const border = colorScheme === 'dark' ? '#444' : '#ccc';
  const inputBg = colorScheme === 'dark' ? '#1c1c1e' : '#f5f5f5';
  const { sendOtp, verifyOtp } = useAuth();

  // OTP flow state
  const [otpEmail, setOtpEmail] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [otpSent, setOtpSent] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSendCode() {
    setError(null);
    if (!otpEmail.trim()) {
      setError('Enter your email address.');
      return;
    }
    setBusy(true);
    try {
      const { error: err } = await sendOtp(otpEmail);
      if (err) setError(err);
      else setOtpSent(true);
    } finally {
      setBusy(false);
    }
  }

  async function onVerifyCode() {
    setError(null);
    if (!otpCode.trim()) {
      setError('Enter the 6-digit code from your email.');
      return;
    }
    setBusy(true);
    try {
      const { error: err } = await verifyOtp(otpEmail, otpCode);
      if (err) setError(err);
      // On success, onAuthStateChange fires SIGNED_IN → router navigates to standings
    } finally {
      setBusy(false);
    }
  }

  function onChangeEmail() {
    setOtpSent(false);
    setOtpCode('');
    setError(null);
  }

  const inputStyle = [
    styles.input,
    {
      borderColor: border,
      backgroundColor: inputBg,
      color: colorScheme === 'dark' ? '#fff' : '#111',
    },
  ];

  return (
    <ThemedView style={[styles.screen, { paddingTop: insets.top + 16 }]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 32 }]}>
          <ThemedText type="title" style={styles.title}>
            Windex
          </ThemedText>

          {!otpSent ? (
            /* ── Step 1: Enter email ── */
            <>
              <ThemedText type="subtitle" style={[styles.lead, { color: muted }]}>
                Enter your email to receive a login code.
              </ThemedText>

              <View style={styles.section}>
                <TextInput
                  style={inputStyle}
                  placeholder="Your email address"
                  placeholderTextColor={muted}
                  autoCapitalize="none"
                  keyboardType="email-address"
                  autoComplete="email"
                  textContentType="emailAddress"
                  value={otpEmail}
                  onChangeText={setOtpEmail}
                />
                <Pressable
                  style={[styles.buttonPrimary, busy && styles.buttonDisabled]}
                  onPress={onSendCode}
                  disabled={busy}>
                  {busy ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <ThemedText style={styles.buttonText}>Send Login Code</ThemedText>
                  )}
                </Pressable>
              </View>
            </>
          ) : (
            /* ── Step 2: Enter code ── */
            <>
              <ThemedText type="subtitle" style={[styles.lead, { color: muted }]}>
                Enter the 6-digit code sent to {otpEmail}
              </ThemedText>

              <View style={styles.section}>
                <TextInput
                  style={[inputStyle, styles.codeInput]}
                  placeholder="000000"
                  placeholderTextColor={muted}
                  keyboardType="number-pad"
                  autoComplete="one-time-code"
                  textContentType="oneTimeCode"
                  maxLength={6}
                  value={otpCode}
                  onChangeText={setOtpCode}
                />
                <Pressable
                  style={[styles.buttonPrimary, busy && styles.buttonDisabled]}
                  onPress={onVerifyCode}
                  disabled={busy}>
                  {busy ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <ThemedText style={styles.buttonText}>Verify Code</ThemedText>
                  )}
                </Pressable>

                <View style={styles.codeActions}>
                  <Pressable onPress={onSendCode} disabled={busy}>
                    <ThemedText style={[styles.linkText, { color: muted }]}>Resend code</ThemedText>
                  </Pressable>
                  <ThemedText style={{ color: muted }}> · </ThemedText>
                  <Pressable onPress={onChangeEmail}>
                    <ThemedText style={[styles.linkText, { color: muted }]}>Change email</ThemedText>
                  </Pressable>
                </View>
              </View>
            </>
          )}

          {error ? <ThemedText style={styles.error}>{error}</ThemedText> : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  flex: { flex: 1 },
  scroll: { paddingHorizontal: 24 },
  title: { marginBottom: 10 },
  lead: { fontSize: 17, lineHeight: 24, marginBottom: 22 },
  section: { marginBottom: 16 },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 14,
    fontSize: 17,
    marginBottom: 12,
  },
  codeInput: {
    fontSize: 32,
    fontWeight: '700',
    textAlign: 'center',
    letterSpacing: 12,
    paddingVertical: 18,
  },
  codeActions: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 12,
  },
  linkText: { fontSize: 14 },
  buttonPrimary: {
    backgroundColor: '#0a7ea4',
    borderRadius: 10,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 4,
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: '#fff', fontWeight: '600', fontSize: 17 },
  error: { color: '#c62828', marginTop: 16, fontSize: 15, lineHeight: 22 },
});
