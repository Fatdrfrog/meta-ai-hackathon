import {
  EmptyState,
  Header,
  Screen,
  SecondaryButton,
  TextField,
  WorkspaceRequired,
} from "@/components/ui";
import {
  getConversationPreview,
  getConversationTimestamp,
  getConversationTitle,
  sortRawConversations,
} from "@/lib/format";
import { subscribeToRealtimeScope } from "@/lib/realtime";
import { useAuth } from "@/providers/auth-provider";
import type { MobileRequestsResponse } from "@icecore/shared/types/mobile-api";
import type { RawConversation } from "@icecore/shared/types/requests";
import { router } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";

function conversationId(conversation: RawConversation): string {
  return String(conversation._id || "");
}

export default function RequestsScreen() {
  const { selectedWorkspace, apiFetch, session } = useAuth();
  const [requests, setRequests] = useState<RawConversation[]>([]);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [hasNextPage, setHasNextPage] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const workspaceId = selectedWorkspace?.id;

  const load = useCallback(
    async (nextPage = 1, mode: "replace" | "append" = "replace") => {
      if (!workspaceId) return;
      if (mode === "replace") setIsRefreshing(true);
      setIsLoading(true);
      try {
        const params = new URLSearchParams({
          workspaceId,
          page: String(nextPage),
          limit: "30",
          includeChannels: "true",
        });
        if (search.trim()) {
          // The server's message search across all conversation messages.
          params.set("searchType", "message_within_chat");
          params.set("searchQuery", search.trim());
        }
        const payload = await apiFetch<MobileRequestsResponse>(
          `/api/requests?${params.toString()}`,
        );
        setPage(nextPage);
        setHasNextPage(Boolean(payload.pagination?.hasNextPage));
        setRequests((current) => {
          const incoming = payload.data || [];
          if (mode === "replace") return sortRawConversations(incoming);
          const byId = new Map(
            current.map((item) => [conversationId(item), item]),
          );
          incoming.forEach((item) => byId.set(conversationId(item), item));
          return sortRawConversations(Array.from(byId.values()));
        });
      } finally {
        setIsLoading(false);
        setIsRefreshing(false);
      }
    },
    [apiFetch, search, workspaceId],
  );

  const hydrateConversation = useCallback(
    async (id: string) => {
      if (!workspaceId) return;
      const params = new URLSearchParams({
        workspaceId,
        conversationIds: id,
        limit: "1",
        includeChannels: "true",
      });
      const payload = await apiFetch<MobileRequestsResponse>(
        `/api/requests?${params.toString()}`,
      );
      const next = payload.data?.[0];
      if (!next?._id) return;
      setRequests((current) => {
        const byId = new Map(
          current.map((item) => [conversationId(item), item]),
        );
        byId.set(conversationId(next), next);
        return sortRawConversations(Array.from(byId.values()));
      });
    },
    [apiFetch, workspaceId],
  );

  useEffect(() => {
    void load(1, "replace");
  }, [load]);

  useEffect(() => {
    if (!workspaceId) return;
    let unsubscribe: (() => Promise<void>) | null = null;
    subscribeToRealtimeScope({
      scope: { kind: "workspace", workspaceId },
      accessToken: session?.access_token,
      onEvent: (eventName, event) => {
        if (eventName !== "conversation.row.changed") return;
        const id =
          typeof event.payload.conversationId === "string"
            ? event.payload.conversationId
            : event.conversationId;
        if (id) {
          void hydrateConversation(id);
        } else {
          void load(1, "replace");
        }
      },
    }).then((cleanup) => {
      unsubscribe = cleanup;
    });
    return () => {
      void unsubscribe?.();
    };
  }, [hydrateConversation, load, session?.access_token, workspaceId]);

  const subtitle = useMemo(() => {
    if (!selectedWorkspace) return "No workspace selected";
    return `${selectedWorkspace.name} · ${requests.length} loaded`;
  }, [requests.length, selectedWorkspace]);

  if (!selectedWorkspace) {
    return (
      <Screen>
        <WorkspaceRequired />
      </Screen>
    );
  }

  return (
    <Screen>
      <Header
        title="Requests"
        subtitle={subtitle}
        action={
          <SecondaryButton
            label="Search"
            onPress={() => void load(1, "replace")}
            disabled={isLoading}
          />
        }
      />
      <View style={styles.searchBox}>
        <TextField
          label="Search"
          value={search}
          onChangeText={setSearch}
          placeholder="Search messages or customers"
          returnKeyType="search"
          onSubmitEditing={() => void load(1, "replace")}
        />
      </View>
      {requests.length === 0 && !isLoading ? (
        <EmptyState
          title="No requests found"
          body="New customer conversations will appear here as they reach the workspace."
        />
      ) : (
        <FlatList
          data={requests}
          keyExtractor={conversationId}
          refreshControl={
            <RefreshControl
              refreshing={isRefreshing}
              onRefresh={() => void load(1, "replace")}
            />
          }
          contentContainerStyle={styles.list}
          renderItem={({ item }) => {
            const unread = item.is_read_by_manager !== true;
            return (
              <Pressable
                accessibilityRole="button"
                onPress={() =>
                  router.push({
                    pathname: "/request/[conversationId]",
                    params: { conversationId: conversationId(item) },
                  })
                }
                style={styles.row}
              >
                <View style={styles.rowTop}>
                  <View style={styles.titleLine}>
                    {unread ? <View style={styles.unreadDot} /> : null}
                    <Text numberOfLines={1} style={styles.title}>
                      {getConversationTitle(item)}
                    </Text>
                  </View>
                  <Text style={styles.time}>
                    {getConversationTimestamp(item)}
                  </Text>
                </View>
                <Text numberOfLines={2} style={styles.preview}>
                  {getConversationPreview(item)}
                </Text>
                <View style={styles.metaRow}>
                  <Text style={styles.meta}>{item.channel || "unknown"}</Text>
                  <Text style={styles.meta}>{item.status}</Text>
                  {item.classification?.category ? (
                    <Text style={styles.meta}>
                      {item.classification.category}
                    </Text>
                  ) : null}
                </View>
              </Pressable>
            );
          }}
          ListFooterComponent={
            <View style={styles.footer}>
              {isLoading ? <ActivityIndicator color="#2563EB" /> : null}
              {hasNextPage && !isLoading ? (
                <SecondaryButton
                  label="Load more"
                  onPress={() => void load(page + 1, "append")}
                />
              ) : null}
            </View>
          }
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  searchBox: {
    marginBottom: 12,
  },
  list: {
    gap: 10,
    paddingBottom: 20,
  },
  row: {
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#E2E8F0",
    backgroundColor: "#FFFFFF",
    padding: 12,
    gap: 8,
  },
  rowTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  titleLine: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
  },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#2563EB",
  },
  title: {
    flex: 1,
    color: "#0F172A",
    fontSize: 16,
    fontWeight: "800",
  },
  time: {
    color: "#64748B",
    fontSize: 12,
    fontWeight: "600",
  },
  preview: {
    color: "#475569",
    fontSize: 14,
    lineHeight: 20,
  },
  metaRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  meta: {
    overflow: "hidden",
    borderRadius: 6,
    backgroundColor: "#F1F5F9",
    color: "#334155",
    paddingHorizontal: 7,
    paddingVertical: 3,
    fontSize: 12,
    fontWeight: "700",
  },
  footer: {
    minHeight: 64,
    alignItems: "center",
    justifyContent: "center",
  },
});
