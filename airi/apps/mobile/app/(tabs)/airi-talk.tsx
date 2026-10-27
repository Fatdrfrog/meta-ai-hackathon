import {
  EmptyState,
  Header,
  PrimaryButton,
  Screen,
  SecondaryButton,
  TextField,
  WorkspaceRequired,
} from "@/components/ui";
import { useAuth } from "@/providers/auth-provider";
import type {
  MobileAiriChatMessage,
  MobileAiriChatMessagesResponse,
  MobileAiriChatThread,
  MobileAiriChatThreadsResponse,
  MobileAiriChatTurnResponse,
  MobileElevenLabsTokenResponse,
} from "@icecore/shared/types/mobile-api";
import { Mic, Plus } from "lucide-react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

const DRAFT_THREAD_ID = "draft";

export default function AiriTalkScreen() {
  const { selectedWorkspace, apiFetch } = useAuth();
  const [threads, setThreads] = useState<MobileAiriChatThread[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MobileAiriChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState<
    "idle" | "connecting" | "ready" | "fallback"
  >("idle");
  const listRef = useRef<FlatList<MobileAiriChatMessage>>(null);

  const workspaceId = selectedWorkspace?.id;

  const loadThreads = useCallback(async () => {
    if (!workspaceId) return;
    setIsLoading(true);
    try {
      const payload = await apiFetch<MobileAiriChatThreadsResponse>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/airi-chats`,
      );
      setThreads(payload.threads || []);
    } catch (error) {
      Alert.alert(
        "Airi chats failed",
        error instanceof Error ? error.message : "Unable to load chats.",
      );
    } finally {
      setIsLoading(false);
    }
  }, [apiFetch, workspaceId]);

  const loadMessages = useCallback(
    async (threadId: string) => {
      if (!workspaceId || threadId === DRAFT_THREAD_ID) {
        setMessages([]);
        return;
      }
      setIsLoading(true);
      try {
        const payload = await apiFetch<MobileAiriChatMessagesResponse>(
          `/api/workspaces/${encodeURIComponent(workspaceId)}/airi-chats/${encodeURIComponent(threadId)}/messages`,
        );
        setMessages(payload.messages || []);
      } catch (error) {
        Alert.alert(
          "Messages failed",
          error instanceof Error ? error.message : "Unable to load messages.",
        );
      } finally {
        setIsLoading(false);
      }
    },
    [apiFetch, workspaceId],
  );

  useEffect(() => {
    void loadThreads();
  }, [loadThreads]);

  useEffect(() => {
    if (selectedThreadId) {
      void loadMessages(selectedThreadId);
    }
  }, [loadMessages, selectedThreadId]);

  useEffect(() => {
    if (messages.length > 0) {
      requestAnimationFrame(() =>
        listRef.current?.scrollToEnd({ animated: true }),
      );
    }
  }, [messages.length]);

  if (!selectedWorkspace) {
    return (
      <Screen>
        <WorkspaceRequired />
      </Screen>
    );
  }

  const send = async () => {
    const content = draft.trim();
    if (!content || isSending || !workspaceId) return;

    const optimistic: MobileAiriChatMessage = {
      id: `pending-${Date.now()}`,
      threadId: selectedThreadId || DRAFT_THREAD_ID,
      role: "user",
      content,
      createdAt: new Date().toISOString(),
    };

    setDraft("");
    setIsSending(true);
    setMessages((current) => [...current, optimistic]);
    try {
      const path = selectedThreadId
        ? `/api/workspaces/${encodeURIComponent(workspaceId)}/airi-chats/${encodeURIComponent(selectedThreadId)}/messages`
        : `/api/workspaces/${encodeURIComponent(workspaceId)}/airi-chats/messages`;
      const payload = await apiFetch<MobileAiriChatTurnResponse>(path, {
        method: "POST",
        body: JSON.stringify({
          content,
          source: selectedThreadId ? undefined : "manual",
          selectedSources: [],
        }),
      });
      setMessages((current) => [
        ...current.filter((message) => message.id !== optimistic.id),
        payload.userMessage,
        payload.assistantMessage,
      ]);
      setSelectedThreadId(payload.thread.id);
      setThreads((current) => [
        payload.thread,
        ...current.filter((thread) => thread.id !== payload.thread.id),
      ]);
    } catch (error) {
      setMessages((current) =>
        current.filter((message) => message.id !== optimistic.id),
      );
      Alert.alert(
        "Airi did not reply",
        error instanceof Error ? error.message : "Unable to send message.",
      );
    } finally {
      setIsSending(false);
    }
  };

  const requestVoiceToken = async () => {
    if (!workspaceId) return;
    setVoiceStatus("connecting");
    try {
      await apiFetch<MobileElevenLabsTokenResponse>(
        "/api/elevenlabs/conversation-token",
        {
          method: "POST",
          body: JSON.stringify({
            workspaceId,
          }),
        },
      );
      setVoiceStatus("ready");
      Alert.alert(
        "Voice token ready",
        "The web ElevenLabs hook is not used in native. Text fallback remains active until a native voice transport is bundled.",
      );
    } catch (error) {
      setVoiceStatus("fallback");
      Alert.alert(
        "Voice unavailable",
        error instanceof Error ? error.message : "Using text fallback.",
      );
    }
  };

  return (
    <Screen>
      <Header
        title="Airi Talk"
        subtitle={selectedWorkspace.name}
        action={
          <Pressable
            accessibilityRole="button"
            onPress={requestVoiceToken}
            style={styles.iconButton}
          >
            <Mic color="#2563EB" size={20} strokeWidth={2.3} />
          </Pressable>
        }
      />

      <View style={styles.threadRail}>
        <Pressable
          onPress={() => {
            setSelectedThreadId(null);
            setMessages([]);
          }}
          style={[
            styles.threadChip,
            !selectedThreadId && styles.threadChipActive,
          ]}
        >
          <Plus color={!selectedThreadId ? "#FFFFFF" : "#2563EB"} size={15} />
          <Text
            style={[
              styles.threadChipText,
              !selectedThreadId && styles.threadChipTextActive,
            ]}
          >
            New
          </Text>
        </Pressable>
        {threads.slice(0, 6).map((thread) => (
          <Pressable
            key={thread.id}
            onPress={() => setSelectedThreadId(thread.id)}
            style={[
              styles.threadChip,
              selectedThreadId === thread.id && styles.threadChipActive,
            ]}
          >
            <Text
              numberOfLines={1}
              style={[
                styles.threadChipText,
                selectedThreadId === thread.id && styles.threadChipTextActive,
              ]}
            >
              {thread.title}
            </Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.statusRow}>
        <Text style={styles.statusText}>
          Voice: {voiceStatus === "idle" ? "text fallback" : voiceStatus}
        </Text>
        {isLoading ? <ActivityIndicator color="#2563EB" size="small" /> : null}
      </View>

      {messages.length === 0 && !isLoading ? (
        <EmptyState
          title="Ask Airi"
          body="Use text now. Voice sessions request a protected ElevenLabs token and degrade cleanly until native transport is enabled."
        />
      ) : (
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.messageList}
          renderItem={({ item }) => (
            <View
              style={[
                styles.messageBubble,
                item.role === "user"
                  ? styles.userBubble
                  : styles.assistantBubble,
              ]}
            >
              <Text
                style={[
                  styles.messageAuthor,
                  item.role === "user" && styles.userMessageAuthor,
                ]}
              >
                {item.role === "user" ? "You" : "Airi"}
              </Text>
              <Text
                style={[
                  styles.messageText,
                  item.role === "user" && styles.userMessageText,
                ]}
              >
                {item.content}
              </Text>
            </View>
          )}
        />
      )}

      <View style={styles.composer}>
        <View style={styles.composerInput}>
          <TextField
            label="Message"
            value={draft}
            onChangeText={setDraft}
            placeholder="Ask about support, knowledge, campaigns..."
            multiline
          />
        </View>
        <PrimaryButton
          label={isSending ? "Sending" : "Send"}
          onPress={send}
          disabled={isSending || !draft.trim()}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  iconButton: {
    width: 42,
    height: 42,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#DBEAFE",
  },
  threadRail: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 10,
  },
  threadChip: {
    maxWidth: 150,
    minHeight: 34,
    borderRadius: 8,
    paddingHorizontal: 10,
    alignItems: "center",
    flexDirection: "row",
    gap: 6,
    backgroundColor: "#FFFFFF",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#CBD5E1",
  },
  threadChipActive: {
    backgroundColor: "#2563EB",
    borderColor: "#2563EB",
  },
  threadChipText: {
    color: "#334155",
    fontSize: 13,
    fontWeight: "700",
  },
  threadChipTextActive: {
    color: "#FFFFFF",
  },
  statusRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    minHeight: 28,
  },
  statusText: {
    color: "#64748B",
    fontSize: 12,
    fontWeight: "700",
  },
  messageList: {
    gap: 10,
    paddingVertical: 12,
  },
  messageBubble: {
    maxWidth: "86%",
    borderRadius: 8,
    padding: 12,
    gap: 4,
  },
  assistantBubble: {
    alignSelf: "flex-start",
    backgroundColor: "#FFFFFF",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#E2E8F0",
  },
  userBubble: {
    alignSelf: "flex-end",
    backgroundColor: "#2563EB",
  },
  messageAuthor: {
    color: "#64748B",
    fontSize: 11,
    fontWeight: "800",
    textTransform: "uppercase",
  },
  userMessageAuthor: {
    color: "#BFDBFE",
  },
  messageText: {
    color: "#0F172A",
    fontSize: 15,
    lineHeight: 22,
  },
  userMessageText: {
    color: "#FFFFFF",
  },
  composer: {
    gap: 10,
    paddingTop: 8,
  },
  composerInput: {
    maxHeight: 132,
  },
});
