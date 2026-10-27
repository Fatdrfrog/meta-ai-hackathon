import { getRequestConfig } from "next-intl/server";
import { getLocaleFromCookie, loadAllMessages } from "./message-loader";

export default getRequestConfig(async () => {
  const locale = await getLocaleFromCookie();

  return {
    locale,
    messages: await loadAllMessages(locale),
  };
});
