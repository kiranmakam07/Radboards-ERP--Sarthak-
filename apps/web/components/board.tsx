'use client';

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';

/**
 * A board of cards in columns, where a card is moved by dragging it to another column: tasks by
 * where the work stands, projects by status. Clicking (or Enter on) a card opens it.
 *
 * The board only reports what happened: onMove(item, column) after a drop, onOpen(item) after a
 * click. The screen decides what a move means, and may first ask for something in a pop-up (why a
 * task could not be done, say), so a card stays where it is until the screen has its answer.
 *
 * Dragging works with a mouse (press and move) and with a finger (press and hold for a moment,
 * then move; a quick swipe still scrolls the board). It is drawn by hand with pointer events
 * rather than the browser's drag and drop, which phones do not support. Keyboard and screen-reader
 * users move a card from the pop-up it opens, so every move has a way that needs no dragging.
 */
/** A column: its title, an optional line under it, and an optional figure for it (the value of its cards). */
export type BoardColumn = { key: string; title: string; hint?: string; total?: string };

type Held = {
  item: unknown; key: string; from: string; el: HTMLElement; type: string; movable: boolean;
  x0: number; y0: number; x: number; y: number; timer?: number; armed: boolean;
};
type Lifted = { key: string; item: unknown; from: string; x: number; y: number; dx: number; dy: number; width: number };

/** How long a finger rests on a card before it is picked up, and how far it may wander meanwhile. */
const HOLD_MS = 280;
const SLOP_PX = 10;

export function Board<T>({ columns, items, columnOf, keyOf, render, canMove, onMove, onOpen, emptyColumn = 'Nothing here' }: {
  columns: BoardColumn[];
  items: T[];
  columnOf: (item: T) => string;
  keyOf: (item: T) => string;
  render: (item: T) => ReactNode;
  /** False for a card that cannot be moved by this person (it still opens). */
  canMove?: (item: T) => boolean;
  onMove: (item: T, to: string) => void;
  onOpen: (item: T) => void;
  emptyColumn?: string;
}) {
  const [lifted, setLifted] = useState<Lifted | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const held = useRef<Held | null>(null);
  const board = useRef<HTMLDivElement>(null);
  // The latest callbacks, for the window listeners set up once below.
  const latest = useRef({ onMove, onOpen });
  latest.current = { onMove, onOpen };

  /** The card leaves its place and follows the pointer. Uses only state setters, so any render's copy will do. */
  const pickUp = (h: Held) => {
    const box = h.el.getBoundingClientRect();
    h.armed = true;
    setLifted({ key: h.key, item: h.item, from: h.from, x: h.x, y: h.y, dx: h.x - box.left, dy: h.y - box.top, width: box.width });
    setOver(h.from);
    document.body.classList.add('board-dragging');
    if (h.type !== 'mouse') navigator.vibrate?.(12);
  };

  useEffect(() => {
    const columnAt = (x: number, y: number) =>
      (document.elementFromPoint(x, y)?.closest('[data-board-col]') as HTMLElement | null)?.dataset.boardCol ?? null;

    const drop = () => {
      const h = held.current;
      held.current = null;
      document.body.classList.remove('board-dragging');
      if (h?.timer) window.clearTimeout(h.timer);
      setLifted(null);
      setOver(null);
      return h;
    };

    const move = (e: PointerEvent) => {
      const h = held.current;
      if (!h) return;
      h.x = e.clientX;
      h.y = e.clientY;
      const far = Math.hypot(h.x - h.x0, h.y - h.y0);
      if (!h.armed) {
        if (h.type === 'mouse' && h.movable && far > 5) pickUp(h);
        // A finger that moves before the hold is up is scrolling, not dragging.
        else if (h.type !== 'mouse' && far > SLOP_PX) drop();
        return;
      }
      setLifted((l) => (l ? { ...l, x: h.x, y: h.y } : l));
      setOver(columnAt(h.x, h.y));
      // Near either edge of a board wider than the screen, it scrolls along.
      const b = board.current;
      if (b) {
        const r = b.getBoundingClientRect();
        if (h.x < r.left + 40) b.scrollLeft -= 14;
        else if (h.x > r.right - 40) b.scrollLeft += 14;
      }
    };

    const up = (e: PointerEvent) => {
      const h = held.current;
      if (!h) return;
      const target = h.armed ? columnAt(e.clientX, e.clientY) : null;
      const wasDrag = h.armed;
      drop();
      if (wasDrag) {
        if (target && target !== h.from) latest.current.onMove(h.item as T, target);
      } else if (Math.hypot(e.clientX - h.x0, e.clientY - h.y0) <= SLOP_PX) {
        latest.current.onOpen(h.item as T);
      }
    };

    // While a card is held by a finger, the page must not scroll under it.
    const noScroll = (e: TouchEvent) => { if (held.current?.armed) e.preventDefault(); };
    const cancel = () => { drop(); };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('touchmove', noScroll, { passive: false });
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('touchmove', noScroll);
      document.body.classList.remove('board-dragging');
    };
  }, []);

  function press(e: ReactPointerEvent<HTMLDivElement>, item: T) {
    if (e.button !== 0) return;
    const h: Held = {
      item, key: keyOf(item), from: columnOf(item), el: e.currentTarget, type: e.pointerType, movable: canMove ? canMove(item) : true,
      x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, armed: false,
    };
    held.current = h;
    // A finger picks the card up once it has rested on it for a moment.
    if (h.movable && h.type !== 'mouse') h.timer = window.setTimeout(() => { if (held.current === h) pickUp(h); }, HOLD_MS);
  }

  const key = (e: KeyboardEvent, item: T) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen(item);
    }
  };

  return (
    <>
      <div ref={board} className={lifted ? 'board is-dragging' : 'board'} style={{ ['--cols' as string]: columns.length }}>
        {columns.map((c) => {
          const cards = items.filter((i) => columnOf(i) === c.key);
          const target = lifted && over === c.key && c.key !== lifted.from;
          return (
            <section key={c.key} className={target ? 'board-col over' : 'board-col'} data-board-col={c.key} aria-label={c.title}>
              <h2>{c.title} <span className="muted small">{cards.length}</span></h2>
              {c.total ? <p className="board-total">{c.total}</p> : null}
              {c.hint ? <p className="muted small board-hint">{c.hint}</p> : null}
              {cards.map((i) => {
                const k = keyOf(i);
                const movable = canMove ? canMove(i) : true;
                return (
                  <div key={k} role="button" tabIndex={0} aria-roledescription={movable ? 'card you can drag to another column' : 'card'}
                    className={`board-card${lifted?.key === k ? ' lifted' : ''}${movable ? '' : ' fixed'}`}
                    onPointerDown={(e) => press(e, i)} onKeyDown={(e) => key(e, i)}>
                    {render(i)}
                  </div>
                );
              })}
              {cards.length === 0 ? <p className="muted small board-empty">{emptyColumn}</p> : null}
            </section>
          );
        })}
      </div>
      {lifted ? (
        <div className="board-card board-ghost" aria-hidden="true" style={{ left: lifted.x - lifted.dx, top: lifted.y - lifted.dy, width: lifted.width }}>
          {render(lifted.item as T)}
        </div>
      ) : null}
    </>
  );
}
