import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { referenceVideoPlanInputSchema } from "./contracts";
import { buildReferenceVideoPlanSnapshot } from "./plan";
import { REFERENCE_VIDEO_RECIPES } from "./recipes";

type LocalizedRecipe = {
  title: string;
  description: string;
  scenes: Record<string, { label: string; caption: string }>;
};

describe.each(["en", "ru", "kz"])(
  "%s reference video recipe translations",
  locale => {
    const messages = JSON.parse(
      readFileSync(
        resolve(__dirname, "../../../../messages/panel", locale, "page.json"),
        "utf8"
      )
    ) as {
      CreativeAssetsWorkspace: {
        referenceVideoRecipes: Record<string, LocalizedRecipe>;
      };
    };
    const catalog = messages.CreativeAssetsWorkspace.referenceVideoRecipes;

    it("covers exactly the canonical recipes and their scene identities", () => {
      expect(Object.keys(catalog).sort()).toEqual(
        REFERENCE_VIDEO_RECIPES.map(recipe => recipe.id).sort()
      );
      for (const recipe of REFERENCE_VIDEO_RECIPES) {
        const translated = catalog[recipe.id];
        expect(translated.title.trim()).not.toBe("");
        expect(translated.description.trim()).not.toBe("");
        expect(Object.keys(translated.scenes).sort()).toEqual(
          recipe.scenes.map(scene => scene.id).sort()
        );
        for (const scene of recipe.scenes) {
          expect(translated.scenes[scene.id].label.trim()).not.toBe("");
        }
      }
    });

    it("accepts every localized default caption in the actual input contract and preserves it in the compiled plan", () => {
      for (const recipe of REFERENCE_VIDEO_RECIPES) {
        const translated = catalog[recipe.id];
        const input = {
          recipeId: recipe.id,
          title: translated.title,
          scenes: recipe.scenes.map(scene => ({
            assetId: "64c13ab08edf48a008793cab",
            caption: translated.scenes[scene.id].caption,
            sourceStart: 0,
          })),
        };
        const result = referenceVideoPlanInputSchema.safeParse(input);
        expect({ recipeId: recipe.id, issues: result.error?.issues }).toEqual({
          recipeId: recipe.id,
          issues: undefined,
        });
        const plan = buildReferenceVideoPlanSnapshot(input);
        expect(plan.scenes.map(scene => scene.caption)).toEqual(
          input.scenes.map(scene => scene.caption.trim())
        );
        expect(plan.timeline.clips.map(clip => clip.caption)).toEqual(
          plan.scenes.map(scene => scene.caption)
        );
      }
    });
  }
);

describe("reference video formats", () => {
  it("offers ten bounded original formats without implying a discovered preset", () => {
    expect(REFERENCE_VIDEO_RECIPES).toHaveLength(10);
    expect(new Set(REFERENCE_VIDEO_RECIPES.map(recipe => recipe.id)).size).toBe(
      10
    );
    for (const recipe of REFERENCE_VIDEO_RECIPES) {
      expect(recipe.scenes.length).toBeLessThanOrEqual(6);
      expect(
        recipe.scenes.reduce((sum, scene) => sum + scene.duration, 0)
      ).toBeLessThanOrEqual(30);
    }
  });
});
