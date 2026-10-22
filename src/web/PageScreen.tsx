import { useEffect, useRef, useState } from 'react';
import type React from 'react';
import { LoaderCircle } from 'lucide-react';
import type { Rect, ScreenFrame } from '../shared/types';
import { hitTest, liftNode, linkFor, nodeRect } from '../shared/element-map';

export interface ScreenChoice { x: number; y: number; base?: number; node?: number; exact?: boolean }
export type SegmentState = 'idle' | 'loading' | 'error';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent);
export const linkModifier = isMac ? '⌘' : 'Ctrl';
/** Start loading the next segment when this many screen pixels remain below. */
const PREFETCH_MARGIN = 1200;

/** How far down the page the editor has captured so far. */
export function loadedHeight(frame: ScreenFrame): number {
  const last = frame.segments?.at(-1);
  return last ? last.top + last.height : frame.height;
}

/**
 * The captured page as stacked screenshot segments. Hover outlines and ↑/↓
 * widening run entirely in the browser from the frame's element map; a click
 * goes to the server, and so does the next segment when scrolling nears the end.
 */
export function PageScreen({ frame, rects, disabled, navigated, revealKey, segmentState, loadMore, pick, follow }: {
  frame: ScreenFrame;
  rects: Rect[];
  disabled: boolean;
  /** The frame shows a page other than the source: plain clicks do not pick. */
  navigated: boolean;
  /** Changing it scrolls the first highlighted rect into view. */
  revealKey: string;
  segmentState: SegmentState;
  loadMore: () => void;
  pick: (choice: ScreenChoice) => void;
  follow: (node: number, href: string | undefined) => void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const frameRequest = useRef(0);
  // Document y still to scroll to once enough of the page is captured.
  const pendingReveal = useRef<number | null>(null);
  const [hover, setHover] = useState<{ base: number; lift: number } | null>(null);
  const [linkMode, setLinkMode] = useState(false);
  const map = frame.map;
  const height = loadedHeight(frame);
  const complete = height >= frame.documentHeight;
  const percent = (rect: Rect): React.CSSProperties => ({
    left: `${rect.x / frame.width * 100}%`,
    top: `${rect.y / height * 100}%`,
    width: `${rect.width / frame.width * 100}%`,
    height: `${rect.height / height * 100}%`,
  });

  useEffect(() => { setHover(null); }, [frame.image]);
  useEffect(() => () => cancelAnimationFrame(frameRequest.current), []);

  useEffect(() => {
    pendingReveal.current = rects.length ? Math.min(...rects.map(rect => rect.y)) : null;
    // Only reveal on purpose (new frame, opened panel, chosen candidate), not on every pick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealKey]);

  const nearBottom = (viewport: HTMLDivElement) => viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < PREFETCH_MARGIN;
  const canLoad = !complete && segmentState === 'idle' && !disabled;

  // Reveal once the target is captured, and keep capturing while the user is
  // near the bottom. Re-checked whenever more of the page arrives or the
  // editor stops being busy.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const target = pendingReveal.current;
    if (target !== null) {
      if (target < height - 200 || complete) {
        pendingReveal.current = null;
        const top = target * viewport.clientWidth / frame.width;
        if (top < viewport.scrollTop || top > viewport.scrollTop + viewport.clientHeight - 48) viewport.scrollTop = Math.max(0, top - 48);
      } else if (canLoad) loadMore();
      return;
    }
    if (canLoad && nearBottom(viewport)) loadMore();
  });

  const hovering = hover !== null;
  useEffect(() => {
    if (!hovering || !map) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Meta' || event.key === 'Control') { setLinkMode(event.type === 'keydown'); return; }
      if (event.type !== 'keydown') return;
      if (event.target instanceof Element && event.target.closest('input, textarea, select')) return;
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();
        setHover(previous => {
          if (!previous) return previous;
          if (event.key === 'ArrowDown') return { ...previous, lift: Math.max(0, previous.lift - 1) };
          const widened = { ...previous, lift: previous.lift + 1 };
          return liftNode(map, widened.base, widened.lift) === liftNode(map, previous.base, previous.lift) ? previous : widened;
        });
      } else if (event.key === 'Escape') setHover(null);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onKey); };
  }, [hovering, map]);

  // Segments share one scale (the capture width), so measure against the stack.
  function pointOf(event: React.MouseEvent<HTMLElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const scale = frame.width / bounds.width;
    return { x: (event.clientX - bounds.left) * scale, y: (event.clientY - bounds.top) * scale };
  }
  function move(event: React.MouseEvent<HTMLElement>) {
    setLinkMode(event.metaKey || event.ctrlKey);
    if (!map) return;
    const { x, y } = pointOf(event);
    cancelAnimationFrame(frameRequest.current);
    frameRequest.current = requestAnimationFrame(() => {
      const base = hitTest(map, x, y);
      setHover(previous => base < 0 ? null : previous?.base === base ? previous : { base, lift: 0 });
    });
  }
  function click(event: React.MouseEvent<HTMLElement>) {
    if (disabled) return;
    const { x, y } = pointOf(event);
    if (!map) { pick({ x, y }); return; }
    const base = hitTest(map, x, y);
    if (base < 0) return;
    const lift = hover?.base === base ? hover.lift : 0;
    const node = liftNode(map, base, lift);
    if (event.metaKey || event.ctrlKey) follow(node, linkFor(map, node));
    else pick({ x, y, base, node, exact: lift > 0 });
  }

  const hovered = map && hover ? liftNode(map, hover.base, hover.lift) : -1;
  const hoveredRect = map && hovered >= 0 ? nodeRect(map, hovered) : null;
  const hoveredLink = map && hovered >= 0 ? linkFor(map, hovered) : undefined;
  const hint = linkMode ? (hoveredLink ? '点击打开此链接' : '这里不是链接') : hover && hover.lift > 0 ? `已扩大 ${hover.lift} 层` : '';
  const images = [{ top: 0, height: frame.height, image: frame.image }, ...(frame.segments ?? [])];

  return <div className="browser-viewport" ref={viewportRef} onScroll={event => { if (canLoad && nearBottom(event.currentTarget)) loadMore(); }}>
    <div className={`browser-screen${linkMode ? ' link-mode' : ''}${navigated ? ' navigated' : ''}${disabled ? ' waiting' : ''}`}
      onMouseMove={move} onMouseLeave={() => { cancelAnimationFrame(frameRequest.current); setHover(null); setLinkMode(false); }} onClick={click}>
      {images.map((segment, index) => <img key={segment.top} src={segment.image} alt={index ? '' : '目标网页预览'} draggable={false} style={{ aspectRatio: `${frame.width} / ${segment.height}` }} />)}
      {rects.map((rect, index) => <span className="selection-rect" key={index} style={percent(rect)} />)}
      {hoveredRect && map && <span className={`hover-rect${linkMode && hoveredLink ? ' link' : ''}`} style={percent(hoveredRect)}>
        <span className={`hover-label${hoveredRect.y < 40 ? ' below' : ''}${hoveredRect.x + hoveredRect.width / 2 > frame.width * 0.6 ? ' right' : ''}`}>{map.labels[hovered]}{hint && <em>{hint}</em>}</span>
      </span>}
    </div>
    {!complete ? <div className="segment-status">
      {segmentState === 'error'
        ? <button type="button" className="button small" onClick={loadMore}>下面的画面加载失败，点击重试</button>
        : segmentState === 'loading'
          ? <span className="inline"><LoaderCircle size={14} className="spin" />正在加载下面的网页画面…</span>
          : <button type="button" className="button small" disabled={disabled} onClick={loadMore}>加载下面的网页画面</button>}
    </div> : frame.truncated ? <div className="segment-status">网页超过 {Math.round(frame.documentHeight / 1000)} 千像素，后面的部分不显示</div> : null}
  </div>;
}
