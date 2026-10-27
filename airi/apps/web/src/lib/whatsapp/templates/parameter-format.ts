import {
  extractTemplateVariables,
  extractTemplateVariablesInOrder,
  type WhatsAppComponent,
  type WhatsAppComponentExample,
} from "@icecore/shared/types/whatsapp";

/**
 * Meta's template-wide `parameter_format`. Positional ({{1}}) is Meta's
 * default; named ({{first_name}}) needs `parameter_format: "NAMED"` and
 * `header_text_named_params` / `body_text_named_params` examples.
 *
 * It covers the header, body, and carousel card body texts. Link variables are
 * left out: Meta numbers them per button ({{1}}) in both formats.
 */
export type WhatsAppTemplateParameterFormat = "NAMED" | "POSITIONAL";

/** `mixed`: a number in a named template. `invalidName`: a name Meta rejects. */
export type WhatsAppTemplateVariableFormatIssue = "mixed" | "invalidName";

export type WhatsAppTemplateVariableText<Path> = {
  path: Path;
  text: string;
};

type WhatsAppTemplateNamedParam = NonNullable<
  WhatsAppComponentExample["body_text_named_params"]
>[number];

type WhatsAppTemplateComponentPath = Array<string | number>;

const POSITIONAL_VARIABLE_PATTERN = /^\d+$/;
const NAMED_VARIABLE_PATTERN = /^[a-z0-9_]+$/;

export const WHATSAPP_TEMPLATE_VARIABLE_FORMAT_ISSUE_MESSAGES: Record<
  WhatsAppTemplateVariableFormatIssue,
  string
> = {
  mixed:
    "Template variables must be all named, like {{first_name}}, or all numbered, like {{1}}",
  invalidName:
    "Named template variables can use only lowercase letters, numbers, and underscores",
};

function isPositionalVariable(variable: string): boolean {
  return POSITIONAL_VARIABLE_PATTERN.test(variable);
}

/** The format these texts' variables use, or null when they have none. */
export function getTemplateTextsParameterFormat(
  texts: string[]
): WhatsAppTemplateParameterFormat | null {
  const variables = texts.flatMap(text =>
    extractTemplateVariablesInOrder(text)
  );
  if (variables.length === 0) return null;
  return variables.every(isPositionalVariable) ? "POSITIONAL" : "NAMED";
}

/**
 * The sample Meta needs for one header or body text: by name for named
 * variables, by position for numbered ones. A named sample already on hand
 * (from `namedExamples`) wins over the generated one.
 */
export function buildWhatsAppTemplateTextExample(params: {
  text: string;
  kind: "header" | "body";
  sample: (variable: string, index: number) => string;
  namedExamples?: Record<string, string>;
}): WhatsAppComponentExample | undefined {
  if (getTemplateTextsParameterFormat([params.text]) === "NAMED") {
    const namedParams = extractTemplateVariablesInOrder(params.text).map(
      (variable, index) => ({
        param_name: variable,
        example:
          params.namedExamples?.[variable]?.trim() ||
          params.sample(variable, index),
      })
    );
    return params.kind === "header"
      ? { header_text_named_params: namedParams }
      : { body_text_named_params: namedParams };
  }

  const variables = extractTemplateVariables(params.text);
  if (variables.length === 0) return undefined;
  const samples = variables.map(params.sample);
  return params.kind === "header"
    ? { header_text: samples }
    : { body_text: [samples] };
}

/** Each text whose variables break the template's format, with the reason. */
export function getTemplateVariableFormatIssues<Path>(
  texts: WhatsAppTemplateVariableText<Path>[]
): Array<{ path: Path; issue: WhatsAppTemplateVariableFormatIssue }> {
  const format = getTemplateTextsParameterFormat(texts.map(({ text }) => text));
  if (format !== "NAMED") return [];

  return texts.flatMap<{
    path: Path;
    issue: WhatsAppTemplateVariableFormatIssue;
  }>(({ path, text }) => {
    const variables = extractTemplateVariablesInOrder(text);
    if (variables.some(isPositionalVariable)) {
      return [{ path, issue: "mixed" }];
    }
    if (variables.some(variable => !NAMED_VARIABLE_PATTERN.test(variable))) {
      return [{ path, issue: "invalidName" }];
    }
    return [];
  });
}

function collectWhatsAppTemplateParameterTexts(
  components: WhatsAppComponent[]
): WhatsAppTemplateVariableText<WhatsAppTemplateComponentPath>[] {
  const texts: WhatsAppTemplateVariableText<WhatsAppTemplateComponentPath>[] =
    [];
  components.forEach((component, componentIndex) => {
    if (component.type === "HEADER" && component.format === "TEXT") {
      texts.push({
        path: [componentIndex, "text"],
        text: component.text || "",
      });
    }
    if (component.type === "BODY") {
      texts.push({
        path: [componentIndex, "text"],
        text: component.text || "",
      });
    }
    if (component.type === "CAROUSEL") {
      component.cards.forEach((card, cardIndex) => {
        card.components.forEach((cardComponent, cardComponentIndex) => {
          if (cardComponent.type !== "BODY") return;
          texts.push({
            path: [
              componentIndex,
              "cards",
              cardIndex,
              "components",
              cardComponentIndex,
              "text",
            ],
            text: cardComponent.text,
          });
        });
      });
    }
  });
  return texts;
}

export function getWhatsAppTemplateParameterFormat(
  components: WhatsAppComponent[]
): WhatsAppTemplateParameterFormat | null {
  return getTemplateTextsParameterFormat(
    collectWhatsAppTemplateParameterTexts(components).map(({ text }) => text)
  );
}

export function getWhatsAppTemplateVariableFormatIssues(
  components: WhatsAppComponent[]
) {
  return getTemplateVariableFormatIssues(
    collectWhatsAppTemplateParameterTexts(components)
  );
}

/**
 * The samples Meta holds for named variables, by name. Header, body, and card
 * bodies share one map: a name means the same value wherever it appears.
 */
export function readWhatsAppTemplateNamedParamExamples(
  components: WhatsAppComponent[] | null | undefined
): Record<string, string> {
  const examples: Record<string, string> = {};
  const add = (params: WhatsAppTemplateNamedParam[] | undefined) => {
    params?.forEach(param => {
      const name = param.param_name?.trim();
      const example = param.example?.trim();
      if (name && example && !(name in examples)) examples[name] = example;
    });
  };

  components?.forEach(component => {
    if (component.type === "HEADER") {
      add(component.example?.header_text_named_params);
    }
    if (component.type === "BODY") {
      add(component.example?.body_text_named_params);
    }
    if (component.type === "CAROUSEL") {
      component.cards.forEach(card =>
        card.components.forEach(cardComponent => {
          if (cardComponent.type === "BODY") {
            add(cardComponent.example?.body_text_named_params);
          }
        })
      );
    }
  });
  return examples;
}

/**
 * Meta's sample value for each of the template's variables, by name: named
 * samples, then positional samples for the body and a text header. A body
 * sample wins when the header reuses a positional name, as both fill the same
 * send value.
 */
export function readWhatsAppTemplateExampleValues(
  components: WhatsAppComponent[] | null | undefined
): Record<string, string> {
  const values = readWhatsAppTemplateNamedParamExamples(components);
  const addPositional = (
    text: string | undefined,
    samples: string[] | undefined
  ) => {
    extractTemplateVariablesInOrder(text ?? "")
      .filter(isPositionalVariable)
      .forEach((variable, index) => {
        const sample = samples?.[index]?.trim();
        if (sample && !(variable in values)) values[variable] = sample;
      });
  };
  const body = components?.find(component => component.type === "BODY");
  if (body?.type === "BODY") {
    addPositional(body.text, body.example?.body_text?.[0]);
  }
  const header = components?.find(component => component.type === "HEADER");
  if (header?.type === "HEADER" && header.format === "TEXT") {
    addPositional(header.text, header.example?.header_text);
  }
  return values;
}
