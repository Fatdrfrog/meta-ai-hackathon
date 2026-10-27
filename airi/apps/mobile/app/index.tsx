import { LoadingState } from "@/components/ui";
import { useAuth } from "@/providers/auth-provider";
import { Redirect } from "expo-router";

export default function IndexRoute() {
  const { isBootstrapping, session } = useAuth();

  if (isBootstrapping) {
    return <LoadingState label="Loading airi.chat" />;
  }

  if (!session) {
    return <Redirect href="/(auth)/login" />;
  }

  return <Redirect href="/(tabs)/airi-talk" />;
}
