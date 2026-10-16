import CopyButton from './CopyButton';

export default function CodeBlock({ code, label }: { code: string; label: string }) {
  return (
    <div className="min-w-0 overflow-hidden rounded-lg border">
      <div className="flex items-center justify-between border-b bg-muted/50 py-1 pr-1 pl-3">
        <span className="text-muted-foreground text-xs font-medium">{label}</span>
        <CopyButton value={code} what={`${label} snippet`} variant="ghost" />
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-xs leading-relaxed" tabIndex={0} aria-label={`${label} code`}>
        <code>{code}</code>
      </pre>
    </div>
  );
}
