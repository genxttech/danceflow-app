process.env.EXPO_PUBLIC_SUPABASE_URL = "https://testproject.supabase.test";
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
process.env.EXPO_PUBLIC_DANCEFLOW_WEB_URL = "https://danceflow.test";
process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY = "pk_test_env";

// The update notice asks the web for its configuration when a screen mounts; screen tests must not make that request. Its own tests unmock it.
jest.mock("@/components/AppUpdateNotice", () => ({ AppUpdateNotice: () => null }));
