import { useEffect, useRef, useState } from 'react';
import { Play, RotateCcw, TriangleAlert } from 'lucide-react';
import { api, type VerifyResult } from '../api';
import { useAnnounce, useId } from '../a11y';
import { loadWidget } from '../widget';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { InputGroup, InputGroupInput } from '@/components/ui/input-group';

export default function TryIt({ siteId, sitekey }: { siteId: string; sitekey: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  // Only render on request: every render issues a real challenge that counts in the stats.
  const [started, setStarted] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [widgetError, setWidgetError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const announce = useAnnounce();
  const tokenId = useId('tryit-token');

  useEffect(() => {
    if (!started) return;
    let cancelled = false;
    loadWidget()
      .then((rb) => {
        if (cancelled || !containerRef.current) return;
        widgetIdRef.current = rb.render(containerRef.current, {
          sitekey,
          theme: 'auto',
          action: 'dashboard-test',
          callback: (t) => {
            setToken(t);
            setWidgetError(null);
            announce('Widget issued a token');
          },
          'error-callback': (code) => {
            setWidgetError(code || 'unknown error');
            setToken(null);
          },
          'expired-callback': () => setToken(null),
        });
      })
      .catch((e: Error) => !cancelled && setLoadError(e.message));
    return () => {
      cancelled = true;
      if (widgetIdRef.current && window.roundabout) {
        window.roundabout.remove(widgetIdRef.current);
        widgetIdRef.current = null;
      }
    };
  }, [sitekey, started]);

  function reset() {
    setToken(null);
    setResult(null);
    setVerifyError(null);
    setWidgetError(null);
    if (widgetIdRef.current) window.roundabout?.reset(widgetIdRef.current);
  }

  async function verify() {
    if (!token) return;
    setVerifying(true);
    setVerifyError(null);
    try {
      const r = await api.testVerify(siteId, token);
      setResult(r);
      announce(r.success ? 'Verification succeeded' : `Verification failed: ${r['error-codes'].join(', ')}`);
    } catch (e) {
      setVerifyError(e instanceof Error ? e.message : String(e));
    } finally {
      setVerifying(false);
    }
  }

  if (!started) {
    return (
      <div className="grid justify-items-start gap-3">
        <p className="text-muted-foreground text-sm">Running it issues a real challenge, so it shows up in this site’s stats.</p>
        <Button type="button" onClick={() => setStarted(true)}>
          <Play />
          Run widget
        </Button>
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      {loadError ? (
        <Alert variant="destructive" role="alert">
          <TriangleAlert />
          <AlertTitle>{loadError}</AlertTitle>
        </Alert>
      ) : (
        <div ref={containerRef} className="min-h-[65px]" aria-label="Live widget" role="group" />
      )}
      {widgetError && (
        <Alert variant="destructive" role="alert">
          <TriangleAlert />
          <AlertTitle>Widget error: {widgetError}</AlertTitle>
        </Alert>
      )}

      <Field>
        <FieldLabel htmlFor={tokenId}>Token</FieldLabel>
        <InputGroup>
          <InputGroupInput
            id={tokenId}
            readOnly
            value={token ?? ''}
            placeholder="Waiting for the widget to issue a token…"
            className="font-mono text-xs"
          />
        </InputGroup>
        <FieldDescription>
          Tokens are single-use: verifying twice returns <code>timeout-or-duplicate</code>.
        </FieldDescription>
      </Field>

      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={verify} disabled={!token || verifying}>
          {verifying ? 'Verifying…' : 'Verify server-side'}
        </Button>
        <Button type="button" variant="outline" onClick={reset}>
          <RotateCcw />
          Reset
        </Button>
      </div>

      {verifyError && (
        <Alert variant="destructive" role="alert">
          <TriangleAlert />
          <AlertTitle>{verifyError}</AlertTitle>
        </Alert>
      )}
      {result && (
        <div className="grid gap-2">
          <div>
            <Badge variant={result.success ? 'secondary' : 'destructive'}>{result.success ? 'Verified' : 'Not verified'}</Badge>
          </div>
          <pre className="overflow-x-auto rounded-md border p-3 font-mono text-xs" tabIndex={0} aria-label="Verification result">
            {JSON.stringify(result, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
