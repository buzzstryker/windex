// Maps Supabase auth errors to friendly, user-facing copy for the login screen.
// Matches on BOTH the error code and a message-substring fallback, because
// Supabase error codes can vary across supabase-js / GoTrue versions. Applied
// at the sendOtp / verifyOtp failure paths so the raw error.message is never
// rendered to the user.
type MaybeAuthError = { code?: string | null; message?: string | null } | null | undefined;

export function friendlyAuthError(error: MaybeAuthError): string {
  const code = (error?.code ?? '').toLowerCase();
  const message = (error?.message ?? '').toLowerCase();

  // Email isn't a registered user (shouldCreateUser:false → signups blocked).
  if (code === 'otp_disabled' || message.includes('signups not allowed')) {
    return "That email isn't associated with a Windex account. Check the spelling, or try a different email.";
  }

  // Too many email sends in a short window.
  if (code === 'over_email_send_rate_limit' || message.includes('rate limit')) {
    return 'Too many requests. Wait a minute and try again.';
  }

  // Invalid or expired verification code (verify step).
  if (code === 'otp_expired' || message.includes('expired') || message.includes('invalid')) {
    return 'That code is incorrect or has expired. Request a new one.';
  }

  // Generic fallback for anything unmatched.
  return 'Something went wrong. Please try again.';
}
