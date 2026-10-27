import { PrimaryButton, Screen, TextField } from "@/components/ui";
import { mobileConfig } from "@/lib/config";
import { useAuth } from "@/providers/auth-provider";
import { Redirect } from "expo-router";
import { useState } from "react";
import { Alert, StyleSheet, Text, View } from "react-native";

export default function LoginScreen() {
  const { session, signInWithPassword } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (session) {
    return <Redirect href="/(tabs)/airi-talk" />;
  }

  const submit = async () => {
    if (!email.trim() || !password) {
      Alert.alert("Missing details", "Enter your email and password.");
      return;
    }

    setIsSubmitting(true);
    try {
      await signInWithPassword(email.trim(), password);
    } catch (error) {
      Alert.alert(
        "Sign in failed",
        error instanceof Error ? error.message : "Unable to sign in.",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Screen>
      <View style={styles.header}>
        <Text style={styles.brand}>airi.chat</Text>
        <Text style={styles.title}>Mobile companion</Text>
        <Text style={styles.subtitle}>
          Sign in with your workspace account to handle requests and use Airi
          Talk on the go.
        </Text>
      </View>

      <View style={styles.form}>
        {!mobileConfig.isConfigured ? (
          <View style={styles.configWarning}>
            <Text style={styles.configTitle}>Mobile env is incomplete</Text>
            <Text style={styles.configText}>
              Set EXPO_PUBLIC_SUPABASE_URL, EXPO_PUBLIC_SUPABASE_ANON_KEY, and
              EXPO_PUBLIC_AIRI_API_URL before signing in.
            </Text>
          </View>
        ) : null}
        <TextField
          label="Email"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          keyboardType="email-address"
          textContentType="emailAddress"
        />
        <TextField
          label="Password"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          textContentType="password"
        />
        <PrimaryButton
          label={isSubmitting ? "Signing in..." : "Sign in"}
          onPress={submit}
          disabled={isSubmitting || !mobileConfig.isConfigured}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    gap: 8,
    paddingTop: 28,
    paddingBottom: 28,
  },
  brand: {
    color: "#2563EB",
    fontSize: 16,
    fontWeight: "800",
  },
  title: {
    color: "#0F172A",
    fontSize: 34,
    fontWeight: "800",
    letterSpacing: 0,
  },
  subtitle: {
    color: "#475569",
    fontSize: 16,
    lineHeight: 23,
  },
  form: {
    gap: 16,
  },
  configWarning: {
    backgroundColor: "#FEF2F2",
    borderColor: "#FCA5A5",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    padding: 12,
    gap: 4,
  },
  configTitle: {
    color: "#991B1B",
    fontSize: 14,
    fontWeight: "700",
  },
  configText: {
    color: "#7F1D1D",
    fontSize: 13,
    lineHeight: 19,
  },
});
