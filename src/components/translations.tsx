'use client';
import * as Dialog from '@radix-ui/react-dialog';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import type {
  ServicesStatus,
  TrackedMedia,
  TranslationAction,
  TranslationFile,
  TranslationJob,
  TranslationMode,
  TranslationModels,
} from '@/types/shared';
import { send, useApi } from '@/lib/client/api';
import { useI18n } from '@/i18n/I18nProvider';
import { Select } from './select';
import { toast } from './notify';
import { Spinner, cx, errorText, primaryButton, smallButton } from './ui';

const LANGUAGES = ['en', 'fr', 'es', 'de', 'it', 'pt', 'ja', 'ko', 'zh', 'ru'];
const ACTIVE = new Set(['queued', 'pending', 'running', 'importing']);

/** Translation of an owned book through TraDoc: jobs of this work, and the "Translate" dialog. */
export function Translations({ entry, owned }: { entry: TrackedMedia; owned: boolean }) {
  const { t } = useI18n();
  const status = useApi<ServicesStatus>('/api/status');
  const jobs = useApi<TranslationJob[]>(`/api/translations?trackedId=${entry.id}`, {
    refreshInterval: (data) => (data?.some((j) => ACTIVE.has(j.state)) ? 5000 : 0),
  });
  const [open, setOpen] = useState(false);
  const configured = status.data ? status.data.tradoc.state !== 'unconfigured' : true;
  return (
    <section className="flex flex-col gap-3 rounded-2xl bg-white/[0.04] p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-lg font-semibold">{t('translate.title')}</h3>
        {configured && owned && (
          <button type="button" className={smallButton} onClick={() => setOpen(true)}>
            {t('translate.open')}
          </button>
        )}
      </div>
      {!configured ? (
        <p className="text-mid text-sm">
          {t('translate.notConfigured')}{' '}
          <Link href="/settings#connections" className="underline hover:text-white">
            {t('translate.settings')}
          </Link>
        </p>
      ) : !owned ? (
        <p className="text-mid text-sm">{t('translate.notOwned')}</p>
      ) : (
        !jobs.data?.length && <p className="text-muted text-sm">{t('translate.empty')}</p>
      )}
      {jobs.data && jobs.data.length > 0 && (
        <ul className="flex flex-col">
          {jobs.data.map((job) => (
            <JobRow key={job.id} job={job} onChange={() => jobs.mutate()} />
          ))}
        </ul>
      )}
      {open && (
        <TranslateDialog
          entry={entry}
          onClose={() => setOpen(false)}
          onStarted={() => {
            setOpen(false);
            void jobs.mutate();
          }}
        />
      )}
    </section>
  );
}

function JobRow({ job, onChange }: { job: TranslationJob; onChange: () => void }) {
  const { t, n } = useI18n();
  const [busy, setBusy] = useState(false);
  const act = async (action: TranslationAction) => {
    if (action === 'remove' && job.backup && !window.confirm(t('translate.removeBackup'))) return;
    setBusy(true);
    try {
      await send('/api/translations/control', 'POST', { id: job.id, action });
      onChange();
    } catch (e) {
      toast({ tone: 'bad', text: errorText(t, e) });
    } finally {
      setBusy(false);
    }
  };
  const actions: TranslationAction[] = [
    ...(['pending', 'running'].includes(job.state) ? (['pause'] as const) : []),
    ...(['paused', 'failed'].includes(job.state) ? (['resume'] as const) : []),
    ...(job.state === 'error' ? (['retry'] as const) : []),
    ...(job.state === 'completed' && job.backup ? (['restore'] as const) : []),
    ...(!['completed', 'restored', 'cancelled'].includes(job.state) ? (['cancel'] as const) : []),
    ...(['completed', 'restored', 'cancelled', 'error'].includes(job.state)
      ? (['remove'] as const)
      : []),
  ];
  const percent = job.progress !== null ? Math.round(job.progress * 100) : null;
  return (
    <li className="border-line flex flex-col gap-2 border-b py-3 last:border-b-0">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="min-w-0 flex-1 truncate font-medium">{job.fileName}</span>
        <span
          className={cx(
            'text-xs',
            job.state === 'completed'
              ? 'text-ok'
              : ['error', 'failed'].includes(job.state)
                ? 'text-bad'
                : 'text-mid',
          )}
        >
          {t(`translate.state.${job.state}`)}
          {job.state === 'running' && percent !== null ? ` · ${n(percent)} %` : ''}
          {job.error && ['error', 'failed'].includes(job.state)
            ? ` · ${t(`error.${job.error}`) === `error.${job.error}` ? job.error : t(`error.${job.error}`)}`
            : ''}
        </span>
      </div>
      <span className="text-muted text-xs">
        {job.sourceLang.toUpperCase()} → {job.targetLang.toUpperCase()}
        {job.model ? ` · ${job.model}` : ''} ·{' '}
        {t(job.mode === 'replace' ? 'translate.modeReplace' : 'translate.modeSeparate')}
        {job.backup && job.state === 'completed' ? ` · ${t('translate.backupKept')}` : ''}
      </span>
      {ACTIVE.has(job.state) && (
        <span className="h-1 overflow-hidden rounded-full bg-white/10">
          <span
            className="block h-full rounded-full bg-[var(--accent)] transition-[width] duration-500"
            style={{ width: `${percent ?? 2}%` }}
          />
        </span>
      )}
      {actions.length > 0 && (
        <span className="flex flex-wrap gap-2">
          {actions.map((a) => (
            <button
              key={a}
              type="button"
              disabled={busy}
              onClick={() => act(a)}
              className="text-mid text-xs underline decoration-white/30 underline-offset-4 hover:text-white disabled:opacity-50"
            >
              {t(`translate.action.${a}`)}
            </button>
          ))}
        </span>
      )}
    </li>
  );
}

function TranslateDialog({
  entry,
  onClose,
  onStarted,
}: {
  entry: TrackedMedia;
  onClose: () => void;
  onStarted: () => void;
}) {
  const { t, n, language } = useI18n();
  const files = useApi<TranslationFile[]>(`/api/translations/files?trackedId=${entry.id}`);
  const models = useApi<TranslationModels>('/api/translations/models');
  const names = useMemo(() => {
    try {
      return new Intl.DisplayNames([language], { type: 'language' });
    } catch {
      return null;
    }
  }, [language]);
  const label = (code: string) => {
    const name = names?.of(code);
    return name ? name.charAt(0).toUpperCase() + name.slice(1) : code.toUpperCase();
  };
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [source, setSource] = useState(language === 'en' ? 'ja' : 'en');
  const [target, setTarget] = useState<string>(language);
  const [model, setModel] = useState('');
  const [mode, setMode] = useState<TranslationMode>('replace');
  const [busy, setBusy] = useState(false);
  const chosen = picked ?? new Set((files.data ?? []).map((f) => f.path));
  const def = models.data?.default;
  const modelOptions = [
    {
      value: '',
      label: def?.model
        ? t('translate.defaultModel', { model: `${def.provider ?? ''} · ${def.model}` })
        : t('translate.defaultModelNone'),
    },
    ...(models.data?.providers ?? []).flatMap((p) =>
      p.models.map((m) => ({ value: `${p.provider}\u0000${m}`, label: `${p.provider} · ${m}` })),
    ),
  ];
  async function start() {
    setBusy(true);
    try {
      const [provider, chosenModel] = model ? model.split('\u0000') : [];
      await send('/api/translations', 'POST', {
        trackedId: entry.id,
        paths: [...chosen],
        sourceLang: source,
        targetLang: target,
        ...(provider ? { provider, model: chosenModel } : {}),
        mode,
      });
      toast({ tone: 'ok', text: t('translate.started', { n: n(chosen.size) }) });
      onStarted();
    } catch (e) {
      toast({ tone: 'bad', text: errorText(t, e) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70" />
        <Dialog.Content className="bg-bg border-line fixed top-1/2 left-1/2 z-50 flex max-h-[90dvh] w-[min(560px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 flex-col gap-5 overflow-y-auto rounded-3xl border p-5 outline-none md:p-7">
          <div className="flex items-start gap-3">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <Dialog.Title className="font-display text-[26px] leading-none font-extrabold tracking-[-0.03em]">
                {t('translate.dialogTitle')}
              </Dialog.Title>
              <Dialog.Description className="text-muted truncate font-serif text-lg italic">
                {entry.title}
              </Dialog.Description>
            </div>
            <Dialog.Close
              className="text-mid -mt-2 -mr-2 flex size-11 shrink-0 items-center justify-center rounded-full hover:bg-white/[0.08]"
              aria-label={t('common.close')}
            >
              ✕
            </Dialog.Close>
          </div>

          <fieldset className="flex flex-col gap-2">
            <legend className="text-muted mb-2 text-xs tracking-[0.14em] uppercase">
              {t('translate.files')}
            </legend>
            {files.isLoading ? (
              <span className="text-mid flex items-center gap-2 text-sm">
                <Spinner /> {t('translate.loading')}
              </span>
            ) : files.error ? (
              <span className="text-bad text-sm">{errorText(t, files.error)}</span>
            ) : !files.data?.length ? (
              <span className="text-mid text-sm">{t('translate.noFiles')}</span>
            ) : (
              files.data.map((f) => (
                <label key={f.path} className="flex items-center gap-3 text-sm">
                  <input
                    type="checkbox"
                    checked={chosen.has(f.path)}
                    onChange={() => {
                      const next = new Set(chosen);
                      if (next.has(f.path)) next.delete(f.path);
                      else next.add(f.path);
                      setPicked(next);
                    }}
                    className="size-4 shrink-0 accent-[var(--accent)]"
                  />
                  <span className="min-w-0 flex-1 truncate">{f.name}</span>
                  {f.sizeBytes !== null && (
                    <span className="text-muted shrink-0 text-xs">
                      {n(Math.max(0.1, Math.round(f.sizeBytes / 104857.6) / 10))} Mo
                    </span>
                  )}
                </label>
              ))
            )}
          </fieldset>

          <div className="grid grid-cols-2 gap-3">
            <label className="text-muted flex flex-col gap-1.5 text-[13px]">
              {t('translate.from')}
              <Select
                label={t('translate.from')}
                value={source}
                onChange={setSource}
                options={LANGUAGES.map((l) => ({ value: l, label: label(l) }))}
                className="w-full rounded-xl"
              />
            </label>
            <label className="text-muted flex flex-col gap-1.5 text-[13px]">
              {t('translate.to')}
              <Select
                label={t('translate.to')}
                value={target}
                onChange={setTarget}
                options={LANGUAGES.map((l) => ({ value: l, label: label(l) }))}
                className="w-full rounded-xl"
              />
            </label>
          </div>

          <label className="text-muted flex flex-col gap-1.5 text-[13px]">
            {t('translate.model')}
            <Select
              label={t('translate.model')}
              value={model}
              onChange={setModel}
              options={modelOptions}
              className="w-full rounded-xl"
            />
            {models.error && (
              <span className="text-warn text-xs">{t('translate.modelsFailed')}</span>
            )}
          </label>

          <fieldset className="flex flex-col gap-2">
            <legend className="text-muted mb-2 text-xs tracking-[0.14em] uppercase">
              {t('translate.mode')}
            </legend>
            {(['replace', 'separate'] as const).map((m) => (
              <label
                key={m}
                className={cx(
                  'flex cursor-pointer items-start gap-3 rounded-2xl p-3 text-sm',
                  mode === m ? 'bg-white/[0.08]' : 'bg-white/[0.03]',
                )}
              >
                <input
                  type="radio"
                  name="translation-mode"
                  checked={mode === m}
                  onChange={() => setMode(m)}
                  className="mt-0.5 size-4 shrink-0 accent-[var(--accent)]"
                />
                <span className="flex flex-col gap-0.5">
                  <span className="font-medium">
                    {t(m === 'replace' ? 'translate.modeReplace' : 'translate.modeSeparate')}
                  </span>
                  <span className="text-muted text-xs leading-relaxed">
                    {t(
                      m === 'replace' ? 'translate.modeReplaceHint' : 'translate.modeSeparateHint',
                    )}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>

          <button
            type="button"
            disabled={busy || !chosen.size || source === target}
            onClick={start}
            className={cx(primaryButton, 'self-stretch')}
          >
            {busy && <Spinner />}
            {t('translate.start')}
          </button>
          {source === target && (
            <span className="text-warn -mt-3 text-xs">{t('translate.sameLanguage')}</span>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
