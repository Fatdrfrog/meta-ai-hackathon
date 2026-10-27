/**
 * Analytics data types
 * Shared across widget and web app
 */

export interface DateRange {
  start: string; // ISO date string
  end: string; // ISO date string
}

export interface PageviewsData {
  total: number;
  timeSeries: Array<{
    date: string;
    count: number;
  }>;
}

export interface TopPage {
  url: string;
  views: number;
  avgTimeOnPage?: number;
}

export interface SessionStats {
  totalSessions: number;
  avgSessionDuration: number; // in seconds
  bounceRate: number; // percentage
}

export interface TrafficSource {
  source: string;
  visitors: number;
  percentage: number;
}

export interface DeviceStats {
  desktop: number;
  mobile: number;
  tablet: number;
}
