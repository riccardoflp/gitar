import { useEffect, useState, type RefObject } from 'react';
import { Icon } from './Icon';

/** How far down the page is scrolled before the button shows, in pixels. */
const SHOWN_PAST = 400;

/** A button in the corner that takes a long page back to its top, once it is scrolled down. */
export function BackToTop({ page }: { page: RefObject<HTMLElement | null> }) {
  const [down, setDown] = useState(false);
  useEffect(() => {
    const element = page.current;
    if (!element) return;
    const scrolled = () => setDown(element.scrollTop > SHOWN_PAST);
    scrolled();
    element.addEventListener('scroll', scrolled, { passive: true });
    return () => element.removeEventListener('scroll', scrolled);
  }, [page]);
  if (!down) return null;
  return (
    <button className="button to-top" title="Back to the top" aria-label="Back to the top" onClick={() => page.current?.scrollTo({ top: 0, behavior: 'smooth' })}>
      <Icon name="arrow-up" />
    </button>
  );
}
