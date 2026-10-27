"use client";

import { Component, Suspense, type ReactNode } from "react";
import {
  ScenarioChunkLoadError,
  type ScenarioLazyChunk,
} from "./scenario-lazy-chunk";

/** Waits between download attempts; the last one repeats. */
const SCENARIO_CHUNK_RETRY_DELAYS_MS = [1000, 2000, 5000, 10000, 30000];

type ScenarioLazyChunkBoundaryProps = {
  chunk: ScenarioLazyChunk<unknown>;
  fallback: ReactNode;
  children: ReactNode;
};

type ScenarioLazyChunkBoundaryState = {
  failed: boolean;
  error: unknown;
};

/**
 * Suspense for a lazily downloaded editor that also survives a failed
 * download (a flaky connection, or a tab left open across a deploy). It keeps
 * the placeholder, downloads again after a short wait or as soon as the
 * browser is back online, then renders the editor. The rest of the page
 * keeps working meanwhile. An error thrown by an editor that did download
 * still reaches the page's error screen.
 */
export class ScenarioLazyChunkBoundary extends Component<
  ScenarioLazyChunkBoundaryProps,
  ScenarioLazyChunkBoundaryState
> {
  state: ScenarioLazyChunkBoundaryState = { failed: false, error: null };

  private failedAttempts = 0;
  private cancelRetry: (() => void) | null = null;
  private unmounted = false;

  static getDerivedStateFromError(error: unknown) {
    return { failed: true, error };
  }

  componentDidCatch(error: unknown) {
    if (error instanceof ScenarioChunkLoadError) this.scheduleRetry();
  }

  componentWillUnmount() {
    this.unmounted = true;
    this.cancelRetry?.();
  }

  private scheduleRetry() {
    this.cancelRetry?.();
    const delay =
      SCENARIO_CHUNK_RETRY_DELAYS_MS[
        Math.min(this.failedAttempts, SCENARIO_CHUNK_RETRY_DELAYS_MS.length - 1)
      ];
    this.failedAttempts += 1;
    const retry = () => {
      this.cancelRetry?.();
      this.cancelRetry = null;
      this.props.chunk.load().then(
        () => {
          if (this.unmounted) return;
          this.failedAttempts = 0;
          this.setState({ failed: false, error: null });
        },
        () => {
          if (!this.unmounted) this.scheduleRetry();
        }
      );
    };
    const timer = window.setTimeout(retry, delay);
    window.addEventListener("online", retry);
    this.cancelRetry = () => {
      window.clearTimeout(timer);
      window.removeEventListener("online", retry);
    };
  }

  render() {
    const { failed, error } = this.state;
    if (failed) {
      if (!(error instanceof ScenarioChunkLoadError)) throw error;
      return this.props.fallback;
    }
    return (
      <Suspense fallback={this.props.fallback}>{this.props.children}</Suspense>
    );
  }
}
