import {
  EmptyState,
  Header,
  PrimaryButton,
  Screen,
  SecondaryButton,
} from "@/components/ui";
import { mobileConfig } from "@/lib/config";
import { useAuth } from "@/providers/auth-provider";
import { CheckCircle2 } from "lucide-react-native";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";

export default function SettingsScreen() {
  const {
    workspaces,
    selectedWorkspaceId,
    selectWorkspace,
    refreshWorkspaces,
    isLoadingWorkspaces,
    signOut,
    session,
  } = useAuth();

  const handleSignOut = async () => {
    await signOut();
  };

  const copy = session?.user.email || "Signed in";

  return (
    <Screen scroll>
      <Header
        title="Settings"
        subtitle={copy}
        action={
          <SecondaryButton
            label={isLoadingWorkspaces ? "Refreshing" : "Refresh"}
            onPress={() => void refreshWorkspaces()}
            disabled={isLoadingWorkspaces}
          />
        }
      />

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Workspace</Text>
        {workspaces.length === 0 ? (
          <EmptyState
            title="No workspaces"
            body="Your account does not have an active workspace yet."
          />
        ) : (
          <View style={styles.workspaceList}>
            {workspaces.map((workspace) => {
              const selected = workspace.id === selectedWorkspaceId;
              return (
                <Pressable
                  key={workspace.id}
                  accessibilityRole="button"
                  onPress={() => void selectWorkspace(workspace.id)}
                  style={[styles.workspaceRow, selected && styles.selectedRow]}
                >
                  <View style={styles.workspaceText}>
                    <Text style={styles.workspaceName}>{workspace.name}</Text>
                    <Text style={styles.workspaceId}>{workspace.id}</Text>
                  </View>
                  {selected ? (
                    <CheckCircle2 color="#2563EB" size={20} strokeWidth={2.4} />
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        )}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Runtime</Text>
        <View style={styles.infoRow}>
          <Text style={styles.infoLabel}>API</Text>
          <Text style={styles.infoValue}>{mobileConfig.apiBaseUrl}</Text>
        </View>
        <View style={styles.infoRow}>
          <Text style={styles.infoLabel}>Realtime</Text>
          <Text style={styles.infoValue}>WebSocket tokens from API</Text>
        </View>
        <View style={styles.infoRow}>
          <Text style={styles.infoLabel}>Airi voice</Text>
          <Text style={styles.infoValue}>Workspace server config</Text>
        </View>
      </View>

      <PrimaryButton
        label="Sign out"
        onPress={() => {
          Alert.alert("Sign out", "End this mobile session?", [
            { text: "Cancel", style: "cancel" },
            { text: "Sign out", style: "destructive", onPress: handleSignOut },
          ]);
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  section: {
    gap: 10,
    marginBottom: 22,
  },
  sectionTitle: {
    color: "#0F172A",
    fontSize: 15,
    fontWeight: "800",
  },
  workspaceList: {
    gap: 8,
  },
  workspaceRow: {
    minHeight: 64,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#CBD5E1",
    backgroundColor: "#FFFFFF",
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  selectedRow: {
    borderColor: "#2563EB",
    backgroundColor: "#EFF6FF",
  },
  workspaceText: {
    flex: 1,
    gap: 2,
  },
  workspaceName: {
    color: "#0F172A",
    fontSize: 15,
    fontWeight: "800",
  },
  workspaceId: {
    color: "#64748B",
    fontSize: 12,
  },
  infoRow: {
    borderRadius: 8,
    backgroundColor: "#FFFFFF",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#E2E8F0",
    padding: 12,
    gap: 4,
  },
  infoLabel: {
    color: "#64748B",
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
  },
  infoValue: {
    color: "#0F172A",
    fontSize: 14,
    fontWeight: "600",
  },
});
