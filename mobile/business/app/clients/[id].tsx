import { useLocalSearchParams } from "expo-router";
import { Screen } from "@/components/Screen";
import { StateMessage } from "@/components/StateMessage";
import { ClientDetailScreen } from "@/screens/ClientDetailScreen";

export default function ClientRoute() {
  const { id, studioId } = useLocalSearchParams<{ id: string; studioId?: string }>();

  if (!id || !studioId) {
    return (
      <Screen edges={[]}>
        <StateMessage title="Not found" body="Open the client from the Clients tab." tone="error" />
      </Screen>
    );
  }

  return <ClientDetailScreen clientId={id} studioId={studioId} />;
}
