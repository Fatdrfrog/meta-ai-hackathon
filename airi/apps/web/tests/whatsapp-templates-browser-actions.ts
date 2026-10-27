// Only the server-action HTTP boundary is replaced. The manager, table,
// editor, catalog client, design system and translations are real.
async function action(operation: string, input: unknown) {
  const response = await fetch("/__browser/templates/actions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operation, input }),
  });
  return response.json();
}
export const getUnifiedTemplatesAction = (input: unknown) =>
  action("list", input);
export const syncTemplatesAction = (input: unknown) => action("sync", input);
export const createUnifiedTemplateAction = (input: unknown) =>
  action("create", input);
export const updateUnifiedTemplateAction = (input: unknown) =>
  action("updateUnified", input);
export const updateTemplateAction = (input: unknown) => action("update", input);
export const deleteTemplateAction = (input: unknown) => action("delete", input);
export const deleteUnifiedTemplateAction = (input: unknown) =>
  action("deleteUnified", input);
export const switchUnifiedTemplateToCurrentWabaAction = (input: unknown) =>
  action("switch", input);
