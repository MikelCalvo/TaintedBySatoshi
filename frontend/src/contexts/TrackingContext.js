import { createContext, useContext, useEffect, useCallback } from "react";
import { useRouter } from "next/router";

const TrackingContext = createContext(null);

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

export function TrackingProvider({ children }) {
  const router = useRouter();

  const trackPageView = useCallback(async (path) => {
    try {
      await fetch(`${API_URL}/api/analytics/track`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "pageview",
          path,
          referrer: typeof document !== "undefined" ? document.referrer : null,
        }),
        keepalive: true,
      });
    } catch (error) {
      // Silent fail - don't interrupt UX for analytics
      if (process.env.NODE_ENV === "development") {
        console.debug("[Analytics] Track failed:", error.message);
      }
    }
  }, []);

  const trackEvent = useCallback(
    async (eventType, data = {}) => {
      try {
        await fetch(`${API_URL}/api/analytics/track`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: eventType,
            path: router.asPath,
            ...data,
          }),
          keepalive: true,
        });
      } catch (error) {
        if (process.env.NODE_ENV === "development") {
          console.debug("[Analytics] Event track failed:", error.message);
        }
      }
    },
    [router.asPath]
  );

  // Auto-track on route change
  useEffect(() => {
    const handleRouteChange = (url) => {
      trackPageView(url);
    };

    // Track initial page
    trackPageView(router.asPath);

    // Listen for route changes
    router.events.on("routeChangeComplete", handleRouteChange);

    return () => {
      router.events.off("routeChangeComplete", handleRouteChange);
    };
  }, [router, trackPageView]);

  return (
    <TrackingContext.Provider value={{ trackPageView, trackEvent }}>
      {children}
    </TrackingContext.Provider>
  );
}

export function useTracking() {
  return useContext(TrackingContext);
}
