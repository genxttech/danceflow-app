import { useCallback } from "react";
import { router } from "expo-router";
import { useAuth } from "@/lib/auth";
import { AuthCallbackScreen } from "@/screens/AuthCallbackScreen";

/** danceflow-business://auth/callback: the email sign-in link lands here (see AuthCallbackScreen). */
export default function AuthCallbackRoute() {
  const { session, linkStatus } = useAuth();
  const onDone = useCallback(() => router.replace("/"), []);
  const onBackToSignIn = useCallback(() => router.replace("/sign-in"), []);
  return <AuthCallbackScreen signedIn={!!session} linkStatus={linkStatus} onDone={onDone} onBackToSignIn={onBackToSignIn} />;
}
