import mongoose from "mongoose";
import {
  PRODUCT_KIT_CAROUSEL_STATES,
  PRODUCT_KIT_ORDER_FORM_STATES,
  PRODUCT_KIT_PART_ERROR_CODES,
  PRODUCT_SHOP_WORDS_CODES,
  type ProductKitCarouselState,
  type ProductKitOrderFormState,
  type ProductKitPartErrorCode,
  type ProductShopWordsCode,
} from "@/lib/products/types";
import type { WhatsAppFlowConfig } from "@icecore/scenario-contracts";
import type { WhatsAppComponent } from "@icecore/shared/types/whatsapp";

/** Why a part wasn't made; `message` is Meta's own words for a refusal. */
export type ProductKitStoredError = {
  code: ProductKitPartErrorCode;
  message?: string | null;
};

/** A product's price as the kit wrote it for buyers. */
export type ProductKitPrice = {
  productId: string;
  price: number | null;
  currency: string | null;
  priceIsFrom: boolean;
};

/** A template an earlier send left at Meta, before "Edit and send again" sent a new one. */
export type ProductKitStoredEarlierTemplate = {
  templateId?: string | null;
  templateName?: string | null;
  metaStatus?: string | null;
  replacedAt: Date;
};

/** A Flow an earlier version published, before "Edit order form" published a new one. */
export type ProductKitStoredEarlierFlow = {
  flowId?: string | null;
  flowName?: string | null;
  replacedAt: Date;
};

/** The most earlier templates or Flows a part remembers. */
export const PRODUCT_KIT_EARLIER_MAX = 10;

/** The biggest edited carousel a kit keeps, as JSON: checked before it's saved. */
export const PRODUCT_KIT_COMPONENTS_MAX_BYTES = 16 * 1024;

/** The order form: a WhatsApp Flow, published when Meta takes it. */
export interface IProductKitOrderFormPart {
  state: ProductKitOrderFormState;
  flowId?: string | null;
  flowName?: string | null;
  productCount: number;
  /** The prices its products were listed with, as last made; older kits have none. */
  prices?: ProductKitPrice[] | null;
  error?: ProductKitStoredError | null;
  /** When this part last changed: one "making" too long has timed out. */
  updatedAt: Date;
  // Studio v2: editing. All optional: kits from before read as not edited, version 1.
  /** The questions as sent; absent for kits from before v2. */
  config?: WhatsAppFlowConfig | null;
  /** Whether `config` is the owner's edit rather than the shelf's. */
  edited?: boolean;
  /** 1 for the form Make published; one more per "Edit order form" on a ready one. */
  version?: number;
  earlier?: ProductKitStoredEarlierFlow[];
  /** The latest edit's request id: a repeat of it returns the kit as it is. */
  lastEditRequestId?: string | null;
}

/** The carousel: a marketing template sent to Meta for review. */
export interface IProductKitCarouselPart {
  state: ProductKitCarouselState;
  /** Meta's id for the template. */
  templateId?: string | null;
  templateName?: string | null;
  /** The template's row in airi's Templates, which Meta's status webhooks keep current. */
  templateRowId?: string | null;
  cardCount: number;
  /** The prices on its cards, as last made; older kits have none. */
  prices?: ProductKitPrice[] | null;
  /** Meta's status and reason, as last read. */
  metaStatus?: string | null;
  metaReason?: string | null;
  approvedAt?: Date | null;
  /** When it went to Meta: one pending for long is read from Meta itself. */
  submittedAt?: Date | null;
  /** When Meta's status was last read, so a pending one is read again later. */
  checkedAt?: Date | null;
  error?: ProductKitStoredError | null;
  updatedAt: Date;
  // Studio v2: editing. All optional: kits from before read as not edited.
  /**
   * The template components as sent, at most PRODUCT_KIT_COMPONENTS_MAX_BYTES
   * as JSON; absent for kits from before v2.
   */
  components?: WhatsAppComponent[] | null;
  /** Whether `components` are the owner's edit rather than the shelf's. */
  edited?: boolean;
  earlier?: ProductKitStoredEarlierTemplate[];
  /** The latest edit's request id: a repeat of it returns the kit as it is. */
  lastEditRequestId?: string | null;
}

/**
 * A kit (Products): the carousel and order form one press made from shelf
 * products, each part saved as it settles. A part that was made is never
 * undone, so a failed one is made again on its own.
 */
export interface IProductKit {
  _id: mongoose.Types.ObjectId;
  workspaceId: string;
  /** The page's id for the press: a repeat finds this kit instead of making another. */
  requestId: string;
  createdBy: string;
  /** The language buyers read it in. */
  language: ProductShopWordsCode;
  /** The products, in shelf order. */
  productIds: string[];
  /** The import whose review it was made from; null for products chosen on the shelf. */
  importId?: string | null;
  /** The owner's time zone, for the time in the form's name; null for UTC. */
  timeZone?: string | null;
  /**
   * The prices it was first made with; each part keeps its own since a part
   * can be made again at newer ones. Kits from before keep only these.
   */
  prices?: ProductKitPrice[];
  /** Only the parts asked for. */
  parts: {
    orderForm?: IProductKitOrderFormPart | null;
    carousel?: IProductKitCarouselPart | null;
  };
  createdAt: Date;
  updatedAt: Date;
}

const PartErrorSchema = new mongoose.Schema<ProductKitStoredError>(
  {
    code: { type: String, required: true, enum: PRODUCT_KIT_PART_ERROR_CODES },
    message: { type: String, maxlength: 300, default: null },
  },
  { _id: false }
);

const PriceSchema = new mongoose.Schema<ProductKitPrice>(
  {
    productId: { type: String, required: true, maxlength: 64 },
    price: { type: Number, default: null },
    currency: { type: String, maxlength: 8, default: null },
    priceIsFrom: { type: Boolean, default: false },
  },
  { _id: false }
);

const EarlierTemplateSchema =
  new mongoose.Schema<ProductKitStoredEarlierTemplate>(
    {
      templateId: { type: String, default: null },
      templateName: { type: String, maxlength: 512, default: null },
      metaStatus: { type: String, maxlength: 40, default: null },
      replacedAt: { type: Date, required: true },
    },
    { _id: false }
  );

const EarlierFlowSchema = new mongoose.Schema<ProductKitStoredEarlierFlow>(
  {
    flowId: { type: String, default: null },
    flowName: { type: String, maxlength: 200, default: null },
    replacedAt: { type: Date, required: true },
  },
  { _id: false }
);

const atMostEarlier = {
  validator: (entries: unknown[] | undefined) =>
    !entries || entries.length <= PRODUCT_KIT_EARLIER_MAX,
  message: `A kit part remembers at most ${PRODUCT_KIT_EARLIER_MAX} earlier sends`,
};

const OrderFormPartSchema = new mongoose.Schema<IProductKitOrderFormPart>(
  {
    state: {
      type: String,
      required: true,
      enum: PRODUCT_KIT_ORDER_FORM_STATES,
    },
    flowId: { type: String, default: null },
    flowName: { type: String, maxlength: 200, default: null },
    productCount: { type: Number, default: 0, min: 0 },
    prices: { type: [PriceSchema], default: undefined },
    error: { type: PartErrorSchema, default: null },
    updatedAt: { type: Date, required: true },
    config: { type: mongoose.Schema.Types.Mixed, default: undefined },
    edited: { type: Boolean, default: undefined },
    version: { type: Number, min: 1, default: undefined },
    earlier: {
      type: [EarlierFlowSchema],
      default: undefined,
      validate: atMostEarlier,
    },
    lastEditRequestId: { type: String, maxlength: 64, default: undefined },
  },
  { _id: false }
);

const CarouselPartSchema = new mongoose.Schema<IProductKitCarouselPart>(
  {
    state: { type: String, required: true, enum: PRODUCT_KIT_CAROUSEL_STATES },
    templateId: { type: String, default: null },
    templateName: { type: String, maxlength: 512, default: null },
    templateRowId: { type: String, maxlength: 64, default: null },
    cardCount: { type: Number, default: 0, min: 0 },
    prices: { type: [PriceSchema], default: undefined },
    metaStatus: { type: String, maxlength: 40, default: null },
    metaReason: { type: String, maxlength: 300, default: null },
    approvedAt: { type: Date, default: null },
    submittedAt: { type: Date, default: null },
    checkedAt: { type: Date, default: null },
    error: { type: PartErrorSchema, default: null },
    updatedAt: { type: Date, required: true },
    components: { type: mongoose.Schema.Types.Mixed, default: undefined },
    edited: { type: Boolean, default: undefined },
    earlier: {
      type: [EarlierTemplateSchema],
      default: undefined,
      validate: atMostEarlier,
    },
    lastEditRequestId: { type: String, maxlength: 64, default: undefined },
  },
  { _id: false }
);

const ProductKitSchema = new mongoose.Schema<IProductKit>(
  {
    workspaceId: { type: String, required: true, trim: true, maxlength: 64 },
    requestId: { type: String, required: true, trim: true, maxlength: 64 },
    createdBy: { type: String, required: true },
    language: { type: String, required: true, enum: PRODUCT_SHOP_WORDS_CODES },
    productIds: {
      type: [{ type: String, maxlength: 64 }],
      required: true,
      validate: {
        validator: (ids: string[]) => ids.length >= 1 && ids.length <= 60,
        message: "A kit has 1 to 60 products",
      },
    },
    importId: { type: String, maxlength: 64, default: null },
    timeZone: { type: String, maxlength: 64, default: null },
    prices: { type: [PriceSchema], default: [] },
    parts: {
      orderForm: { type: OrderFormPartSchema, default: null },
      carousel: { type: CarouselPartSchema, default: null },
    },
  },
  { timestamps: true, collection: "product_kits" }
);

// One kit per press, however often it's sent.
ProductKitSchema.index(
  { workspaceId: 1, requestId: 1 },
  { name: "product_kit_request", unique: true }
);

ProductKitSchema.index(
  { workspaceId: 1, createdAt: -1 },
  { name: "product_kit_workspace_recent" }
);

export const ProductKit =
  (mongoose.models.ProductKit as mongoose.Model<IProductKit> | undefined) ||
  mongoose.model<IProductKit>("ProductKit", ProductKitSchema);
