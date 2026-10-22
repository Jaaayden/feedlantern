import { useEffect, useRef, useState } from 'react';
import type React from 'react';
import type { Rect, ScreenFrame } from '../shared/types';
import { hitTest, liftNode, linkFor, nodeRect } from '../shared/element-map';

export interface ScreenChoice { x: number; y: number; base?: number; node?: number; exact?: boolean }

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent);
export const linkModifier = isMac ? '⌘' : 'Ctrl';

const percent = (rect: Rect, frame: ScreenFrame): React.CSSProperties => ({
  left: `${rect.x / frame.width * 100}%`,
  top: `${rect.y / frame.height * 100}%`,
  width: `${rect.width / frame.width * 100}%`,
  height: `${rect.height / frame.height * 100}%`,
});

/**
 * The captured page as one tall image. Hover outlines and ↑/↓ widening run
 * entirely in the browser from the frame's element map; only a click goes to
 * the server.
 */
export function PageScreen({ frame, rects, disabled, navigated, revealKey, pick, follow }: {
  frame: ScreenFrame;
  rects: Rect[];
  disabled: boolean;
  /** The frame shows a page other than the source: plain clicks do not pick. */
  navigated: boolean;
  /** Changing it scrolls the first highlighted rect into view. */
  revealKey: string;
  pick: (choice: ScreenChoice) => void;
  follow: (node: number, href: string | undefined) => void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const frameRequest = useRef(0);
  const [hover, setHover] = useState<{ base: number; lift: number } | null>(null);
  const [linkMode, setLinkMode] = useState(false);
  const map = frame.map;

  useEffect(() => { setHover(null); }, [frame.image]);
  useEffect(() => () => cancelAnimationFrame(frameRequest.current), []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !rects.length) return;
    const scale = viewport.clientWidth / frame.width;
    const top = Math.min(...rects.map(rect => rect.y)) * scale;
    if (top < viewport.scrollTop || top > viewport.scrollTop + viewport.clientHeight - 48) viewport.scrollTop = Math.max(0, top - 48);
    // Only reveal on purpose (new frame, opened panel, chosen candidate), not on every pick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealKey]);

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

  function pointOf(event: React.MouseEvent<HTMLImageElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - bounds.left) * frame.width / bounds.width, y: (event.clientY - bounds.top) * frame.height / bounds.height };
  }
  function move(event: React.MouseEvent<HTMLImageElement>) {
    setLinkMode(event.metaKey || event.ctrlKey);
    if (!map) return;
    const { x, y } = pointOf(event);
    cancelAnimationFrame(frameRequest.current);
    frameRequest.current = requestAnimationFrame(() => {
      const base = hitTest(map, x, y);
      setHover(previous => base < 0 ? null : previous?.base === base ? previous : { base, lift: 0 });
    });
  }
  function click(event: React.MouseEvent<HTMLImageElement>) {
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

  return <div className="browser-viewport" ref={viewportRef}>
    <div className={`browser-screen${linkMode ? ' link-mode' : ''}${navigated ? ' navigated' : ''}${disabled ? ' waiting' : ''}`}>
      <img src={frame.image} alt="目标网页预览" draggable={false} style={{ aspectRatio: `${frame.width} / ${frame.height}` }}
        onMouseMove={move} onMouseLeave={() => { cancelAnimationFrame(frameRequest.current); setHover(null); setLinkMode(false); }} onClick={click} />
      {rects.map((rect, index) => <span className="selection-rect" key={index} style={percent(rect, frame)} />)}
      {hoveredRect && map && <span className={`hover-rect${linkMode && hoveredLink ? ' link' : ''}`} style={percent(hoveredRect, frame)}>
        <span className={`hover-label${hoveredRect.y < 40 ? ' below' : ''}${hoveredRect.x + hoveredRect.width / 2 > frame.width * 0.6 ? ' right' : ''}`}>{map.labels[hovered]}{hint && <em>{hint}</em>}</span>
      </span>}
    </div>
  </div>;
}
