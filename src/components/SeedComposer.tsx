import { useState } from 'react';
import { useStore } from '../store/useStore';

/**
 * 种子词输入。
 *
 * 左栏与画布空态共用同一份提交逻辑——中文输入法组词时的回车、
 * 空词校验、成功才清空输入框，这些细节只在写一遍。
 */
export function SeedComposer({
  size = 'sm',
  placeholder = '一个词，例如：锈蚀',
  autoFocus,
}: {
  size?: 'sm' | 'lg';
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const [v, setV] = useState('');
  const addSeed = useStore((s) => s.addSeed);
  const ok = v.trim().length > 0;

  // 返回 null 说明是空词或纯空格：什么都不做，输入框内容保留
  const submit = () => {
    if (addSeed(v)) setV('');
  };

  return (
    <div className={`seed-add ${size}`}>
      <input
        className="pinput"
        value={v}
        placeholder={placeholder}
        maxLength={40}
        autoFocus={autoFocus}
        aria-label="种子词"
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          // 输入法组词过程中的回车是选词，不是提交
          if (e.nativeEvent.isComposing) return;
          e.preventDefault();
          submit();
        }}
      />
      <button className={`btn ${size === 'lg' ? 'pri' : 'aqua'}`} disabled={!ok} onClick={submit}>
        添加
      </button>
    </div>
  );
}
