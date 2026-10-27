import {
  Header,
  LoadingState,
  PrimaryButton,
  Screen,
  SecondaryButton,
  TextField,
} from "@/components/ui";
import {
  formatMessageTime,
  getDetailTitle,
  normalizeConversationMessage,
} from "@/lib/format";
import { subscribeToRealtimeScope } from "@/lib/realtime";
import { useAuth } from "@/providers/auth-provider";
import type {
  MobileConversationDetail,
  MobileConversationMessage,
  MobileConversationReplyResponse,
  MobileWindowStatusResponse,
} from "@icecore/shared/types/mobile-api";
import { ArrowLeft, RefreshCw } from "lucide-react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

export default function RequestDetailScreen() {
  const { conversationId } = useLocalSearchParams<{ conversationId: string }>();
  const { selectedWorkspace, apiFetch, session } = useAuth();
  const [detail, setDetail] = useState<MobileConversationDetail | null>(null);
  const [windowStatus, setWindowStatus] =
    useState<MobileWindowStatusResponse | null>(null);
  const [reply, setReply] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const listRef = useRef<FlatList<MobileConversationMessage>>(null);

  const workspaceId = selectedWorkspace?.id;

  const loadDetail = useCallback(async () => {
    if (!conversationId || !workspaceId) return;
    setIsLoading(true);
    try {
      const params = new URLSearchParams({
        workspaceId,
        page: "1",
        limit: "50",
        view: "chat",
      });
      const payload = await apiFetch<MobileConversationDetail>(
        `/api/conversations/${encodeURIComponent(conversationId)}?${params.toString()}`,
      );
      setDetail({
        ...payload,
        messages: (payload.messages || []).map(normalizeConversationMessage),
      });
      void apiFetch(
        `/api/conversations/${encodeURIComponent(conversationId)}/read`,
        {
          method: "PATCH",
        },
      ).catch(() => {});
    } catch (error) {
      Alert.alert(
        "Conversation failed",
        error instanceof Error ? error.message : "Unable to load conversation.",
      );
    } finally {
      setIsLoading(false);
    }
  }, [apiFetch, conversationId, workspaceId]);

  const loadWindowStatus = useCallback(async () => {
    if (!conversationId) return;
    try {
      const payload = await apiFetch<MobileWindowStatusResponse>(
        `/api/conversations/${encodeURIComponent(conversationId)}/window-status`,
      );
      setWindowStatus(payload);
    } catch {
      setWindowStatus(null);
    }
  }, [apiFetch, conversationId]);

  useEffect(() => {
    void loadDetail();
    void loadWindowStatus();
  }, [loadDetail, loadWindowStatus]);

  useEffect(() => {
    if (!conversationId || !workspaceId) return;
    let unsubscribe: (() => Promise<void>) | null = null;
    subscribeToRealtimeScope({
      scope: { kind: "conversation", workspaceId, conversationId },
      accessToken: session?.access_token,
      onEvent: (eventName) => {
        if (
          eventName === "conversation.message.created" ||
          eventName === "conversation.message.updated" ||
          eventName === "conversation.read.changed" ||
          eventName === "airi.handoff" ||
          eventName === "widget.csat.changed"
        ) {
          void loadDetail();
          void loadWindowStatus();
        }
      },
    }).then((cleanup) => {
      unsubscribe = cleanup;
    });
    return () => {
      void unsubscribe?.();
    };
  }, [
    conversationId,
    loadDetail,
    loadWindowStatus,
    session?.access_token,
    workspaceId,
  ]);

  if (isLoading && !detail) {
    return <LoadingState label="Loading conversation" />;
  }

  const sendReply = async () => {
    const text = reply.trim();
    if (!text || !conversationId || isSending) return;
    setIsSending(true);
    setReply("");
    try {
      await apiFetch<MobileConversationReplyResponse>(
        `/api/conversations/${encodeURIComponent(conversationId)}/reply`,
        {
          method: "POST",
          body: JSON.stringify({ text }),
        },
      );
      await loadDetail();
    } catch (error) {
      setReply(text);
      Alert.alert(
        "Reply failed",
        error instanceof Error ? error.message : "Unable to send reply.",
      );
    } finally {
      setIsSending(false);
    }
  };

  const title = detail ? getDetailTitle(detail) : "Conversation";
  const messages = detail?.messages || [];
  const isInstagramCommentThread =
    detail?.channel === "instagram" &&
    detail.external_thread?.type === "comment";
  const isWindowRestrictedConversation = Boolean(
    windowStatus?.requiresWindow && !isInstagramCommentThread,
  );
  const isHumanAgentReplyAvailable = Boolean(
    detail?.channel === "instagram" &&
      windowStatus?.windowInfo?.isWithinWindow === false &&
      windowStatus?.humanAgent?.enabled,
  );
  const isReplyBlockedByWindow = Boolean(
    isWindowRestrictedConversation &&
      windowStatus?.windowInfo?.isWithinWindow === false &&
      !isHumanAgentReplyAvailable,
  );
  const windowBlockedMessage =
    detail?.channel === "instagram"
      ? windowStatus?.humanAgent?.reason === "human_agent_window_expired"
        ? "Human Agent replies are allowed only within 7 days of the customer's last message. Wait for the customer to message again."
        : "Instagram 24-hour window is closed. Human Agent is not approved yet, so reply is blocked until the customer messages again."
      : "24-hour messaging window is closed. Send an approved template or wait for the customer to message again.";
  const windowCopy = windowStatus?.requiresWindow
    ? windowStatus.windowInfo?.isWithinWindow
      ? `${Math.max(0, Math.floor(windowStatus.windowInfo.hoursRemaining))}h left`
      : "Window closed"
    : "No Meta window";

  return (
    <Screen>
      <Header
        title={title}
        subtitle={`${detail?.channel || "conversation"} · ${windowCopy}`}
        action={
          <View style={styles.headerActions}>
            <Pressable
              accessibilityRole="button"
              onPress={() => router.back()}
              style={styles.iconButton}
            >
              <ArrowLeft color="#0F172A" size={20} strokeWidth={2.3} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => void loadDetail()}
              style={styles.iconButton}
            >
              <RefreshCw color="#2563EB" size={19} strokeWidth={2.3} />
            </Pressable>
          </View>
        }
      />

      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(item) => item._id}
        contentContainerStyle={styles.messageList}
        onContentSizeChange={() => {
          if (messages.length > 0) {
            listRef.current?.scrollToEnd({ animated: true });
          }
        }}
        renderItem={({ item }) => {
          const outbound = item.direction === "outbound";
          const text =
            item.text ||
            (item.mediaType ? `[${item.mediaType} attachment]` : "Message");
          return (
            <View
              style={[
                styles.messageBubble,
                outbound ? styles.outboundBubble : styles.inboundBubble,
              ]}
            >
              <Text
                style={[
                  styles.messageMeta,
                  outbound && styles.outboundMessageMeta,
                ]}
              >
                {outbound ? "Manager" : "Customer"} ·{" "}
                {formatMessageTime(item.date)}
              </Text>
              <Text
                style={[
                  styles.messageText,
                  outbound && styles.outboundMessageText,
                ]}
              >
                {text}
              </Text>
              {item.fileName ? (
                <Text
                  style={[
                    styles.attachmentText,
                    outbound && styles.outboundAttachmentText,
                  ]}
                >
                  {item.fileName}
                </Text>
              ) : null}
            </View>
          );
        }}
      />

      <View style={styles.composer}>
        {isReplyBlockedByWindow ? (
          <View style={styles.windowBlockedAlert}>
            <Text style={styles.windowBlockedTitle}>Reply blocked</Text>
            <Text style={styles.windowBlockedBody}>{windowBlockedMessage}</Text>
          </View>
        ) : null}
        <TextField
          label="Reply"
          value={reply}
          onChangeText={setReply}
          placeholder="Write a customer reply"
          multiline
          editable={!isReplyBlockedByWindow && !isSending}
        />
        <View style={styles.composerActions}>
          <SecondaryButton label="Refresh" onPress={() => void loadDetail()} />
          <View style={styles.sendButton}>
            <PrimaryButton
              label={isSending ? "Sending" : "Send reply"}
              onPress={sendReply}
              disabled={isSending || isReplyBlockedByWindow || !reply.trim()}
            />
          </View>
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  headerActions: {
    flexDirection: "row",
    gap: 8,
  },
  iconButton: {
    width: 42,
    height: 42,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#FFFFFF",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#CBD5E1",
  },
  messageList: {
    gap: 10,
    paddingVertical: 12,
  },
  messageBubble: {
    maxWidth: "88%",
    borderRadius: 8,
    padding: 12,
    gap: 4,
  },
  inboundBubble: {
    alignSelf: "flex-start",
    backgroundColor: "#FFFFFF",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#E2E8F0",
  },
  outboundBubble: {
    alignSelf: "flex-end",
    backgroundColor: "#0F172A",
  },
  messageMeta: {
    color: "#64748B",
    fontSize: 11,
    fontWeight: "800",
  },
  outboundMessageMeta: {
    color: "#CBD5E1",
  },
  messageText: {
    color: "#0F172A",
    fontSize: 15,
    lineHeight: 22,
  },
  outboundMessageText: {
    color: "#FFFFFF",
  },
  attachmentText: {
    color: "#2563EB",
    fontSize: 12,
    fontWeight: "700",
  },
  outboundAttachmentText: {
    color: "#93C5FD",
  },
  composer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#CBD5E1",
    paddingTop: 10,
    gap: 10,
  },
  windowBlockedAlert: {
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#FCA5A5",
    backgroundColor: "#FEF2F2",
    padding: 10,
    gap: 3,
  },
  windowBlockedTitle: {
    color: "#991B1B",
    fontSize: 13,
    fontWeight: "800",
  },
  windowBlockedBody: {
    color: "#7F1D1D",
    fontSize: 12,
    lineHeight: 18,
  },
  composerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  sendButton: {
    flex: 1,
  },
});
