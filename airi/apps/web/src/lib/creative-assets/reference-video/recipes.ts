export type ReferenceVideoRecipe = {
  id: string;
  scenes: { id: string; duration: number }[];
};

const scene = (id: string, duration: number) => ({ id, duration });

// Original editing recipes. TikTok discovery metadata is attribution, not video analysis.
export const REFERENCE_VIDEO_RECIPES: ReferenceVideoRecipe[] = [
  {
    id: "product-reveal",
    scenes: [scene("hook", 3), scene("details", 4), scene("cta", 4)],
  },
  {
    id: "before-after",
    scenes: [
      scene("before", 3),
      scene("process", 4),
      scene("after", 4),
      scene("cta", 3),
    ],
  },
  {
    id: "three-details",
    scenes: [
      scene("hook", 3),
      scene("first", 3),
      scene("second", 3),
      scene("third", 3),
      scene("cta", 3),
    ],
  },
  {
    id: "how-it-works",
    scenes: [
      scene("first", 4),
      scene("second", 4),
      scene("third", 4),
      scene("cta", 3),
    ],
  },
  {
    id: "offer-spotlight",
    scenes: [scene("hook", 3), scene("details", 5), scene("cta", 4)],
  },
  {
    id: "menu-picks",
    scenes: [
      scene("first", 4),
      scene("second", 4),
      scene("third", 4),
      scene("cta", 3),
    ],
  },
  {
    id: "space-tour",
    scenes: [
      scene("entrance", 3),
      scene("inside", 4),
      scene("detail", 4),
      scene("cta", 3),
    ],
  },
  {
    id: "behind-scenes",
    scenes: [
      scene("team", 3),
      scene("process", 5),
      scene("result", 4),
      scene("cta", 3),
    ],
  },
  {
    id: "collection",
    scenes: [
      scene("first", 3),
      scene("second", 3),
      scene("third", 3),
      scene("cta", 4),
    ],
  },
  {
    id: "service-story",
    scenes: [
      scene("need", 3),
      scene("service", 5),
      scene("result", 4),
      scene("cta", 4),
    ],
  },
];
