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
import { Reply, X } from "lucide-react";
import { useState } from "react";
import { ProductSegmented } from "./product-controls";
import styles from "./product-buyers-preview.module.css";

// "What buyers see": the carousel and the order form as WhatsApp shows them,
// built on the page from the real products and the same words the server
// sends Meta (kit-text.ts, shop-words.ts). It is a picture of the output, so
// it keeps WhatsApp's light look in both themes.

const COPY = PRODUCTS_COPY.make.preview;
type Tab = "carousel" | "orderForm";

export function BuyersPreview({
  products,
  language,
  spokenLanguage,
}: {
  products: readonly ProductKitPlanProduct[];
  /** The language buyers read it in. */
  language: ProductShopWordsCode;
  /** The language the owner spoke, which the caption names as theirs; null when it's none of these. */
  spokenLanguage: ProductShopWordsCode | null;
}) {
  const [tab, setTab] = useState<Tab>("carousel");
  const name = PRODUCTS_COPY.make.languages[language];
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
          <CarouselScreen products={products} language={language} />
        ) : (
          <FormScreen products={products} language={language} />
        )}
      </div>
      <p className={styles.caption}>
        {COPY.caption(name, language === spokenLanguage)}
      </p>
    </aside>
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
      <p className={styles.from}>
        <span className={styles.avatar} aria-hidden="true">
          A
        </span>
        {COPY.shop}
      </p>
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
