import {
  installBenignBrowserErrorHandlers,
  installTranslatedDomGuards,
} from "@/lib/benign-browser-errors";
import { schedulePostHogInit } from "@/lib/posthog/client";

installTranslatedDomGuards();
installBenignBrowserErrorHandlers();
schedulePostHogInit();
