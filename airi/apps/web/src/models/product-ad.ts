import mongoose from "mongoose";
import {
  PRODUCT_AD_ERROR_CODES,
  PRODUCT_AD_IDEA_KINDS,
  PRODUCT_AD_IDEA_MAX_LENGTH,
  PRODUCT_AD_MAX_PRODUCTS,
  PRODUCT_AD_MIN_PRODUCTS,
  PRODUCT_AD_SCENE_METHODS,
  PRODUCT_AD_SETTINGS,
  PRODUCT_AD_STATUSES,
  PRODUCT_AD_STEPS,
  PRODUCT_AD_VOICES,
  PRODUCT_SHOP_WORDS_CODES,
  type ProductAdErrorCode,
  type ProductAdIdeaKind,
  type ProductAdScript,
  type ProductAdStatus,
  type ProductAdStep,
  type ProductAdVoice,
  type ProductShopWordsCode,
} from "@/lib/products/types";
import type {
  ProductAdBox,
  ProductAdFileRef,
  ProductAdRender,
  ProductAdStepTiming,
  ProductAdStills,
  ProductAdStoredProduct,
  ProductAdStoredScene,
  ProductAdTimings,
} from "@icecore/temporal";

/**
 * A product as the ad shows it (the contract's snapshot), plus the small copy
 * of its cut-out the studio and the made list display.
 */
export type ProductAdSnapshot = ProductAdStoredProduct & {
  thumb: ProductAdFileRef | null;
};

/**
 * A video ad (Products): 1 to 3 shelf products in a 9:16 video, with its
 * stills and copy. The web makes it from the owner's brief and starts its
 * workflow; the worker saves each step here as it's made (the script, every
 * scene, the stills), so a retry or a later render pays for nothing twice.
 * The document's parts are the shared contract's types (@icecore/temporal).
 */
export interface IProductAd {
  _id: mongoose.Types.ObjectId;
  workspaceId: string;
  /** The page's id for the press: a repeat finds this ad instead of making another. */
  requestId: string;
  createdBy: string;
  status: ProductAdStatus;
  /**
   * When the current run was asked for: the press of "Make the ad", or the
   * latest edit or retry. The studio counts the making time from here.
   */
  requestedAt: Date;
  /** The step being made; null once it's ready or failed. */
  step: ProductAdStep | null;
  errorCode: ProductAdErrorCode | null;
  /** The failure in words, for support; not shown to the owner. */
  errorMessage: string | null;
  /** The language the owner spoke, as Muse Spark named it. */
  language: string | null;
  /** The shop words' language for its fixed words; null when it has none. */
  wordsCode: ProductShopWordsCode | null;
  /** The brief. */
  idea: { kind: ProductAdIdeaKind; text: string | null };
  voice: ProductAdVoice;
  /**
   * The person from the video, shown only after the owner said they agreed:
   * the import's transparent cut-out (photo) and its small copy (thumb). Null
   * when the ad doesn't show them.
   */
  presenter: {
    use: boolean;
    consentAt: Date | null;
    photo: ProductAdFileRef | null;
    thumb: ProductAdFileRef | null;
  } | null;
  /** How buyers reach the shop: the connected number, else the shop's name. */
  ending: { phone: string | null; shopName: string };
  products: ProductAdSnapshot[];
  script: ProductAdScript | null;
  scenes: ProductAdStoredScene[];
  stills: ProductAdStills;
  /** The render being made or last made: 1 for the first video. */
  renderNo: number;
  render: ProductAdRender | null;
  /** The ledger's action every paid call books to. */
  actionId: string;
  /** What its model calls cost, in millionths of a US dollar. */
  costMicros: number;
  /** When the worker picked up the current run; null while it waits for a slot. */
  startedAt: Date | null;
  timings: ProductAdTimings;
  workflowId?: string;
  readyAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const FileRefSchema = new mongoose.Schema<ProductAdFileRef>(
  {
    bucket: { type: String, required: true },
    path: { type: String, required: true },
  },
  { _id: false }
);

const ProductSnapshotSchema = new mongoose.Schema<ProductAdSnapshot>(
  {
    productId: { type: String, required: true, maxlength: 64 },
    importId: { type: String, maxlength: 64, default: null },
    name: { type: String, required: true, maxlength: 160 },
    englishName: { type: String, maxlength: 160, default: null },
    priceText: { type: String, required: true, maxlength: 80 },
    priceQuote: { type: String, maxlength: 400, default: null },
    cutout: { type: FileRefSchema, default: null },
    thumb: { type: FileRefSchema, default: null },
    original: { type: FileRefSchema, default: null },
    clip: { type: FileRefSchema, default: null },
    samPhrase: { type: String, maxlength: 80, default: "" },
    description: { type: String, maxlength: 120, default: "" },
  },
  { _id: false }
);

const ScriptSchema = new mongoose.Schema<ProductAdScript>(
  {
    sticker: { type: String, maxlength: 80, default: "" },
    scenes: {
      type: [
        new mongoose.Schema<ProductAdScript["scenes"][number]>(
          {
            productId: { type: String, required: true, maxlength: 64 },
            caption: { type: String, maxlength: 160, default: "" },
            setting: { type: String, enum: PRODUCT_AD_SETTINGS },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    priceCardTitle: { type: String, maxlength: 80, default: "" },
    ending: { type: String, maxlength: 160, default: "" },
    postIntro: { type: String, maxlength: 400, default: "" },
    ctwa: {
      headline: { type: String, maxlength: 80, default: "" },
      primaryText: { type: String, maxlength: 250, default: "" },
      greeting: { type: String, maxlength: 320, default: "" },
      questions: { type: [{ type: String, maxlength: 160 }], default: [] },
    },
    edited: { type: Boolean, default: false },
  },
  { _id: false }
);

const BoxSchema = new mongoose.Schema<ProductAdBox>(
  {
    x: { type: Number, min: 0, max: 1 },
    y: { type: Number, min: 0, max: 1 },
    w: { type: Number, min: 0, max: 1 },
    h: { type: Number, min: 0, max: 1 },
  },
  { _id: false }
);

const SceneSchema = new mongoose.Schema<ProductAdStoredScene>(
  {
    productId: { type: String, required: true, maxlength: 64 },
    exact: { type: FileRefSchema, default: null },
    muse: { type: FileRefSchema, default: null },
    method: { type: String, enum: PRODUCT_AD_SCENE_METHODS, default: "exact" },
    check: {
      type: new mongoose.Schema<NonNullable<ProductAdStoredScene["check"]>>(
        {
          same: { type: Boolean, required: true },
          difference: { type: String, maxlength: 400, default: null },
        },
        { _id: false }
      ),
      default: null,
    },
    box: { type: BoxSchema, default: null },
    attempts: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const RenderSchema = new mongoose.Schema<ProductAdRender>(
  {
    renderNo: { type: Number, required: true, min: 1 },
    video: { type: FileRefSchema, required: true },
    bytes: { type: Number, required: true, min: 0 },
    seconds: { type: Number, required: true, min: 0 },
    width: { type: Number, required: true, min: 0 },
    height: { type: Number, required: true, min: 0 },
    poster: { type: FileRefSchema, default: null },
    ms: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const StepTimingSchema = new mongoose.Schema<ProductAdStepTiming>(
  {
    startedAt: { type: Date, required: true },
    finishedAt: { type: Date, default: null },
  },
  { _id: false }
);

const ProductAdSchema = new mongoose.Schema<IProductAd>(
  {
    workspaceId: { type: String, required: true, trim: true, maxlength: 64 },
    requestId: { type: String, required: true, trim: true, maxlength: 64 },
    createdBy: { type: String, required: true },
    status: {
      type: String,
      required: true,
      enum: PRODUCT_AD_STATUSES,
      default: "making",
    },
    requestedAt: { type: Date, required: true, default: () => new Date() },
    step: { type: String, enum: [...PRODUCT_AD_STEPS, null], default: null },
    errorCode: {
      type: String,
      enum: [...PRODUCT_AD_ERROR_CODES, null],
      default: null,
    },
    errorMessage: { type: String, maxlength: 500, default: null },
    language: { type: String, trim: true, maxlength: 40, default: null },
    wordsCode: {
      type: String,
      enum: [...PRODUCT_SHOP_WORDS_CODES, null],
      default: null,
    },
    idea: {
      kind: { type: String, required: true, enum: PRODUCT_AD_IDEA_KINDS },
      text: {
        type: String,
        maxlength: PRODUCT_AD_IDEA_MAX_LENGTH,
        default: null,
      },
    },
    voice: { type: String, required: true, enum: PRODUCT_AD_VOICES },
    presenter: {
      type: new mongoose.Schema<NonNullable<IProductAd["presenter"]>>(
        {
          use: { type: Boolean, required: true },
          consentAt: { type: Date, default: null },
          photo: { type: FileRefSchema, default: null },
          thumb: { type: FileRefSchema, default: null },
        },
        { _id: false }
      ),
      default: null,
    },
    ending: {
      phone: { type: String, maxlength: 32, default: null },
      shopName: { type: String, maxlength: 160, default: "" },
    },
    products: {
      type: [ProductSnapshotSchema],
      required: true,
      validate: {
        validator: (products: unknown[]) =>
          products.length >= PRODUCT_AD_MIN_PRODUCTS &&
          products.length <= PRODUCT_AD_MAX_PRODUCTS,
        message: `An ad shows ${PRODUCT_AD_MIN_PRODUCTS} to ${PRODUCT_AD_MAX_PRODUCTS} products`,
      },
    },
    script: { type: ScriptSchema, default: null },
    scenes: { type: [SceneSchema], default: [] },
    stills: {
      status: { type: FileRefSchema, default: null },
      feed: { type: FileRefSchema, default: null },
    },
    renderNo: { type: Number, default: 1, min: 1 },
    render: { type: RenderSchema, default: null },
    actionId: { type: String, required: true, maxlength: 128 },
    costMicros: { type: Number, default: 0, min: 0 },
    startedAt: { type: Date, default: null },
    timings: {
      script: { type: StepTimingSchema, default: undefined },
      pictures: { type: StepTimingSchema, default: undefined },
      framing: { type: StepTimingSchema, default: undefined },
      video: { type: StepTimingSchema, default: undefined },
    },
    workflowId: { type: String },
    readyAt: { type: Date, default: null },
  },
  { timestamps: true, collection: "product_ads" }
);

// One ad per press, however often it's sent.
ProductAdSchema.index(
  { workspaceId: 1, requestId: 1 },
  { name: "product_ad_request", unique: true }
);

ProductAdSchema.index(
  { workspaceId: 1, createdAt: -1 },
  { name: "product_ad_workspace_recent" }
);

export const ProductAd =
  (mongoose.models.ProductAd as mongoose.Model<IProductAd> | undefined) ||
  mongoose.model<IProductAd>("ProductAd", ProductAdSchema);
