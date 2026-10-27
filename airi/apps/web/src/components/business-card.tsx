"use client";

import { ExternalLink } from "lucide-react";
import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef } from "react";

// Type definitions for device motion events
interface DeviceMotionEventWithPermission extends Event {
  requestPermission?: () => Promise<string>;
}

interface DeviceMotionEventConstructor {
  new (): DeviceMotionEventWithPermission;
  prototype: DeviceMotionEventWithPermission;
  requestPermission?: () => Promise<string>;
}

declare global {
  interface Window {
    DeviceMotionEvent: DeviceMotionEventConstructor;
  }
}

interface LinkData {
  platform: string;
  url: string;
  icon: string;
  color: string;
  subtitle?: string;
}

interface BusinessCardData {
  name: string;
  title: string;
  company: string;
  description: string;
  links: LinkData[];
}

interface BusinessCardProps {
  data: BusinessCardData;
  className?: string;
  enableTilt?: boolean;
  enableMobileTilt?: boolean;
  mobileTiltSensitivity?: number;
}

const ANIMATION_CONFIG = {
  SMOOTH_DURATION: 600,
  INITIAL_DURATION: 1500,
  INITIAL_X_OFFSET: 70,
  INITIAL_Y_OFFSET: 60,
  DEVICE_BETA_OFFSET: 20,
} as const;

const DEFAULT_BEHIND_GRADIENT =
  "radial-gradient(farthest-side circle at var(--pointer-x) var(--pointer-y),hsla(266,100%,90%,var(--card-opacity)) 4%,hsla(266,50%,80%,calc(var(--card-opacity)*0.75)) 10%,hsla(266,25%,70%,calc(var(--card-opacity)*0.5)) 50%,hsla(266,0%,60%,0) 100%),radial-gradient(35% 52% at 55% 20%,#00ffaac4 0%,#073aff00 100%),radial-gradient(100% 100% at 50% 50%,#00c1ffff 1%,#073aff00 76%),conic-gradient(from 124deg at 50% 50%,#c137ffff 0%,#07c6ffff 40%,#07c6ffff 60%,#c137ffff 100%)";

const DEFAULT_INNER_GRADIENT =
  "linear-gradient(145deg,#60496e8c 0%,#71C4FF44 100%)";

const clamp = (value: number, min = 0, max = 100): number =>
  Math.min(Math.max(value, min), max);
const round = (value: number, precision = 3): number =>
  parseFloat(value.toFixed(precision));
const adjust = (
  value: number,
  fromMin: number,
  fromMax: number,
  toMin: number,
  toMax: number
): number =>
  round(toMin + ((toMax - toMin) * (value - fromMin)) / (fromMax - fromMin));
const easeInOutCubic = (x: number): number =>
  x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;

export default function BusinessCard({
  data,
  className = "",
  enableTilt = true,
  enableMobileTilt = false,
  mobileTiltSensitivity = 5,
}: BusinessCardProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  const animationHandlers = useMemo(() => {
    if (!enableTilt) return null;

    let rafId: number | null = null;

    const updateCardTransform = (
      offsetX: number,
      offsetY: number,
      card: HTMLElement,
      wrap: HTMLElement
    ) => {
      const width = card.clientWidth;
      const height = card.clientHeight;

      const percentX = clamp((100 / width) * offsetX);
      const percentY = clamp((100 / height) * offsetY);

      const centerX = percentX - 50;
      const centerY = percentY - 50;

      const properties = {
        "--pointer-x": `${percentX}%`,
        "--pointer-y": `${percentY}%`,
        "--background-x": `${adjust(percentX, 0, 100, 35, 65)}%`,
        "--background-y": `${adjust(percentY, 0, 100, 35, 65)}%`,
        "--pointer-from-center": `${clamp(Math.hypot(percentY - 50, percentX - 50) / 50, 0, 1)}`,
        "--pointer-from-top": `${percentY / 100}`,
        "--pointer-from-left": `${percentX / 100}`,
        "--rotate-x": `${round(-(centerX / 5))}deg`,
        "--rotate-y": `${round(centerY / 4)}deg`,
        "--card-opacity": "0.8",
      };

      Object.entries(properties).forEach(([property, value]) => {
        wrap.style.setProperty(property, value);
      });
    };

    const createSmoothAnimation = (
      duration: number,
      startX: number,
      startY: number,
      card: HTMLElement,
      wrap: HTMLElement
    ) => {
      const startTime = performance.now();
      const targetX = wrap.clientWidth / 2;
      const targetY = wrap.clientHeight / 2;

      const animationLoop = (currentTime: number) => {
        const elapsed = currentTime - startTime;
        const progress = clamp(elapsed / duration);
        const easedProgress = easeInOutCubic(progress);

        const currentX = adjust(easedProgress, 0, 1, startX, targetX);
        const currentY = adjust(easedProgress, 0, 1, startY, targetY);

        updateCardTransform(currentX, currentY, card, wrap);

        if (progress < 1) {
          rafId = requestAnimationFrame(animationLoop);
        }
      };

      rafId = requestAnimationFrame(animationLoop);
    };

    return {
      updateCardTransform,
      createSmoothAnimation,
      cancelAnimation: () => {
        if (rafId) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
      },
    };
  }, [enableTilt]);

  const handlePointerMove = useCallback(
    (event: PointerEvent) => {
      const card = cardRef.current;
      const wrap = wrapRef.current;

      if (!card || !wrap || !animationHandlers) return;

      const rect = card.getBoundingClientRect();
      animationHandlers.updateCardTransform(
        event.clientX - rect.left,
        event.clientY - rect.top,
        card,
        wrap
      );
    },
    [animationHandlers]
  );

  const handlePointerEnter = useCallback(() => {
    const card = cardRef.current;
    const wrap = wrapRef.current;

    if (!card || !wrap || !animationHandlers) return;

    animationHandlers.cancelAnimation();
    wrap.classList.add("active");
    card.classList.add("active");
  }, [animationHandlers]);

  const handlePointerLeave = useCallback(
    (event: PointerEvent) => {
      const card = cardRef.current;
      const wrap = wrapRef.current;

      if (!card || !wrap || !animationHandlers) return;

      animationHandlers.createSmoothAnimation(
        ANIMATION_CONFIG.SMOOTH_DURATION,
        event.offsetX,
        event.offsetY,
        card,
        wrap
      );
      wrap.classList.remove("active");
      card.classList.remove("active");
    },
    [animationHandlers]
  );

  const handleDeviceOrientation = useCallback(
    (event: DeviceOrientationEvent) => {
      const card = cardRef.current;
      const wrap = wrapRef.current;

      if (!card || !wrap || !animationHandlers) return;

      const { beta, gamma } = event;
      if (!beta || !gamma) return;

      animationHandlers.updateCardTransform(
        card.clientHeight / 2 + gamma * mobileTiltSensitivity,
        card.clientWidth / 2 +
          (beta - ANIMATION_CONFIG.DEVICE_BETA_OFFSET) * mobileTiltSensitivity,
        card,
        wrap
      );
    },
    [animationHandlers, mobileTiltSensitivity]
  );

  useEffect(() => {
    if (!enableTilt || !animationHandlers) return;

    const card = cardRef.current;
    const wrap = wrapRef.current;

    if (!card || !wrap) return;

    const pointerMoveHandler = handlePointerMove as EventListener;
    const pointerEnterHandler = handlePointerEnter as EventListener;
    const pointerLeaveHandler = handlePointerLeave as EventListener;
    const deviceOrientationHandler = handleDeviceOrientation as EventListener;

    const handleClick = () => {
      if (!enableMobileTilt || location.protocol !== "https:") return;
      if (typeof window.DeviceMotionEvent.requestPermission === "function") {
        window.DeviceMotionEvent.requestPermission().then((state: string) => {
          if (state === "granted") {
            window.addEventListener(
              "deviceorientation",
              deviceOrientationHandler
            );
          }
        });
      } else {
        window.addEventListener("deviceorientation", deviceOrientationHandler);
      }
    };

    card.addEventListener("pointerenter", pointerEnterHandler);
    card.addEventListener("pointermove", pointerMoveHandler);
    card.addEventListener("pointerleave", pointerLeaveHandler);
    card.addEventListener("click", handleClick);

    const initialX = wrap.clientWidth - ANIMATION_CONFIG.INITIAL_X_OFFSET;
    const initialY = ANIMATION_CONFIG.INITIAL_Y_OFFSET;

    animationHandlers.updateCardTransform(initialX, initialY, card, wrap);
    animationHandlers.createSmoothAnimation(
      ANIMATION_CONFIG.INITIAL_DURATION,
      initialX,
      initialY,
      card,
      wrap
    );

    return () => {
      card.removeEventListener("pointerenter", pointerEnterHandler);
      card.removeEventListener("pointermove", pointerMoveHandler);
      card.removeEventListener("pointerleave", pointerLeaveHandler);
      card.removeEventListener("click", handleClick);
      window.removeEventListener("deviceorientation", deviceOrientationHandler);
      animationHandlers.cancelAnimation();
    };
  }, [
    enableTilt,
    enableMobileTilt,
    animationHandlers,
    handlePointerMove,
    handlePointerEnter,
    handlePointerLeave,
    handleDeviceOrientation,
  ]);

  const cardStyle = useMemo(
    () =>
      ({
        "--behind-gradient": DEFAULT_BEHIND_GRADIENT,
        "--inner-gradient": DEFAULT_INNER_GRADIENT,
        "--pointer-x": "50%",
        "--pointer-y": "50%",
        "--background-x": "50%",
        "--background-y": "50%",
        "--pointer-from-center": "0",
        "--pointer-from-top": "0.5",
        "--pointer-from-left": "0.5",
        "--rotate-x": "0deg",
        "--rotate-y": "0deg",
        "--card-opacity": "0.8",
      }) as React.CSSProperties,
    []
  );

  return (
    <div
      className={`w-full max-w-sm mx-auto perspective-1000 ${className}`.trim()}
    >
      {/* Mobile warning */}
      <div className="text-center text-sm text-white/80 mb-4 block sm:hidden">
        {enableMobileTilt
          ? "Tap to enable tilt effect"
          : "Hover effect optimized for desktop"}
      </div>

      {/* Enhanced Card Wrapper */}
      <div
        ref={wrapRef}
        className="bc-card-wrapper transition-all duration-300"
        style={cardStyle}
      >
        {/* Main Card */}
        <section
          ref={cardRef}
          className="bc-card relative w-full h-auto transform-gpu transition-all duration-300 ease-out"
          style={{
            transform:
              "translateZ(0) rotateX(var(--rotate-x)) rotateY(var(--rotate-y))",
            transformStyle: "preserve-3d",
          }}
        >
          {/* Background Gradient */}
          <div
            className="absolute inset-0 rounded-3xl opacity-80"
            style={{
              background: "var(--behind-gradient)",
              backgroundPosition: "var(--background-x) var(--background-y)",
            }}
          />

          {/* Inner Gradient Overlay */}
          <div
            className="absolute inset-0 rounded-3xl"
            style={{
              background: "var(--inner-gradient)",
            }}
          />

          {/* Shine Effect */}
          <div className="bc-shine absolute inset-0 rounded-3xl opacity-0 transition-opacity duration-300" />

          {/* Glare Effect */}
          <div className="bc-glare absolute inset-0 rounded-3xl opacity-0 transition-opacity duration-300" />

          {/* Content Container */}
          <div className="bc-inside relative z-10 p-6">
            {/* Header with Logo */}
            <div className="relative mb-8">
              <div className="absolute -top-4 left-1/2 transform -translate-x-1/2 z-20">
                <Image
                  src="/logo_short_black.svg"
                  alt="Logo"
                  width={100}
                  height={100}
                />
              </div>
              <div className="h-16"></div>
            </div>

            {/* Company Name */}
            <h1 className="text-2xl font-bold text-center text-white mb-3 drop-shadow-lg">
              {data.company}
            </h1>

            {/* Description */}
            <p className="text-sm text-white/90 text-center leading-relaxed mb-8 drop-shadow-md">
              {data.description}
            </p>

            {/* Website Link */}
            <div className="mb-6">
              <a
                href={data.links[0]?.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-between bg-white/20 backdrop-blur-sm border border-white/30 rounded-2xl p-4 hover:bg-white/30 transition-all duration-300 group"
              >
                <div className="flex items-center space-x-3">
                  <div
                    className={`w-8 h-8 rounded-full ${data.links[0]?.color} flex items-center justify-center`}
                  >
                    <span className="text-white text-sm">
                      {data.links[0]?.icon}
                    </span>
                  </div>
                  <span className="text-white font-medium">Website</span>
                </div>
                <ExternalLink className="w-4 h-4 text-white/70 group-hover:text-white transition-colors" />
              </a>
            </div>

            {/* Social Links */}
            <div>
              <h2 className="text-lg font-bold text-white mb-4 drop-shadow-lg">
                Find me on
              </h2>

              <div className="space-y-3">
                {data.links.slice(1).map((link, index) => (
                  <a
                    key={index}
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-between bg-white/20 backdrop-blur-sm border border-white/30 rounded-2xl p-4 hover:bg-white/30 transition-all duration-300 group"
                  >
                    <div className="flex items-center space-x-3">
                      <div
                        className={`w-8 h-8 rounded-full ${link.color} flex items-center justify-center`}
                      >
                        <span className="text-white text-sm">{link.icon}</span>
                      </div>
                      <div>
                        <div className="font-bold text-white">
                          {link.platform}
                        </div>
                        {link.subtitle && (
                          <div className="text-sm text-white/80">
                            {link.subtitle}
                          </div>
                        )}
                      </div>
                    </div>
                    <ExternalLink className="w-4 h-4 text-white/70 group-hover:text-white transition-colors" />
                  </a>
                ))}
              </div>
            </div>
          </div>
        </section>
      </div>

      {/* Custom Styles */}
      <style jsx>{`
        .perspective-1000 {
          perspective: 1000px;
        }

        .bc-card-wrapper {
          transform-style: preserve-3d;
        }

        .bc-card-wrapper.active .bc-shine {
          opacity: 1;
        }

        .bc-card-wrapper.active .bc-glare {
          opacity: 1;
        }

        .bc-shine {
          background: linear-gradient(
            135deg,
            rgba(255, 255, 255, 0.4) 0%,
            rgba(255, 255, 255, 0.1) 50%,
            transparent 100%
          );
          transform: translateZ(1px);
        }

        .bc-glare {
          background: radial-gradient(
            circle at var(--pointer-x) var(--pointer-y),
            rgba(255, 255, 255, 0.3) 0%,
            transparent 50%
          );
          transform: translateZ(2px);
        }

        .bc-inside {
          transform: translateZ(10px);
        }
      `}</style>
    </div>
  );
}
