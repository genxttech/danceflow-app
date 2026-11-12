import { render } from "@testing-library/react-native";
import { Pressable, ScrollView, Text, View } from "react-native";

/**
 * The first render in a test file loads React Native's lazily required host components and the
 * test renderer, and on a cold transform cache (every fresh CI checkout) Babel compiles them then:
 * 15 s or more, against about 80 ms for the same test warm. That cost is one-off setup, so it is
 * paid here, in beforeAll with its own budget, and each test's 5 s timeout measures only its work.
 *
 *   beforeAll(warmUpRenderer, WARM_UP_TIMEOUT_MS);
 */
export const WARM_UP_TIMEOUT_MS = 60_000;

export function warmUpRenderer() {
  const { unmount } = render(
    <ScrollView>
      <View>
        <Pressable accessibilityRole="button">
          <Text>warm</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
  unmount();
}
