import {
  WHATSAPP_TEMPLATE_VARIABLE_FORMAT_ISSUE_MESSAGES,
  getWhatsAppTemplateVariableFormatIssues,
} from "@/lib/whatsapp/templates/parameter-format";
import { WHATSAPP_TEMPLATE_LIMITS } from "@icecore/shared/constants/whatsapp-templates";
import { pickWhatsAppTemplateFlowIdentifier } from "@icecore/shared/types/whatsapp-flows";
import type {
  WhatsAppComponent,
  WhatsAppTemplateCategory,
} from "@icecore/shared/types/whatsapp";
import { z } from "zod";

export const WHATSAPP_TEMPLATE_BUTTON_TYPES = [
  "QUICK_REPLY",
  "URL",
  "PHONE_NUMBER",
  "FLOW",
  "OTP",
  "REQUEST_CONTACT_INFO",
] as const;

const WHATSAPP_TEMPLATE_FLOW_ACTIONS = ["navigate", "data_exchange"] as const;
const WHATSAPP_TEMPLATE_OTP_TYPES = [
  "COPY_CODE",
  "ONE_TAP",
  "ZERO_TAP",
] as const;

export type WhatsAppTemplateButtonValidationMessages = {
  buttonTextRequired: string;
  buttonTextMax: string;
  invalidUrl: string;
  urlRequired: string;
  phoneRequired: string;
  flowRequired: string;
  flowNavigateScreenRequired: string;
  maxButtons: string;
  maxOneFlowButton: string;
  maxOnePhoneButton: string;
  maxTwoUrlButtons: string;
};

export type WhatsAppTemplateComponentSchemaOptions = {
  requireFlowNavigateScreen?: boolean;
  requireMediaHeaderExample?: boolean;
  allowAuthenticationFields?: boolean;
};

const DEFAULT_BUTTON_MESSAGES: WhatsAppTemplateButtonValidationMessages = {
  buttonTextRequired: "Button text is required",
  buttonTextMax: `Max ${WHATSAPP_TEMPLATE_LIMITS.BUTTON_TEXT_MAX_LENGTH} characters`,
  invalidUrl: "Enter a valid URL",
  urlRequired: "URL is required",
  phoneRequired: "Phone number is required",
  flowRequired: "Flow is required",
  flowNavigateScreenRequired: "Navigate screen is required",
  maxButtons: `Only ${WHATSAPP_TEMPLATE_LIMITS.BUTTONS_MAX_COUNT} buttons are allowed`,
  maxOneFlowButton: "Only one Flow button is allowed",
  maxOnePhoneButton: "Only one phone button is allowed",
  maxTwoUrlButtons: "Only two URL buttons are allowed",
};

const optionalText = z.string().optional();
const trimmedOptionalText = z.preprocess(
  value => (typeof value === "string" ? value.trim() : value),
  z.string().optional()
);
const clientId = z.string().optional();

function countButtonsOfType(buttons: Array<{ type: string }>, type: string) {
  return buttons.filter(button => button.type === type).length;
}

function normalizedMessages(
  messages?: Partial<WhatsAppTemplateButtonValidationMessages>
): WhatsAppTemplateButtonValidationMessages {
  return { ...DEFAULT_BUTTON_MESSAGES, ...(messages || {}) };
}

function requiredTrimmedText(message: string) {
  return z.preprocess(
    value => (typeof value === "string" ? value : ""),
    z.string().trim().min(1, message)
  );
}

function normalizeTemplateUrlForValidation(value: string): string {
  return value.replace(/\{\{\s*[A-Za-z0-9_]+\s*\}\}/g, "sample");
}

export function isValidWhatsAppTemplateUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;

  try {
    const parsed = new URL(normalizeTemplateUrlForValidation(trimmed));
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isAuthenticationReadbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      ["www.whatsapp.com", "whatsapp.com"].includes(url.hostname) &&
      /^\/otp\/code\/?$/.test(url.pathname) &&
      WHATSAPP_TEMPLATE_OTP_TYPES.some(
        type => type === url.searchParams.get("otp_type")
      )
    );
  } catch {
    return false;
  }
}

function buttonTextSchema(messages: WhatsAppTemplateButtonValidationMessages) {
  return z.preprocess(
    value => (typeof value === "string" ? value : ""),
    z
      .string()
      .trim()
      .min(1, messages.buttonTextRequired)
      .max(
        WHATSAPP_TEMPLATE_LIMITS.BUTTON_TEXT_MAX_LENGTH,
        messages.buttonTextMax
      )
  );
}

function urlTextSchema(messages: WhatsAppTemplateButtonValidationMessages) {
  return requiredTrimmedText(messages.urlRequired)
    .pipe(z.string().max(WHATSAPP_TEMPLATE_LIMITS.BUTTON_URL_MAX_LENGTH))
    .refine(isValidWhatsAppTemplateUrl, messages.invalidUrl);
}

function createWhatsAppTemplateButtonSchema(
  messages?: Partial<WhatsAppTemplateButtonValidationMessages>,
  options: WhatsAppTemplateComponentSchemaOptions = {}
) {
  const resolvedMessages = normalizedMessages(messages);
  const requireFlowNavigateScreen = options.requireFlowNavigateScreen !== false;
  const text = buttonTextSchema(resolvedMessages);

  return z
    .discriminatedUnion("type", [
      z.object({
        clientId,
        type: z.literal("QUICK_REPLY"),
        text,
        url: optionalText,
        phone_number: optionalText,
        flow_id: optionalText,
        flow_action: z.enum(WHATSAPP_TEMPLATE_FLOW_ACTIONS).optional(),
        navigate_screen: optionalText,
        example: z.array(z.string()).optional(),
      }),
      z.object({
        clientId,
        type: z.literal("URL"),
        text,
        url: urlTextSchema(resolvedMessages),
        phone_number: optionalText,
        flow_id: optionalText,
        flow_action: z.enum(WHATSAPP_TEMPLATE_FLOW_ACTIONS).optional(),
        navigate_screen: optionalText,
        example: z.array(z.string()).optional(),
      }),
      z.object({
        clientId,
        type: z.literal("PHONE_NUMBER"),
        text,
        url: optionalText,
        phone_number: requiredTrimmedText(resolvedMessages.phoneRequired),
        flow_id: optionalText,
        flow_action: z.enum(WHATSAPP_TEMPLATE_FLOW_ACTIONS).optional(),
        navigate_screen: optionalText,
      }),
      z.object({
        clientId,
        type: z.literal("FLOW"),
        text,
        url: optionalText,
        phone_number: optionalText,
        flow_id: trimmedOptionalText,
        flow_name: trimmedOptionalText,
        flow_json: trimmedOptionalText,
        flow_action: z.enum(WHATSAPP_TEMPLATE_FLOW_ACTIONS).default("navigate"),
        navigate_screen: z.string().trim().optional(),
      }),
      z.object({
        clientId,
        type: z.literal("OTP"),
        text: z.preprocess(
          value =>
            typeof value === "string" ? value.trim() || undefined : value,
          z.string().max(25).optional()
        ),
        otp_type: z.enum(WHATSAPP_TEMPLATE_OTP_TYPES).default("COPY_CODE"),
        autofill_text: z.string().trim().optional(),
        package_name: z.string().trim().optional(),
        signature_hash: z.string().trim().optional(),
        supported_apps: z
          .array(
            z.object({
              package_name: z.string().trim().min(1),
              signature_hash: z.string().trim().min(1),
            })
          )
          .min(1)
          .optional(),
        zero_tap_terms_accepted: z.boolean().optional(),
      }),
      z.object({
        clientId,
        type: z.literal("REQUEST_CONTACT_INFO"),
        text: optionalText,
        url: optionalText,
        phone_number: optionalText,
        flow_id: optionalText,
        flow_action: z.enum(WHATSAPP_TEMPLATE_FLOW_ACTIONS).optional(),
        navigate_screen: optionalText,
      }),
    ])
    .superRefine((button, ctx) => {
      if (button.type === "OTP" && button.otp_type !== "COPY_CODE") {
        if (
          !button.supported_apps?.length &&
          !(button.package_name && button.signature_hash)
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "Autofill authentication requires an Android app package and signature",
            path: ["supported_apps"],
          });
        }
        if (
          button.otp_type === "ZERO_TAP" &&
          button.zero_tap_terms_accepted !== true
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Zero-tap authentication requires accepted terms",
            path: ["zero_tap_terms_accepted"],
          });
        }
      }
      if (button.type === "FLOW") {
        if (
          !pickWhatsAppTemplateFlowIdentifier({
            flow_id: button.flow_id,
            flow_name: button.flow_name,
            flow_json: button.flow_json,
          })
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: resolvedMessages.flowRequired,
            path: ["flow_id"],
          });
        }
      }
      if (
        requireFlowNavigateScreen &&
        button.type === "FLOW" &&
        button.flow_action === "navigate" &&
        !button.navigate_screen?.trim()
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: resolvedMessages.flowNavigateScreenRequired,
          path: ["navigate_screen"],
        });
      }
    });
}

export function createWhatsAppTemplateButtonsSchema(
  messages?: Partial<WhatsAppTemplateButtonValidationMessages>,
  options: WhatsAppTemplateComponentSchemaOptions = {}
) {
  const resolvedMessages = normalizedMessages(messages);
  return z
    .array(createWhatsAppTemplateButtonSchema(resolvedMessages, options))
    .max(
      WHATSAPP_TEMPLATE_LIMITS.BUTTONS_MAX_COUNT,
      resolvedMessages.maxButtons
    )
    .superRefine((buttons, ctx) => {
      const typedButtons = buttons as Array<{ type: string }>;
      if (countButtonsOfType(typedButtons, "FLOW") > 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: resolvedMessages.maxOneFlowButton,
          path: [],
        });
      }
      if (countButtonsOfType(typedButtons, "PHONE_NUMBER") > 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: resolvedMessages.maxOnePhoneButton,
          path: [],
        });
      }
      if (countButtonsOfType(typedButtons, "URL") > 2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: resolvedMessages.maxTwoUrlButtons,
          path: [],
        });
      }
    });
}

export function createWhatsAppTemplateButtonTypeLimitSchema(
  messages?: Partial<WhatsAppTemplateButtonValidationMessages>
) {
  const resolvedMessages = normalizedMessages(messages);
  return z
    .array(
      z.object({
        type: z.enum(WHATSAPP_TEMPLATE_BUTTON_TYPES),
      })
    )
    .max(
      WHATSAPP_TEMPLATE_LIMITS.BUTTONS_MAX_COUNT,
      resolvedMessages.maxButtons
    )
    .superRefine((buttons, ctx) => {
      if (countButtonsOfType(buttons, "FLOW") > 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: resolvedMessages.maxOneFlowButton,
          path: [],
        });
      }
      if (countButtonsOfType(buttons, "PHONE_NUMBER") > 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: resolvedMessages.maxOnePhoneButton,
          path: [],
        });
      }
      if (countButtonsOfType(buttons, "URL") > 2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: resolvedMessages.maxTwoUrlButtons,
          path: [],
        });
      }
    });
}

export const whatsappComponentExampleSchema = z
  .object({
    header_handle: z.array(z.string().trim().max(2048)).optional(),
    header_text: z.array(z.string().trim().max(120)).optional(),
    header_text_named_params: z
      .array(
        z.object({
          param_name: z.string().optional(),
          example: z.string().optional(),
        })
      )
      .optional(),
    body_text: z.array(z.array(z.string().trim().max(240))).optional(),
    body_text_named_params: z
      .array(
        z.object({
          param_name: z.string().optional(),
          example: z.string().optional(),
        })
      )
      .optional(),
    button_text: z.array(z.string().trim().max(25)).optional(),
    button_url: z.array(z.string().trim().max(2048)).optional(),
    button_phone_number: z.array(z.string().trim().max(32)).optional(),
  })
  .passthrough();

function hasHeaderHandleExample(example: unknown): boolean {
  if (!example || typeof example !== "object") return false;
  const headerHandle = (example as { header_handle?: unknown }).header_handle;
  return (
    Array.isArray(headerHandle) &&
    headerHandle.some(value => typeof value === "string" && value.trim())
  );
}

export function createWhatsAppComponentSchema(
  messages?: Partial<WhatsAppTemplateButtonValidationMessages>,
  options: WhatsAppTemplateComponentSchemaOptions = {}
): z.ZodType<WhatsAppComponent> {
  const requireMediaHeaderExample = options.requireMediaHeaderExample !== false;
  const carouselButtonSchema = z.discriminatedUnion("type", [
    z.object({
      type: z.literal("QUICK_REPLY"),
      text: buttonTextSchema(normalizedMessages(messages)),
      example: z.array(z.string()).optional(),
    }),
    z.object({
      type: z.literal("URL"),
      text: buttonTextSchema(normalizedMessages(messages)),
      url: urlTextSchema(normalizedMessages(messages)),
      example: z.array(z.string()).optional(),
    }),
    z.object({
      type: z.literal("PHONE_NUMBER"),
      text: buttonTextSchema(normalizedMessages(messages)),
      phone_number: requiredTrimmedText(
        normalizedMessages(messages).phoneRequired
      ),
    }),
  ]);
  const carouselCardSchema = z.object({
    components: z
      .array(
        z.union([
          z.object({
            type: z.literal("HEADER"),
            format: z.enum(["IMAGE", "VIDEO"]),
            example: whatsappComponentExampleSchema.optional(),
          }),
          z.object({
            type: z.literal("BODY"),
            text: z
              .string()
              .min(1)
              .max(WHATSAPP_TEMPLATE_LIMITS.CAROUSEL_CARD_BODY_MAX_LENGTH),
            example: whatsappComponentExampleSchema.optional(),
          }),
          z.object({
            type: z.literal("BUTTONS"),
            buttons: z
              .array(carouselButtonSchema)
              .min(1)
              .max(WHATSAPP_TEMPLATE_LIMITS.CAROUSEL_CARD_BUTTONS_MAX_COUNT),
          }),
        ])
      )
      .min(1),
  });

  return z
    .discriminatedUnion("type", [
      z.object({
        type: z.literal("HEADER"),
        format: z.enum(["TEXT", "IMAGE", "VIDEO", "DOCUMENT", "LOCATION"]),
        text: z
          .string()
          .max(WHATSAPP_TEMPLATE_LIMITS.HEADER_MAX_LENGTH)
          .optional(),
        example: whatsappComponentExampleSchema.optional(),
      }),
      z.object({
        type: z.literal("BODY"),
        text: options.allowAuthenticationFields
          ? z
              .string()
              .min(1)
              .max(WHATSAPP_TEMPLATE_LIMITS.BODY_MAX_LENGTH)
              .optional()
          : z.string().min(1).max(WHATSAPP_TEMPLATE_LIMITS.BODY_MAX_LENGTH),
        example: whatsappComponentExampleSchema.optional(),
        add_security_recommendation: z.boolean().optional(),
      }),
      z.object({
        type: z.literal("FOOTER"),
        text: options.allowAuthenticationFields
          ? z
              .string()
              .min(1)
              .max(WHATSAPP_TEMPLATE_LIMITS.FOOTER_MAX_LENGTH)
              .optional()
          : z.string().min(1).max(WHATSAPP_TEMPLATE_LIMITS.FOOTER_MAX_LENGTH),
        code_expiration_minutes: z.number().int().min(1).max(90).optional(),
      }),
      z.object({
        type: z.literal("BUTTONS"),
        buttons: createWhatsAppTemplateButtonsSchema(messages, options),
      }),
      z.object({
        type: z.literal("CAROUSEL"),
        cards: z
          .array(carouselCardSchema)
          .min(WHATSAPP_TEMPLATE_LIMITS.CAROUSEL_CARDS_MIN)
          .max(WHATSAPP_TEMPLATE_LIMITS.CAROUSEL_CARDS_MAX),
      }),
    ])
    .superRefine((component, ctx) => {
      if (component.type === "HEADER") {
        if (component.format === "TEXT" && !component.text?.trim()) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Header text is required for text headers",
            path: ["text"],
          });
        }

        if (
          requireMediaHeaderExample &&
          ["IMAGE", "VIDEO", "DOCUMENT"].includes(component.format) &&
          !hasHeaderHandleExample(component.example)
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Media header example is required",
            path: ["example", "header_handle"],
          });
        }
      }

      if (component.type === "CAROUSEL") {
        const headerFormats = new Set<string>();
        const buttonShapes: string[] = [];
        component.cards.forEach((card, cardIndex) => {
          const typeCounts = new Map<string, number>();
          for (const item of card.components) {
            typeCounts.set(item.type, (typeCounts.get(item.type) || 0) + 1);
          }
          for (const duplicateType of ["HEADER", "BODY", "BUTTONS"] as const) {
            if ((typeCounts.get(duplicateType) || 0) > 1) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `Carousel cards cannot repeat ${duplicateType} components`,
                path: ["cards", cardIndex, "components"],
              });
            }
          }
          const header = card.components.find(item => item.type === "HEADER");
          const buttons = card.components.find(item => item.type === "BUTTONS");
          if (!header || header.type !== "HEADER") {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "Carousel cards require an image or video header",
              path: ["cards", cardIndex, "components"],
            });
          } else {
            headerFormats.add(header.format);
            if (
              requireMediaHeaderExample &&
              !hasHeaderHandleExample(header.example)
            ) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "Media header example is required",
                path: ["cards", cardIndex, "components"],
              });
            }
          }
          const body = card.components.find(item => item.type === "BODY");
          if (!body || body.type !== "BODY" || !body.text.trim()) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "Carousel cards require body text",
              path: ["cards", cardIndex, "components"],
            });
          }
          if (
            !buttons ||
            buttons.type !== "BUTTONS" ||
            buttons.buttons.length === 0
          ) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "Carousel cards require at least one button",
              path: ["cards", cardIndex, "components"],
            });
          } else {
            buttonShapes.push(
              buttons.buttons.map(button => button.type).join(",")
            );
          }
        });
        if (headerFormats.size > 1) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Carousel card header formats must match",
            path: ["cards"],
          });
        }
        if (new Set(buttonShapes).size > 1) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Carousel card button types must match",
            path: ["cards"],
          });
        }
      }
    }) as z.ZodType<WhatsAppComponent>;
}

export function createWhatsAppComponentsSchema(
  messages?: Partial<WhatsAppTemplateButtonValidationMessages>,
  options: WhatsAppTemplateComponentSchemaOptions = {}
) {
  return z.array(createWhatsAppComponentSchema(messages, options));
}

export function getFirstZodIssueMessage(
  error: z.ZodError,
  fallback = "Invalid value"
) {
  return error.issues[0]?.message || fallback;
}

export function createWhatsAppTemplateSubmissionComponentsSchema(
  category?: WhatsAppTemplateCategory
) {
  return createWhatsAppComponentsSchema(undefined, {
    allowAuthenticationFields: true,
  })
    .min(1, "At least one template component is required")
    .superRefine((components, ctx) => {
      const hasOtp = components.some(
        component =>
          component.type === "BUTTONS" &&
          component.buttons.some(button => button.type === "OTP")
      );
      const authentication =
        category === "AUTHENTICATION" || (category === undefined && hasOtp);
      const issue = (message: string, path: Array<string | number>) =>
        ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
      components.forEach((component, index) => {
        if (component.type !== "BUTTONS") return;
        component.buttons.forEach((button, buttonIndex) => {
          if (button.type === "URL" && isAuthenticationReadbackUrl(button.url))
            issue(
              "Meta authentication readback URLs must be converted to an OTP definition before submission",
              [index, "buttons", buttonIndex]
            );
        });
      });
      if (authentication) {
        if (
          components.filter(component => component.type === "BODY").length !==
            1 ||
          components.filter(component => component.type === "FOOTER").length >
            1 ||
          components.filter(component => component.type === "BUTTONS")
            .length !== 1
        ) {
          issue(
            "Authentication templates require one preset body, one OTP button, and at most one expiry footer",
            []
          );
        }
        components.forEach((component, index) => {
          if (component.type === "BODY") {
            if (component.text !== undefined || component.example !== undefined)
              issue(
                "Authentication body text and examples are generated by Meta",
                [index]
              );
          } else if (component.type === "FOOTER") {
            if (
              component.text !== undefined ||
              component.code_expiration_minutes === undefined
            )
              issue(
                "Authentication footers must define an expiry warning instead of custom text",
                [index]
              );
          } else if (component.type === "BUTTONS") {
            if (
              component.buttons.length !== 1 ||
              component.buttons[0]?.type !== "OTP"
            )
              issue("Authentication templates require exactly one OTP button", [
                index,
                "buttons",
              ]);
          } else
            issue(
              "Authentication templates support only preset body, expiry footer, and OTP button components",
              [index]
            );
        });
        return;
      }
      components.forEach((component, index) => {
        if (
          component.type === "BODY" &&
          (!component.text ||
            component.add_security_recommendation !== undefined)
        )
          issue(
            "Non-authentication templates require custom body text without authentication options",
            [index]
          );
        if (
          component.type === "FOOTER" &&
          (!component.text || component.code_expiration_minutes !== undefined)
        )
          issue(
            "Non-authentication footers require text without authentication options",
            [index]
          );
        if (
          component.type === "BUTTONS" &&
          component.buttons.some(button => button.type === "OTP")
        )
          issue("OTP buttons require the AUTHENTICATION category", [
            index,
            "buttons",
          ]);
      });
      for (const { path, issue } of getWhatsAppTemplateVariableFormatIssues(
        components
      )) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: WHATSAPP_TEMPLATE_VARIABLE_FORMAT_ISSUE_MESSAGES[issue],
          path,
        });
      }
    });
}

export function parseWhatsAppTemplateSubmissionComponents(
  components: unknown,
  category?: WhatsAppTemplateCategory
) {
  return createWhatsAppTemplateSubmissionComponentsSchema(category).safeParse(
    components
  );
}

export function getWhatsAppTemplateComponentsErrorMessage(error: z.ZodError) {
  return `Invalid WhatsApp template components: ${getFirstZodIssueMessage(
    error,
    "Invalid template components"
  )}`;
}
