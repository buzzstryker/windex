import { useCallback } from 'react';
import { useRouter } from 'expo-router';

/**
 * Safe header back-navigation for custom-header (non-tab) screens.
 *
 * The header chevrons on these screens previously called `router.back()`
 * directly, which silently no-ops when `router.canGoBack()` is false. On
 * web/PWA that state is reachable: the root layout lands the app via
 * `router.replace('/(tabs)/standings')` (which adds no poppable entry), and a
 * cold open / service-worker reload can leave a custom-header screen as the
 * stack root. With no hamburger on these screens, the dead chevron strands the
 * user with no escape but a force-close.
 *
 * This hook returns a `goBack` callback that pops when possible and otherwise
 * falls back to the app's cold-start landing route — a tab that has the
 * hamburger, restoring drawer access. Behavior is identical to the old code
 * whenever `canGoBack()` is true, so patched screens cannot regress.
 */
export function useSafeBack(): () => void {
  const router = useRouter();
  return useCallback(() => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/(tabs)/standings');
    }
  }, [router]);
}
