export type PortSide = "left" | "right";
export type Point = { x: number; y: number };
export type TableRectangle = Point & { id: string; width: number; height: number };

/** Facing sides for horizontal neighbors; one outside lane for stacked tables. */
export function chooseRelationPorts(source: TableRectangle, target: TableRectangle): { source: PortSide; target: PortSide } {
  if (source.id === target.id) return { source: "right", target: "right" };
  if (source.x + source.width <= target.x) return { source: "right", target: "left" };
  if (target.x + target.width <= source.x) return { source: "left", target: "right" };
  const left = Math.abs(source.x - target.x);
  const right = Math.abs(source.x + source.width - target.x - target.width);
  const side = left < right ? "left" : "right";
  return { source: side, target: side };
}

function segmentHits(a: Point, b: Point, rectangle: TableRectangle) {
  const padding = 10;
  const left = rectangle.x - padding, right = rectangle.x + rectangle.width + padding;
  const top = rectangle.y - padding, bottom = rectangle.y + rectangle.height + padding;
  if (a.x === b.x) return a.x > left && a.x < right && Math.max(a.y, b.y) > top && Math.min(a.y, b.y) < bottom;
  return a.y > top && a.y < bottom && Math.max(a.x, b.x) > left && Math.min(a.x, b.x) < right;
}

function simplify(points: Point[]) {
  const result: Point[] = [];
  for (const point of points) {
    const last = result.at(-1);
    if (last && last.x === point.x && last.y === point.y) continue;
    const before = result.at(-2);
    if (before && last && ((before.x === last.x && last.x === point.x) || (before.y === last.y && last.y === point.y))) {
      // Only remove a straight-through point, never an outward-and-back stub.
      if ((last.x - before.x) * (point.x - last.x) >= 0 && (last.y - before.y) * (point.y - last.y) >= 0) result.pop();
    }
    result.push(point);
  }
  return result;
}

/** Bounded candidate search: prefer short, low-bend routes, heavily penalize
 * crossing any table, and include outside escape lanes for crowded diagrams. */
export function routeRelation(source: Point, target: Point, sourceSide: PortSide, targetSide: PortSide, rectangles: TableRectangle[], lane = 0): Point[] {
  const clearance = 26 + lane;
  const start = { x: source.x + (sourceSide === "left" ? -clearance : clearance), y: source.y };
  const end = { x: target.x + (targetSide === "left" ? -clearance : clearance), y: target.y };
  const minX = Math.min(start.x, end.x), maxX = Math.max(start.x, end.x);
  const minY = Math.min(start.y, end.y), maxY = Math.max(start.y, end.y);
  const candidates: Point[][] = [];
  const addX = (x: number) => candidates.push([start, { x, y: start.y }, { x, y: end.y }, end]);
  const addY = (y: number) => candidates.push([start, { x: start.x, y }, { x: end.x, y }, end]);
  addX((start.x + end.x) / 2);
  addY((start.y + end.y) / 2);
  addX(minX - clearance); addX(maxX + clearance);
  addY(minY - clearance); addY(maxY + clearance);
  let outerLeft = minX, outerRight = maxX, outerTop = minY, outerBottom = maxY;
  let nearby = 0;
  for (const rectangle of rectangles) {
    outerLeft = Math.min(outerLeft, rectangle.x);
    outerRight = Math.max(outerRight, rectangle.x + rectangle.width);
    outerTop = Math.min(outerTop, rectangle.y);
    outerBottom = Math.max(outerBottom, rectangle.y + rectangle.height);
    if (nearby < 12 && rectangle.x < maxX + 100 && rectangle.x + rectangle.width > minX - 100 && rectangle.y < maxY + 100 && rectangle.y + rectangle.height > minY - 100) {
      addX(rectangle.x - clearance); addX(rectangle.x + rectangle.width + clearance);
      addY(rectangle.y - clearance); addY(rectangle.y + rectangle.height + clearance);
      nearby += 1;
    }
  }
  addX(outerLeft - clearance); addX(outerRight + clearance);
  addY(outerTop - clearance); addY(outerBottom + clearance);
  // Two-turn escapes also handle different endpoint sides in crowded corridors.
  for (const y of [outerTop - clearance, outerBottom + clearance]) {
    candidates.push([start, { x: start.x, y }, { x: end.x, y }, end]);
    for (const x of [outerLeft - clearance, outerRight + clearance]) {
      candidates.push([start, { x, y: start.y }, { x, y }, { x: end.x, y }, end]);
    }
  }
  let best = candidates[0], bestScore = Infinity;
  for (const candidate of candidates) {
    let score = candidate.length * 18;
    // Start/end stubs must exit outward, never reverse through their own table.
    const first = candidate.find((point) => point.x !== start.x || point.y !== start.y);
    const last = [...candidate].reverse().find((point) => point.x !== end.x || point.y !== end.y);
    if (first && first.y === start.y && (first.x - start.x) * (start.x - source.x) < 0) score += 100000;
    if (last && last.y === end.y && (last.x - end.x) * (end.x - target.x) < 0) score += 100000;
    for (let index = 1; index < candidate.length; index += 1) {
      const a = candidate[index - 1], b = candidate[index];
      score += Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
      for (const rectangle of rectangles) if (segmentHits(a, b, rectangle)) score += 100000;
    }
    if (score < bestScore) { best = candidate; bestScore = score; }
  }
  // A self-reference on the same field still needs a visible loop.
  if (source.x === target.x && source.y === target.y) {
    const x = start.x + (sourceSide === "left" ? -clearance : clearance);
    best = [start, { x, y: start.y }, { x, y: start.y - 36 }, { x: end.x, y: end.y - 36 }, end];
  }
  return simplify([source, ...best, target]);
}

/** Round orthogonal corners without changing the selected route. */
export function roundedRoutePath(points: Point[], radius = 8) {
  if (!points.length) return "";
  let path = `M ${points[0].x} ${points[0].y}`;
  for (let index = 1; index < points.length - 1; index += 1) {
    const before = points[index - 1], point = points[index], after = points[index + 1];
    const incoming = Math.abs(point.x - before.x) + Math.abs(point.y - before.y);
    const outgoing = Math.abs(after.x - point.x) + Math.abs(after.y - point.y);
    const r = Math.min(radius, incoming / 2, outgoing / 2);
    const entry = { x: point.x - Math.sign(point.x - before.x) * r, y: point.y - Math.sign(point.y - before.y) * r };
    const exit = { x: point.x + Math.sign(after.x - point.x) * r, y: point.y + Math.sign(after.y - point.y) * r };
    path += ` L ${entry.x} ${entry.y} Q ${point.x} ${point.y} ${exit.x} ${exit.y}`;
  }
  const end = points.at(-1)!;
  return `${path} L ${end.x} ${end.y}`;
}
