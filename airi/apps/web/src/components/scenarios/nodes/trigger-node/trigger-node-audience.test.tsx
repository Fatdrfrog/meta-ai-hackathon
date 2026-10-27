/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { ChannelFilterEditor } from "./trigger-node-audience";

describe("ChannelFilterEditor", () => {
  it("does not disable the last enabled channel", () => {
    const onChange = jest.fn();
    render(
      <ChannelFilterEditor
        t={key => key}
        onChange={onChange}
        channels={{
          options: [{ id: "stale_channel", label: "stale_channel" }],
          enabledChannelSet: new Set(["stale_channel"]),
        }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "stale_channel" }));

    expect(onChange).not.toHaveBeenCalled();
  });

  it("emits only a channel delta and uses an empty filter for all channels", () => {
    const onChange = jest.fn();
    render(
      <ChannelFilterEditor
        t={key => key}
        onChange={onChange}
        channels={{
          options: [
            { id: "whatsapp", label: "WhatsApp" },
            { id: "telegram", label: "Telegram" },
          ],
          enabledChannelSet: new Set(["whatsapp"]),
        }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Telegram" }));

    expect(onChange).toHaveBeenCalledWith({ channelFilter: [] });
  });
  it("emits selected channels in option order without mutating the model", () => {
    const onChange = jest.fn();
    const enabledChannelSet = new Set(["third", "first", "second"]);
    render(
      <ChannelFilterEditor
        t={key => key}
        onChange={onChange}
        channels={{
          options: ["first", "second", "third", "fourth"].map(id => ({
            id,
            label: id,
          })),
          enabledChannelSet,
        }}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "second" }));
    expect(onChange).toHaveBeenCalledWith({
      channelFilter: ["first", "third"],
    });
    expect(Array.from(enabledChannelSet)).toEqual(["third", "first", "second"]);
  });
});
