'use client';
import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { BookPosition } from './epub-view';

/**
 * PDF pages rendered in the browser (pdf.js), one under the other. Only the pages near the
 * screen are drawn; the file itself is read in byte ranges.
 */
export function PdfView({
  url,
  initialPage,
  zoom,
  background,
  onPosition,
  onToggleChrome,
  onReady,
  onError,
}: {
  url: string;
  initialPage: number;
  zoom: number;
  background: string;
  onPosition: (p: BookPosition) => void;
  onToggleChrome: () => void;
  onReady: (pages: number) => void;
  onError: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [ratio, setRatio] = useState(1.414);
  const callbacks = useRef({ onPosition, onReady, onError });
  useEffect(() => {
    callbacks.current = { onPosition, onReady, onError };
  });

  useEffect(() => {
    let cancelled = false;
    let task: { destroy(): Promise<void> } | null = null;
    void (async () => {
      try {
        const pdfjs = await import('pdfjs-dist');
        if (!pdfjs.GlobalWorkerOptions.workerPort)
          pdfjs.GlobalWorkerOptions.workerPort = new Worker(
            new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url),
            { type: 'module' },
          );
        const loading = pdfjs.getDocument({
          url,
          withCredentials: true,
          disableAutoFetch: true,
          rangeChunkSize: 256 * 1024,
        });
        task = loading;
        const doc = await loading.promise;
        const first = await doc.getPage(1);
        const view = first.getViewport({ scale: 1 });
        if (cancelled) return;
        setRatio(view.height / view.width);
        setPdf(doc);
        callbacks.current.onReady(doc.numPages);
      } catch {
        if (!cancelled) callbacks.current.onError();
      }
    })();
    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [url]);

  // Back to the saved page once the document is there.
  useEffect(() => {
    if (!pdf || !box.current) return;
    const el = box.current.querySelector<HTMLElement>(`[data-page="${initialPage}"]`);
    el?.scrollIntoView({ block: 'start' });
  }, [pdf, initialPage]);

  // The current page is the one crossing the middle of the screen.
  useEffect(() => {
    const el = box.current;
    if (!el || !pdf) return;
    let request = 0;
    let last = -1;
    const onScroll = () => {
      cancelAnimationFrame(request);
      request = requestAnimationFrame(() => {
        const middle = el.scrollTop + el.clientHeight / 2;
        let current = 0;
        for (const child of el.querySelectorAll<HTMLElement>('[data-page]'))
          if (child.offsetTop <= middle) current = Number(child.dataset.page);
        if (current === last) return;
        last = current;
        const n = pdf.numPages;
        callbacks.current.onPosition({
          part: current,
          offset: 0,
          fraction: n > 1 ? current / (n - 1) : 1,
          page: current,
          pages: n,
        });
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener('scroll', onScroll);
  }, [pdf]);

  return (
    <div
      ref={box}
      onClick={onToggleChrome}
      className="h-full w-full overflow-y-auto overscroll-contain"
      style={{ background }}
    >
      <div className="mx-auto flex flex-col gap-3 px-2 py-16" style={{ maxWidth: 900 * zoom }}>
        {pdf &&
          Array.from({ length: pdf.numPages }, (_, i) => (
            <PdfPage key={i} pdf={pdf} index={i} ratio={ratio} root={box} zoom={zoom} />
          ))}
      </div>
    </div>
  );
}

function PdfPage({
  pdf,
  index,
  ratio,
  root,
  zoom,
}: {
  pdf: PDFDocumentProxy;
  index: number;
  ratio: number;
  zoom: number;
  root: React.RefObject<HTMLDivElement | null>;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(index < 2);
  const [aspect, setAspect] = useState(ratio);
  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), {
      root: root.current,
      rootMargin: '150% 0px',
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [root]);
  useEffect(() => {
    const el = holder.current;
    if (!near || !el) return;
    let cancelled = false;
    let task: { cancel(): void } | null = null;
    const canvas = document.createElement('canvas');
    canvas.className = 'block h-auto w-full rounded-sm bg-white';
    void (async () => {
      try {
        const page = await pdf.getPage(index + 1);
        if (cancelled) return;
        const base = page.getViewport({ scale: 1 });
        setAspect(base.height / base.width);
        const scale = (el.clientWidth * Math.min(window.devicePixelRatio || 1, 2.5)) / base.width;
        const viewport = page.getViewport({ scale });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const render = page.render({ canvas, viewport });
        task = render;
        await render.promise;
        if (!cancelled) el.replaceChildren(canvas);
      } catch {
        /* Cancelled or damaged page: the placeholder stays. */
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
      el.replaceChildren();
    };
  }, [near, pdf, index, zoom]);
  return (
    <div
      ref={holder}
      data-page={index}
      className="w-full rounded-sm bg-white/[0.06]"
      style={{ aspectRatio: `1 / ${aspect}` }}
    />
  );
}
