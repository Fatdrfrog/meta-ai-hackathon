"use client";

import { Button } from "@/components/ui/button";
import { CarouselCardsScroller } from "@/components/whatsapp/carousel-cards-scroller";
import { cn } from "@/lib/utils";
import {
  ArrowLeft,
  Bookmark,
  Camera,
  Check,
  CheckCheck,
  ChevronRight,
  CircleAlert,
  FileText,
  Heart,
  Instagram,
  MessageCircle,
  Mic,
  MoreHorizontal,
  Paperclip,
  Phone,
  Reply,
  Send,
  Smile,
  ImageOff,
  Video,
} from "lucide-react";
import Image from "next/image";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { HeroCardPreviewKind } from "./hero-workflow-definitions";
import { LandingCampaignAudience } from "./landing-campaign-audience";
import { LandingRevenuePreview } from "./landing-revenue-preview";
import { LANDING_CAMPAIGN_SAMPLE } from "./landing-workflow-sample";
import s from "./landing-workflow-studio.module.css";

export type { HeroCardPreviewKind } from "./hero-workflow-definitions";

export function ProductImage({
  className,
  priority = false,
  image = "collection",
  src,
  alt,
}: {
  className?: string;
  priority?: boolean;
  src?: string;
  alt?: string;
  image?:
    | "collection"
    | "instagram"
    | "campaign"
    | "story"
    | "catalog"
    | "display"
    | "vase"
    | "textile";
}) {
  const t = useTranslations("LandingDemo.featureCards");
  const [failed, setFailed] = useState(false);
  return (
    <div className={cn(s.productImage, className)}>
      {failed ? (
        <div className={s.imageFallback}>
          <ImageOff aria-hidden />
          <span>{t("imageUnavailable")}</span>
        </div>
      ) : (
        <Image
          src={src ?? `/landing/home-${image}.webp`}
          alt={
            alt ??
            (image === "collection" ? t("imageAlt") : t(`imageAlts.${image}`))
          }
          fill
          priority={priority}
          sizes="(max-width: 767px) 90vw, (max-width: 1199px) 42vw, 380px"
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
}

export function Bubble({
  children,
  outgoing = false,
  time,
}: {
  children: ReactNode;
  outgoing?: boolean;
  time?: string;
}) {
  return (
    <div className={cn(s.bubble, outgoing && s.outgoing)}>
      <p>{children}</p>
      {time && (
        <span className={s.timestamp}>
          {time}
          {outgoing && <CheckCheck size={13} aria-hidden />}
        </span>
      )}
    </div>
  );
}

function ShopName() {
  const t = useTranslations("LandingDemo.featureCards.previews.common");
  return (
    <div className={s.shopName}>
      <span aria-hidden className={s.shopMonogram}>
        F.
      </span>
      <span>{t("shop")}</span>
    </div>
  );
}

export function WhatsAppConversation({
  children,
  backAction,
  className,
}: {
  children: ReactNode;
  backAction?: ReactNode;
  className?: string;
}) {
  const t = useTranslations("LandingDemo.featureCards.previews.common");
  return (
    <div
      className={cn(s.whatsappPreview, className)}
      role="region"
      aria-label={t("conversationLabel")}
    >
      <div className={s.whatsappHeader}>
        {backAction ?? (
          <ArrowLeft size={21} className={s.whatsappBackIcon} aria-hidden />
        )}
        <span className={s.instagramAvatar} aria-hidden>
          F.
        </span>
        <div className={s.whatsappContact}>
          <strong>{t("shop")}</strong>
          <span>{t("businessAccount")}</span>
        </div>
        <Video size={19} aria-hidden />
        <Phone size={17} aria-hidden />
      </div>
      <div className={s.whatsappMessages}>
        <span className={s.whatsappDate}>{t("today")}</span>
        {children}
      </div>
      <div className={s.whatsappComposer} aria-hidden>
        <div>
          <Smile size={19} />
          <span>{t("message")}</span>
          <Paperclip size={18} />
          <Camera size={18} />
        </div>
        <span>
          <Mic size={19} />
        </span>
      </div>
    </div>
  );
}

function CarouselPreview({
  interactive,
  priority,
}: {
  interactive: boolean;
  priority: boolean;
}) {
  const t = useTranslations("LandingDemo.featureCards");
  const [colour, setColour] = useState<"cream" | "terracotta" | null>(null);
  return (
    <div className={s.carouselScene}>
      <WhatsAppConversation className={s.carouselChat}>
        <Bubble outgoing time="10:02">
          {t("previews.carousel.question")}
        </Bubble>
        <Bubble time="10:03">{t("previews.carousel.answer")}</Bubble>
        <div
          className={s.messageCarousel}
          role={interactive ? "group" : undefined}
          aria-label={interactive ? t("previews.carousel.choose") : undefined}
        >
          <CarouselCardsScroller
            interactive={interactive}
            persistentNavigation
            viewportClassName={s.messageCarouselViewport}
            navigationClassName={s.messageCarouselArrow}
            previousLabel={t("previews.carousel.previous")}
            nextLabel={t("previews.carousel.next")}
          >
            {(["cream", "terracotta"] as const).map(value => (
              <div key={value} className={s.messageProductCard}>
                <ProductImage
                  image={value === "cream" ? "campaign" : "catalog"}
                  priority={priority && value === "cream"}
                  className={s.messageProductPhoto}
                />
                <div className={s.messageProductBody}>
                  <strong>{t("previews.common.product")}</strong>
                  <span>{t(`previews.common.${value}`)}</span>
                  <span>{t("previews.common.price")}</span>
                  <span className={s.timestamp}>10:03</span>
                </div>
                {interactive ? (
                  <button
                    className={s.messageProductReply}
                    type="button"
                    onClick={() => setColour(value)}
                  >
                    <Reply size={16} aria-hidden />
                    {t(`previews.common.${value}`)}
                  </button>
                ) : (
                  <div className={s.messageProductReply}>
                    <Reply size={16} aria-hidden />
                    {t(`previews.common.${value}`)}
                  </div>
                )}
              </div>
            ))}
          </CarouselCardsScroller>
        </div>
        {interactive && (
          <div
            className={s.carouselReply}
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {colour && (
              <Bubble outgoing time="10:04">
                {t(`previews.common.${colour}`)}
              </Bubble>
            )}
          </div>
        )}
      </WhatsAppConversation>
    </div>
  );
}

function KnowledgePreview() {
  const t = useTranslations("LandingDemo.featureCards.previews.knowledge");
  return (
    <div className={s.knowledgeScene}>
      <ShopName />
      <Bubble>{t("question")}</Bubble>
      <Bubble outgoing>{t("answer")}</Bubble>
      <div className={s.sourceReceipt}>
        <FileText size={17} aria-hidden />
        <span>{t("citation")}</span>
        <span className={s.sourceRule} />
      </div>
    </div>
  );
}

function RemindersPreview() {
  const t = useTranslations("LandingDemo.featureCards.previews.reminders");
  return (
    <div className={s.remindersScene}>
      <ShopName />
      <Bubble outgoing time="10:02">
        {t("messageBody")}
      </Bubble>
      <div className={s.timeDivider}>
        <span />
        {t("waitLabel")}
        <span />
      </div>
      <Bubble outgoing time="10:02">
        {t("followUpBody")}
      </Bubble>
      <Bubble time="10:04">{t("reply")}</Bubble>
    </div>
  );
}

function SmartChatPreview({
  interactive,
  compact,
}: {
  interactive: boolean;
  compact: boolean;
}) {
  const t = useTranslations("LandingDemo.featureCards.previews.smartChat");
  const [showExclusions, setShowExclusions] = useState(false);
  return (
    <div className={s.draftScene}>
      <div className={s.draftHeading}>
        <span>{t("status")}</span>
        <span className={s.campaignChannel}>
          <Image src="/whatsapp.svg" width={14} height={14} alt="" />
          WhatsApp
        </span>
      </div>
      <LandingCampaignAudience />
      <div className={s.draftBody}>
        <div>
          {!compact && <h4>{t("title")}</h4>}
          <p>{t("answer")}</p>
        </div>
        <ProductImage image="vase" className={s.draftPhoto} />
      </div>
      <div className={s.campaignTemplate}>
        <span>{t("template")}</span>
        <span>
          <Check size={14} aria-hidden />
          {t("templateStatus")}
        </span>
      </div>
      {interactive ? (
        <>
          <Button
            variant="secondary"
            className={s.sceneButton}
            onClick={() => setShowExclusions(value => !value)}
            aria-expanded={showExclusions}
          >
            {t(showExclusions ? "hideExclusions" : "showExclusions")}
            <ChevronRight size={16} aria-hidden />
          </Button>
          {showExclusions && (
            <dl className={s.campaignExclusions}>
              <div>
                <dt>{t("purchased")}</dt>
                <dd>{LANDING_CAMPAIGN_SAMPLE.purchased}</dd>
              </div>
              <div>
                <dt>{t("unsubscribed")}</dt>
                <dd>{LANDING_CAMPAIGN_SAMPLE.unsubscribed}</dd>
              </div>
            </dl>
          )}
        </>
      ) : null}
      {!compact && <p className={s.approvalNote}>{t("approval")}</p>}
    </div>
  );
}

function MetaPreview({ compact }: { compact: boolean }) {
  const t = useTranslations("LandingDemo.featureCards.previews.meta");
  return (
    <div className={s.metaScene}>
      {!compact && (
        <div className={s.monitorLabel}>
          <span className={s.statusDot} />
          {t("quality")}
        </div>
      )}
      <div className={s.qualityNotice}>
        <CircleAlert size={22} aria-hidden />
        <div>
          <span className={s.qualityStatus}>{t("status")}</span>
          <h4>{t("title")}</h4>
          <p>{t("body")}</p>
        </div>
      </div>
      {!compact && <p className={s.qualityFootnote}>{t("note")}</p>}
    </div>
  );
}

function AdsPreview({ interactive }: { interactive: boolean }) {
  const t = useTranslations("LandingDemo.featureCards.previews.ads");
  const [showConversation, setShowConversation] = useState(false);
  const [liked, setLiked] = useState(false);
  const [saved, setSaved] = useState(false);
  const ctaRef = useRef<HTMLButtonElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const visited = useRef(false);
  useEffect(() => {
    if (showConversation) backRef.current?.focus({ preventScroll: true });
    else if (visited.current) ctaRef.current?.focus({ preventScroll: true });
  }, [showConversation]);

  const cta = (
    <>
      <Image src="/whatsapp.svg" width={18} height={18} alt="" />
      <span>{t("cta")}</span>
      <ChevronRight size={18} aria-hidden />
    </>
  );

  if (showConversation) {
    return (
      <div className={s.adsScene} data-ad-view="whatsapp">
        <WhatsAppConversation
          backAction={
            <button
              ref={backRef}
              type="button"
              className={s.nativeIconButton}
              aria-label={t("back")}
              onClick={() => setShowConversation(false)}
            >
              <ArrowLeft size={21} aria-hidden />
            </button>
          }
        >
          <div className={s.adReferral}>
            <ProductImage image="story" className={s.adReferralImage} />
            <div>
              <span>{t("source")}</span>
              <strong>{t("headline")}</strong>
            </div>
          </div>
          <Bubble outgoing time="14:22">
            {t("lead")}
          </Bubble>
          <Bubble time="14:23">{t("answer")}</Bubble>
        </WhatsAppConversation>
      </div>
    );
  }

  return (
    <div className={s.adsScene} data-ad-view="instagram">
      <div className={s.instagramPost}>
        <div className={s.instagramPlatform}>
          <Instagram size={17} aria-hidden />
          <span>Instagram</span>
        </div>
        <div className={s.instagramPostHeader}>
          <span className={s.instagramAvatar} aria-hidden>
            F.
          </span>
          <div>
            <strong>formahome</strong>
            <span>{t("sponsored")}</span>
          </div>
          <MoreHorizontal size={21} aria-hidden />
        </div>
        <ProductImage image="story" className={s.instagramCreative} />
        {interactive ? (
          <button
            ref={ctaRef}
            type="button"
            className={s.instagramCta}
            onClick={() => {
              visited.current = true;
              setShowConversation(true);
            }}
          >
            {cta}
          </button>
        ) : (
          <div className={s.instagramCta}>{cta}</div>
        )}
        <div className={s.instagramToolbar}>
          {interactive ? (
            <button
              type="button"
              className={s.nativeIconButton}
              aria-label={t("like")}
              aria-pressed={liked}
              onClick={() => setLiked(value => !value)}
            >
              <Heart
                size={23}
                fill={liked ? "currentColor" : "none"}
                aria-hidden
              />
            </button>
          ) : (
            <Heart size={23} aria-hidden />
          )}
          <MessageCircle size={23} aria-hidden />
          <Send size={23} aria-hidden />
          <span />
          {interactive ? (
            <button
              type="button"
              className={s.nativeIconButton}
              aria-label={t("save")}
              aria-pressed={saved}
              onClick={() => setSaved(value => !value)}
            >
              <Bookmark
                size={22}
                fill={saved ? "currentColor" : "none"}
                aria-hidden
              />
            </button>
          ) : (
            <Bookmark size={22} aria-hidden />
          )}
        </div>
        <p className={s.instagramCaption}>
          <strong>formahome</strong> {t("caption")}
        </p>
      </div>
    </div>
  );
}

function AssetsPreview({
  interactive,
  compact,
}: {
  interactive: boolean;
  compact: boolean;
}) {
  const t = useTranslations("LandingDemo.featureCards.previews.assets");
  const [placement, setPlacement] = useState<"story" | "catalog" | "ad">(
    "story"
  );
  return (
    <div className={s.assetsScene}>
      {!compact && <h4>{t("title")}</h4>}
      <div className={s.assetContactSheet}>
        {(["story", "catalog", "ad"] as const).map((value, index) => {
          const content = (
            <>
              <ProductImage
                image={
                  value === "ad"
                    ? "vase"
                    : value === "catalog"
                      ? "textile"
                      : "story"
                }
                className={index === 0 ? s.portraitAsset : s.squareAsset}
              />
              <span>{t(value)}</span>
            </>
          );
          return interactive ? (
            <button
              key={value}
              type="button"
              className={s.assetTile}
              aria-pressed={placement === value}
              aria-label={t(value)}
              onClick={() => setPlacement(value)}
            >
              {content}
            </button>
          ) : (
            <div key={value} className={s.assetTile}>
              {content}
            </div>
          );
        })}
      </div>
      {(interactive || !compact) && (
        <p className={s.assetHint} role={interactive ? "status" : undefined}>
          {interactive ? t("selected", { placement: t(placement) }) : t("hint")}
        </p>
      )}
    </div>
  );
}

function VoicePreview({ compact }: { compact: boolean }) {
  const t = useTranslations("LandingDemo.featureCards.previews.voice");
  return (
    <div className={s.voiceScene}>
      {!compact && (
        <div className={s.voiceTitle}>
          <Mic size={22} aria-hidden />
          <h4>{t("title")}</h4>
        </div>
      )}
      <div className={s.voiceScript}>
        <span>{t("scriptLabel")}</span>
        <p>{t("script")}</p>
      </div>
      <div className={s.waveform} aria-hidden>
        {[
          20, 38, 24, 52, 34, 62, 45, 28, 54, 68, 38, 58, 24, 48, 64, 32, 44,
          22, 52, 30, 18,
        ].map((height, index) => (
          <span key={index} style={{ height: `${height}%` }} />
        ))}
      </div>
      {!compact && <p className={s.voiceNote}>{t("note")}</p>}
    </div>
  );
}

export function HeroFeatureCardPreview({
  kind,
  interactive = false,
  priority = false,
  compact = false,
}: {
  kind: HeroCardPreviewKind;
  interactive?: boolean;
  priority?: boolean;
  compact?: boolean;
}) {
  let scene: ReactNode;
  switch (kind) {
    case "carousel":
      scene = <CarouselPreview interactive={interactive} priority={priority} />;
      break;
    case "knowledge":
      scene = <KnowledgePreview />;
      break;
    case "reminders":
      scene = <RemindersPreview />;
      break;
    case "smartChat":
      scene = <SmartChatPreview interactive={interactive} compact={compact} />;
      break;
    case "meta":
      scene = <MetaPreview compact={compact} />;
      break;
    case "analytics":
      scene = (
        <LandingRevenuePreview interactive={interactive} compact={compact} />
      );
      break;
    case "ads":
      scene = <AdsPreview interactive={interactive} />;
      break;
    case "assets":
      scene = <AssetsPreview interactive={interactive} compact={compact} />;
      break;
    case "voice":
      scene = <VoicePreview compact={compact} />;
      break;
  }
  return (
    <div
      className={s.preview}
      inert={!interactive ? true : undefined}
      aria-hidden={!interactive ? true : undefined}
      data-interactive={interactive}
    >
      {scene}
    </div>
  );
}
