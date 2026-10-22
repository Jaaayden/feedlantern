import type { ElementMap, Rect } from './types';

// Shared by the editor (hover, instantly) and the server (picks by coordinate),
// so a click lands on exactly the element the hover outline showed.

export function nodeCount(map: ElementMap): number {
  return Math.floor(map.boxes.length / 5);
}

export function nodeRect(map: ElementMap, node: number): Rect {
  const at = node * 5;
  return { x: map.boxes[at], y: map.boxes[at + 1], width: map.boxes[at + 2], height: map.boxes[at + 3] };
}

export function parentNode(map: ElementMap, node: number): number {
  return map.boxes[node * 5 + 4];
}

function contains(map: ElementMap, node: number, x: number, y: number): boolean {
  const at = node * 5;
  return x >= map.boxes[at] && y >= map.boxes[at + 1] && x < map.boxes[at] + map.boxes[at + 2] && y < map.boxes[at + 1] + map.boxes[at + 3];
}

/**
 * The deepest element under a point. Ties go to the later element in document
 * order, which is usually painted on top. Parents always precede children, so
 * depth is computed in the same single pass.
 */
export function hitTest(map: ElementMap, x: number, y: number): number {
  const count = nodeCount(map);
  const depth = new Int32Array(count);
  let best = -1;
  let bestDepth = -1;
  for (let node = 0; node < count; node++) {
    const parent = parentNode(map, node);
    depth[node] = parent >= 0 ? depth[parent] + 1 : 0;
    if (depth[node] >= bestDepth && contains(map, node, x, y)) {
      best = node;
      bestDepth = depth[node];
    }
  }
  return best;
}

/** Walk `levels` mapped ancestors up from `node`, stopping at a root. */
export function liftNode(map: ElementMap, node: number, levels: number): number {
  let current = node;
  for (let step = 0; step < levels; step++) {
    const parent = parentNode(map, current);
    if (parent < 0) break;
    current = parent;
  }
  return current;
}

/** How many levels `ancestor` sits above `node`, or -1 if it is not an ancestor. */
export function levelsBetween(map: ElementMap, node: number, ancestor: number): number {
  let current = node;
  for (let level = 0; current >= 0; level++) {
    if (current === ancestor) return level;
    current = parentNode(map, current);
  }
  return -1;
}

/** The nearest link at or above `node`. */
export function linkFor(map: ElementMap, node: number): string | undefined {
  for (let current = node; current >= 0; current = parentNode(map, current)) {
    const href = map.links[String(current)];
    if (href) return href;
  }
  return undefined;
}
