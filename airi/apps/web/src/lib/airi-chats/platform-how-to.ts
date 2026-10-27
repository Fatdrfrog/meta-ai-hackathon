const PLATFORM_CHANNEL_RE =
  /whatsapp|вотсап|ватсап|вацап|waba|telegram|телеграм|instagram|инстаграм|e-?mail|почт/i;
const PLATFORM_CONNECT_RE =
  /connect|reconnect|подключ|добав|интеграц|байлан|улаш|ulash|ulang|onboard|setup|настро|привяз/i;
const PLATFORM_HOW_TO_RE =
  /how\s+to|how\s+do\s+i|как\s+(подключ|настро|интегр|добав|сделать)|қалай|qanday/i;
const PLATFORM_REGISTER_RE =
  /регистрац|register|signup|sign[\s-]?up|embedded\s+signup|onboard/i;
const PLATFORM_PRODUCT_RE = /airi\.chat|airi\s*chat|\bairi\b/i;
const PRODUCT_NAME_RE = /airi\.chat|airi\s*chat/i;
const PLATFORM_MESSENGER_RE = /messenger|мессенджер/i;
const WEAK_PLATFORM_HOW_TO_RE =
  /how\s+(to|do\s+i|does|can)|как\s|қалай|qanday|connect|подключ|интеграц|onboard|setup|настро|trial|pricing|цен[аы]|тариф/i;
const CREATE_CHANNEL_ARTIFACT_RE =
  /(create|draft|build|edit|continue|update|сделай|сделать|создай|создать|нарисуй|измени|продолж).{0,48}(flow|template|шаблон|флоу|campaign|кампан|scenario|сценари|lead[-\s]?form)/i;
const TENANT_CUSTOMER_RE =
  /клиент|покупател|customer|lead\s+form|для\s+(клиент|покупател)/i;

export function isAiriPlatformHowToRequest(userMessage: string): boolean {
  const text = userMessage.trim();
  if (!text) return false;
  if (CREATE_CHANNEL_ARTIFACT_RE.test(text)) return false;

  const hasChannel = PLATFORM_CHANNEL_RE.test(text);
  if (
    hasChannel &&
    (PLATFORM_CONNECT_RE.test(text) ||
      PLATFORM_HOW_TO_RE.test(text) ||
      (PLATFORM_REGISTER_RE.test(text) && !TENANT_CUSTOMER_RE.test(text)))
  ) {
    return true;
  }

  return (
    PLATFORM_PRODUCT_RE.test(text) &&
    (PLATFORM_CONNECT_RE.test(text) ||
      PLATFORM_HOW_TO_RE.test(text) ||
      PLATFORM_REGISTER_RE.test(text) ||
      /what can|что (умеет|может)|неге болады/i.test(text))
  );
}

export function isAiriPlatformQuestionSafetyNet(userMessage: string): boolean {
  const text = userMessage.trim();
  if (!text) return false;
  if (CREATE_CHANNEL_ARTIFACT_RE.test(text)) return false;
  if (isAiriPlatformHowToRequest(text)) return true;
  if (PRODUCT_NAME_RE.test(text)) return true;
  if (TENANT_CUSTOMER_RE.test(text)) return false;

  const hasMessenger =
    PLATFORM_CHANNEL_RE.test(text) || PLATFORM_MESSENGER_RE.test(text);
  return hasMessenger && WEAK_PLATFORM_HOW_TO_RE.test(text);
}

export function shouldRerouteEmptyTenantToProductKb(params: {
  intent: string;
  userMessage: string;
  tenantHasKbOrChats: boolean;
  hasSelectedSources: boolean;
}): boolean {
  if (params.intent !== "general_answer") return false;
  if (params.hasSelectedSources) return false;
  if (params.tenantHasKbOrChats) return false;
  return isAiriPlatformQuestionSafetyNet(params.userMessage);
}
