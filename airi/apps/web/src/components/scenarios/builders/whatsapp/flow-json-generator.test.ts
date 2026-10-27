import { generateFlowJson } from "./flow-json-generator";

describe("generateFlowJson", () => {
  it.each(["linear", "data_endpoint"] as const)(
    "carries checkbox answers as arrays through successive %s screens",
    flowNavigationMode => {
      const json = generateFlowJson({
        templateId: "purchase_interest",
        ctaText: "Open",
        flowNavigationMode,
        screens: [
          {
            id: "INTERESTS",
            title: "Your interests",
            fields: [
              {
                id: "interests",
                label: "Products",
                fieldType: "CheckboxGroup",
                required: true,
                options: [
                  { id: "phone", title: "Phones" },
                  { id: "laptop", title: "Laptops" },
                ],
              },
              { id: "name", label: "Name", fieldType: "TextInput" },
              { id: "notes", label: "Notes", fieldType: "TextArea" },
              { id: "date", label: "Date", fieldType: "DatePicker" },
              {
                id: "budget",
                label: "Budget",
                fieldType: "Dropdown",
                options: [{ id: "low", title: "Under 1000" }],
              },
              {
                id: "contact",
                label: "Contact method",
                fieldType: "RadioButtonsGroup",
                options: [{ id: "chat", title: "WhatsApp" }],
              },
            ],
          },
          {
            id: "DETAILS",
            title: "Details",
            fields: [{ id: "email", label: "Email", fieldType: "TextInput" }],
          },
          {
            id: "CONFIRM",
            title: "Confirm",
            fields: [{ id: "note", label: "Note", fieldType: "TextInput" }],
          },
        ],
      });

      const firstFooter = json.screens[0]?.layout.children[0]?.children?.at(-1);
      expect(firstFooter?.["on-click-action"]?.payload).toMatchObject({
        interests: "${form.interests}",
        name: "${form.name}",
      });
      for (const screen of json.screens.slice(1)) {
        expect(screen.data).toMatchObject({
          interests: {
            type: "array",
            items: { type: "string" },
            __example__: [],
          },
          name: { type: "string", __example__: " " },
          notes: { type: "string", __example__: " " },
          date: { type: "string", __example__: " " },
          budget: { type: "string", __example__: " " },
          contact: { type: "string", __example__: " " },
        });
        const footer = screen.layout.children[0]?.children?.at(-1);
        expect(footer?.["on-click-action"]?.payload).toMatchObject({
          interests: "${data.interests}",
          name: "${data.name}",
        });
      }
    }
  );

  it("removes html tags from flow labels and option titles", () => {
    const json = generateFlowJson({
      templateId: "flow_template",
      ctaText: "Open",
      screens: [
        {
          id: "screen_1",
          title: "<p>Бұйымды таңдаңыз</p>",
          fields: [
            {
              id: "field_1",
              label: "<p>Бұйымдар</p>",
              fieldType: "RadioButtonsGroup",
              options: [
                { id: "opt_1", title: "<p>Медаль ілгіш</p>" },
                { id: "opt_2", title: "Басқа" },
              ],
            },
          ],
        },
      ],
      metaFlowId: "flow_123",
      metaFlowName: "Flow",
      metaFlowStatus: "DRAFT",
    });

    expect(json.screens[0]?.title).toBe("Бұйымды таңдаңыз");
    expect(json.screens[0]?.layout.children[0]?.children?.[0]).toMatchObject({
      label: "Бұйымдар",
      "data-source": [
        { id: "opt_1", title: "Медаль ілгіш" },
        { id: "opt_2", title: "Басқа" },
      ],
    });

    const footer = json.screens[0]?.layout.children[0]?.children?.[1];
    expect(footer?.type).toBe("Footer");
    expect(footer?.["on-click-action"]?.name).toBe("complete");
  });

  it("uses navigate between screens in linear mode", () => {
    const json = generateFlowJson({
      templateId: "t",
      ctaText: "Open",
      screens: [
        {
          id: "A",
          title: "One",
          fields: [{ id: "f1", label: "F1", fieldType: "TextInput" }],
        },
        {
          id: "B",
          title: "Two",
          fields: [{ id: "f2", label: "F2", fieldType: "TextInput" }],
        },
      ],
    });

    expect(json.routing_model).toBeUndefined();
    expect(json.data_api_version).toBeUndefined();
    expect(json.screens[0]).not.toHaveProperty("terminal");

    const footerA = json.screens[0]?.layout.children[0]?.children?.[1];
    expect(footerA?.["on-click-action"]?.name).toBe("navigate");
    expect(footerA?.["on-click-action"]?.next).toEqual({
      type: "screen",
      name: "B",
    });
    expect(json.screens[0]?.data).toBeUndefined();

    expect(json.screens[1]?.data).toMatchObject({
      f1: { type: "string" },
    });
    const footerB = json.screens[1]?.layout.children[0]?.children?.[1];
    expect(footerB?.["on-click-action"]?.name).toBe("complete");
  });

  it("emits Meta-safe screen ids and next targets when config ids contain digits", () => {
    const json = generateFlowJson({
      templateId: "t",
      ctaText: "Open",
      screens: [
        {
          id: "LEAD_FORM",
          title: "One",
          fields: [{ id: "f1", label: "F1", fieldType: "TextInput" }],
        },
        {
          id: "screen_2",
          title: "Two",
          fields: [{ id: "f2", label: "F2", fieldType: "TextInput" }],
        },
        {
          id: "screen_3",
          title: "Three",
          fields: [{ id: "f3", label: "F3", fieldType: "TextInput" }],
        },
      ],
    });

    expect(json.screens.map(screen => screen.id)).toEqual([
      "LEAD_FORM",
      "screen_TWO",
      "screen_THREE",
    ]);
    expect(
      json.screens[0]?.layout.children[0]?.children?.[1]?.["on-click-action"]
        ?.next
    ).toEqual({ type: "screen", name: "screen_TWO" });
    expect(
      json.screens[1]?.layout.children[0]?.children?.[1]?.["on-click-action"]
        ?.next
    ).toEqual({ type: "screen", name: "screen_THREE" });
  });

  it("adds routing_model and data_exchange in data_endpoint mode", () => {
    const json = generateFlowJson({
      templateId: "t",
      ctaText: "Open",
      flowNavigationMode: "data_endpoint",
      screens: [
        {
          id: "S1",
          title: "One",
          fields: [
            {
              id: "q",
              label: "Q",
              fieldType: "RadioButtonsGroup",
              options: [{ id: "a", title: "A" }],
            },
          ],
        },
        {
          id: "S2",
          title: "Two",
          fields: [{ id: "x", label: "X", fieldType: "TextInput" }],
        },
        {
          id: "S3",
          title: "Three",
          fields: [{ id: "y", label: "Y", fieldType: "TextInput" }],
        },
      ],
      screenRoutes: { S1: ["S3"] },
    });

    expect(json.data_api_version).toBe("4.0");
    expect(json.version).toBe("7.3");
    expect(json.routing_model).toMatchObject({
      S_ONE: ["S_THREE"],
      S_TWO: ["S_THREE"],
      S_THREE: [],
    });

    const footer1 = json.screens[0]?.layout.children[0]?.children?.[1];
    expect(footer1?.["on-click-action"]?.name).toBe("data_exchange");
    expect(footer1?.["on-click-action"]?.next).toBeUndefined();
  });
});
