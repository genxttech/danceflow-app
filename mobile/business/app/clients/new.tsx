import { useLocalSearchParams } from "expo-router";
import { Screen } from "@/components/Screen";
import { StateMessage } from "@/components/StateMessage";
import { AddClientScreen } from "@/screens/AddClientScreen";

export default function NewClientRoute() {
  const { studioId } = useLocalSearchParams<{ studioId?: string }>();

  if (!studioId) {
    return (
      <Screen edges={[]}>
        <StateMessage title="Not found" body="Open this from the Clients tab." tone="error" />
      </Screen>
    );
  }

  return <AddClientScreen studioId={studioId} />;
}
