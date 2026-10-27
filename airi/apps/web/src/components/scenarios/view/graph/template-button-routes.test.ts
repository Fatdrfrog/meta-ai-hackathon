/**
 * Regression (fix/template-button-routes): a WhatsApp template's reply-button
 * routes must stay with their buttons when the author removes a button.
 *
 * Today a route is keyed by the button's position in the template
 * (`right-source-whatsapp-template-button-branch::<position>`), and branch
 * sync keeps every edge on its old position. Removing a button therefore
 * hands the next button the removed button's follow-up, and the route that
 * falls off the end is dropped.
 *
 * Each test connects routes and removes the button through the builder's own
 * code; see template-button-route-test-utils.ts.
 */
import {
  buildTemplateRouteGraph,
  buttonBoundToFollowUp,
  followUpsOfButton,
  quickReply,
  removeTemplateButtonAndSave,
  urlButton,
} from "./template-button-route-test-utils";

describe("template reply-button routes follow the button, not its position (regression)", () => {
  it("removing the first reply button does not hand its route to the remaining button", () => {
    const graph = buildTemplateRouteGraph({
      buttons: [quickReply("Basic"), quickReply("Premium")],
      routes: [
        ["Basic", "basic-follow-up"],
        ["Premium", "premium-follow-up"],
      ],
    });
    expect(followUpsOfButton(graph, "Basic")).toEqual(["basic-follow-up"]);
    expect(followUpsOfButton(graph, "Premium")).toEqual(["premium-follow-up"]);

    const saved = removeTemplateButtonAndSave(graph, "Basic");

    // Premium keeps its own follow-up; Basic's follow-up is not moved onto it.
    expect(followUpsOfButton(saved, "Premium")).toEqual(["premium-follow-up"]);
    expect(buttonBoundToFollowUp(saved, "premium-follow-up")).toBe("Premium");
    expect(buttonBoundToFollowUp(saved, "basic-follow-up")).not.toBe("Premium");
  });

  it("removing a middle reply button keeps the later button's route", () => {
    const graph = buildTemplateRouteGraph({
      buttons: [quickReply("Basic"), quickReply("Plus"), quickReply("Premium")],
      routes: [
        ["Basic", "basic-follow-up"],
        ["Plus", "plus-follow-up"],
        ["Premium", "premium-follow-up"],
      ],
    });

    const saved = removeTemplateButtonAndSave(graph, "Plus");

    expect(followUpsOfButton(saved, "Basic")).toEqual(["basic-follow-up"]);
    expect(followUpsOfButton(saved, "Premium")).toEqual(["premium-follow-up"]);
    expect(buttonBoundToFollowUp(saved, "premium-follow-up")).toBe("Premium");
    expect(buttonBoundToFollowUp(saved, "plus-follow-up")).not.toBe("Premium");
  });

  it("removing a link button in front of the reply buttons keeps both reply routes", () => {
    const graph = buildTemplateRouteGraph({
      buttons: [
        urlButton("See plans"),
        quickReply("Basic"),
        quickReply("Premium"),
      ],
      routes: [
        ["Basic", "basic-follow-up"],
        ["Premium", "premium-follow-up"],
      ],
    });

    const saved = removeTemplateButtonAndSave(graph, "See plans");

    expect(followUpsOfButton(saved, "Basic")).toEqual(["basic-follow-up"]);
    expect(followUpsOfButton(saved, "Premium")).toEqual(["premium-follow-up"]);
    expect(buttonBoundToFollowUp(saved, "basic-follow-up")).toBe("Basic");
    expect(buttonBoundToFollowUp(saved, "premium-follow-up")).toBe("Premium");
  });
});
