import type { WhatsAppComponent } from "@icecore/shared/types/whatsapp";
import {
  remapTemplateFlowsForCurrentWaba,
  TemplateFlowRemapError,
  type RemapTemplateFlowsForWabaDeps,
} from "@/lib/whatsapp/templates/remap-template-flows-for-waba";

const FLOW_JSON = { version: "7.3", screens: [{ id: "START" }] };

const FLOW_COMPONENTS: WhatsAppComponent[] = [
  { type: "BODY", text: "Testing" },
  {
    type: "BUTTONS",
    buttons: [{ type: "FLOW", text: "What is it", flow_id: "flow-old" }],
  },
];

function createDeps(
  overrides: Partial<RemapTemplateFlowsForWabaDeps> = {}
): RemapTemplateFlowsForWabaDeps {
  return {
    getFlow: jest.fn(),
    createFlow: jest.fn(),
    updateFlow: jest.fn(),
    findFlowByName: jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      flow: null,
    }),
    findFlowByIdOnWaba: jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      flow: null,
    }),
    ...overrides,
  } as RemapTemplateFlowsForWabaDeps;
}

describe("remapTemplateFlowsForCurrentWaba", () => {
  it("leaves templates without Flow buttons unchanged", async () => {
    const deps = createDeps();
    const components: WhatsAppComponent[] = [{ type: "BODY", text: "Hello" }];

    await expect(
      remapTemplateFlowsForCurrentWaba(
        {
          accessToken: "token",
          currentWabaId: "waba-current",
          components,
        },
        deps
      )
    ).resolves.toBe(components);
    expect(deps.getFlow).not.toHaveBeenCalled();
  });

  it("keeps a Flow already owned by the current WABA", async () => {
    const deps = createDeps({
      getFlow: jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        flow: {
          id: "flow-old",
          name: "try_flow",
          status: "PUBLISHED",
          whatsapp_business_account: { id: "waba-current" },
        },
        flowJson: FLOW_JSON,
      }),
    });

    const result = await remapTemplateFlowsForCurrentWaba(
      {
        accessToken: "token",
        currentWabaId: "waba-current",
        components: FLOW_COMPONENTS,
      },
      deps
    );

    expect(result).toEqual(FLOW_COMPONENTS);
    expect(deps.createFlow).not.toHaveBeenCalled();
    expect(deps.updateFlow).not.toHaveBeenCalled();
  });

  it("leaves flow_name and flow_json buttons unchanged", async () => {
    const deps = createDeps();
    const components: WhatsAppComponent[] = [
      {
        type: "BUTTONS",
        buttons: [{ type: "FLOW", text: "Open", flow_name: "booking" }],
      },
    ];

    await expect(
      remapTemplateFlowsForCurrentWaba(
        {
          accessToken: "token",
          currentWabaId: "waba-current",
          sourceWabaId: "waba-old",
          components,
        },
        deps
      )
    ).resolves.toBe(components);
    expect(deps.getFlow).not.toHaveBeenCalled();
  });

  it("reads the old Flow JSON and creates it on the current WABA", async () => {
    const deps = createDeps({
      getFlow: jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        flow: {
          id: "flow-old",
          name: "try_flow",
          status: "PUBLISHED",
          categories: ["LEAD_GENERATION"],
          whatsapp_business_account: { id: "waba-old" },
        },
        flowJson: FLOW_JSON,
      }),
      createFlow: jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        flow: { id: "flow-new", name: "try_flow", status: "PUBLISHED" },
        providerFlowId: "flow-new",
      }),
    });

    const result = await remapTemplateFlowsForCurrentWaba(
      {
        accessToken: "token",
        currentWabaId: "waba-current",
        sourceWabaId: "waba-old",
        components: FLOW_COMPONENTS,
      },
      deps
    );

    expect(deps.getFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        flowId: "flow-old",
        includeJson: true,
      })
    );
    expect(deps.createFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        wabaId: "waba-current",
        name: "try_flow",
        categories: ["LEAD_GENERATION"],
        flowJson: JSON.stringify(FLOW_JSON),
        publish: true,
      })
    );
    const createPayload = (deps.createFlow as jest.Mock).mock.calls[0]?.[0] as {
      cloneFlowId?: string;
    };
    expect(createPayload.cloneFlowId).toBeUndefined();
    expect(result).toEqual([
      { type: "BODY", text: "Testing" },
      {
        type: "BUTTONS",
        buttons: [{ type: "FLOW", text: "What is it", flow_id: "flow-new" }],
      },
    ]);
  });

  it("reuses a same-named Flow already on the current WABA", async () => {
    const deps = createDeps({
      getFlow: jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        flow: {
          id: "flow-old",
          name: "try_flow",
          status: "PUBLISHED",
          whatsapp_business_account: { id: "waba-old" },
        },
        flowJson: FLOW_JSON,
      }),
      findFlowByName: jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        flow: { id: "flow-existing", name: "try_flow", status: "PUBLISHED" },
      }),
    });

    const result = await remapTemplateFlowsForCurrentWaba(
      {
        accessToken: "token",
        currentWabaId: "waba-current",
        sourceWabaId: "waba-old",
        components: FLOW_COMPONENTS,
      },
      deps
    );

    expect(deps.createFlow).not.toHaveBeenCalled();
    expect(result[1]).toEqual({
      type: "BUTTONS",
      buttons: [{ type: "FLOW", text: "What is it", flow_id: "flow-existing" }],
    });
  });

  it("does not call migrate_flows when copying a previous-WABA Flow", async () => {
    const deps = createDeps({
      getFlow: jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        flow: {
          id: "1502809548249689",
          name: "try",
          status: "PUBLISHED",
          whatsapp_business_account: { id: "940525742304249" },
        },
        flowJson: FLOW_JSON,
      }),
      createFlow: jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        flow: { id: "flow-new", status: "PUBLISHED" },
        providerFlowId: "flow-new",
      }),
    });

    await remapTemplateFlowsForCurrentWaba(
      {
        accessToken: "token",
        currentWabaId: "waba-current",
        sourceWabaId: "940525742304249",
        components: [
          { type: "BODY", text: "Testing" },
          {
            type: "BUTTONS",
            buttons: [
              {
                type: "FLOW",
                text: "What is it",
                flow_id: "1502809548249689",
              },
            ],
          },
        ],
      },
      deps
    );

    expect(deps.createFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "try",
        flowJson: JSON.stringify(FLOW_JSON),
        publish: true,
      })
    );
  });

  it("throws when the old Flow JSON cannot be read", async () => {
    const deps = createDeps({
      getFlow: jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        flow: {
          id: "flow-old",
          name: "try_flow",
          status: "PUBLISHED",
          whatsapp_business_account: { id: "waba-old" },
        },
      }),
    });

    await expect(
      remapTemplateFlowsForCurrentWaba(
        {
          accessToken: "token",
          currentWabaId: "waba-current",
          sourceWabaId: "waba-old",
          components: FLOW_COMPONENTS,
        },
        deps
      )
    ).rejects.toThrow("Could not read Flow JSON");
    expect(deps.createFlow).not.toHaveBeenCalled();
  });

  it("throws when GET cannot see the source Flow", async () => {
    const deps = createDeps({
      getFlow: jest.fn().mockResolvedValue({
        ok: false,
        status: 404,
        error: "Flow not found",
      }),
    });

    await expect(
      remapTemplateFlowsForCurrentWaba(
        {
          accessToken: "token",
          currentWabaId: "waba-current",
          components: FLOW_COMPONENTS,
        },
        deps
      )
    ).rejects.toThrow(TemplateFlowRemapError);
    expect(deps.createFlow).not.toHaveBeenCalled();
  });

  it("reports the alternate-name create error after a name conflict", async () => {
    const deps = createDeps({
      getFlow: jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        flow: {
          id: "flow-old",
          name: "try_flow",
          status: "PUBLISHED",
          whatsapp_business_account: { id: "waba-old" },
        },
        flowJson: FLOW_JSON,
      }),
      createFlow: jest
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 400,
          error: "Flow name already exists",
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 400,
          error: "Invalid flow JSON on retry",
        }),
    });

    await expect(
      remapTemplateFlowsForCurrentWaba(
        {
          accessToken: "token",
          currentWabaId: "waba-current",
          sourceWabaId: "waba-old",
          components: FLOW_COMPONENTS,
        },
        deps
      )
    ).rejects.toThrow("Invalid flow JSON on retry");
    expect(deps.createFlow).toHaveBeenCalledTimes(2);
  });
});
