import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CircleOff, ShieldCheck, Trash2, TriangleAlert } from 'lucide-react';
import { api, ApiError, MODE_INFO, ttlLabel, type Site, type StatsDay } from '../api';
import { useAnnounce, useDocumentTitle } from '../a11y';
import { useAuth } from '../auth';
import CodeBlock from '../components/CodeBlock';
import KeyField from '../components/KeyField';
import { useConfirm } from '../components/Modal';
import SecretOnce from '../components/SecretOnce';
import SiteForm from '../components/SiteForm';
import StatsChart from '../components/StatsChart';
import Tabs from '../components/Tabs';
import TryIt from '../components/TryIt';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs as UiTabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

type TabKey = 'overview' | 'setup' | 'clearance' | 'settings';
const TABS: { key: TabKey; label: string; path: string }[] = [
  { key: 'overview', label: 'Overview', path: '' },
  { key: 'setup', label: 'Setup', path: '/setup' },
  { key: 'clearance', label: 'Pre-clearance', path: '/clearance' },
  { key: 'settings', label: 'Settings', path: '/settings' },
];

function ErrorAlert({ title, message, onRetry }: { title: string; message: string; onRetry?: () => void }) {
  return (
    <Alert variant="destructive" role="alert">
      <TriangleAlert />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p>{message}</p>
        {onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry}>
            Retry
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}

function SectionCard({
  id,
  title,
  description,
  action,
  children,
  className,
}: {
  id: string;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card aria-labelledby={id} role="region" className={className}>
      <CardHeader>
        <CardTitle id={id}>
          <h2>{title}</h2>
        </CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
        {action && <CardAction>{action}</CardAction>}
      </CardHeader>
      <CardContent className="grid min-w-0 gap-4">{children}</CardContent>
    </Card>
  );
}

export default function SiteDetailPage() {
  const { id = '', tab = 'overview' } = useParams();
  const navigate = useNavigate();
  const [site, setSite] = useState<Site | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const { can } = useAuth();
  const current = TABS.find((t) => t.key === tab) ?? TABS[0];
  useDocumentTitle(notFound ? 'Site not found' : site ? `${current.label} · ${site.name}` : 'Site');

  const load = useCallback(() => {
    setError(null);
    api
      .getSite(id)
      .then(setSite)
      .catch((e: Error) => {
        if (e instanceof ApiError && e.status === 404) setNotFound(true);
        else setError(e.message);
      });
  }, [id]);

  useEffect(load, [load]);

  if (notFound) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyTitle>
            <h1>Site not found</h1>
          </EmptyTitle>
          <EmptyDescription>It may have been deleted, or it belongs to another organization.</EmptyDescription>
        </EmptyHeader>
        <Button asChild variant="outline">
          <Link to="/sites">Back to sites</Link>
        </Button>
      </Empty>
    );
  }
  if (error) return <ErrorAlert title="Couldn’t load this site" message={error} onRetry={load} />;
  if (!site) {
    return (
      <div className="grid gap-4" aria-busy="true" aria-label="Loading site">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-9 w-96 max-w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const anyHost = site.domains.includes('*');
  const base = `/sites/${site.id}`;
  return (
    <>
      <Breadcrumb className="mb-2">
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link to="/sites">Sites</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{site.name}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      <div className="mb-6 grid gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{site.name}</h1>
        <ul className="flex flex-wrap gap-1.5" aria-label="Site summary">
          <li>
            <Badge variant="secondary">{MODE_INFO[site.mode].label}</Badge>
          </li>
          <li>
            <Badge variant="outline">Difficulty {site.difficulty}</Badge>
          </li>
          <li>
            <Badge variant="outline" title={anyHost ? undefined : site.domains.join(', ')}>
              {anyHost ? 'Any hostname' : site.domains.length === 1 ? site.domains[0] : `${site.domains.length} domains`}
            </Badge>
          </li>
          {site.clearance_enabled && (
            <li>
              <Badge variant="outline">Pre-clearance · {ttlLabel(site.clearance_ttl_secs)}</Badge>
            </li>
          )}
        </ul>
      </div>

      <UiTabs value={current.key} onValueChange={(v) => navigate(base + (TABS.find((t) => t.key === v)?.path ?? ''))} className="mb-6">
        <div className="overflow-x-auto">
          <TabsList aria-label="Site sections">
            {TABS.map((t) => (
              <TabsTrigger key={t.key} value={t.key}>
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
      <TabsContent value={current.key}>
        {current.key === 'overview' && <Overview site={site} canTry={can.tryIt} />}

        {current.key === 'setup' && (
          <div className="grid gap-6">
            <SectionCard id="keys-h" title="Keys" description="The sitekey goes in your page; the secret stays on your server.">
              <Keys site={site} onChange={setSite} canRotate={can.manageSecrets} />
            </SectionCard>
            <SectionCard id="embed-h" title="Add it to your site">
              <Embed sitekey={site.sitekey} />
            </SectionCard>
          </div>
        )}

        {current.key === 'clearance' && (
          <SectionCard
            id="clearance-h"
            title="Pre-clearance"
            description="Let visitors who already passed through your reverse proxy or middleware without another challenge."
          >
            <Clearance site={site} settingsHref={`${base}/settings`} />
          </SectionCard>
        )}

        {current.key === 'settings' && (
          <div className="grid gap-6">
            <SectionCard id="settings-h" title="Settings">
              <SiteForm
                key={site.updated_at}
                initial={site}
                submitLabel="Save changes"
                busyLabel="Saving…"
                readOnly={!can.editSites}
                onSubmit={async (input) => {
                  setSite(await api.updateSite(site.id, input));
                }}
              />
            </SectionCard>
            {can.deleteSites && (
              <SectionCard
                id="danger-h"
                title="Delete this site"
                description="Its sitekey and secret stop working immediately. This can’t be undone."
                className="border-destructive"
              >
                <div>
                  <DeleteButton site={site} onDeleted={() => navigate('/sites', { replace: true })} />
                </div>
              </SectionCard>
            )}
          </div>
        )}
      </TabsContent>
      </UiTabs>
    </>
  );
}

function DeleteButton({ site, onDeleted }: { site: Site; onDeleted: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = useConfirm();
  const announce = useAnnounce();

  async function del() {
    const ok = await confirm({
      title: `Delete “${site.name}”?`,
      body: 'Its sitekey and secret stop working immediately. This can’t be undone.',
      confirmLabel: 'Delete site',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteSite(site.id);
      announce(`Deleted ${site.name}`);
      onDeleted();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div className="grid justify-items-start gap-3">
      <Button type="button" variant="destructive" onClick={del} disabled={busy}>
        <Trash2 />
        {busy ? 'Deleting…' : 'Delete site'}
      </Button>
      {error && <ErrorAlert title="Couldn’t delete the site" message={error} />}
    </div>
  );
}

const GRACE_OPTIONS: { hours: number; label: string }[] = [
  { hours: 0, label: 'Immediately' },
  { hours: 1, label: '1 hour' },
  { hours: 24, label: '24 hours' },
  { hours: 168, label: '7 days' },
];

function Keys({ site, onChange, canRotate }: { site: Site; onChange: (s: Site) => void; canRotate: boolean }) {
  const confirm = useConfirm();
  const announce = useAnnounce();
  const [secret, setSecret] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [grace, setGrace] = useState(24);
  const [busy, setBusy] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function rotate() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.rotateSecret(site.id, grace);
      setSecret(r.secret);
      setPicking(false);
      announce('Secret rotated. Copy the new secret now.');
      onChange({ ...site, previous_secret_expires_at: r.previous_secret_expires_at });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    const ok = await confirm({
      title: 'Revoke the previous secret?',
      body: 'Servers still using it will fail verification immediately.',
      confirmLabel: 'Revoke now',
      danger: true,
    });
    if (!ok) return;
    setRevoking(true);
    setError(null);
    try {
      await api.revokePreviousSecret(site.id);
      onChange({ ...site, previous_secret_expires_at: null });
      announce('Previous secret revoked');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRevoking(false);
    }
  }

  const prevUntil = site.previous_secret_expires_at ? new Date(site.previous_secret_expires_at) : null;
  const prevActive = prevUntil !== null && prevUntil.getTime() > Date.now();

  return (
    <div className="grid gap-6">
      <KeyField label="Sitekey (public)" value={site.sitekey} what="sitekey" />
      {secret ? (
        <SecretOnce secret={secret} onDismiss={() => setSecret(null)} />
      ) : (
        <Field>
          <FieldLabel htmlFor="secret-masked">Secret key</FieldLabel>
          <InputGroup>
            <InputGroupInput id="secret-masked" readOnly value="rs_••••••••••••••••••••••••" aria-label="Secret key (hidden)" className="font-mono text-xs" />
            {!picking && canRotate && (
              <InputGroupAddon align="inline-end">
                <Button type="button" variant="ghost" size="sm" onClick={() => setPicking(true)} aria-label="Rotate secret key">
                  Rotate
                </Button>
              </InputGroupAddon>
            )}
          </InputGroup>
          <FieldDescription>
            {canRotate ? 'Secrets are only shown once. Rotate to issue a new one.' : 'Secrets are only shown once. Admins can rotate it.'}
          </FieldDescription>
        </Field>
      )}
      {picking && (
        <Card>
          <CardContent className="grid gap-4">
            <fieldset className="grid gap-3">
              <legend className="mb-3 text-sm font-medium">Keep accepting the current secret for…</legend>
              <RadioGroup value={String(grace)} onValueChange={(v) => setGrace(Number(v))} className="flex flex-wrap gap-4">
                {GRACE_OPTIONS.map((o) => (
                  <div key={o.hours} className="flex items-center gap-2">
                    <RadioGroupItem value={String(o.hours)} id={`grace-${o.hours}`} />
                    <Label htmlFor={`grace-${o.hours}`}>{o.label}</Label>
                  </div>
                ))}
              </RadioGroup>
            </fieldset>
            <p className="text-muted-foreground text-sm">
              {grace === 0
                ? 'The current secret stops working immediately, so update your servers first.'
                : 'Both secrets work during the grace period, so you can roll out the new one without downtime.'}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" onClick={rotate} disabled={busy}>
                {busy ? 'Rotating…' : 'Rotate secret'}
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setPicking(false)} disabled={busy}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
      {prevActive && (
        <Alert>
          <TriangleAlert />
          <AlertTitle>Previous secret still accepted</AlertTitle>
          <AlertDescription>
            <p>Until {prevUntil.toLocaleString()}.</p>
            {canRotate && (
              <Button type="button" size="sm" variant="outline" onClick={revoke} disabled={revoking}>
                {revoking ? 'Revoking…' : 'Revoke now'}
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}
      {error && <ErrorAlert title="Something went wrong" message={error} />}
    </div>
  );
}

function RefTable({ caption, columns, rows }: { caption: string; columns: string[]; rows: ReactNode[][] }) {
  return (
    <div className="overflow-x-auto rounded-md border">
      <Table>
        <TableCaption className="sr-only">{caption}</TableCaption>
        <TableHeader>
          <TableRow>
            {columns.map((c) => (
              <TableHead key={c}>{c}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r, i) => (
            <TableRow key={i}>
              {r.map((cell, j) => (
                <TableCell key={j} className={j === 0 ? 'font-mono text-xs' : 'text-sm whitespace-normal'}>
                  {cell}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

const Muted = ({ children }: { children: ReactNode }) => <p className="text-muted-foreground text-sm">{children}</p>;

const ATTRIBUTES: [string, string, string][] = [
  ['data-sitekey', 'required', 'Your site’s public sitekey.'],
  ['data-theme', 'auto | light | dark', 'Color scheme. Default auto (follows the visitor’s OS).'],
  ['data-size', 'normal | compact | flexible', 'normal is 300×65, compact 150×140, flexible fills its container width.'],
  ['data-appearance', 'always | execute | interaction-only', 'When the widget is visible. interaction-only shows it only if a click is needed.'],
  ['data-execution', 'render | execute', 'execute defers solving until you call roundabout.execute(widgetId).'],
  ['data-language', 'auto | en | es | fr | de | pt | it | ja | zh | ko | ru', 'UI language. Default auto (browser language).'],
  ['data-action', '≤ 32 chars [A-Za-z0-9_-]', 'Label returned by siteverify, e.g. login.'],
  ['data-cdata', '≤ 255 chars [A-Za-z0-9_-]', 'Custom data returned by siteverify.'],
  ['data-retry', 'auto | never', 'Retry automatically after a failure. Default auto.'],
  ['data-retry-interval', 'ms', 'Delay between automatic retries. Default 8000.'],
  ['data-refresh-expired', 'auto | never', 'Get a new token when one expires. Default auto.'],
  ['data-response-field-name', 'string', 'Name of the hidden input. Default roundabout-response.'],
  ['data-response-field', '"false"', 'Don’t add a hidden input at all.'],
];

const CALLBACKS: [string, string][] = [
  ['data-callback', 'Called with the token on success.'],
  ['data-error-callback', 'Called with an error code.'],
  ['data-expired-callback', 'The token expired (before auto-refresh).'],
  ['data-timeout-callback', 'An interactive challenge wasn’t completed in time.'],
  ['data-before-interactive-callback', 'Right before the checkbox is shown.'],
  ['data-after-interactive-callback', 'After the visitor completes the checkbox.'],
  ['data-unsupported-callback', 'The browser can’t run the challenge.'],
];

function Embed({ sitekey }: { sitekey: string }) {
  const origin = window.location.origin;
  const html = `<script src="${origin}/widget/api.js" async defer></script>

<form action="/signup" method="POST">
  <!-- adds a hidden "roundabout-response" field to the form -->
  <div class="roundabout" data-sitekey="${sitekey}"></div>
  <button type="submit">Sign up</button>
</form>`;
  const explicit = `<script src="${origin}/widget/api.js?render=explicit" async defer></script>
<div id="captcha"></div>
<script>
  roundabout.ready(() => {
    const id = roundabout.render('#captcha', {
      sitekey: '${sitekey}',
      execution: 'execute',
      callback: (token) => submitForm(token),
    });
    document.querySelector('#submit').onclick = () => roundabout.execute(id);
  });
</script>`;
  const curl = `curl -X POST ${origin}/v1/siteverify \\
  -d "secret=$ROUNDABOUT_SECRET" \\
  -d "response=$TOKEN_FROM_FORM"`;
  const node = `const res = await fetch('${origin}/v1/siteverify', {
  method: 'POST',
  body: new URLSearchParams({
    secret: process.env.ROUNDABOUT_SECRET,
    response: req.body['roundabout-response'],
    remoteip: req.ip,
  }),
});
const outcome = await res.json();
if (!outcome.success) {
  return res.status(403).send('Verification failed');
}`;
  const verifyResponse = `{
  "success": true,
  "challenge_ts": "2026-10-17T09:12:44.123Z",
  "hostname": "shop.example.com",
  "error-codes": [],
  "action": "login",
  "cdata": "sess-42",
  "metadata": {
    "ephemeral_id": "eid_…",
    "risk_score": 0,
    "pat": false
  }
}`;
  const feedback = `curl -X POST ${origin}/v1/feedback \\
  -d "secret=$ROUNDABOUT_SECRET" \\
  -d "response=$TOKEN_YOU_VERIFIED" \\
  -d "verdict=abuse"   # or "legit"

# → {"success": true, "error-codes": []}`;

  const testSitekeys: [string, string][] = [
    ['rk_test_pass', 'Always passes (non-interactive).'],
    ['rk_test_fail', 'Always fails.'],
    ['rk_test_interactive', 'Always asks for the checkbox.'],
  ];
  const testSecrets: [string, string][] = [
    ['rs_test_pass', 'Every token verifies successfully.'],
    ['rs_test_fail', 'Every token fails with invalid-input-response.'],
    ['rs_test_spent', 'Every token fails with timeout-or-duplicate, as if already redeemed.'],
  ];

  return (
    <Tabs
      label="Embed documentation"
      tabs={[
        {
          key: 'quick',
          label: 'Quick start',
          content: (
            <>
              <Muted>1. Add the widget to any page served from an allowed domain.</Muted>
              <CodeBlock label="HTML" code={html} />
              <Muted>
                2. On your server, verify the token before trusting the request. Tokens expire after 5 minutes and can
                only be verified once.
              </Muted>
              <div className="grid items-start gap-4 lg:grid-cols-2">
                <CodeBlock label="curl" code={curl} />
                <CodeBlock label="Node.js" code={node} />
              </div>
            </>
          ),
        },
        {
          key: 'options',
          label: 'Options',
          content: (
            <>
              <Muted>
                Set these as <code>data-*</code> attributes, or pass them to <code>roundabout.render(el, options)</code>{' '}
                without the <code>data-</code> prefix (e.g. <code>'retry-interval'</code>).
              </Muted>
              <RefTable caption="Widget attributes" columns={['Attribute', 'Values', 'Description']} rows={ATTRIBUTES.map(([a, v, d]) => [a, <code key="v">{v}</code>, d])} />
              <h3 className="text-sm font-semibold">Callbacks</h3>
              <Muted>Give the name of a global function, or pass a function to render().</Muted>
              <RefTable caption="Widget callbacks" columns={['Attribute', 'Called when']} rows={CALLBACKS.map(([a, d]) => [a, d])} />
              <CodeBlock label="Explicit render + execute" code={explicit} />
            </>
          ),
        },
        {
          key: 'verify',
          label: 'Verify',
          content: (
            <>
              <Muted>
                <code>POST /v1/siteverify</code> accepts form or JSON bodies with <code>secret</code>, <code>response</code>,
                and optional <code>remoteip</code> and <code>idempotency_key</code>. Check that <code>hostname</code> and{' '}
                <code>action</code> match what you expect.
              </Muted>
              <div className="grid items-start gap-4 lg:grid-cols-2">
                <CodeBlock label="curl" code={curl} />
                <CodeBlock label="Response" code={verifyResponse} />
              </div>
              <Muted>
                <code>metadata.ephemeral_id</code> is a short-lived device ID for spotting one device across many IPs;{' '}
                <code>risk_score</code> is 0 when nothing looked suspicious; <code>pat</code> is true when the browser
                passed with a Private Access Token.
              </Muted>
            </>
          ),
        },
        {
          key: 'testing',
          label: 'Test keys',
          content: (
            <>
              <Muted>
                Use these in CI and automated tests. They work on any hostname and never touch your real sites or stats.
                Pair any test sitekey with any test secret.
              </Muted>
              <div className="grid items-start gap-4 lg:grid-cols-2">
                <RefTable caption="Test sitekeys (widget)" columns={['Sitekey', 'Behaviour']} rows={testSitekeys} />
                <RefTable caption="Test secrets (siteverify)" columns={['Secret', 'Behaviour']} rows={testSecrets} />
              </div>
            </>
          ),
        },
        {
          key: 'feedback',
          label: 'Report abuse',
          content: (
            <>
              <Muted>
                Found out later that a verified request was spam or fraud? Report it. Reports feed Roundabout’s IP,
                network and device reputation, so similar traffic gets challenged harder. Tokens are remembered for 7 days
                after verification.
              </Muted>
              <CodeBlock label="curl" code={feedback} />
            </>
          ),
        },
      ]}
    />
  );
}

function Clearance({ site, settingsHref }: { site: Site; settingsHref: string }) {
  const origin = window.location.origin;
  const sk = site.sitekey;
  const nginx = `location / {
  auth_request /_roundabout_check;
  error_page 401 = @roundabout_gate;
  proxy_pass http://your_app;
}

location = /_roundabout_check {
  internal;
  proxy_pass ${origin}/v1/clearance/check?sitekey=${sk};
  proxy_pass_request_body off;
  proxy_set_header Content-Length "";
  proxy_set_header Cookie $http_cookie;
  proxy_set_header User-Agent $http_user_agent;
  proxy_set_header X-Forwarded-Host $host;
}

location @roundabout_gate {
  return 302 /_roundabout/gate?sitekey=${sk}&return=$request_uri;
}

location /_roundabout/ {
  proxy_pass ${origin}/v1/;
}`;
  const caddy = `example.com {
	# Serve the gate page (and the widget it loads) through your domain.
	handle_path /_roundabout/* {
		rewrite * /v1{uri}
		reverse_proxy ${origin} {
			header_up Host {upstream_hostport}
		}
	}

	handle {
		# The original request's headers (Cookie, User-Agent) are forwarded to the check.
		forward_auth ${origin} {
			uri /v1/clearance/check?sitekey=${sk}
			header_up Host {upstream_hostport}
			header_up X-Forwarded-Host {host}

			# Not cleared yet: send the visitor to the gate instead of returning the 401.
			@unauthorized status 401
			handle_response @unauthorized {
				redir * /_roundabout/gate?sitekey=${sk}&return={uri} 302
			}
		}
		reverse_proxy your_app:8080
	}
}`;
  const express = `import express from "express";
import { gate } from "@roundabout/clearance";

const app = express();

// Visitors without a valid rb_clearance cookie are redirected to the gate.
app.use(gate({ endpoint: "${origin}", sitekey: "${sk}" }));`;
  const offline = `import { createHash, createPublicKey, verify } from "node:crypto";

// Ed25519 public keys (JWKS). Cache them and refresh occasionally.
const { keys } = await (await fetch("${origin}/v1/clearance/keys")).json();

// Token: rbc1.<base64url JSON payload>.<base64url Ed25519 signature over "rbc1.<payload>">
// Payload: { v, kid, s: sitekey, h: hostname, u: base64url(sha256(User-Agent))[:16], iat, exp }
export function hasClearance(cookie, { hostname, userAgent }) {
  const [prefix, payloadB64, sigB64] = String(cookie).split(".");
  if (prefix !== "rbc1" || !payloadB64 || !sigB64) return false;
  const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString());
  const jwk = keys.find((k) => k.kid === payload.kid);
  if (!jwk) return false;
  const signed = verify(
    null,
    Buffer.from(\`rbc1.\${payloadB64}\`),
    createPublicKey({ key: jwk, format: "jwk" }),
    Buffer.from(sigB64, "base64url"),
  );
  const ua = createHash("sha256").update(userAgent).digest("base64url").slice(0, 16);
  return (
    signed &&
    payload.s === "${sk}" &&
    payload.h === hostname &&
    payload.u === ua &&
    payload.exp > Date.now() / 1000
  );
}`;
  const online = `curl -X POST ${origin}/v1/clearance/verify \\
  -d "secret=$ROUNDABOUT_SECRET" \\
  -d "clearance=$RB_CLEARANCE_COOKIE" \\
  -d "hostname=shop.example.com" \\
  -d "user_agent=$VISITOR_USER_AGENT"

# → {"success": true, "error-codes": [], "hostname": "shop.example.com",
#    "expires_at": "2026-10-17T10:42:00Z"}`;

  return (
    <div className="grid gap-6">
      <Alert>
        {site.clearance_enabled ? <ShieldCheck /> : <CircleOff />}
        <AlertTitle>{site.clearance_enabled ? `On · cookies last ${ttlLabel(site.clearance_ttl_secs)}` : 'Off'}</AlertTitle>
        <AlertDescription>
          <p>
            {site.clearance_enabled
              ? 'A successful solve sets a signed first-party rb_clearance cookie, bound to this sitekey, the hostname and the visitor’s User-Agent.'
              : 'Visitors are challenged on every protected page load. Turn it on to issue a clearance cookie after a successful solve.'}
          </p>
          <Button asChild size="sm" variant="outline">
            <Link to={settingsHref}>{site.clearance_enabled ? 'Change in settings' : 'Turn on in settings'}</Link>
          </Button>
        </AlertDescription>
      </Alert>
      <Muted>
        Your reverse proxy or middleware checks the cookie and lets cleared visitors through. Visitors without it are sent
        to a gate page that runs the widget and then returns them.
      </Muted>
      <Tabs
        label="Pre-clearance integration"
        tabs={[
          { key: 'nginx', label: 'nginx', content: <CodeBlock label="nginx" code={nginx} /> },
          {
            key: 'caddy',
            label: 'Caddy',
            content: (
              <>
                <CodeBlock label="Caddyfile" code={caddy} />
                <Muted>
                  Caddy’s <code>forward_auth</code> passes the auth service’s 401 straight to the visitor, so the redirect
                  to the gate is done with <code>handle_response</code>.
                </Muted>
              </>
            ),
          },
          { key: 'node', label: 'Node / Express', content: <CodeBlock label="Express" code={express} /> },
          {
            key: 'offline',
            label: 'Offline verification',
            content: (
              <>
                <Muted>
                  Verify the cookie yourself with the public keys at <code className="break-all">{origin}/v1/clearance/keys</code>:
                  no call to Roundabout per request.
                </Muted>
                <CodeBlock label="Node.js" code={offline} />
              </>
            ),
          },
          {
            key: 'online',
            label: 'Online verification',
            content: (
              <>
                <Muted>Or ask Roundabout to check a cookie value, using the site secret.</Muted>
                <CodeBlock label="curl" code={online} />
              </>
            ),
          },
        ]}
      />
    </div>
  );
}

function Overview({ site, canTry }: { site: Site; canTry: boolean }) {
  const [days, setDays] = useState<StatsDay[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    api
      .stats(site.id, 30)
      .then((r) => setDays(r.days))
      .catch((e: Error) => setError(e.message));
  }, [site.id]);

  useEffect(load, [load]);

  const totals = useMemo(() => {
    const t = { issued: 0, solved: 0, failed: 0, interactive: 0, verified: 0, verify_failed: 0, reported: 0, pat: 0 };
    for (const d of days ?? []) {
      t.issued += d.issued;
      t.solved += d.solved;
      t.failed += d.failed;
      t.interactive += d.interactive;
      t.verified += d.verified;
      t.verify_failed += d.verify_failed;
      t.reported += d.reported ?? 0;
      t.pat += d.pat ?? 0;
    }
    return t;
  }, [days]);

  if (error) return <ErrorAlert title="Couldn’t load stats" message={error} onRetry={load} />;
  if (!days) {
    return (
      <div className="grid gap-4" aria-busy="true" aria-label="Loading stats">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
        <Skeleton className="h-72" />
      </div>
    );
  }

  const attempts = totals.solved + totals.failed;
  const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(1)}%` : '—');
  const kpis: { label: string; value: string; note: string }[] = [
    { label: 'Challenges', value: totals.issued.toLocaleString(), note: 'issued in 30 days' },
    { label: 'Pass rate', value: pct(totals.solved, attempts), note: `${totals.failed.toLocaleString()} failed` },
    { label: 'Verified', value: totals.verified.toLocaleString(), note: `${totals.verify_failed.toLocaleString()} rejected by siteverify` },
    { label: 'Asked to click', value: pct(totals.interactive, totals.issued), note: `${totals.interactive.toLocaleString()} visitors` },
  ];
  const more: [string, string][] = [
    ['Solved', totals.solved.toLocaleString()],
    ['Failed', totals.failed.toLocaleString()],
    ['Passed with a Private Access Token', `${totals.pat.toLocaleString()} (${pct(totals.pat, totals.solved)})`],
    ['Abuse reports', totals.reported.toLocaleString()],
  ];

  return (
    <div className="grid gap-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {kpis.map((k) => (
          <Card key={k.label} role="group" aria-label={`${k.label}: ${k.value}, ${k.note}`}>
            <CardHeader>
              <CardDescription>{k.label}</CardDescription>
              <CardTitle className="text-3xl tabular-nums">{k.value}</CardTitle>
              <p className="text-muted-foreground text-xs">{k.note}</p>
            </CardHeader>
          </Card>
        ))}
      </div>

      <SectionCard id="chart-h" title="Solved vs failed" description="Daily, last 30 days">
        {attempts === 0 ? (
          <Empty className="border border-dashed">
            <EmptyHeader>
              <EmptyTitle>No traffic yet</EmptyTitle>
              <EmptyDescription>Embed the widget (see Setup) or run Try it below, and numbers show up here.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <StatsChart days={days} />
        )}
      </SectionCard>

      <div className="grid gap-6 lg:grid-cols-5">
        <SectionCard
          id="try-h"
          title="Try it"
          description="Renders the live widget, then verifies the token server-side."
          className="lg:col-span-3"
        >
          {canTry ? <TryIt siteId={site.id} sitekey={site.sitekey} /> : <Muted>Members and above can try the widget and verify tokens here.</Muted>}
        </SectionCard>
        <SectionCard id="more-h" title="Details" className="lg:col-span-2">
          <dl className="divide-y text-sm">
            {more.map(([k, v]) => (
              <div key={k} className="flex items-baseline justify-between gap-4 py-3 first:pt-0 last:pb-0">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="font-medium tabular-nums">{v}</dd>
              </div>
            ))}
          </dl>
        </SectionCard>
      </div>
    </div>
  );
}
