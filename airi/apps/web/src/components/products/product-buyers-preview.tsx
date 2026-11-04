"use client";

import { PRODUCTS_COPY } from "@/lib/products/copy";
import {
  carouselCardText,
  KIT_CAROUSEL_MAX_CARDS,
  ORDER_FORM_MAX_PRODUCTS,
  orderFormOption,
} from "@/lib/products/kit-text";
import { SHOP_WORDS } from "@/lib/products/shop-words";
import type {
  ProductKitPlanProduct,
  ProductShopWordsCode,
} from "@/lib/products/types";
import type {
  WhatsAppFlowConfig,
  WhatsAppFlowFieldConfig,
} from "@icecore/scenario-contracts";
import type { WhatsAppComponent } from "@icecore/shared/types/whatsapp";
import { ChevronDown, ExternalLink, Reply, X } from "lucide-react";
import { useState } from "react";
import { ProductSegmented } from "./product-controls";
import styles from "./product-buyers-preview.module.css";

// "What buyers see": the carousel and the order form as WhatsApp shows them,
// built on the page from the real products and the same words the server
// sends Meta (kit-text.ts, shop-words.ts), or from the owner's edits when
// there are some. It is a picture of the output, so it keeps WhatsApp's
// light look in both themes.

const COPY = PRODUCTS_COPY.make.preview;
type Tab = "carousel" | "orderForm";

export function BuyersPreview({
  products,
  language,
  spokenLanguage,
  carousel,
  orderForm,
}: {
  products: readonly ProductKitPlanProduct[];
  /** The language buyers read it in. */
  language: ProductShopWordsCode;
  /** The language the owner spoke, which the caption names as theirs; null when it's none of these. */
  spokenLanguage: ProductShopWordsCode | null;
  /** The owner's edited cards, drawn instead of the shelf's. */
  carousel?: { components: readonly WhatsAppComponent[] };
  /** The owner's edited questions, drawn instead of the shelf's. */
  orderForm?: { config: WhatsAppFlowConfig };
}) {
  const [tab, setTab] = useState<Tab>("carousel");
  const name = PRODUCTS_COPY.make.languages[language];
  const edited = Boolean(carousel || orderForm);
  return (
    <aside className={styles.preview} aria-label={COPY.title}>
      <div className={styles.head}>
        <p className={styles.title}>{COPY.title}</p>
        <ProductSegmented
          label={COPY.tabsLabel}
          value={tab}
          onChange={setTab}
          options={[
            { value: "carousel", label: COPY.tabs.carousel },
            { value: "orderForm", label: COPY.tabs.orderForm },
          ]}
        />
      </div>
      <div className={styles.screen} lang={language}>
        {tab === "carousel" ? (
          carousel ? (
            <EditedCarouselScreen components={carousel.components} />
          ) : (
            <CarouselScreen products={products} language={language} />
          )
        ) : orderForm ? (
          <OrderFormScreen config={orderForm.config} language={language} />
        ) : (
          <FormScreen products={products} language={language} />
        )}
      </div>
      <p className={styles.caption}>
        {edited
          ? COPY.captionEdited
          : COPY.caption(name, language === spokenLanguage)}
      </p>
    </aside>
  );
}

/** Who the message is from, above it. */
function ChatFrom() {
  return (
    <p className={styles.from}>
      <span className={styles.avatar} aria-hidden="true">
        A
      </span>
      {COPY.shop}
    </p>
  );
}

/** The chat: the message above the cards, then the cards as made, on white. */
function CarouselScreen({
  products,
  language,
}: {
  products: readonly ProductKitPlanProduct[];
  language: ProductShopWordsCode;
}) {
  const words = SHOP_WORDS[language];
  const cards = products
    .filter(product => product.hasPhoto)
    .slice(0, KIT_CAROUSEL_MAX_CARDS);
  return (
    <div className={styles.chat}>
      <ChatFrom />
      <p className={styles.bubble}>{words.carouselBody}</p>
      {cards.length > 0 ? (
        <ul className={styles.cards}>
          {cards.map(product => {
            const text = carouselCardText(product, words);
            return (
              <li key={product.id} className={styles.card}>
                <span className={styles.cardPicture}>
                  {product.imageUrl ? (
                    // Signed storage links; next/image would need every bucket host.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={product.imageUrl} alt="" draggable={false} />
                  ) : null}
                </span>
                <span className={styles.cardText}>
                  <span className={styles.cardName}>{text.name}</span>
                  {text.price ? (
                    <span className={styles.cardPrice}>{text.price}</span>
                  ) : null}
                </span>
                <span className={styles.cardButton}>
                  <Reply aria-hidden="true" />
                  {words.orderButton}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className={styles.empty}>{COPY.noCards}</p>
      )}
    </div>
  );
}

type TemplateButton = { type?: string; text?: string };
type TemplateCard = { components?: readonly WhatsAppComponent[] };

/** A card's picture, words and buttons, read from its template components. */
function readEditedCard(card: TemplateCard) {
  const parts = card.components ?? [];
  const header = parts.find(part => part.type === "HEADER") as
    | { example?: { header_handle?: unknown[] } }
    | undefined;
  const image = header?.example?.header_handle?.[0];
  const body = parts.find(part => part.type === "BODY") as
    | { text?: string }
    | undefined;
  const buttons = (
    parts.find(part => part.type === "BUTTONS") as
      | { buttons?: TemplateButton[] }
      | undefined
  )?.buttons;
  const [name = "", ...rest] = (body?.text ?? "").split("\n");
  return {
    image: typeof image === "string" ? image : null,
    name,
    rest: rest.join("\n"),
    buttons: buttons ?? [],
  };
}

/** The owner's edited cards, as WhatsApp shows them. */
function EditedCarouselScreen({
  components,
}: {
  components: readonly WhatsAppComponent[];
}) {
  const body = components.find(part => part.type === "BODY") as
    | { text?: string }
    | undefined;
  const carousel = components.find(part => part.type === "CAROUSEL") as
    | { cards?: TemplateCard[] }
    | undefined;
  const cards = (carousel?.cards ?? []).map(readEditedCard);
  return (
    <div className={styles.chat}>
      <ChatFrom />
      {body?.text ? <p className={styles.bubble}>{body.text}</p> : null}
      {cards.length > 0 ? (
        <ul className={styles.cards}>
          {cards.map((card, index) => (
            <li key={index} className={styles.card}>
              <span className={styles.cardPicture}>
                {card.image ? (
                  // The owner's storage links; next/image would need every bucket host.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={card.image} alt="" draggable={false} />
                ) : null}
              </span>
              <span className={styles.cardText}>
                <span className={styles.cardName}>{card.name}</span>
                {card.rest ? (
                  <span className={styles.cardPrice}>{card.rest}</span>
                ) : null}
              </span>
              {card.buttons.map((button, buttonIndex) => (
                <span key={buttonIndex} className={styles.cardButton}>
                  {button.type === "URL" ? (
                    <ExternalLink aria-hidden="true" />
                  ) : (
                    <Reply aria-hidden="true" />
                  )}
                  {button.text}
                </span>
              ))}
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.empty}>{COPY.noCards}</p>
      )}
    </div>
  );
}

/** The order form's one screen, as the Flow opens it. */
function FormScreen({
  products,
  language,
}: {
  products: readonly ProductKitPlanProduct[];
  language: ProductShopWordsCode;
}) {
  const words = SHOP_WORDS[language];
  const listed = products.slice(0, ORDER_FORM_MAX_PRODUCTS);
  return (
    <div className={styles.form}>
      <p className={styles.formBar}>
        <X aria-hidden="true" />
        <span>{words.form.title}</span>
      </p>
      <div className={styles.formBody}>
        <p className={styles.formQuestion}>{words.form.products}</p>
        <ul className={styles.options}>
          {listed.map(product => {
            const option = orderFormOption(product, words);
            return (
              <li key={product.id} className={styles.option}>
                <span className={styles.box} aria-hidden="true" />
                <span>
                  <span className={styles.optionTitle}>{option.title}</span>
                  {option.description ? (
                    <span className={styles.optionPrice}>
                      {option.description}
                    </span>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
        {[words.form.name, words.form.address, words.form.comment].map(
          label => (
            <p key={label} className={styles.field}>
              {label}
            </p>
          )
        )}
      </div>
      <p className={styles.submit}>{words.form.submit}</p>
    </div>
  );
}

/** One question of an edited form, as WhatsApp draws it. */
function FormQuestion({ field }: { field: WhatsAppFlowFieldConfig }) {
  const label = `${field.label}${field.required ? " *" : ""}`;
  switch (field.fieldType) {
    case "CheckboxGroup":
    case "RadioButtonsGroup":
      return (
        <div className={styles.question}>
          <p className={styles.formQuestion}>{label}</p>
          <ul className={styles.options}>
            {(field.options ?? []).map(option => (
              <li key={option.id} className={styles.option}>
                <span
                  className={
                    field.fieldType === "RadioButtonsGroup"
                      ? styles.radio
                      : styles.box
                  }
                  aria-hidden="true"
                />
                <span>
                  <span className={styles.optionTitle}>{option.title}</span>
                  {option.description ? (
                    <span className={styles.optionPrice}>
                      {option.description}
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      );
    case "Dropdown":
      return (
        <p className={`${styles.field} ${styles.select}`}>
          <span>{label}</span>
          <ChevronDown aria-hidden="true" />
        </p>
      );
    case "TextArea":
      return <p className={`${styles.field} ${styles.area}`}>{label}</p>;
    case "TextInput":
    case "DatePicker":
      return <p className={styles.field}>{label}</p>;
    default:
      return <p className={styles.other}>{COPY.otherField(label)}</p>;
  }
}

/**
 * A screen of an edited order form, as the Flow opens it: by default the
 * first. Also the Flow editor's preview in "Edit questions".
 */
export function OrderFormScreen({
  config,
  language,
  screenId,
}: {
  config: WhatsAppFlowConfig;
  language: ProductShopWordsCode;
  screenId?: string;
}) {
  const words = SHOP_WORDS[language];
  const screens = config.screens;
  const screen =
    screens.find(candidate => candidate.id === screenId) ?? screens[0];
  if (!screen) return null;
  const submit =
    screen.footer?.label || config.flowSubmitLabel || words.form.submit;
  return (
    <div className={styles.form} lang={language}>
      <p className={styles.formBar}>
        <X aria-hidden="true" />
        <span>{screen.title || words.form.title}</span>
      </p>
      <div className={styles.formBody}>
        {screen.fields.length > 0 ? (
          screen.fields.map(field => (
            <FormQuestion key={field.id} field={field} />
          ))
        ) : (
          <p className={styles.other}>{COPY.noQuestions}</p>
        )}
      </div>
      <p className={styles.submit}>{submit}</p>
    </div>
  );
}
