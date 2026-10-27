import type {
  ScenarioTemplateContext,
  ScenarioTemplateContextPath,
} from "./scenario-template-tokens";

const catalogPaths = [
  "first_name",
  "customer.firstName",
  "trigger.whatsappReferral.campaignName",
  "countdown",
  "countdown.hours",
  "input.name",
  "form.order.size",
] satisfies ScenarioTemplateContextPath[];

// @ts-expect-error Paths are case-sensitive, like the renderer.
const wronglyCasedPath: ScenarioTemplateContextPath = "customer.firstname";
// @ts-expect-error A group without humanized text does not render.
const calendarGroup: ScenarioTemplateContextPath = "calendar";
// @ts-expect-error A form answer names a form and one of its fields.
const formGroup: ScenarioTemplateContextPath = "form.order";

declare const context: ScenarioTemplateContext;
const answers: Readonly<Record<string, string>> = context.input;
const formAnswers: Readonly<Record<string, Readonly<Record<string, string>>>> =
  context.form;
// @ts-expect-error The context has no paths beyond the description.
const undescribed: unknown = context.customer.email;

void catalogPaths;
void wronglyCasedPath;
void calendarGroup;
void formGroup;
void answers;
void formAnswers;
void undescribed;
