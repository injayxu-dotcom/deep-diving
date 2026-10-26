import { useEffect, useRef, useState } from 'react';
import { Icon, type IconName } from './Icon';

export type MoreItem = {
  key: string;
  icon: IconName;
  label: string;
  onClick: () => void;
  /** 次要说明，例如"会删除画布与简报" */
  hint?: string;
  disabled?: boolean;
  /** 不可逆操作（清空）：走危险色，且和上面的项拉开一道分隔线 */
  danger?: boolean;
};

/**
 * 顶栏的「⋯ 更多」。
 *
 * 为什么要有它：顶栏原来 10 个按钮平铺，最右边挤着「清空」这种**不可逆**操作，
 * 和「操作说明」挨着、同一种灰、同样大小 —— 误点成本完全不成比例。
 * 收进菜单之后才有位置表达"这一项不一样"：危险色 + 分隔线 + 一句后果说明。
 *
 * 三个细节都是踩过的"看起来能用但其实不能"：
 * ① 用 mousedown 而不是 click 判"点到了外面"。click 要等 mouseup，
 *    如果用户从按钮上按下、拖到外面松手，click 会落在外面 —— 菜单会先关再被这次点击
 *    重新打开，表现成"点不掉"。
 * ② 关闭时**不渲染**菜单项，而不是用 CSS 藏起来。否则 Tab 键会走到看不见的按钮上。
 * ③ Esc 关闭后把焦点还给触发按钮，不然焦点停在 body 上，键盘用户直接迷路。
 */
export function MoreMenu({ items }: { items: MoreItem[] }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  /** ↑↓ 在菜单项之间移动焦点；首尾循环，符合菜单的标准键盘行为 */
  const move = (dir: 1 | -1) => {
    const nodes = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    if (!nodes.length) return;
    const i = nodes.indexOf(document.activeElement as HTMLButtonElement);
    const next = i < 0 ? (dir === 1 ? 0 : nodes.length - 1) : (i + dir + nodes.length) % nodes.length;
    nodes[next].focus();
  };

  return (
    <div className="more-wrap" ref={wrap}>
      <button
        ref={trigger}
        className="btn ghost sm more-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="更多"
        title="更多"
        onClick={() => setOpen((v) => !v)}
        data-act="more"
      >
        {/* 稿子里这一项就是个省略号字形（图标集里没有 ellipsis，也没必要为它画一个）。
            形状本身是惯例，所以配 aria-label 兜住读屏。 */}
        <span className="more-dots" aria-hidden="true">⋯</span>
      </button>

      {open ? (
        <div className="more-menu" role="menu" ref={menu} onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
          if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
        }}>
          {items.map((it) => (
            <button
              key={it.key}
              role="menuitem"
              className={`more-item ${it.danger ? 'danger' : ''}`}
              disabled={it.disabled}
              data-act={it.key}
              onClick={() => { setOpen(false); it.onClick(); }}
            >
              <Icon name={it.icon} />
              <span className="more-item-t">{it.label}</span>
              {it.hint ? <span className="more-item-h">{it.hint}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
