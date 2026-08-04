"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

interface AutoScrollOptions {
  hasMessages: boolean;
  isStreaming: boolean;
  composerHeight: number;
  messageCount: number;
  sessionId?: string | null;
  lastMessageRole?: "user" | "assistant" | "system";
  lastMessageContent?: string;
  lastEventCount?: number;
}

/**
 * Latest-message autoscroll, designed for jitter-free LLM streaming.
 *
 * The implementation deliberately collapses what used to be three
 * separate scroll paths (a throttled timer, a rAF tick, a smooth-vs-
 * instant branch on stream state) into one: a single
 * ``useLayoutEffect`` that follows one computed target while ``autoFollow``
 * is true. That is the only writer to ``scrollTop``
 * during streaming, which removes all the races that previously made
 * the viewport visibly stutter — smooth-scroll animation interrupted
 * by the next delta's instant snap, throttle + rAF firing within the
 * same frame, the browser's built-in scroll anchoring tugging back at
 * the manual pin while mid-stream code blocks / KaTeX / dynamic
 * viewers reflow above the cursor, etc.
 *
 * Three companion mechanisms keep behaviour correct in edge cases:
 *
 *  - ``handleScroll`` watches the user's scroll position. The instant
 *    they move more than 80px from the reading target we release the pin
 *    so they can browse history without being yanked back.
 *  - ``composerHeight`` changes (e.g. when the composer grows for a
 *    multi-line draft) re-pin once via a layout effect so the freshly-
 *    revealed content stays on screen.
 *  - A short post-stream window watches for ``childList`` mutations.
 *    Several capability viewers (MathAnimator, Quiz, Visualize) are
 *    loaded via ``next/dynamic({ssr:false})`` and only mount after the
 *    final result event lands; if the user is still pinned we follow
 *    those late-mounting heights downward.
 *
 * The scroll container must also opt into ``overflow-anchor: none``
 * (set globally on ``[data-chat-scroll-root="true"]``). Without it,
 * the browser's default scroll-anchoring tries to keep an in-viewport
 * element fixed in screen space when content above it grows — which
 * fights this hook every time a code block expands.
 */
export function useChatAutoScroll({
  hasMessages,
  isStreaming,
  composerHeight,
  messageCount,
  sessionId,
  lastMessageRole,
  lastMessageContent,
  lastEventCount,
}: AutoScrollOptions) {
  const containerRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const scrollRafRef = useRef(0);
  const positionedSessionRef = useRef<string | null | undefined>(undefined);
  const [trailingSpaceHeight, setTrailingSpaceHeight] = useState(0);

  const pinnedScrollTop = useCallback(() => {
    const container = containerRef.current;
    if (!container) return 0;
    if (lastMessageRole !== "assistant") return container.scrollTop;
    const assistants = container.querySelectorAll<HTMLElement>(
      '[data-chat-message-role="assistant"]',
    );
    const assistant = assistants.item(assistants.length - 1);
    if (!assistant) return container.scrollTop;
    const containerRect = container.getBoundingClientRect();
    const assistantRect = assistant.getBoundingClientRect();
    const assistantBottom = assistantRect.bottom - containerRect.top + container.scrollTop;
    return Math.max(0, assistantBottom - container.clientHeight * 0.55);
  }, [lastMessageRole]);

  const pinToLatest = useCallback(() => {
    const container = containerRef.current;
    if (!container || scrollRafRef.current) return;
    const step = () => {
      if (!shouldAutoScrollRef.current) {
        scrollRafRef.current = 0;
        return;
      }
      const distance = pinnedScrollTop() - container.scrollTop;
      if (Math.abs(distance) <= 1) {
        scrollRafRef.current = 0;
        return;
      }
      container.scrollTop += Math.max(-40, Math.min(distance, 40));
      scrollRafRef.current = requestAnimationFrame(step);
    };
    step();
  }, [pinnedScrollTop]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || !hasMessages || lastMessageRole !== "assistant") return;
    const update = () => setTrailingSpaceHeight(Math.max(0, container.clientHeight * 0.5));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    return () => observer.disconnect();
  }, [hasMessages, lastMessageRole]);

  // Primary pin: runs in layout phase after every render that bumps
  // message count / streaming content / events / composer height / mount.
  // A newly loaded session jumps to its tail before paint; later changes
  // use the bounded animation above.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || !hasMessages) return;
    const sessionKey = sessionId ?? "__draft__";
    if (positionedSessionRef.current !== sessionKey) {
      if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = 0;
      shouldAutoScrollRef.current = true;
      positionedSessionRef.current = sessionKey;
      container.scrollTop = container.scrollHeight;
      return;
    }
    if (shouldAutoScrollRef.current) pinToLatest();
  }, [
    pinToLatest,
    hasMessages,
    sessionId,
    isStreaming,
    messageCount,
    lastMessageContent,
    lastEventCount,
    composerHeight,
    trailingSpaceHeight,
  ]);

  // Companion pin: content-change-driven, active ONLY while the turn is
  // streaming. ``useLayoutEffect`` above already pins on every page-level
  // state change (new delta, new event, new message), but there is a class
  // of height growth that doesn't bubble up to the page:
  //
  //   1. ``useSmoothStreamText`` advances the visible markdown inside
  //      a child component between WebSocket deltas. Those frames
  //      grow the inner content but the page's deps don't change, so
  //      the layout effect above doesn't re-fire on them.
  //   2. KaTeX, code blocks, Mermaid, and the late-mount viewer
  //      ``next/dynamic`` chunks all change the height of the message
  //      area asynchronously when they finish hydrating mid-stream.
  //   3. Images/iframes finishing their network load grow the content
  //      without mutating the DOM tree at all.
  //
  // We can't use ``ResizeObserver`` on the scroll container itself because
  // it observes border-box, not scrollHeight; overflow growth doesn't fire
  // it. This used to be a per-frame rAF loop instead — 60 unconditional
  // ``scrollHeight`` reads per second, each a forced synchronous layout of
  // the whole transcript, which grew with conversation length and kept the
  // main thread busy even in the idle window between the last token and the
  // turn's ``done`` event. A MutationObserver (cases 1–2) plus a capture-
  // phase ``load`` listener (case 3), coalesced to at most one pin per
  // frame, covers the same growth for a cost proportional to actual change.
  useEffect(() => {
    if (!isStreaming || !hasMessages) return;
    const container = containerRef.current;
    if (!container) return;
    let rafId = 0;
    const pin = () => {
      rafId = 0;
      if (shouldAutoScrollRef.current) pinToLatest();
    };
    const schedule = () => {
      if (!rafId) rafId = requestAnimationFrame(pin);
    };
    const mo = new MutationObserver(schedule);
    mo.observe(container, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    container.addEventListener("load", schedule, true);
    schedule();
    return () => {
      mo.disconnect();
      container.removeEventListener("load", schedule, true);
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [isStreaming, hasMessages, pinToLatest]);

  // After streaming ends, capability viewers loaded via ``next/dynamic``
  // (MathAnimatorViewer, QuizViewer, VisualizationViewer, RichCodeBlock,
  // Mermaid …) finish hydrating and grow the content height. Keep the
  // active assistant edge in the same reading zone while they mount.
  //
  // The observer is intentionally short-lived (4s after stream stop):
  // a longer window would mis-classify post-turn user interactions
  // (expanding a trace ``<details>``, clicking a citation) as
  // "streaming-style growth" and rip them back to the bottom.
  const POST_STREAM_AUTOSCROLL_WINDOW_MS = 4000;
  useEffect(() => {
    if (isStreaming) return;
    if (!hasMessages) return;

    const container = containerRef.current;
    if (!container) return;

    let prevHeight = container.scrollHeight;
    let rafId = 0;
    const deadline = performance.now() + POST_STREAM_AUTOSCROLL_WINDOW_MS;

    const check = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        if (performance.now() > deadline) return;
        const curHeight = container.scrollHeight;
        if (curHeight > prevHeight && shouldAutoScrollRef.current) {
          pinToLatest();
        }
        prevHeight = curHeight;
      });
    };

    const mo = new MutationObserver(check);
    mo.observe(container, { childList: true, subtree: true });
    const stopTimer = window.setTimeout(() => {
      mo.disconnect();
      if (rafId) cancelAnimationFrame(rafId);
    }, POST_STREAM_AUTOSCROLL_WINDOW_MS);

    return () => {
      window.clearTimeout(stopTimer);
      mo.disconnect();
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [hasMessages, isStreaming, pinToLatest]);

  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container || scrollRafRef.current) return;
    shouldAutoScrollRef.current =
      Math.abs(pinnedScrollTop() - container.scrollTop) < 80;
  }, [pinnedScrollTop]);

  // Intent-based release. During dense streaming, position-only checks can
  // miss a user gesture while the bounded animation is active. Release the
  // pin the instant we see an UPWARD scroll *gesture* (wheel up, or a touch
  // drag that pulls earlier content into view), which is unambiguous user
  // intent and independent of where the pin has parked the scroll position.
  // Once released the pin stops fighting, the user is free to browse, and
  // ``handleScroll`` re-arms the pin when they return near the bottom.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const release = () => {
      shouldAutoScrollRef.current = false;
    };

    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) release();
    };

    let touchY = 0;
    const onTouchStart = (event: TouchEvent) => {
      touchY = event.touches[0]?.clientY ?? 0;
    };
    const onTouchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY ?? 0;
      // Finger dragging downward scrolls the content up (reveals earlier
      // messages) — an explicit "let me read back" gesture.
      if (y - touchY > 4) release();
      touchY = y;
    };

    container.addEventListener("wheel", onWheel, { passive: true });
    container.addEventListener("touchstart", onTouchStart, { passive: true });
    container.addEventListener("touchmove", onTouchMove, { passive: true });
    return () => {
      container.removeEventListener("wheel", onWheel);
      container.removeEventListener("touchstart", onTouchStart);
      container.removeEventListener("touchmove", onTouchMove);
    };
    // Re-attach when the scroll container (re)mounts — it only exists once
    // there are messages to show.
  }, [hasMessages]);

  useEffect(() => {
    return () => {
      if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current);
    };
  }, []);

  // ``scrollToBottom`` is preserved as a public escape hatch for an
  // imperative jump to the latest message, kept instant so it never
  // animates against an active stream.
  const scrollToBottom = useCallback(
    (_behavior: ScrollBehavior) => {
      void _behavior;
      pinToLatest();
    },
    [pinToLatest],
  );

  return {
    containerRef,
    endRef,
    shouldAutoScrollRef,
    scrollToBottom,
    handleScroll,
    trailingSpaceHeight,
  };
}
