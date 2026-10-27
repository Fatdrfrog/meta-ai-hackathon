"use client";

import { Dialog, DialogTrigger } from "@/components/ui/dialog";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Pause,
  Play,
} from "lucide-react";
import { useTranslations } from "next-intl";
import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { HeroFeatureCardPreview } from "./hero-feature-card-previews";
import {
  HERO_WORKFLOWS,
  HERO_WORKFLOW_COLUMNS,
  type HeroWorkflow,
} from "./hero-workflow-definitions";
import { HeroWorkflowExplorer } from "./hero-workflow-explorer";
import s from "./landing-workflow-studio.module.css";

const subscribeToHydration = () => () => undefined;
const getClientHydrationSnapshot = () => true;
const getServerHydrationSnapshot = () => false;
const reducedMotionQuery = "(prefers-reduced-motion: reduce)";
const subscribeToReducedMotion = (onChange: () => void) => {
  const query = window.matchMedia(reducedMotionQuery);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
};
const getReducedMotionSnapshot = () =>
  window.matchMedia(reducedMotionQuery).matches;
const getServerReducedMotionSnapshot = () => true;
const SCROLL_PIXELS_PER_SECOND = 40;

const FeatureCard = memo(function FeatureCard({
  workflow,
  priority = false,
  interactive = false,
}: {
  workflow: HeroWorkflow;
  priority?: boolean;
  interactive?: boolean;
}) {
  const t = useTranslations("LandingDemo.featureCards");
  return (
    <article
      data-feature-card={workflow.id}
      data-tone={workflow.tone}
      className={s.card}
    >
      <div className={s.cardHeader}>
        <h3>{t(`cards.${workflow.id}.title`)}</h3>
      </div>
      <HeroFeatureCardPreview
        kind={workflow.preview}
        priority={priority}
        interactive={interactive}
        compact
      />
    </article>
  );
});

function ScrollColumn({
  workflows,
  direction,
  paused,
  animate,
  staticLayout,
}: {
  workflows: readonly HeroWorkflow[];
  direction: "up" | "down";
  paused: boolean;
  animate: boolean;
  staticLayout: boolean;
}) {
  const t = useTranslations("LandingDemo.featureCards");
  const viewportRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const sequenceRef = useRef<HTMLDivElement>(null);
  const heightRef = useRef(0);
  const scrollRemainderRef = useRef(0);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const browsing = hovered || focused;
  const stopped = paused || browsing;

  // Autoplay uses a compositor transform: native scrollTop rounds small steps
  // on some displays. Transfer to native scrolling only for manual reading.
  useLayoutEffect(() => {
    const sequence = sequenceRef.current;
    const viewport = viewportRef.current;
    const track = trackRef.current;
    if (!sequence || !viewport || !track) return;
    if (staticLayout) {
      track.style.transform = "";
      viewport.scrollTop = 0;
      scrollRemainderRef.current = 0;
      heightRef.current = 0;
      return;
    }

    let animation: Animation | undefined;
    let duration = 0;
    const setPosition = (position: number) => {
      viewport.scrollTop = position;
      // Keep the fraction native scrolling cannot represent, including at pause.
      scrollRemainderRef.current = viewport.scrollTop - position;
      track.style.transform = `translate3d(0, ${scrollRemainderRef.current}px, 0)`;
    };
    const freeze = () => {
      if (!animation) return;
      const progress =
        (Number(animation.currentTime ?? 0) % duration) / duration;
      const height = heightRef.current;
      setPosition(
        height * (direction === "up" ? 0.5 + progress : 1.5 - progress)
      );
      animation.cancel();
      animation = undefined;
    };
    const measure = () => {
      const height = sequence.getBoundingClientRect().height;
      if (!height || (height === heightRef.current && animation)) return;
      freeze();
      const previousHeight = heightRef.current;
      const offset = previousHeight
        ? (viewport.scrollTop - scrollRemainderRef.current) / previousHeight
        : 1;
      heightRef.current = height;
      // Stay in the middle copy; either loop boundary shows identical content.
      const phase = (((offset - 0.5) % 1) + 1) % 1;
      setPosition((0.5 + phase) * height);
      if (!animate || stopped || typeof track.animate !== "function") return;

      const start = viewport.scrollTop - height * 0.5;
      const end = start - height;
      duration = (height / SCROLL_PIXELS_PER_SECOND) * 1000;
      animation = track.animate(
        [
          {
            transform: `translate3d(0, ${direction === "up" ? start : end}px, 0)`,
          },
          {
            transform: `translate3d(0, ${direction === "up" ? end : start}px, 0)`,
          },
        ],
        { duration, iterations: Infinity, easing: "linear" }
      );
      animation.currentTime =
        (direction === "up" ? phase : 1 - phase) * duration;
    };
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(measure);
    observer?.observe(sequence);
    return () => {
      observer?.disconnect();
      freeze();
    };
  }, [animate, direction, staticLayout, stopped]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !stopped || staticLayout) return;
    const onScroll = () => {
      const height = heightRef.current;
      if (!height) return;
      if (viewport.scrollTop < height / 2) viewport.scrollTop += height;
      else if (viewport.scrollTop >= height * 1.5) viewport.scrollTop -= height;
    };
    // Autoplay needs no scroll handler or React event work on each frame.
    viewport.addEventListener("scroll", onScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", onScroll);
  }, [staticLayout, stopped]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !browsing || staticLayout) return;
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
      event.preventDefault();
      const scale =
        event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? viewport.clientHeight
            : 1;
      viewport.scrollTop += event.deltaX * scale;
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, [browsing, staticLayout]);

  const scroll = (sign: -1 | 1) => {
    const viewport = viewportRef.current;
    if (viewport) viewport.scrollTop += sign * viewport.clientHeight * 0.55;
  };
  const copy = () => (
    <div
      className={s.sequence}
      data-testid="hero-scroll-copy"
      aria-hidden="true"
      inert
    >
      {workflows.map(workflow => (
        <FeatureCard key={workflow.id} workflow={workflow} />
      ))}
    </div>
  );
  return (
    <div
      className={s.column}
      data-scroll-direction={direction}
      data-browsing={browsing}
      onPointerEnter={event => {
        if (event.pointerType !== "touch") setHovered(true);
      }}
      onPointerLeave={() => setHovered(false)}
      onPointerCancel={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={event => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setFocused(false);
      }}
    >
      <div
        ref={viewportRef}
        className={s.columnViewport}
        data-column-viewport
        role="region"
        aria-label={workflows
          .map(workflow => t(`cards.${workflow.id}.badge`))
          .join(" · ")}
        tabIndex={staticLayout ? undefined : 0}
        onKeyDown={event => {
          if (event.target !== event.currentTarget || staticLayout) return;
          if (
            ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(
              event.key
            )
          ) {
            event.preventDefault();
            scroll(
              event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1
            );
          }
        }}
      >
        <div
          ref={trackRef}
          className={s.track}
          data-testid="hero-scroll-track"
          data-direction={direction}
          data-animate={animate}
          data-paused={stopped}
        >
          {!staticLayout && copy()}
          <div className={s.sequence} ref={sequenceRef}>
            {workflows.map(workflow => (
              <FeatureCard
                key={workflow.id}
                workflow={workflow}
                priority={workflow.id === "interactive"}
              />
            ))}
          </div>
          {!staticLayout && copy()}
        </div>
      </div>
      {!staticLayout && (
        <div className={s.columnNavigation}>
          <button
            type="button"
            aria-label={t("scrollUp")}
            onClick={() => scroll(-1)}
          >
            <ArrowUp size={18} aria-hidden />
          </button>
          <span>{t("scrollHint")}</span>
          <button
            type="button"
            aria-label={t("scrollDown")}
            onClick={() => scroll(1)}
          >
            <ArrowDown size={18} aria-hidden />
          </button>
        </div>
      )}
    </div>
  );
}

export function HeroFeatureCards() {
  const t = useTranslations("LandingDemo.featureCards");
  const mobile = useIsMobile();
  const reducedMotion = useSyncExternalStore(
    subscribeToReducedMotion,
    getReducedMotionSnapshot,
    getServerReducedMotionSnapshot
  );
  const hydrated = useSyncExternalStore(
    subscribeToHydration,
    getClientHydrationSnapshot,
    getServerHydrationSnapshot
  );
  const showcaseRef = useRef<HTMLDivElement>(null);
  const [manualPaused, setManualPaused] = useState(false);
  const [focused, setFocused] = useState(false);
  const [visible, setVisible] = useState(true);
  const [documentHidden, setDocumentHidden] = useState(false);
  const [explorerOpen, setExplorerOpen] = useState(false);
  const [mobileIndex, setMobileIndex] = useState(0);
  const [interactionViewport, setInteractionViewport] = useState(mobile);

  // Dialog replaces its root at this breakpoint, so transient interaction ends.
  if (interactionViewport !== mobile) {
    setInteractionViewport(mobile);
    setFocused(false);
  }

  useEffect(() => {
    // Reconcile focus after the motion control is added or removed.
    const frame = requestAnimationFrame(() => {
      setFocused(
        Boolean(showcaseRef.current?.contains(document.activeElement)) &&
          !document.activeElement?.closest("[data-scroll-direction]")
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [reducedMotion]);

  useEffect(() => {
    const onVisibility = () => setDocumentHidden(document.hidden);
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    const element = showcaseRef.current;
    const observer =
      element && typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver(([entry]) =>
            setVisible(Boolean(entry?.isIntersecting))
          )
        : undefined;
    if (element) observer?.observe(element);
    return () => {
      observer?.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [mobile, hydrated]);

  const paused =
    manualPaused || focused || explorerOpen || !visible || documentHidden;
  const selected = HERO_WORKFLOWS[mobileIndex]!;

  return (
    <Dialog open={explorerOpen} onOpenChange={setExplorerOpen}>
      <div
        ref={showcaseRef}
        className={s.showcase}
        data-testid="hero-showcase"
        data-static={Boolean(reducedMotion)}
        onFocusCapture={event => {
          setFocused(
            !(event.target as HTMLElement).closest("[data-scroll-direction]")
          );
        }}
        onBlurCapture={event => {
          if (!event.currentTarget.contains(event.relatedTarget))
            setFocused(false);
        }}
      >
        <div className={s.showcaseCaption}>
          <span>{t("label")}</span>
          <span>{t("example")}</span>
        </div>
        {mobile || !hydrated ? (
          <div className={s.mobileReader} data-mobile-reader>
            <FeatureCard
              key={selected.id}
              workflow={selected}
              interactive
              priority={selected.id === "interactive"}
            />
            <div className={s.readerControls}>
              <button
                type="button"
                className={s.iconButton}
                aria-label={t("previous")}
                onClick={() =>
                  setMobileIndex(
                    index =>
                      (index + HERO_WORKFLOWS.length - 1) %
                      HERO_WORKFLOWS.length
                  )
                }
              >
                <ArrowLeft size={19} aria-hidden />
              </button>
              <span role="status">
                {t("progress", {
                  current: mobileIndex + 1,
                  total: HERO_WORKFLOWS.length,
                })}{" "}
                · {t(`cards.${selected.id}.badge`)}
              </span>
              <button
                type="button"
                className={s.iconButton}
                aria-label={t("next")}
                onClick={() =>
                  setMobileIndex(index => (index + 1) % HERO_WORKFLOWS.length)
                }
              >
                <ArrowRight size={19} aria-hidden />
              </button>
            </div>
          </div>
        ) : (
          <div className={s.columns}>
            {HERO_WORKFLOW_COLUMNS.map((workflows, index) => (
              <ScrollColumn
                key={index}
                workflows={workflows}
                direction={index === 0 ? "down" : "up"}
                paused={paused}
                animate={hydrated && !reducedMotion}
                staticLayout={Boolean(reducedMotion)}
              />
            ))}
          </div>
        )}
        <div className={s.showcaseControls}>
          {hydrated && !mobile && !reducedMotion ? (
            <button
              type="button"
              className={s.textButton}
              data-motion-control
              aria-pressed={manualPaused}
              onClick={() => setManualPaused(value => !value)}
            >
              {manualPaused ? (
                <Play size={14} aria-hidden />
              ) : (
                <Pause size={14} aria-hidden />
              )}
              {t(manualPaused ? "play" : "pause")}
            </button>
          ) : (
            <span className={s.exampleLabel}>{t("previewLabel")}</span>
          )}
          <DialogTrigger asChild>
            <button type="button" className={s.textButton}>
              {t("explore")}
              <ArrowRight size={17} aria-hidden />
            </button>
          </DialogTrigger>
        </div>
      </div>
      {explorerOpen && <HeroWorkflowExplorer initialWorkflow={selected} />}
    </Dialog>
  );
}
