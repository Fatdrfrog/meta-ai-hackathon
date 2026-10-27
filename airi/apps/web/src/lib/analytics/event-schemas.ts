/**
 * Event Schema Validation
 *
 * Defines required properties and types for widget analytics events
 */

export interface EventSchema {
  requiredProperties: string[];
  propertyTypes: Record<string, "string" | "number" | "boolean" | "array">;
}

/**
 * Event schemas for widget analytics events
 */
export const WIDGET_EVENT_SCHEMAS: Record<string, EventSchema> = {
  widget_pageview: {
    requiredProperties: ["visitor_id", "page_url"],
    propertyTypes: {
      visitor_id: "string",
      page_url: "string",
      session_id: "string",
      page_title: "string",
      page_referrer: "string",
      session_page_number: "number",
    },
  },
  widget_session_start: {
    requiredProperties: ["visitor_id", "session_id"],
    propertyTypes: {
      visitor_id: "string",
      session_id: "string",
    },
  },
  widget_session_end: {
    requiredProperties: [
      "visitor_id",
      "session_id",
      "duration_ms",
      "page_count",
    ],
    propertyTypes: {
      visitor_id: "string",
      session_id: "string",
      duration_ms: "number",
      page_count: "number",
    },
  },
  widget_performance: {
    requiredProperties: ["visitor_id", "page_url"],
    propertyTypes: {
      visitor_id: "string",
      page_url: "string",
      page_load_time: "number",
      dns_time: "number",
      tcp_time: "number",
      ttfb: "number",
      dom_interactive: "number",
      dom_complete: "number",
    },
  },
  widget_web_vital_lcp: {
    requiredProperties: ["visitor_id", "value", "page_url"],
    propertyTypes: {
      visitor_id: "string",
      value: "number",
      page_url: "string",
    },
  },
  widget_web_vital_fid: {
    requiredProperties: ["visitor_id", "value", "page_url"],
    propertyTypes: {
      visitor_id: "string",
      value: "number",
      page_url: "string",
    },
  },
  widget_web_vital_cls: {
    requiredProperties: ["visitor_id", "value", "page_url"],
    propertyTypes: {
      visitor_id: "string",
      value: "number",
      page_url: "string",
    },
  },
  widget_scroll_depth: {
    requiredProperties: ["visitor_id", "depth_percentage", "page_url"],
    propertyTypes: {
      visitor_id: "string",
      depth_percentage: "number",
      page_url: "string",
    },
  },
  widget_page_visible_time: {
    requiredProperties: ["visitor_id", "duration_ms", "page_url"],
    propertyTypes: {
      visitor_id: "string",
      duration_ms: "number",
      page_url: "string",
    },
  },
  widget_message_send: {
    requiredProperties: ["visitor_id", "page_url"],
    propertyTypes: {
      visitor_id: "string",
      page_url: "string",
      session_id: "string",
      conversation_started: "boolean",
      has_media: "boolean",
      media_type: "string",
    },
  },
  widget_error: {
    requiredProperties: ["visitor_id", "error_type", "page_url"],
    propertyTypes: {
      visitor_id: "string",
      error_type: "string",
      page_url: "string",
      session_id: "string",
      has_media: "boolean",
      media_type: "string",
    },
  },
};

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
}

/**
 * Validate an event against its schema
 */
export function validateEvent(
  eventName: string,
  properties: Record<string, unknown>
): ValidationResult {
  const schema = WIDGET_EVENT_SCHEMAS[eventName];

  // If no schema defined, skip validation (unknown event types)
  if (!schema) {
    return { isValid: true, errors: [] };
  }

  const errors: string[] = [];

  // Check required properties
  for (const requiredProp of schema.requiredProperties) {
    if (
      !(requiredProp in properties) ||
      properties[requiredProp] === undefined ||
      properties[requiredProp] === null
    ) {
      errors.push(`Missing required property: ${requiredProp}`);
    }
  }

  // Check property types (only for properties that exist)
  for (const [propName, expectedType] of Object.entries(schema.propertyTypes)) {
    if (
      propName in properties &&
      properties[propName] !== undefined &&
      properties[propName] !== null
    ) {
      const actualValue = properties[propName];
      const actualType = Array.isArray(actualValue)
        ? "array"
        : typeof actualValue;

      if (actualType !== expectedType) {
        errors.push(
          `Property ${propName} has type ${actualType}, expected ${expectedType}`
        );
      }
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}
