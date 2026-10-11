'use client';

import type { AttributeRowDto, ProfileDto } from '@lodgent/shared';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox, Input, Select } from '@/components/ui/form';
import { Alert, Badge } from '@/components/ui/misc';
import type { ActionState } from '@/lib/api';
import { cn } from '@/lib/utils';
import { importWebsite, reviewDescription, reviewSuggestions, setAttribute } from './profile-actions';

type Value = boolean | number | string;
type Suggestion = AttributeRowDto['suggestions'][number];
type Source = Suggestion['source'];

const SOURCES: Record<
  Source,
  { label: string; variant: 'secondary' | 'outline' | 'default' | 'success'; title: string }
> = {
  pms: { label: 'Apaleo', variant: 'secondary', title: 'Derived from your Apaleo set-up' },
  website: { label: 'Website', variant: 'outline', title: 'Found on your website by keyword matching' },
  ai_extracted: { label: 'AI · website', variant: 'default', title: 'Extracted from your website by AI' },
  hotel: { label: 'You', variant: 'success', title: 'Set by your team' },
};

export function SourceBadge({ source }: { source: Source }) {
  const s = SOURCES[source];
  return (
    <Badge variant={s.variant} title={s.title}>
      {s.label}
    </Badge>
  );
}

function formatValue(value: Value, row: Pick<AttributeRowDto, 'unit'>): string {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return row.unit ? `${value} ${row.unit}` : String(value);
  return value.replace(/_/g, ' ');
}

function Evidence({ evidence }: { evidence: Suggestion['evidence'] }) {
  if (evidence.length === 0) return null;
  return (
    <ul className="mt-1 grid gap-1">
      {evidence.slice(0, 3).map((e) => {
        const isWeb = /^https?:\/\//.test(e.url);
        return (
          <li key={`${e.url}-${e.snippet}`} className="text-xs text-muted-foreground">
            <q className="italic">{e.snippet}</q>{' '}
            {isWeb ? (
              <a
                href={e.url}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="underline underline-offset-2"
              >
                {new URL(e.url).pathname}
              </a>
            ) : (
              <span>({e.url.replace(/^pms:\/\/apaleo\//, 'Apaleo ').replace(/\/.*$/, '')})</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** One proposed value for one attribute; agreeing suggestions from several sources are merged. */
interface PendingItem {
  key: string;
  ids: string[];
  value: Value;
  sources: Source[];
  confidence: number;
  evidence: Suggestion['evidence'];
  row: AttributeRowDto;
  group: string;
  scope: string;
}

/** Wraps a server action call with transition state and a shared status message. */
function useAction() {
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<ActionState>(null);
  const run = (fn: () => Promise<ActionState>, after?: () => void) =>
    startTransition(async () => {
      const result = await fn();
      setStatus(result);
      if (result?.ok) after?.();
    });
  return { pending, status, run };
}

function StatusLine({ status }: { status: ActionState }) {
  return (
    <div aria-live="polite">
      {status?.error ? <Alert variant="error">{status.error}</Alert> : null}
      {status?.ok && status.message ? <Alert variant="success">{status.message}</Alert> : null}
    </div>
  );
}

export function ProfileEditor({
  orgId,
  propertyId,
  profile,
  canEdit,
  websiteUrl,
}: {
  orgId: string;
  propertyId: string;
  profile: ProfileDto;
  canEdit: boolean;
  websiteUrl: string | null;
}) {
  const router = useRouter();
  const crawlActive = profile.crawl?.status === 'queued' || profile.crawl?.status === 'running';

  // While an import runs, refresh every few seconds so suggestions appear as soon as it finishes.
  useEffect(() => {
    if (!crawlActive) return;
    const t = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(t);
  }, [crawlActive, router]);

  return (
    <div className="grid gap-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <CompletenessCard profile={profile} />
        <ImportCard
          orgId={orgId}
          propertyId={propertyId}
          profile={profile}
          canEdit={canEdit}
          websiteUrl={websiteUrl}
        />
      </div>
      {profile.descriptions.length > 0 ? (
        <DescriptionSuggestions orgId={orgId} propertyId={propertyId} profile={profile} canEdit={canEdit} />
      ) : null}
      <ReviewQueue orgId={orgId} propertyId={propertyId} profile={profile} canEdit={canEdit} />
      <AttributeEditor orgId={orgId} propertyId={propertyId} profile={profile} canEdit={canEdit} />
    </div>
  );
}

function CompletenessCard({ profile }: { profile: ProfileDto }) {
  const { score, gaps } = profile.completeness;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Profile completeness</CardTitle>
        <CardDescription>The more agents know, the more searches you match.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="flex items-center gap-3">
          <div
            className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuenow={score}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Profile completeness"
          >
            <div
              className={cn(
                'h-full rounded-full',
                score >= 80 ? 'bg-success' : score >= 50 ? 'bg-primary' : 'bg-warning',
              )}
              style={{ width: `${score}%` }}
            />
          </div>
          <span className="w-12 text-right text-lg font-semibold tabular-nums">{score}%</span>
        </div>
        {gaps.length > 0 ? (
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Most valuable next steps
            </p>
            <ol className="grid gap-1.5 text-sm">
              {gaps.slice(0, 5).map((g) => (
                <li key={g.key} className="flex gap-2">
                  <span aria-hidden className="text-muted-foreground">
                    →
                  </span>
                  <span>
                    <span className="font-medium">{g.label}</span>
                    <span className="text-muted-foreground"> — {g.message}</span>
                  </span>
                </li>
              ))}
            </ol>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Nothing important is missing.</p>
        )}
      </CardContent>
    </Card>
  );
}

function ImportCard({
  orgId,
  propertyId,
  profile,
  canEdit,
  websiteUrl,
}: {
  orgId: string;
  propertyId: string;
  profile: ProfileDto;
  canEdit: boolean;
  websiteUrl: string | null;
}) {
  const { pending, status, run } = useAction();
  const crawl = profile.crawl;
  const active = crawl?.status === 'queued' || crawl?.status === 'running';
  return (
    <Card>
      <CardHeader>
        <CardTitle>Import from your website</CardTitle>
        <CardDescription>
          We read up to 30 pages of your site and suggest attributes, each with the sentence it came from.
          Nothing goes live until you approve it.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        {websiteUrl ? (
          <p>
            Website:{' '}
            <a
              href={websiteUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2"
            >
              {websiteUrl}
            </a>
          </p>
        ) : (
          <Alert variant="warning">Add your website URL under Details first.</Alert>
        )}
        {crawl ? (
          <div className="rounded-md border bg-muted/40 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">Last import</span>
              <Badge
                variant={
                  crawl.status === 'succeeded'
                    ? 'success'
                    : crawl.status === 'failed'
                      ? 'destructive'
                      : 'warning'
                }
              >
                {active ? `${crawl.status}…` : crawl.status}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {new Date(crawl.createdAt).toLocaleString()}
              </span>
            </div>
            {crawl.status === 'succeeded' && crawl.stats ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {crawl.stats.pages} pages read · {crawl.stats.suggestions} suggestions ({crawl.stats.new} new,{' '}
                {crawl.stats.changed} changed) · {crawl.stats.droppedUnverified} dropped because the quote
                wasn’t on the page{crawl.model ? ` · ${crawl.model}` : ''}
              </p>
            ) : null}
            {crawl.error ? <p className="mt-1 text-xs text-destructive">{crawl.error}</p> : null}
          </div>
        ) : null}
        {canEdit ? (
          <div>
            <Button
              variant="outline"
              disabled={!websiteUrl || active || pending}
              onClick={() => run(() => importWebsite(orgId, propertyId))}
            >
              {active ? 'Importing…' : pending ? 'Starting…' : crawl ? 'Import again' : 'Import website'}
            </Button>
          </div>
        ) : null}
        <StatusLine status={status} />
      </CardContent>
    </Card>
  );
}

function DescriptionSuggestions({
  orgId,
  propertyId,
  profile,
  canEdit,
}: {
  orgId: string;
  propertyId: string;
  profile: ProfileDto;
  canEdit: boolean;
}) {
  const { pending, status, run } = useAction();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Suggested descriptions</CardTitle>
        <CardDescription>Written from your website. Accepting replaces the current text.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {profile.descriptions.map((d) => (
          <div key={d.id} className="grid gap-2 rounded-md border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{d.roomTypeName ?? 'Hotel description'}</span>
              <SourceBadge source={d.source} />
              {d.evidenceUrl && /^https?:/.test(d.evidenceUrl) ? (
                <a
                  href={d.evidenceUrl}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="text-xs text-muted-foreground underline"
                >
                  source
                </a>
              ) : null}
            </div>
            <p className="text-sm">{d.text}</p>
            {d.current ? (
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer">Current text</summary>
                <p className="mt-1">{d.current}</p>
              </details>
            ) : null}
            {canEdit ? (
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={pending}
                  onClick={() => run(() => reviewDescription(orgId, propertyId, d.id, true))}
                >
                  Use this
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => run(() => reviewDescription(orgId, propertyId, d.id, false))}
                >
                  Dismiss
                </Button>
              </div>
            ) : null}
          </div>
        ))}
        <StatusLine status={status} />
      </CardContent>
    </Card>
  );
}

function ReviewQueue({
  orgId,
  propertyId,
  profile,
  canEdit,
}: {
  orgId: string;
  propertyId: string;
  profile: ProfileDto;
  canEdit: boolean;
}) {
  const items = useMemo(() => {
    const byKey = new Map<string, PendingItem>();
    const add = (row: AttributeRowDto, group: string) => {
      const scope = `${row.roomTypeId ?? '-'}:${row.code}`;
      for (const s of row.suggestions) {
        if (s.status !== 'suggested') continue;
        const key = `${scope}=${JSON.stringify(s.value)}`;
        const item = byKey.get(key);
        if (item) {
          item.ids.push(s.assignmentId);
          if (!item.sources.includes(s.source)) item.sources.push(s.source);
          item.confidence = Math.max(item.confidence, s.confidence);
          item.evidence.push(...s.evidence);
        } else {
          byKey.set(key, {
            key,
            ids: [s.assignmentId],
            value: s.value,
            sources: [s.source],
            confidence: s.confidence,
            evidence: [...s.evidence],
            row,
            group,
            scope,
          });
        }
      }
    };
    for (const c of profile.categories) for (const row of c.attributes) add(row, c.label);
    for (const r of profile.rooms) for (const row of r.attributes) add(row, r.name);
    return [...byKey.values()];
  }, [profile]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const { pending, status, run } = useAction();

  if (items.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Suggestions to review</CardTitle>
          <CardDescription>
            All caught up. New suggestions appear after a sync or a website import.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const conflicts = (item: PendingItem) => items.filter((o) => o.scope === item.scope && o.key !== item.key);
  const toggle = (item: PendingItem) => {
    const next = new Set(selected);
    if (next.has(item.key)) {
      next.delete(item.key);
    } else {
      // Only one value per attribute can win: deselect conflicting values for the same attribute.
      for (const other of conflicts(item)) next.delete(other.key);
      next.add(item.key);
    }
    setSelected(next);
  };
  const selectConfident = () => {
    const next = new Set<string>();
    const chosen = new Set<string>();
    for (const item of [...items].sort((a, b) => b.confidence - a.confidence)) {
      if (item.confidence < 0.8 || chosen.has(item.scope)) continue;
      chosen.add(item.scope);
      next.add(item.key);
    }
    setSelected(next);
  };
  const groups = [...new Set(items.map((i) => i.group))];
  const ids = items.filter((i) => selected.has(i.key)).flatMap((i) => i.ids);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Suggestions to review ({items.length})</CardTitle>
        <CardDescription>
          Approved values are what agents see. Each suggestion shows where it came from; your own edits always
          win.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {canEdit ? (
          <div className="sticky top-0 z-10 -mx-2 flex flex-wrap items-center gap-2 rounded-md bg-card/95 px-2 py-2 backdrop-blur">
            <Button size="sm" variant="outline" onClick={selectConfident}>
              Select confident (80%+)
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setSelected(new Set())}
              disabled={selected.size === 0}
            >
              Clear
            </Button>
            <span className="ml-auto text-xs text-muted-foreground">{selected.size} selected</span>
            <Button
              size="sm"
              disabled={pending || selected.size === 0}
              onClick={() =>
                run(
                  () => reviewSuggestions(orgId, propertyId, ids, []),
                  () => setSelected(new Set()),
                )
              }
            >
              Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={pending || selected.size === 0}
              onClick={() =>
                run(
                  () => reviewSuggestions(orgId, propertyId, [], ids),
                  () => setSelected(new Set()),
                )
              }
            >
              Reject
            </Button>
          </div>
        ) : null}
        <StatusLine status={status} />
        {groups.map((group) => (
          <fieldset key={group} className="grid gap-1">
            <legend className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {group}
            </legend>
            {items
              .filter((i) => i.group === group)
              .map((item) => (
                // biome-ignore lint/a11y/noLabelWithoutControl: the Checkbox inside is a native input (editors only).
                <label
                  key={item.key}
                  className={cn(
                    'flex gap-3 rounded-md border px-3 py-2',
                    selected.has(item.key) ? 'border-primary/50 bg-accent' : 'hover:bg-muted/50',
                  )}
                >
                  {canEdit ? (
                    <Checkbox
                      className="mt-0.5"
                      checked={selected.has(item.key)}
                      onChange={() => toggle(item)}
                      aria-label={`${item.row.label}: ${formatValue(item.value, item.row)}`}
                    />
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-medium">{item.row.label}</span>
                      <span>{formatValue(item.value, item.row)}</span>
                      {item.sources.map((source) => (
                        <SourceBadge key={source} source={source} />
                      ))}
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {Math.round(item.confidence * 100)}%
                      </span>
                      {conflicts(item).length > 0 ? <Badge variant="warning">Sources disagree</Badge> : null}
                      {item.row.effective ? (
                        <span className="text-xs text-muted-foreground">
                          currently {formatValue(item.row.effective.value, item.row)}
                        </span>
                      ) : null}
                    </div>
                    <Evidence evidence={item.evidence} />
                  </div>
                </label>
              ))}
          </fieldset>
        ))}
      </CardContent>
    </Card>
  );
}

function ValueControl({
  row,
  disabled,
  onSet,
}: {
  row: AttributeRowDto;
  disabled: boolean;
  onSet: (value: Value | null) => void;
}) {
  const current = row.effective?.value ?? null;
  const [draft, setDraft] = useState(current === null ? '' : String(current));
  useEffect(() => setDraft(current === null ? '' : String(current)), [current]);
  const id = `attr-${row.roomTypeId ?? 'p'}-${row.code}`;

  if (row.valueType === 'boolean') {
    const options: { label: string; value: boolean | null }[] = [
      { label: 'Yes', value: true },
      { label: 'No', value: false },
      { label: '—', value: null },
    ];
    return (
      <fieldset className="inline-flex rounded-md border" disabled={disabled}>
        <legend className="sr-only">{row.label}</legend>
        {options.map((o) => (
          <label
            key={o.label}
            className="cursor-pointer px-2.5 py-1 text-xs first-of-type:rounded-l-md last-of-type:rounded-r-md has-checked:bg-primary has-checked:text-primary-foreground has-focus-visible:ring-2 has-focus-visible:ring-ring has-disabled:opacity-60 hover:bg-muted has-checked:hover:bg-primary"
          >
            <input
              type="radio"
              className="sr-only"
              name={`attr-${row.roomTypeId ?? 'p'}-${row.code}`}
              checked={current === o.value}
              onChange={() => onSet(o.value)}
            />
            <span aria-hidden={o.value === null ? true : undefined}>{o.label}</span>
            {o.value === null ? <span className="sr-only">Unknown</span> : null}
          </label>
        ))}
      </fieldset>
    );
  }
  if (row.valueType === 'enum') {
    return (
      <Select
        id={id}
        aria-label={row.label}
        className="h-8 w-40 text-xs"
        value={current === null ? '' : String(current)}
        disabled={disabled}
        onChange={(e) => onSet(e.target.value === '' ? null : e.target.value)}
      >
        <option value="">—</option>
        {(row.enumValues ?? []).map((v) => (
          <option key={v} value={v}>
            {v.replace(/_/g, ' ')}
          </option>
        ))}
      </Select>
    );
  }
  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === (current === null ? '' : String(current))) return;
    if (trimmed === '') return onSet(null);
    onSet(row.valueType === 'number' ? Number(trimmed) : trimmed);
  };
  return (
    <Input
      id={id}
      aria-label={row.label}
      className={cn('h-8 text-xs', row.valueType === 'number' ? 'w-24' : 'w-56')}
      type={row.valueType === 'number' ? 'number' : 'text'}
      value={draft}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        }
      }}
    />
  );
}

function AttributeRows({
  rows,
  canEdit,
  onSet,
  pendingKey,
}: {
  rows: AttributeRowDto[];
  canEdit: boolean;
  onSet: (row: AttributeRowDto, value: Value | null) => void;
  pendingKey: string | null;
}) {
  return (
    <ul className="divide-y">
      {rows.map((row) => {
        const key = `${row.roomTypeId ?? '-'}:${row.code}`;
        return (
          <li key={key} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
            <span className="min-w-48 flex-1 text-sm">
              {row.label}
              {row.importance >= 4 ? (
                <span className="ml-1 text-xs text-muted-foreground" title="Often used by agents to filter">
                  ★
                </span>
              ) : null}
            </span>
            {row.effective ? <SourceBadge source={row.effective.source} /> : null}
            {canEdit ? (
              <ValueControl row={row} disabled={pendingKey === key} onSet={(v) => onSet(row, v)} />
            ) : (
              <span className="text-sm text-muted-foreground">
                {row.effective ? formatValue(row.effective.value, row) : '—'}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function AttributeEditor({
  orgId,
  propertyId,
  profile,
  canEdit,
}: {
  orgId: string;
  propertyId: string;
  profile: ProfileDto;
  canEdit: boolean;
}) {
  const { status, run } = useAction();
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const onSet = (row: AttributeRowDto, value: Value | null) => {
    const key = `${row.roomTypeId ?? '-'}:${row.code}`;
    setPendingKey(key);
    run(async () => {
      const result = await setAttribute(orgId, propertyId, row.code, row.roomTypeId, value);
      setPendingKey(null);
      return result?.ok ? { ok: true, message: `${row.label} saved` } : result;
    });
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>All attributes</CardTitle>
        <CardDescription>
          Set anything we missed. ★ marks attributes travellers and agents filter on most.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2">
        <StatusLine status={status} />
        {profile.categories.map((c) => {
          const answered = c.attributes.filter((a) => a.effective).length;
          return (
            <details key={c.code} className="rounded-md border px-3 open:pb-2">
              <summary className="flex cursor-pointer items-center justify-between py-2 text-sm font-medium">
                {c.label}
                <span className="text-xs font-normal text-muted-foreground tabular-nums">
                  {answered}/{c.attributes.length}
                </span>
              </summary>
              <AttributeRows rows={c.attributes} canEdit={canEdit} onSet={onSet} pendingKey={pendingKey} />
            </details>
          );
        })}
        {profile.rooms.map((r) => (
          <details key={r.roomTypeId} className="rounded-md border px-3 open:pb-2">
            <summary className="flex cursor-pointer items-center justify-between py-2 text-sm font-medium">
              Room: {r.name}
              <span className="text-xs font-normal text-muted-foreground tabular-nums">
                {r.attributes.filter((a) => a.effective).length}/{r.attributes.length}
              </span>
            </summary>
            <AttributeRows rows={r.attributes} canEdit={canEdit} onSet={onSet} pendingKey={pendingKey} />
          </details>
        ))}
      </CardContent>
    </Card>
  );
}
