/**
 * Performance monitoring utility for API routes and database operations
 */

export interface PerformanceMetadata {
  workspaceId?: string;
  periodDays?: number | "all";
  method?: string;
  path?: string;
  status?: number;
  error?: string;
  userId?: string;
  count?: number;
  [key: string]: string | number | boolean | undefined;
}

export interface PerformanceMetric {
  operation: string;
  duration: number;
  timestamp: Date;
  metadata?: PerformanceMetadata;
}

class PerformanceMonitor {
  private static instance: PerformanceMonitor;
  private metrics: PerformanceMetric[] = [];
  private readonly maxMetrics = 1000; // Keep last 1000 metrics in memory

  private constructor() {}

  static getInstance(): PerformanceMonitor {
    if (!PerformanceMonitor.instance) {
      PerformanceMonitor.instance = new PerformanceMonitor();
    }
    return PerformanceMonitor.instance;
  }

  startTimer(operation: string): (metadata?: PerformanceMetadata) => void {
    const start = Date.now();

    return (metadata?: PerformanceMetadata) => {
      const duration = Date.now() - start;
      this.recordMetric(operation, duration, metadata);
    };
  }

  recordMetric(
    operation: string,
    duration: number,
    metadata?: PerformanceMetadata
  ): void {
    const metric: PerformanceMetric = {
      operation,
      duration,
      timestamp: new Date(),
      metadata,
    };

    this.metrics.push(metric);

    // Keep only recent metrics to prevent memory leaks
    if (this.metrics.length > this.maxMetrics) {
      this.metrics = this.metrics.slice(-this.maxMetrics);
    }
  }

  getMetrics(operation?: string): PerformanceMetric[] {
    if (operation) {
      return this.metrics.filter(m => m.operation === operation);
    }
    return [...this.metrics];
  }

  getAverageTime(operation: string, timeWindow?: number): number {
    const now = Date.now();
    const windowMs = timeWindow ? timeWindow * 60 * 1000 : 60 * 60 * 1000; // Default 1 hour

    const recentMetrics = this.metrics.filter(
      m => m.operation === operation && now - m.timestamp.getTime() < windowMs
    );

    if (recentMetrics.length === 0) return 0;

    const totalTime = recentMetrics.reduce((sum, m) => sum + m.duration, 0);
    return totalTime / recentMetrics.length;
  }

  getSlowOperations(threshold = 2000): PerformanceMetric[] {
    return this.metrics.filter(m => m.duration > threshold);
  }

  clearMetrics(): void {
    this.metrics = [];
  }

  getStats() {
    const operations = [...new Set(this.metrics.map(m => m.operation))];

    return operations.map(operation => {
      const operationMetrics = this.metrics.filter(
        m => m.operation === operation
      );
      const durations = operationMetrics.map(m => m.duration);

      return {
        operation,
        count: operationMetrics.length,
        averageTime: durations.reduce((a, b) => a + b, 0) / durations.length,
        minTime: Math.min(...durations),
        maxTime: Math.max(...durations),
        recentTime: operationMetrics[operationMetrics.length - 1]?.duration,
      };
    });
  }
}

// Convenience functions
export function startTimer(operation: string) {
  return PerformanceMonitor.getInstance().startTimer(operation);
}

export function getPerformanceStats() {
  return PerformanceMonitor.getInstance().getStats();
}

export function getSlowOperations(threshold?: number) {
  return PerformanceMonitor.getInstance().getSlowOperations(threshold);
}

// Async function wrapper for automatic timing
export async function withTiming<T>(
  operation: string,
  fn: () => Promise<T>,
  metadata?: PerformanceMetadata
): Promise<T> {
  const timer = startTimer(operation);
  try {
    const result = await fn();
    timer(metadata);
    return result;
  } catch (error) {
    timer({
      ...metadata,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    throw error;
  }
}
