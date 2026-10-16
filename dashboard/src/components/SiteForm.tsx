import { useEffect, useRef, useState, type FormEvent } from 'react';
import { TriangleAlert } from 'lucide-react';
import { CLEARANCE_TTLS, MODE_INFO, type Mode, type SiteInput } from '../api';
import { useAnnounce, useId } from '../a11y';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Textarea } from '@/components/ui/textarea';

const HASH_RATE = 2_000_000; // hashes/sec on a typical laptop

function estimate(bits: number): string {
  const ms = (2 ** bits / HASH_RATE) * 1000;
  if (ms < 1) return 'under 1 ms';
  if (ms < 1000) return `about ${Math.round(ms)} ms`;
  return `about ${(ms / 1000).toFixed(1)} s`;
}

/** Lowercase, strip scheme/path; keeps `*` (any hostname). */
export function parseDomains(text: string): string[] {
  const seen = new Set<string>();
  for (const raw of text.split(/[\n,\s]+/)) {
    const d = raw
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '');
    if (d) seen.add(d);
  }
  return [...seen];
}

interface Props {
  initial?: SiteInput;
  submitLabel: string;
  busyLabel: string;
  /** Read-only rendering for viewers. */
  readOnly?: boolean;
  onSubmit: (input: SiteInput) => Promise<void>;
}

type FieldErrors = { name?: string; domains?: string };

export default function SiteForm({ initial, submitLabel, busyLabel, readOnly, onSubmit }: Props) {
  const [name, setName] = useState(initial?.name ?? '');
  const [domainsText, setDomainsText] = useState((initial?.domains ?? []).join('\n'));
  const [mode, setMode] = useState<Mode>(initial?.mode ?? 'managed');
  const [difficulty, setDifficulty] = useState(initial?.difficulty ?? 16);
  const [clearance, setClearance] = useState(initial?.clearance_enabled ?? false);
  const [ttl, setTtl] = useState(initial?.clearance_ttl_secs ?? 1800);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [saved, setSaved] = useState(false);
  const announce = useAnnounce();
  const p = useId('site');
  const anyHost = parseDomains(domainsText).includes('*');
  const sliderWrap = useRef<HTMLDivElement>(null);

  // The Radix slider thumb carries role="slider" but no name; point it at our label.
  useEffect(() => {
    const thumb = sliderWrap.current?.querySelector<HTMLElement>('[role="slider"]');
    if (!thumb) return;
    thumb.setAttribute('aria-labelledby', `${p}-difficulty-label`);
    thumb.setAttribute('aria-describedby', `${p}-difficulty-hint`);
    thumb.setAttribute('aria-valuetext', `${difficulty} bits, ${estimate(difficulty)}`);
  }, [difficulty, p]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    const domains = parseDomains(domainsText);
    const fe: FieldErrors = {};
    if (!name.trim()) fe.name = 'Enter a name for this site.';
    if (domains.length === 0) fe.domains = 'Add at least one domain, or * to allow any hostname.';
    setFieldErrors(fe);
    if (Object.keys(fe).length) {
      setError('Please fix the highlighted fields.');
      return;
    }
    setBusy(true);
    try {
      await onSubmit({
        name: name.trim(),
        domains,
        mode,
        difficulty,
        clearance_enabled: clearance,
        clearance_ttl_secs: ttl,
      });
      setDomainsText(domains.join('\n'));
      setSaved(true);
      if (initial) announce('Settings saved');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate>
      <FieldGroup>
        <Field data-invalid={!!fieldErrors.name}>
          <FieldLabel htmlFor={`${p}-name`}>Name</FieldLabel>
          <Input
            id={`${p}-name`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My marketing site"
            maxLength={100}
            required
            disabled={readOnly}
            aria-invalid={!!fieldErrors.name}
            aria-describedby={fieldErrors.name ? `${p}-name-err` : undefined}
          />
          {fieldErrors.name && <FieldError id={`${p}-name-err`}>{fieldErrors.name}</FieldError>}
        </Field>

        <Field data-invalid={!!fieldErrors.domains}>
          <FieldLabel htmlFor={`${p}-domains`}>Domains</FieldLabel>
          <Textarea
            id={`${p}-domains`}
            rows={4}
            value={domainsText}
            onChange={(e) => setDomainsText(e.target.value)}
            placeholder={'example.com\nlocalhost'}
            spellCheck={false}
            className="font-mono"
            required
            disabled={readOnly}
            aria-invalid={!!fieldErrors.domains}
            aria-describedby={
              [`${p}-domains-hint`, fieldErrors.domains && `${p}-domains-err`, anyHost && `${p}-any`].filter(Boolean).join(' ') ||
              undefined
            }
          />
          <FieldDescription id={`${p}-domains-hint`}>
            One per line. Subdomains are included automatically (<code>example.com</code> covers{' '}
            <code>www.example.com</code>). <code>localhost</code> works for development. Enter <code>*</code> to allow
            any hostname.
          </FieldDescription>
          {fieldErrors.domains && <FieldError id={`${p}-domains-err`}>{fieldErrors.domains}</FieldError>}
          {anyHost && (
            <Alert id={`${p}-any`}>
              <TriangleAlert />
              <AlertTitle>Any hostname allowed</AlertTitle>
              <AlertDescription>
                With <code>*</code>, any website can embed this sitekey and spend your visitors’ solves. Check{' '}
                <code>hostname</code> in siteverify responses yourself.
              </AlertDescription>
            </Alert>
          )}
        </Field>

        <FieldSet>
          <FieldLegend variant="label">Widget mode</FieldLegend>
          <RadioGroup
            value={mode}
            onValueChange={(v) => setMode(v as Mode)}
            disabled={readOnly}
            className="grid gap-3 md:grid-cols-3"
          >
            {(Object.keys(MODE_INFO) as Mode[]).map((m) => (
              <FieldLabel key={m} htmlFor={`${p}-mode-${m}`}>
                <Field orientation="horizontal">
                  <FieldContent>
                    <FieldTitle id={`${p}-mode-${m}-title`}>{MODE_INFO[m].label}</FieldTitle>
                    <FieldDescription id={`${p}-mode-${m}-desc`}>{MODE_INFO[m].description}</FieldDescription>
                  </FieldContent>
                  <RadioGroupItem
                    value={m}
                    id={`${p}-mode-${m}`}
                    aria-labelledby={`${p}-mode-${m}-title`}
                    aria-describedby={`${p}-mode-${m}-desc`}
                  />
                </Field>
              </FieldLabel>
            ))}
          </RadioGroup>
        </FieldSet>

        <Field>
          <FieldLabel id={`${p}-difficulty-label`}>
            Difficulty: {difficulty} bits
          </FieldLabel>
          <div ref={sliderWrap}>
            <Slider
              min={8}
              max={24}
              step={1}
              value={[difficulty]}
              onValueChange={([v]) => setDifficulty(v)}
              disabled={readOnly}
            />
          </div>
          <FieldDescription id={`${p}-difficulty-hint`}>
            About 2<sup>{difficulty}</sup> = {(2 ** difficulty).toLocaleString()} hashes, {estimate(difficulty)} on a
            typical laptop. Higher costs bots more but slows real visitors on low-end phones.
          </FieldDescription>
        </Field>

        <FieldSet>
          <FieldLegend variant="label">Pre-clearance</FieldLegend>
          <Field orientation="horizontal">
            <Checkbox
              id={`${p}-clearance`}
              checked={clearance}
              onCheckedChange={(v) => setClearance(v === true)}
              disabled={readOnly}
              aria-describedby={`${p}-clearance-hint`}
            />
            <FieldContent>
              <FieldLabel htmlFor={`${p}-clearance`}>Set a clearance cookie after a successful solve</FieldLabel>
              <FieldDescription id={`${p}-clearance-hint`}>
                Lets your reverse proxy or middleware wave cleared visitors through without another challenge.
              </FieldDescription>
            </FieldContent>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${p}-ttl`}>Clearance lasts</FieldLabel>
            <Select value={String(ttl)} onValueChange={(v) => setTtl(Number(v))} disabled={readOnly || !clearance}>
              <SelectTrigger id={`${p}-ttl`} className="w-full sm:w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CLEARANCE_TTLS.map((t) => (
                  <SelectItem key={t.secs} value={String(t.secs)}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </FieldSet>

        {error && (
          <Alert variant="destructive" role="alert">
            <TriangleAlert />
            <AlertTitle>{error}</AlertTitle>
          </Alert>
        )}

        {readOnly ? (
          <FieldDescription>You have view-only access. Ask an admin to change settings.</FieldDescription>
        ) : (
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={busy}>
              {busy ? busyLabel : submitLabel}
            </Button>
            {saved && initial && <span className="text-muted-foreground text-sm">Saved</span>}
          </div>
        )}
      </FieldGroup>
    </form>
  );
}
