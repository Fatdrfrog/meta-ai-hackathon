/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { EmptyShelf } from "./product-shelf";

// The empty shelf is a wall shelf: the message on the wall, ghost products
// standing on the plank one to a bay, each with its blank label clipped to the
// plank's edge in the same bay, and the wall under the plank.

const emptyShelf = (lit?: boolean) =>
  render(
    <EmptyShelf lit={lit}>
      <h2>Your products will appear here</h2>
    </EmptyShelf>
  ).container.firstElementChild as HTMLElement;

test("stands one ghost in each bay, with its label in the same bay below it", () => {
  const shelf = emptyShelf();

  const ghosts = [...shelf.querySelectorAll(".ghostRow > .ghostBay")];
  expect(
    ghosts.map(bay => bay.querySelector(".ghost")?.getAttribute("data-shape"))
  ).toEqual(["bottle", "box", "jar", "carton"]);
  const labels = [...shelf.querySelectorAll(".lip .ghostTags > .ghostBay")];
  expect(labels).toHaveLength(ghosts.length);
  for (const bay of labels) expect(bay.querySelector(".ghostTag")).not.toBeNull();
});

test("puts the plank right under the wall the ghosts stand on, then the wall below it", () => {
  const shelf = emptyShelf();

  expect([...shelf.children].map(part => part.className)).toEqual([
    "emptyWall",
    "top",
    "lip",
    "emptyBelow",
  ]);
  // The ghosts are the wall's last part, so they stand on the plank.
  expect(shelf.querySelector(".emptyWall")?.lastElementChild).toHaveClass(
    "ghostRow"
  );
});

test("keeps the drawing out of the accessibility tree, and the message in it", () => {
  const shelf = emptyShelf();

  expect(shelf.querySelector(".ghostRow")).toHaveAttribute(
    "aria-hidden",
    "true"
  );
  for (const part of [".top", ".lip", ".emptyBelow"])
    expect(shelf.querySelector(part)).toHaveAttribute("aria-hidden", "true");
  expect(
    screen.getByRole("heading", { name: "Your products will appear here" })
  ).toBeInTheDocument();
});

test("dims the shelf's light when it couldn't load", () => {
  expect(emptyShelf(false)).toHaveAttribute("data-light", "off");
  expect(emptyShelf()).not.toHaveAttribute("data-light");
});
