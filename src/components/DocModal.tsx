import { useMemo, useState } from 'react';
import { useStore } from '../store/useStore';
import { buildDoc } from '../lib/docExport';

/**
 * 交付文档弹层：预览 Markdown 全文 → 复制 / 下载。
 * 遵循「预览 → 确认 → 带走」的流程，不直接触发下载。
 */
export function DocModal({ onClose }: { onClose: () => void }) {
  const product = useStore((s) => s.product);
  const mood = useStore((s) => s.mood);
  const brief = useStore((s) => s.brief);
  const report = useStore((s) => s.report);
  const intel = useStore((s) => s.intel);
  const nodes = useStore((s) => s.nodes);
  const edges = useStore((s) => s.edges);

  const md = useMemo(
    () => buildDoc({ product, mood, brief, report, intel, nodes, edges }),
    [product, mood, brief, report, intel, nodes, edges],
  );
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(md);
    } catch {
      // 沙箱里 clipboard API 可能被禁，退回 execCommand
      const ta = document.createElement('textarea');
      ta.value = md;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const download = () => {
    const name = (product.trim() || '创意深潜').replace(/[\\/:*?"<>|]/g, '_');
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${name}-交付文档.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal modal-doc" onClick={(e) => e.stopPropagation()}>
        <div className="modal-h">
          <span>交付文档 · Markdown</span>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>

        <div className="modal-b">
          <p className="doc-hint">
            由当前画布内容自动汇编：调研洞察 / 情报卡 / 种子词（含来源）/ 收敛概念与提示词。先检查，再带走。
          </p>
          <pre className="doc-pre">{md}</pre>
        </div>

        <div className="modal-f">
          <span className="doc-meta">{md.length} 字符</span>
          <button className="btn sm" onClick={onClose}>
            关闭
          </button>
          <button className="btn sm" onClick={download}>
            下载 .md
          </button>
          <button className="btn sm aqua" onClick={copy}>
            {copied ? '已复制 ✓' : '复制全文'}
          </button>
        </div>
      </div>
    </div>
  );
}
