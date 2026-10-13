import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';

export interface MenuItem {
  label: string;
  run(): void;
  danger?: boolean;
}

/** Falsy entries are dropped, so menus can be written with `condition && item`. */
export type MenuEntry = MenuItem | 'separator' | false | null | undefined;

type OpenMenu = (event: MouseEvent, entries: MenuEntry[]) => void;

const MenuContext = createContext<OpenMenu>(() => {});

/** Returns a function that opens a context menu at the pointer. */
export const useMenu = () => useContext(MenuContext);

/** Drops empty entries, and separators that would start, end or repeat. */
function tidy(entries: MenuEntry[]): (MenuItem | 'separator')[] {
  const items: (MenuItem | 'separator')[] = [];
  for (const entry of entries) {
    if (!entry) continue;
    if (entry === 'separator' && (!items.length || items[items.length - 1] === 'separator')) continue;
    items.push(entry);
  }
  if (items[items.length - 1] === 'separator') items.pop();
  return items;
}

const MAX_COLUMNS = 3;
/** The least a column of the menu takes. */
const COLUMN_WIDTH = 184;

interface OpenState {
  id: number;
  x: number;
  y: number;
  items: (MenuItem | 'separator')[];
}

function Menu({ menu, onClose }: { menu: OpenState; onClose(): void }) {
  const element = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: menu.x, top: menu.y });
  const [columns, setColumns] = useState(1);

  // Keep the menu inside the view, which in the panel is often short: a menu taller than the view is laid out in columns.
  useLayoutEffect(() => {
    const available = window.innerHeight - 8;
    const needed = element.current!.scrollHeight;
    // Measured again once the columns are there. They do not come out even, hence the margin.
    const wanted = Math.min(MAX_COLUMNS, Math.ceil(needed / (available * 0.85)));
    // A view of the side bar is narrow as well as short: there the menu stays in one column, and scrolls.
    if (columns === 1 && needed > available && wanted * COLUMN_WIDTH <= window.innerWidth - 8) {
      setColumns(wanted);
      return;
    }
    const box = element.current!.getBoundingClientRect();
    setPosition({
      left: Math.max(0, Math.min(menu.x, window.innerWidth - box.width - 4)),
      top: Math.max(0, Math.min(menu.y, window.innerHeight - box.height - 4)),
    });
    element.current!.focus();
  }, [menu, columns]);

  useEffect(() => {
    const outside = (event: Event) => {
      if (!element.current?.contains(event.target as Node)) onClose();
    };
    const escape = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    document.addEventListener('mousedown', outside);
    document.addEventListener('scroll', outside, true);
    document.addEventListener('keydown', escape);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('scroll', outside, true);
      document.removeEventListener('keydown', escape);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  return (
    <div
      className={columns > 1 ? 'menu context columns' : 'menu context'}
      role="menu"
      tabIndex={-1}
      ref={element}
      style={columns > 1 ? { ...position, columnCount: columns } : position}
    >
      {menu.items.map((item, index) =>
        item === 'separator' ? (
          <hr key={index} />
        ) : (
          <button
            key={index}
            role="menuitem"
            className={item.danger ? 'danger' : undefined}
            onClick={() => {
              onClose();
              item.run();
            }}
          >
            {item.label}
          </button>
        ),
      )}
    </div>
  );
}

export function MenuProvider({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState<OpenState | null>(null);
  const opened = useRef(0);
  const close = useCallback(() => setMenu(null), []);
  const open = useCallback<OpenMenu>((event, entries) => {
    event.preventDefault();
    event.stopPropagation();
    const items = tidy(entries);
    // A button pressed from the keyboard has no pointer position: the menu opens below the button instead.
    const box = event.type === 'click' && event.detail === 0 ? event.currentTarget.getBoundingClientRect() : null;
    setMenu(items.length ? { id: ++opened.current, x: box?.left ?? event.clientX, y: box?.bottom ?? event.clientY, items } : null);
  }, []);

  return (
    <MenuContext.Provider value={open}>
      {children}
      {/* A menu opened while another is open starts afresh, in one column. */}
      {menu && <Menu key={menu.id} menu={menu} onClose={close} />}
    </MenuContext.Provider>
  );
}
