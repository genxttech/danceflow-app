import { takePostSignInRoute } from "@/lib/postSignInRoute";

type RouterLike = {
  replace: (href: never) => void;
  push: (href: never) => void;
};

const HOME = "/(tabs)/home";

/**
 * Leaves the sign-in flow. The destination goes on top of Today (not in place of the callback
 * screen), so Back from it lands on Today instead of the sign-in screen or exiting the app on a
 * cold start. A tab destination replaces instead, because pushing a tab would stack a second tab bar.
 */
export async function continueAfterSignIn(router: RouterLike): Promise<string> {
  const route = await takePostSignInRoute();

  if (!route || route === HOME) {
    router.replace(HOME as never);
    return HOME;
  }
  if (route.startsWith("/(tabs)/")) {
    router.replace(route as never);
    return route;
  }

  router.replace(HOME as never);
  router.push(route as never);
  return route;
}
