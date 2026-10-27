import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });

test("columns move on every frame without whole-pixel scroll steps", async ({
  page,
}) => {
  await page.goto("/", { waitUntil: "networkidle" });
  const tracks = page.getByTestId("hero-scroll-track");
  await expect(tracks).toHaveCount(2);
  await page.mouse.move(1, 1);
  await expect(tracks.first()).toHaveAttribute("data-paused", "false");

  const samples = await tracks.evaluateAll(
    elements =>
      new Promise<{ time: number; positions: number[] }[]>(resolve => {
        const frames: { time: number; positions: number[] }[] = [];
        const sample = (time: number) => {
          frames.push({
            time,
            positions: elements.map(el => el.getBoundingClientRect().top),
          });
          if (time - frames[0].time < 2000) requestAnimationFrame(sample);
          else resolve(frames);
        };
        requestAnimationFrame(sample);
      })
  );

  for (const column of [0, 1]) {
    const steps = samples.slice(1).map((frame, index) => ({
      distance: frame.positions[column] - samples[index].positions[column],
      elapsed: frame.time - samples[index].time,
    }));
    // Whole-pixel scrolling at 40 px/s leaves every third 60 Hz frame still.
    expect(
      steps.filter(step => Math.abs(step.distance) < 0.01).length
    ).toBeLessThan(steps.length * 0.1);
    const distance = steps.reduce((sum, step) => sum + step.distance, 0);
    const elapsed = samples.at(-1)!.time - samples[0].time;
    expect(Math.abs(distance / (elapsed / 1000))).toBeCloseTo(40, 0);
  }
});

test("fractional positions survive hover, browsing, looping and resize", async ({
  page,
}) => {
  await page.goto("/", { waitUntil: "networkidle" });
  const tracks = page.getByTestId("hero-scroll-track");
  const viewports = page.locator("[data-column-viewport]");
  await expect(tracks).toHaveCount(2);
  await page.mouse.move(1, 1);

  for (const index of [0, 1]) {
    const track = tracks.nth(index);
    const viewport = viewports.nth(index);
    const before = await track.evaluate(async element => {
      const animation = element.getAnimations()[0];
      await animation.ready;
      animation.pause();
      animation.currentTime = Number(animation.currentTime) + 7;
      return element.getBoundingClientRect().top;
    });
    await viewport.hover({ position: { x: 30, y: 120 } });
    await expect(track).toHaveAttribute("data-paused", "true");
    await expect(tracks.nth(1 - index)).toHaveAttribute("data-paused", "false");
    expect(
      Math.abs(
        (await track.evaluate(el => el.getBoundingClientRect().top)) - before
      )
    ).toBeLessThan(0.03);
    expect(await track.evaluate(el => el.getAnimations().length)).toBe(0);

    const nativePosition = await viewport.evaluate(el => el.scrollTop);
    await page.mouse.wheel(120, 0);
    await expect
      .poll(() => viewport.evaluate(el => el.scrollTop))
      .toBe(nativePosition + 120);
    await page.mouse.move(1, 1);
    await expect(track).toHaveAttribute("data-paused", "false");
    await expect
      .poll(() => track.evaluate(el => el.getAnimations().length))
      .toBe(1);

    const seam = await track.evaluate(element => {
      const animation = element.getAnimations()[0];
      const duration = Number(animation.effect!.getTiming().duration);
      const viewport = element.parentElement!;
      const visible = () =>
        [...element.querySelectorAll<HTMLElement>("article")]
          .map(card => ({
            id: card.dataset.featureCard,
            top: card.getBoundingClientRect().top,
            bottom: card.getBoundingClientRect().bottom,
          }))
          .filter(
            card =>
              card.top < viewport.getBoundingClientRect().bottom &&
              card.bottom > viewport.getBoundingClientRect().top
          );
      animation.pause();
      animation.currentTime = duration - 20;
      const before = visible();
      animation.currentTime = duration + 20;
      const after = visible();
      animation.play();
      return { before, after };
    });
    expect(seam.after.map(card => card.id)).toEqual(
      seam.before.map(card => card.id)
    );
    seam.after.forEach((card, i) =>
      expect(Math.abs(card.top - seam.before[i].top)).toBeCloseTo(1.6, 1)
    );
  }

  await tracks.evaluateAll(elements =>
    elements.forEach(element => {
      const animation = element.getAnimations()[0];
      animation.currentTime =
        Number(animation.effect!.getTiming().duration) * 0.7;
    })
  );
  await page.setViewportSize({ width: 1024, height: 900 });
  await expect
    .poll(() =>
      tracks.evaluateAll(elements =>
        elements.every(element => {
          const animation = element.getAnimations()[0];
          const height = element.children[1].getBoundingClientRect().height;
          return (
            Math.abs(
              Number(animation?.effect?.getTiming().duration) -
                (height / 40) * 1000
            ) < 0.1
          );
        })
      )
    )
    .toBe(true);
  const phases = await tracks.evaluateAll(elements =>
    elements.map(element => {
      const animation = element.getAnimations()[0];
      return (
        Number(animation.currentTime) /
        Number(animation.effect!.getTiming().duration)
      );
    })
  );
  phases.forEach(phase => expect(phase).toBeCloseTo(0.7, 1));

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.getByTestId("hero-scroll-copy")).toHaveCount(0);
  expect(
    await tracks.evaluateAll(elements =>
      elements.every(
        element =>
          element.getAnimations().length === 0 &&
          (element as HTMLElement).style.transform === ""
      )
    )
  ).toBe(true);
});
