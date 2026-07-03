import { useEffect, useMemo, useState } from "react";
import { Image, Pressable, StyleSheet, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams } from "expo-router";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";
import { colors } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import {
  blockPartnerThread,
  loadPartnerThread,
  loadPartnerThreadMessages,
  reportPartnerThread,
  sendPartnerThreadMessage,
  type PartnerConversationMessage,
  type PartnerConversationThread
} from "@/lib/partnerSearch";

function formatMessageTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

export default function PartnerThreadScreen() {
  const { threadId } = useLocalSearchParams<{ threadId: string }>();
  const { session } = useAuth();
  const user = session?.user ?? null;
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [thread, setThread] = useState<PartnerConversationThread | null>(null);
  const [messages, setMessages] = useState<PartnerConversationMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const otherUserId = useMemo(() => {
    if (!thread || !user) return null;
    return thread.requesterUserId === user.id ? thread.partnerUserId : thread.requesterUserId;
  }, [thread, user]);

  async function loadThread() {
    if (!threadId || !user) return;

    setLoading(true);
    setErrorMessage(null);

    try {
      const [nextThread, nextMessages] = await Promise.all([
        loadPartnerThread(threadId, user.id),
        loadPartnerThreadMessages(threadId, user.id)
      ]);
      setThread(nextThread);
      setMessages(nextMessages);
    } catch {
      setErrorMessage("We could not load this DanceFlow conversation yet.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadThread();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, user?.id]);

  async function sendMessage() {
    if (!threadId || !user) return;

    setSending(true);
    setStatusMessage(null);
    setErrorMessage(null);

    try {
      await sendPartnerThreadMessage({
        body: draft,
        threadId,
        userId: user.id
      });
      setDraft("");
      await loadThread();
    } catch {
      setErrorMessage("We could not send that message yet.");
    } finally {
      setSending(false);
    }
  }

  async function reportThread() {
    if (!threadId || !user) return;

    try {
      await reportPartnerThread({
        reason: "Reported from Partner Messages",
        threadId,
        userId: user.id
      });
      setStatusMessage("Thanks. DanceFlow will review this conversation.");
    } catch {
      setErrorMessage("We could not submit that report yet.");
    }
  }

  async function blockThread() {
    if (!threadId || !user || !otherUserId) return;

    try {
      await blockPartnerThread({
        blockedUserId: otherUserId,
        threadId,
        userId: user.id
      });
      setStatusMessage("This conversation has been blocked.");
      await loadThread();
    } catch {
      setErrorMessage("We could not block this conversation yet.");
    }
  }

  if (!user) {
    return (
      <Screen>
        <FeatureCard
          title="Sign in required"
          detail="Sign in to view DanceFlow partner messages."
        />
      </Screen>
    );
  }

  return (
    <Screen>
      <AppText variant="eyebrow">Partner Messages</AppText>
      <AppText variant="title">DanceFlow conversation</AppText>
      <AppText variant="caption">
        Keep partner communication inside DanceFlow. Do not share phone numbers, links, rates, or lesson advertising.
      </AppText>

      {loading ? <FeatureCard title="Loading messages" detail="Opening your DanceFlow conversation." /> : null}
      {statusMessage ? <FeatureCard title="Partner Messages" detail={statusMessage} /> : null}
      {errorMessage ? <FeatureCard title="Messages need attention" detail={errorMessage} /> : null}

      {thread ? (
        <View style={styles.threadCard}>
          <View style={styles.threadHeader}>
            {thread.partnerPhotoUrl ? (
              <Image
                accessibilityIgnoresInvertColors
                resizeMode="cover"
                source={{ uri: thread.partnerPhotoUrl }}
                style={styles.avatar}
              />
            ) : (
              <View style={styles.avatarPlaceholder}>
                <Ionicons color={colors.primary} name="person-outline" size={24} />
              </View>
            )}
            <View style={{ flex: 1 }}>
              <AppText style={styles.partnerName}>{thread.partnerDisplayName}</AppText>
              {thread.partnerHeadline ? (
                <AppText variant="caption">{thread.partnerHeadline}</AppText>
              ) : null}
            </View>
            <View style={styles.statusPill}>
              <AppText style={styles.statusText}>{thread.status}</AppText>
            </View>
          </View>

          <View style={styles.safetyActions}>
            <Pressable onPress={reportThread} style={styles.safetyButton}>
              <Ionicons color={colors.accent} name="flag-outline" size={16} />
              <AppText style={styles.safetyButtonText}>Report</AppText>
            </Pressable>
            <Pressable onPress={blockThread} style={styles.safetyButton}>
              <Ionicons color={colors.danger} name="ban-outline" size={16} />
              <AppText style={styles.safetyButtonText}>Block</AppText>
            </Pressable>
          </View>
        </View>
      ) : null}

      <View style={styles.messageList}>
        {messages.length ? (
          messages.map((message) => {
            const mine = message.senderUserId === user.id;
            return (
              <View
                key={message.id}
                style={[styles.messageBubble, mine ? styles.myMessage : styles.theirMessage]}
              >
                <AppText style={mine ? styles.myMessageText : styles.theirMessageText}>
                  {message.body}
                </AppText>
                <AppText style={mine ? styles.myMessageMeta : styles.theirMessageMeta}>
                  {formatMessageTime(message.createdAt)}
                </AppText>
              </View>
            );
          })
        ) : !loading ? (
          <FeatureCard title="No messages yet" detail="Send a respectful first message to start the conversation." />
        ) : null}
      </View>

      {thread?.status === "blocked" ? (
        <FeatureCard title="Conversation blocked" detail="Messaging is paused for this partner conversation." />
      ) : (
        <View style={styles.composer}>
          <TextInput
            multiline
            onChangeText={setDraft}
            placeholder="Write a DanceFlow message"
            placeholderTextColor={colors.muted}
            style={styles.input}
            value={draft}
          />
          <AppButton
            label={sending ? "Sending..." : "Send Message"}
            onPress={sendMessage}
          />
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  avatar: {
    borderRadius: 24,
    height: 48,
    width: 48
  },
  avatarPlaceholder: {
    alignItems: "center",
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderRadius: 24,
    borderWidth: 1,
    height: 48,
    justifyContent: "center",
    width: 48
  },
  composer: {
    gap: 10
  },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 16,
    borderWidth: 1,
    color: colors.text,
    fontSize: 16,
    minHeight: 96,
    paddingHorizontal: 12,
    paddingVertical: 12,
    textAlignVertical: "top"
  },
  messageBubble: {
    borderRadius: 18,
    gap: 6,
    maxWidth: "86%",
    paddingHorizontal: 14,
    paddingVertical: 10
  },
  messageList: {
    gap: 10
  },
  myMessage: {
    alignSelf: "flex-end",
    backgroundColor: colors.primary
  },
  myMessageMeta: {
    color: "rgba(255,255,255,0.72)",
    fontSize: 11
  },
  myMessageText: {
    color: "#fff",
    fontSize: 15,
    lineHeight: 21
  },
  partnerName: {
    color: colors.text,
    fontSize: 18,
    fontWeight: "900"
  },
  safetyActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8
  },
  safetyButton: {
    alignItems: "center",
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 11,
    paddingVertical: 8
  },
  safetyButtonText: {
    color: colors.text,
    fontSize: 12,
    fontWeight: "900"
  },
  statusPill: {
    backgroundColor: "#fff4e7",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6
  },
  statusText: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: "900",
    textTransform: "capitalize"
  },
  theirMessage: {
    alignSelf: "flex-start",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1
  },
  theirMessageMeta: {
    color: colors.muted,
    fontSize: 11
  },
  theirMessageText: {
    color: colors.text,
    fontSize: 15,
    lineHeight: 21
  },
  threadCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 20,
    borderWidth: 1,
    gap: 14,
    padding: 16
  },
  threadHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12
  }
});
